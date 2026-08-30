/**
 * Mette le pagine appena scritte nell'indice semantico **nativo** (LanceDB su
 * file), al posto di `indexPagesInR2R`.
 *
 * Perché si cambia motore, coi numeri misurati sullo stesso corpus (44.561
 * vettori, 200 domande, top-5):
 *
 *     R2R + Postgres   p50 1.706,7 ms   p95 2.111,9 ms   488 MB · 1 container · porta 7272
 *     LanceDB tarato   p50     4,3 ms   p95     7,4 ms   recall@5 99,7% · nessun processo
 *
 * La porta non è un dettaglio: `r2r-serve` ignora il proprio `--host` e la
 * falla #2295 restituisce l'utente amministratore a ogni richiesta non
 * autenticata. Un file su disco non ha porte da presidiare.
 *
 * ⚠️ **Convenzione del `page_id`, e non è la stessa dell'app desktop.**
 * `ingest.ts` e `embedAllPages` usano il **basename**; qui si usa il
 * **percorso relativo a `wiki/`**, che è ciò che scrive `embed-backfill.ts`.
 * Misurato sul vault della cliente: **104 file su 10.942 condividono il
 * basename**, e con la chiave corta le loro righe si sovrascrivono a vicenda —
 * la ricerca ne perde una a testa senza dare errore. `pageIndex` in
 * `vault-api.ts` accetta entrambe le chiavi, così un indice misto risolve lo
 * stesso.
 */
import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { embedPage, isDerivedPage } from "@/lib/embedding"

import {
  estraiPagina,
  grafoCausaleAcceso,
  grafoEntitaAcceso,
  scriviRiga,
  type ChiamaModello,
} from "./entity-extract"
import { splitFrontmatter } from "./note-policy"
import { vectorCompact } from "./vector-store"

/** `wiki/sources/foo.md` → `sources/foo`. Restituisce null fuori da `wiki/`. */
export function pageIdFor(relPath: string): string | null {
  const parts = relPath.split(/[\\/]/).filter(Boolean)
  if (parts.length < 2 || parts[0] !== "wiki") return null
  if (!parts[parts.length - 1].endsWith(".md")) return null
  return parts.slice(1).join("/").replace(/\.md$/i, "")
}

