/**
 * Il grafo dei `[[wikilink]]` letto dal disco, e la creazione della pagina che
 * un collegamento cerca senza trovarla.
 *
 * Perché sta qui e non passa dall'API: i due allestimenti di questo stesso
 * server non hanno le stesse capacità.
 *
 *     vault_*     (locale, stdio)   cerca ✅  legge ✅  SCRIVE ✅  grafo ❌
 *     llm_wiki_*  (HTTP)            cerca ✅  legge ✅  scrive ❌  GRAFO ✅
 *
 * L'agente che lavora sul vault è quello locale, ed è proprio quello cieco sul
 * grafo: per collegare una nota deve **indovinare** il percorso del bersaglio.
 * Misurato sul vault della cliente, il costo di quell'indovinare: **5.254
 * collegamenti rotti e 2.271 pagine orfane**. Il grafo qui sotto è calcolato
 * dagli stessi file che l'agente può già leggere — nessun backend, nessuna
 * porta.
 */
import { promises as fs } from "node:fs"
import { randomBytes } from "node:crypto"
import path from "node:path"

import { listNotes, writeNote, VaultError } from "./vault-fs.js"

export interface GraphNode {
  /** Il nome con cui lo si scrive in un `[[ ]]`. */
  id: string
  /** Percorso vero, relativo alla radice del vault. È ciò che toglie l'indovinare. */
  path: string
  outgoing: string[]
}

export interface VaultGraph {
  nodes: GraphNode[]
  edges: Array<{ source: string; target: string }>
  /** Bersagli citati da un `[[ ]]` che non esistono: sono le pagine da creare. */
  brokenLinks: Array<{ from: string; target: string }>
  /** Pagine che nessuno cita: invisibili a chi cammina sui collegamenti. */
  orphans: string[]
}

/** `[[a]]`, `[[a|etichetta]]`, `[[a#sezione]]`, `![[a]]` — tiene solo il bersaglio. */
export function parseWikilinks(content: string): string[] {
  // Il corpo di un blocco di codice non è testo del vault: un `[[esempio]]`
  // dentro tre backtick è documentazione, non un arco del grafo.
  const senzaCodice = content.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "")
  const out: string[] = []
  for (const m of senzaCodice.matchAll(/!?\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g)) {
    const t = m[1].trim()
    if (t) out.push(t)
  }
  return out
}

/**
 * Le due chiavi con cui un collegamento può nominare una pagina.
 *
 * `schema.md` prescrive il **solo basename** (`[[metamedicina]]`), ed è la
 * forma che il vault risolve. Ma il percorso completo compare lo stesso —
 * misurate 55 occorrenze in una sola passata di ingest — e un grafo che le
 * ignora dichiara rotto un collegamento che l'autore intendeva valido.
 * Si accettano entrambe in lettura; la creazione scrive sempre la corta.
 */
function chiaviDi(relPath: string): string[] {
  const senzaExt = relPath.replace(/\.md$/i, "").split(path.sep).join("/")
  const base = senzaExt.split("/").pop() ?? senzaExt
  return base === senzaExt ? [base] : [base, senzaExt]
}

export async function buildGraph(vaultRoot: string, folder = "."): Promise<VaultGraph> {
  // ⚠️ `folder` restringe le pagine da **mostrare**, non quelle su cui si
  // **risolve**. Risolvere solo dentro la cartella fa risultare rotto ogni
  // collegamento che esce da lì: misurato su `entities/` del vault della
  // cliente, **692 rotti che rotti non erano** — erano link a `concepts/`.
  // Un numero del genere manda l'agente a creare pagine che esistono già.
  const tutti = await listNotes(vaultRoot, ".")
  const files = folder === "." ? tutti : await listNotes(vaultRoot, folder)

  // chiave → percorso vero. Sulla chiave corta vince il primo, come fa il vault.
  const perChiave = new Map<string, string>()
  for (const rel of tutti) {
    for (const k of chiaviDi(rel)) if (!perChiave.has(k)) perChiave.set(k, rel)
  }

  const nodes: GraphNode[] = []
  const edges: Array<{ source: string; target: string }> = []
  const brokenLinks: Array<{ from: string; target: string }> = []
  const citati = new Set<string>()

  for (const rel of files) {
    let content: string
    try {
      content = await fs.readFile(path.join(vaultRoot, rel), "utf8")
    } catch {
      continue // un file sparito fra l'elenco e la lettura non ferma il grafo
    }
    const id = chiaviDi(rel)[0]
    const outgoing: string[] = []
    for (const target of parseWikilinks(content)) {
      const dest = perChiave.get(target)
      if (dest) {
        const destId = chiaviDi(dest)[0]
        if (destId === id) continue // l'autocitazione non è un arco
        outgoing.push(destId)
        edges.push({ source: id, target: destId })
        citati.add(destId)
      } else {
        brokenLinks.push({ from: id, target })
      }
    }
    nodes.push({ id, path: rel, outgoing })
  }

  const orphans = nodes.filter((n) => !citati.has(n.id)).map((n) => n.id)
  return { nodes, edges, brokenLinks, orphans }
}

