/**
 * Headless vector store — the Bun/Node replacement for the Tauri Rust
 * `vector_*` commands (src-tauri/src/commands/vectorstore.rs). Uses the same
 * on-disk LanceDB directory (`<vault>/.llm-wiki/lancedb`) and the same v2
 * chunk table (`wiki_chunks_v2`), so the semantic index the ingest engine
 * writes is the exact one the MCP read path (vault-api) queries.
 *
 * LanceDB's Node addon runs fine under Bun (verified). Writes are serialized
 * per-vault because LanceDB append/delete on one dataset is not concurrency
 * safe; the ingest runner uses concurrency 1 anyway, so this is just a guard.
 */
import * as lancedb from "@lancedb/lancedb"
import { join } from "node:path"

const TABLE = "wiki_chunks_v2"
const connections = new Map<string, Promise<lancedb.Connection>>()
const writeChains = new Map<string, Promise<unknown>>()

function dbDir(vault: string): string {
  return join(vault, ".llm-wiki", "lancedb")
}

function connect(vault: string): Promise<lancedb.Connection> {
  const dir = dbDir(vault)
  let c = connections.get(dir)
  if (!c) {
    c = lancedb.connect(dir)
    connections.set(dir, c)
  }
  return c
}

async function openTable(vault: string): Promise<lancedb.Table | null> {
  const db = await connect(vault)
  try {
    return await db.openTable(TABLE)
  } catch {
    return null // table not created yet
  }
}

/** SQL string literal with single-quote escaping (LanceDB filter predicates). */
function sqlStr(s: string): string {
  return `'${String(s).replace(/'/g, "''")}'`
}

/** Serialize all writes to one vault's dataset (append/delete are not safe to
 *  interleave). Failures don't break the chain for the next write. */
function serialize<T>(vault: string, fn: () => Promise<T>): Promise<T> {
  const dir = dbDir(vault)
  const prev = writeChains.get(dir) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  writeChains.set(dir, next.then(() => undefined, () => undefined))
  return next
}

export interface IncomingChunk {
  chunk_index: number
  chunk_text: string
  heading_path: string
  embedding: number[]
  /** D4 — etichetta di visibilità. Assente = `VISIBILITY_DEFAULT`. */
  visibility?: string
}

export interface ChunkSearchResult {
  chunk_id: string
  page_id: string
  chunk_index: number
  chunk_text: string
  heading_path: string
  score: number
  visibility: string
}

/** D4 — l'etichetta con cui la ricerca pre-filtra. "all" finché un cliente non chiede altro. */
export const VISIBILITY_DEFAULT = "all"

/**
 * Aggiunge la colonna `visibility` a una tabella che non ce l'ha ancora.
 *
 * Va chiamata una volta sull'indice esistente: `addColumns` con un'espressione
 * costante non ricalcola nulla e non tocca i vettori — le 248.083 righe già
 * indicizzate restano dove sono. Idempotente: se la colonna c'è, non fa niente.
 */
export async function ensureVisibilityColumn(vault: string): Promise<"aggiunta" | "c'era già" | "nessuna tabella"> {
  const tbl = await openTable(vault)
  if (!tbl) return "nessuna tabella"
  const schema = await tbl.schema()
  if (schema.fields.some((f) => f.name === "visibility")) return "c'era già"
  return serialize(vault, async () => {
    await tbl.addColumns([{ name: "visibility", valueSql: `'${VISIBILITY_DEFAULT}'` }])
    return "aggiunta" as const
  })
}

/** `["all","interna"]` → `visibility IN ('all','interna')`, con le virgolette messe a posto. */
function visibilityClause(visibility: string[]): string {
  return `visibility IN (${visibility.map(sqlStr).join(", ")})`
}

/**
 * Clean-slate upsert for one page: delete its existing chunks, then insert the
 * new ones. An empty `chunks` array is a no-op (never clears the page) — mirrors
 * the Rust contract so a transient embedding failure can't wipe the index.
 */
export function vectorUpsertChunks(
  vault: string,
  pageId: string,
  chunks: IncomingChunk[],
): Promise<void> {
  if (!chunks.length) return Promise.resolve()
  return serialize(vault, async () => {
    const db = await connect(vault)
    const rows = chunks.map((c) => ({
      chunk_id: `${pageId}#${c.chunk_index}`,
      page_id: pageId,
      chunk_index: c.chunk_index,
      chunk_text: c.chunk_text,
      heading_path: c.heading_path ?? "",
      // D4: ogni pezzo nasce con la sua etichetta. Costa una colonna adesso;
      // aggiungerla dopo significherebbe riscrivere il motore di ricerca più la
      // colla fra indice e permessi — ~1.800 righe nei casi reali.
      visibility: c.visibility ?? VISIBILITY_DEFAULT,
      vector: c.embedding.map((v) => Math.fround(v)),
    }))
    let tbl: lancedb.Table | null
    try {
      tbl = await db.openTable(TABLE)
    } catch {
      tbl = null
    }
    if (!tbl) {
      await db.createTable(TABLE, rows)
      return
    }
    await tbl.delete(`page_id = ${sqlStr(pageId)}`)
    await tbl.add(rows)
  })
}

