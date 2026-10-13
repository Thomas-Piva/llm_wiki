/**
 * Un archivio non è un documento: è un contenitore.
 *
 * Finora un `.zip` finiva nel motore come qualsiasi altra sorgente, che gli
 * leggeva i byte compressi e li passava al modello. Risultato misurato sul
 * vault della cliente: **193 archivi falliti su 1.804 fallimenti totali**, cioè
 * un decimo dei guasti, tutti con la stessa causa e nessuno con un contenuto
 * rotto davvero — dentro c'erano PDF e immagini perfettamente leggibili.
 *
 * Qui l'archivio viene aperto e i file che contiene diventano sorgenti vere,
 * ognuna con la sua pagina. Lo zip smette di essere una sorgente e torna a
 * essere quello che è: una scatola.
 */
import JSZip from "jszip"
import { createDirectory, fileExists, readFileAsBase64, writeFileBase64 } from "@/commands/fs"
import { getFileName, normalizePath } from "@/lib/path-utils"

/** Estensioni trattate come contenitori da aprire invece che da leggere. */
const ZIP_EXTENSIONS = new Set(["zip"])

/**
 * Quanto in profondità si scende in archivi dentro archivi. Due livelli
 * coprono il caso reale (lo zip di una pratica che contiene lo zip degli
 * allegati) e chiudono la porta alla bomba a matrioska.
 */
const MAX_ZIP_DEPTH = 2

/** Tetti contro gli archivi malevoli. Nessuno dei due si avvicina a un caso vero. */
const MAX_ENTRIES = 5_000
const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024 // 2 GB scompattati

/** Roba che i sistemi operativi infilano negli archivi e che non è contenuto. */
function isNoise(name: string): boolean {
  const base = name.split("/").pop() ?? name
  return (
    name.startsWith("__MACOSX/") ||
    base === ".DS_Store" ||
    base === "Thumbs.db" ||
    base.startsWith("._")
  )
}

export function isZipSource(path: string): boolean {
  const name = getFileName(normalizePath(path)).toLowerCase()
  const ext = name.includes(".") ? name.split(".").pop() ?? "" : ""
  return ZIP_EXTENSIONS.has(ext)
}

/** Dove finisce il contenuto: una cartella accanto all'archivio, stesso nome. */
export function extractionDirFor(zipPath: string): string {
  const p = normalizePath(zipPath)
  return p.replace(/\.zip$/i, "") + "-contenuto"
}

/**
 * Impedisce lo zip-slip: un archivio può dichiarare un percorso come
 * `../../.ssh/authorized_keys` e senza questo controllo lo scriveremmo
 * davvero. Torna `null` per ogni nome che esce dalla cartella di destinazione.
 */
export function safeEntryPath(dir: string, entryName: string): string | null {
  if (entryName.includes("\0")) return null
  const parts: string[] = []
  for (const seg of entryName.split(/[\\/]+/)) {
    if (seg === "" || seg === ".") continue
    if (seg === "..") return null          // nessuna risalita, nemmeno una
    if (/^[a-zA-Z]:$/.test(seg)) return null // percorso assoluto Windows
    parts.push(seg)
  }
  if (parts.length === 0) return null
  return `${dir.replace(/\/+$/, "")}/${parts.join("/")}`
}

export interface ZipExpansion {
  /** I file scritti su disco, pronti per essere ingeriti uno per uno. */
  files: string[]
  /** Voci saltate e perché: finisce nei warning della pagina, non nel silenzio. */
  skipped: string[]
}

/**
 * Apre l'archivio e scrive il suo contenuto accanto a esso. Non ingerisce
 * niente: separare l'apertura dall'ingest tiene questa funzione provabile
 * senza modello, senza rete e senza il resto della pipeline.
 */
export async function expandZipSource(zipPath: string, depth = 0): Promise<ZipExpansion> {
  if (depth >= MAX_ZIP_DEPTH) {
    return { files: [], skipped: [`archivi annidati oltre ${MAX_ZIP_DEPTH} livelli: non aperto`] }
  }

  const { base64 } = await readFileAsBase64(zipPath)
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
  const zip = await JSZip.loadAsync(bytes)

  const dir = extractionDirFor(zipPath)
  await createDirectory(dir)

  const files: string[] = []
  const skipped: string[] = []
  let totale = 0
  let contate = 0

  for (const [name, entry] of Object.entries(zip.files)) {
    if (entry.dir || isNoise(name)) continue

    if (++contate > MAX_ENTRIES) {
      skipped.push(`archivio con più di ${MAX_ENTRIES} voci: aperte le prime ${MAX_ENTRIES}`)
      break
    }

    const dest = safeEntryPath(dir, name)
    if (!dest) {
      // Non è un dettaglio da ignorare: un nome che risale è un tentativo di
      // scrivere fuori dalla cartella, e va detto.
      skipped.push(`percorso rifiutato (esce dalla cartella): ${name}`)
      continue
    }

    const parent = dest.slice(0, dest.lastIndexOf("/"))
    if (parent && parent !== dir) await createDirectory(parent)

    let contenuto: Uint8Array
    try {
      contenuto = await entry.async("uint8array")
    } catch (err) {
      skipped.push(`${name}: non leggibile (${err instanceof Error ? err.message : String(err)})`)
      continue
    }

    totale += contenuto.byteLength
    if (totale > MAX_TOTAL_BYTES) {
      skipped.push(`archivio oltre i ${Math.round(MAX_TOTAL_BYTES / 1e9)} GB scompattati: fermato a ${name}`)
      break
    }

    // Già scritto da una passata precedente: non lo riscrivo, ma lo restituisco
    // lo stesso — l'ingest a valle ha la sua cache e salterà da solo.
    if (!(await fileExists(dest))) {
      await writeFileBase64(dest, toBase64(contenuto))
    }

    if (isZipSource(dest)) {
      const dentro = await expandZipSource(dest, depth + 1)
      files.push(...dentro.files)
      skipped.push(...dentro.skipped)
    } else {
      files.push(dest)
    }
  }

  return { files, skipped }
}

/** Uint8Array → base64 a blocchi: `String.fromCharCode(...tutto)` sfonda lo stack sui file grossi. */
function toBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000
  let s = ""
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(s)
}