/** Un identificatore che sopravvive alla rinomina del file (D2). */
export function nuovoId(): string {
  return `c-${randomBytes(3).toString("hex")}`
}

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** `Metamedicina Applicata` → `metamedicina-applicata`. */
export function kebab(nome: string): string {
  return nome
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

export interface CreatePageResult {
  path: string
  id: string
  created: boolean
  reason?: string
}

/**
 * Crea la pagina che un `[[collegamento]]` cerca e non trova.
 *
 * ⛔ **Solo aggiunta, mai sovrascrittura** (D5). Se la pagina esiste, torna
 * `created: false` col motivo e **non tocca il file**. Sul vault della cliente
 * fondere o riscrivere è una decisione che prende lei, non il sistema: nessun
 * file cancellato, nessuna nota riscritta, reversibile al 100%.
 *
 * Il frontmatter nasce già con i campi che servono più avanti:
 *   `id:`         identità che sopravvive alla rinomina (D2)
 *   `aliases:`    i nomi alternativi, così fondere non rompe i link (D2)
 *   `visibility:` l'etichetta su cui la ricerca pre-filtra (D4)
 * Costano una riga adesso; aggiungerli dopo significherebbe riscrivere
 * l'identità di ogni pagina già scritta.
 */
export async function createMissingPage(
  vaultRoot: string,
  opts: {
    title: string
    folder?: string
    summary?: string
    body?: string
    aliases?: string[]
    related?: string[]
    visibility?: string
    readonlyPrefixes?: string[]
    today?: string
  },
): Promise<CreatePageResult> {
  const titolo = opts.title.trim()
  if (!titolo) throw new VaultError("title is required")

  const slug = kebab(titolo)
  if (!slug || !KEBAB.test(slug)) {
    throw new VaultError(`"${opts.title}" non produce un nome di file valido (kebab-case)`)
  }

  const cartella = (opts.folder ?? "concepts").replace(/^\/+|\/+$/g, "")
  const rel = `${cartella}/${slug}.md`
  const id = nuovoId()

  // Il bersaglio potrebbe già esistere altrove nel vault, non solo in questa
  // cartella: `schema.md` vieta due file con lo stesso nome, quindi un nome
  // già preso è un conflitto ovunque si trovi.
  const esistenti = await listNotes(vaultRoot, ".").catch(() => [] as string[])
  const collisione = esistenti.find((p) => (p.split("/").pop() ?? p) === `${slug}.md`)
  if (collisione) {
    return { path: collisione, id, created: false, reason: `esiste già: ${collisione}` }
  }

  const data = opts.today ?? new Date().toISOString().slice(0, 10)
  const tags = [cartella.split("/")[0]]
  const related = (opts.related ?? []).map((r) => `[[${r}]]`).join(",")

  const frontmatter = [
    "---",
    `id: ${id}`,
    `title: ${titolo}`,
    `summary: ${opts.summary ?? `Voce creata da un collegamento a [[${slug}]] che non aveva bersaglio.`}`,
    `tags: [${tags.join(", ")}]`,
    `aliases: [${(opts.aliases ?? []).join(", ")}]`,
    "status: draft",
    `visibility: ${opts.visibility ?? "all"}`,
    `created: ${data}`,
    `updated: ${data}`,
    `related: ${related}`,
    "---",
  ].join("\n")

  const corpo = opts.body?.trim()
    ? opts.body.trim()
    : `# ${titolo}\n\n> [!info] Pagina creata da un collegamento senza bersaglio.\n> Il contenuto non è stato ancora scritto: serve a non far sparire l'arco del grafo.`

  await writeNote(vaultRoot, rel, `${frontmatter}\n\n${corpo}\n`, opts.readonlyPrefixes ?? [])
  return { path: rel, id, created: true }
}

/** Compatta il grafo in un testo leggibile da un modello, percorsi inclusi. */
export function formatGraph(g: VaultGraph, limit = 200): string {
  const righe: string[] = [
    `${g.nodes.length} pagine · ${g.edges.length} collegamenti · ${g.brokenLinks.length} rotti · ${g.orphans.length} orfane`,
    "",
    "## pagine (id → percorso → uscenti)",
  ]
  for (const n of g.nodes.slice(0, limit)) {
    righe.push(`${n.id} → ${n.path} → ${n.outgoing.join(", ") || "(nessuno)"}`)
  }
  if (g.nodes.length > limit) righe.push(`… altre ${g.nodes.length - limit} pagine`)
  if (g.brokenLinks.length) {
    righe.push("", "## collegamenti senza bersaglio (candidati a vault_create_missing_page)")
    for (const b of g.brokenLinks.slice(0, limit)) righe.push(`${b.from} → [[${b.target}]]`)
    if (g.brokenLinks.length > limit) righe.push(`… altri ${g.brokenLinks.length - limit}`)
  }
  if (g.orphans.length) {
    righe.push("", "## orfane (nessuno le cita)")
    righe.push(g.orphans.slice(0, limit).join(", "))
  }
  return righe.join("\n")
}