/** Brute-force (flat) nearest-neighbour search. Distance → score = 1/(1+dist),
 *  matching the Rust scoring so the MCP results rank the same way. */
export async function vectorSearchChunks(
  vault: string,
  queryEmbedding: number[],
  topK: number,
  opts?: { visibility?: string[] },
): Promise<ChunkSearchResult[]> {
  const tbl = await openTable(vault)
  if (!tbl) return []
  let q = tbl.search(queryEmbedding).limit(Math.max(1, topK))
  if (opts?.visibility?.length) {
    // D4 — **pre**-filtro, non post: in questa versione `where()` sulla query
    // vettoriale filtra PRIMA della ricerca, ed è il comportamento voluto.
    // Filtrare dopo è il difetto documentato dei prototipi: perde risultati e
    // il recall crolla proprio sulle domande selettive, cioè quelle in cui i
    // permessi contano. La colonna esiste anche quando nessuno la usa: così
    // questo ramo è una clausola, non una riscrittura del motore.
    q = q.where(visibilityClause(opts.visibility))
  }
  const res = (await q.toArray()) as Array<Record<string, unknown>>
  return res.map((r) => ({
    chunk_id: String(r.chunk_id),
    page_id: String(r.page_id),
    chunk_index: Number(r.chunk_index),
    chunk_text: String(r.chunk_text ?? ""),
    heading_path: String(r.heading_path ?? ""),
    score: 1 / (1 + Number(r._distance ?? 0)),
    visibility: String(r.visibility ?? VISIBILITY_DEFAULT),
  }))
}

export function vectorDeletePage(vault: string, pageId: string): Promise<void> {
  return serialize(vault, async () => {
    const tbl = await openTable(vault)
    if (tbl) await tbl.delete(`page_id = ${sqlStr(pageId)}`)
  })
}

/**
 * Merge the fragments a long write run leaves behind.
 *
 * Every `vectorUpsertChunks` is a delete followed by an add, and each add lands
 * in its own fragment. The delete has to look through all of them, so the cost
 * of writing page N grows with N: measured on a real backfill, 87 pages/minute
 * at the start and **2 pages/minute** after six thousand, with the embedding
 * time flat at ~1s throughout. The remaining work went from two hours to forty.
 *
 * LanceDB's own guidance is to optimize often when writes are frequent. The
 * desktop path does; this one used to return without doing anything, which is
 * why the problem only ever appeared headless.
 *
 * Not called per page on purpose: compaction rewrites data, so doing it every
 * time would trade one quadratic cost for another.
 */
export async function vectorCompact(
  vault: string,
): Promise<{ fileRimossi: number; indice: EsitoIndice | "fallito" } | null> {
  const tbl = await openTable(vault)
  if (!tbl) return null
  const esito = await serialize(vault, async () => {
    // `cleanupOlderThan` è la parte che conta, e senza di essa la chiamata non
    // fa nulla: il peso non sta nei dati ma nello **storico delle versioni**.
    // Misurato su un riempimento reale a metà strada — 6.200 pagine, 17.737
    // righe:
    //
    //     _versions      3,3 GB   12.402 manifest    ← il peso è tutto qui
    //     data            84 MB    6.201 file        ← i dati veri
    //
    // Ogni pagina costa due transazioni (cancella, poi inserisci) e ogni
    // manifest elenca tutti i frammenti esistenti: il manifest N pesa quanto N,
    // quindi conservarli tutti costa N². `optimize()` da solo non li tocca
    // perché di default risparmia i file più recenti di sette giorni, e i
    // nostri hanno minuti. Con la pulizia: **3,31 GB → 0,03 GB, 31.004 file → 4**.
    const stats = await tbl.optimize({ cleanupOlderThan: new Date(), deleteUnverified: true })
    return { fileRimossi: stats?.prune?.oldVersionsRemoved ?? 0 }
  })
  // Dopo la compattazione, non prima: `createIndex` lavora sui frammenti, e
  // farlo su quelli non ancora uniti significa costruire l'indice due volte.
  // Fuori da `serialize` perché `ensureVectorIndex` prende il suo turno da sé.
  const indice = await ensureVectorIndex(vault).catch((err) => {
    // Un indice mancante rende la ricerca lenta, non rotta: non è una ragione
    // per far fallire la passata che ha appena scritto i dati.
    console.warn(`[lancedb] indice non creato: ${err instanceof Error ? err.message : err}`)
    return "fallito" as const
  })
  return { ...esito, indice }
}