/** Titolo dal frontmatter, dal primo `# `, altrimenti l'ultimo pezzo dell'id. */
export function titleFor(content: string, pageId: string): string {
  const fm = /^---\n([\s\S]*?)\n---/.exec(content)
  const fromFm = fm && /^title:\s*["']?(.+?)["']?\s*$/m.exec(fm[1])
  if (fromFm?.[1]?.trim()) return fromFm[1].trim()
  const h1 = /^#\s+(.+)$/m.exec(content)
  if (h1?.[1]?.trim()) return h1[1].trim()
  return pageId.split("/").pop() ?? pageId
}

interface EmbeddingConfigish {
  enabled?: boolean
  endpoint?: string
  model?: string
  [k: string]: unknown
}

/** `embeddingConfig` da app-state.json, solo se davvero utilizzabile. */
export async function embeddingConfigFor(vault: string): Promise<EmbeddingConfigish | null> {
  try {
    const raw = await readFile(join(vault, ".llm-wiki", "app-state.json"), "utf8")
    const cfg = JSON.parse(raw).embeddingConfig
    return cfg && cfg.enabled && cfg.endpoint && cfg.model ? cfg : null
  } catch {
    return null
  }
}

/** Il modello scelto al banco. Il ripiego è più veloce ma **moltiplica i
 *  quasi-doppioni** (`il creare` accanto a `creare`), quindi va deduplicato a
 *  valle e costa 5,6 volte tanto: si usa solo se il primo non risponde. */
const MODELLO_ENTITA = "inclusionai/ling-3.0-flash"
const MODELLO_RIPIEGO = "google/gemini-2.5-flash-lite"

/** Legge l'`_index.md` di una cartella. `null` se non c'è. */
function lettoreIndici(vault: string) {
  return async (folder: string): Promise<string | null> => {
    const rel = folder === "." ? ["wiki", "_index.md"] : ["wiki", ...folder.split("/"), "_index.md"]
    try {
      return await readFile(join(vault, ...rel), "utf8")
    } catch {
      return null
    }
  }
}

/** Costruisce il chiamante del modello dalla configurazione già nel vault. */
async function chiamanteModello(vault: string): Promise<ChiamaModello | null> {
  let cfg: any
  try {
    const raw = await readFile(join(vault, ".llm-wiki", "app-state.json"), "utf8")
    cfg = JSON.parse(raw).llmConfig
  } catch {
    return null
  }
  const base = String(cfg?.customEndpoint ?? "").replace(/\/$/, "")
  const key = cfg?.apiKey
  if (!base || !key) return null

  return async (prompt: string): Promise<string> => {
    for (const model of [MODELLO_ENTITA, MODELLO_RIPIEGO]) {
      try {
        const res = await fetch(`${base}/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
          body: JSON.stringify({
            model,
            messages: [{ role: "user", content: prompt }],
            temperature: 0,
            // ⛔ Su questo endpoint il ragionamento va spento con `enabled`,
            // non con `effort:"none"`: l'effort è per-modello e questi non
            // dichiarano di accettare "none". Misurato altrove: 6,3 s → 15,0 s
            // per chiamata, in silenzio.
            reasoning: { enabled: false },
          }),
        })
        if (!res.ok) continue
        const d: any = await res.json()
        const testo = d?.choices?.[0]?.message?.content
        if (typeof testo === "string" && testo.trim()) return testo
      } catch {
        /* passa al ripiego */
      }
    }
    return ""
  }
}

/**
 * D0 + D3 — il grafo delle entità, all'ingest e **solo dove è acceso**.
 *
 * Non è una scelta di prudenza: l'estrazione costa 15 ore sul vault della
 * cliente e 593 sul Dropbox intero. Acceso per cartella con `entity_graph: true`
 * nell'`_index.md`; le relazioni tipizzate vogliono in più `causal_graph: true`,
 * perché il grafo su tutto costa 10-30 volte l'indicizzazione e sulle domande
 * normali **perde** contro la ricerca vettoriale (recall@5 32,5% contro 67%).
 *
 * Senza flag non parte, non spende e non scrive niente.
 */
async function estraiEntitaSeAcceso(
  vault: string,
  pageId: string,
  contenuto: string,
  chiama: ChiamaModello | null,
): Promise<void> {
  if (!chiama) return
  const leggi = lettoreIndici(vault)
  const fm = splitFrontmatter(contenuto).fm
  if (!(await grafoEntitaAcceso(pageId, leggi, fm))) return
  const causale = await grafoCausaleAcceso(pageId, leggi, fm)
  try {
    const riga = await estraiPagina(pageId, contenuto, chiama, causale)
    if (riga.entita.length) await scriviRiga(vault, riga)
  } catch (err) {
    // non si inghiotte in silenzio: il grafo è un di più, l'indice no
    console.warn(`[grafo] ${pageId}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * Indicizza le pagine passate. Restituisce quante ne sono entrate.
 *
 * Non lancia mai: la pagina è comunque sul disco, e una reindicizzazione la
 * ripesca. Ma non tace nemmeno — ogni fallimento finisce sul registro col
 * motivo, perché un `catch` vuoto ci ha già nascosto per giorni che ogni PDF
 * finiva al parser a pagamento.
 */
export async function indexPagesNative(vault: string, relPaths: string[]): Promise<number> {
  if (relPaths.length === 0) return 0
  const cfg = await embeddingConfigFor(vault)
  if (!cfg) return 0

  const chiama = await chiamanteModello(vault)
  let indexed = 0
  for (const rel of relPaths) {
    const pageId = pageIdFor(rel)
    if (!pageId) continue
    // Indice, registro, panoramica, scopo e schema sono derivati: rientrano
    // nella ricerca come rumore, e `log.md` a 988 KB aveva tenuto la coda per
    // due ore da solo.
    if (isDerivedPage(pageId)) continue
    try {
      const content = await readFile(join(vault, ...rel.split(/[\\/]/)), "utf8")
      if (!content.trim()) continue
      // deferOptimization: la compattazione costa quanto l'intera tabella,
      // quindi si fa una volta a fine lotto e non a ogni pagina.
      const ok = await embedPage(vault, pageId, titleFor(content, pageId), content, cfg as never, {
        deferOptimization: true,
      })
      if (ok) {
        indexed++
        // D0: il grafo si estrae qui, una volta sola, mentre il documento è già
        // in mano. Alla domanda resterà solo da leggerlo.
        await estraiEntitaSeAcceso(vault, pageId, content, chiama)
      }
    } catch (err) {
      console.warn(`[index] ${rel}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  if (indexed > 0) {
    // Senza `cleanupOlderThan` la compattazione non tocca lo storico delle
    // versioni, ed è lì che sta il peso: misurato 3,3 GB su 12.402 manifest
    // contro 84 MB di dati. Con la pulizia: 3,31 GB → 0,03 GB.
    try {
      await vectorCompact(vault)
    } catch (err) {
      console.warn(`[index] compattazione: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return indexed
}