/**
 * Oltre questa soglia la scansione esatta smette di convenire.
 *
 * Misurato sul corpus della cliente: 248.083 pezzi, ricerca esatta **94,9 ms**,
 * quindi il costo è lineare a circa 0,4 ms ogni mille righe. A cinquantamila la
 * scansione sta sotto i 20 ms — ancora impercettibile, e senza indice da
 * costruire né da mantenere. Sopra, la differenza diventa quella misurata nel
 * bake-off: **94,9 ms → 4,3 ms, con recall@5 al 99,7%**.
 *
 * La soglia non può essere bassa: l'IVF addestra i suoi centroidi campionando
 * (`sample_rate` 256), quindi su poche righe produce un indice peggiore della
 * scansione che sostituisce.
 */
export const SOGLIA_INDICE_ANN_DEFAULT = 50_000

/** Letta a ogni chiamata, non al caricamento: così `LANCEDB_ANN_MIN_ROWS` vale
 *  anche per un processo già avviato, e i test non devono ricaricare il modulo. */
export function sogliaIndiceAnn(): number {
  const v = Number(process.env.LANCEDB_ANN_MIN_ROWS)
  return Number.isFinite(v) && v >= 0 ? v : SOGLIA_INDICE_ANN_DEFAULT
}

const NOME_INDICE_VETTORE = "vector_idx"

/**
 * Crea l'indice approssimato quando la tabella è abbastanza grande, una volta sola.
 *
 * ⚠️ Questo pezzo mancava, ed è la ragione per cui il numero migliore del
 * progetto non arrivava a nessuno: l'`IVF_HNSW_SQ` in produzione l'ha creato
 * **uno script Python del bake-off, a mano**. Né questo file né il gemello Rust
 * hanno mai chiamato `createIndex`, quindi chiunque scarichi l'applicazione fa
 * sempre scansione esatta.
 *
 * Si crea una volta e basta: da lì in poi `optimize()` — che `vectorCompact`
 * chiama a ogni fine passata — aggiunge da sé le righe nuove all'indice
 * esistente. Verificato sull'indice della cliente: `numUnindexedRows: 0` dopo
 * ore di scritture.
 *
 * `cosine` non è una preferenza: è la metrica con cui l'indice in produzione è
 * stato tarato e misurato. Cambiarla invaliderebbe il recall del bake-off.
 */
export type EsitoIndice = "creato" | "c'era già" | "troppo piccola" | "nessuna tabella"

export async function ensureVectorIndex(vault: string): Promise<EsitoIndice> {
  const tbl = await openTable(vault)
  if (!tbl) return "nessuna tabella"

  const indici = await tbl.listIndices()
  if (indici.some((i) => i.columns.includes("vector"))) return "c'era già"

  const righe = await tbl.countRows()
  if (righe < sogliaIndiceAnn()) return "troppo piccola"

  return serialize(vault, async () => {
    const t0 = Date.now()
    // La costruzione è cara e monopolizza i core: va detto, perché su un box
    // piccolo l'utente vede la macchina occuparsi e deve sapere di cosa.
    console.error(`[lancedb] costruisco l'indice su ${righe} righe — una volta sola, può volerci qualche minuto`)
    await tbl.createIndex("vector", {
      config: lancedb.Index.hnswSq({ distanceType: "cosine" }),
    })
    console.error(`[lancedb] indice pronto in ${((Date.now() - t0) / 1000).toFixed(0)}s`)
    return "creato" as const
  })
}

export async function vectorCountChunks(vault: string): Promise<number> {
  const tbl = await openTable(vault)
  return tbl ? tbl.countRows() : 0
}

export function vectorClearChunks(vault: string): Promise<void> {
  return serialize(vault, async () => {
    const db = await connect(vault)
    try {
      await db.dropTable(TABLE)
    } catch {
      /* no table */
    }
  })
}

/**
 * Embed texts through an OpenAI-compatible `/v1/embeddings` endpoint (OpenAI,
 * Gemini openai-compat, Voyage, Jina, local servers…). `cfg` is the app's
 * EmbeddingConfig (endpoint, model, apiKey, outputDimensionality, extraHeaders).
 */
export async function embedTexts(texts: string[], cfg: Record<string, any>): Promise<number[][]> {
  if (!texts.length) return []
  if (!cfg?.endpoint) throw new Error("embedding: no endpoint configured")
  const body: Record<string, unknown> = { model: cfg.model, input: texts }
  if (cfg.outputDimensionality) body.dimensions = cfg.outputDimensionality
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(cfg.extraHeaders ?? {}),
  }
  if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`
  const res = await fetch(cfg.endpoint, { method: "POST", headers, body: JSON.stringify(body) })
  if (!res.ok) {
    throw new Error(`embedding HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
  }
  const json = (await res.json()) as { data?: Array<{ embedding: number[] }> }
  if (!json.data || json.data.length !== texts.length) {
    throw new Error(`embedding: expected ${texts.length} vectors, got ${json.data?.length ?? 0}`)
  }
  return json.data.map((d) => d.embedding)
}
