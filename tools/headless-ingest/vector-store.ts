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
}

export interface ChunkSearchResult {
  chunk_id: string
  page_id: string
  chunk_index: number
  chunk_text: string
  heading_path: string
  score: number
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
): Promise<ChunkSearchResult[]> {
  const tbl = await openTable(vault)
  if (!tbl) return []
  const res = (await tbl.search(queryEmbedding).limit(Math.max(1, topK)).toArray()) as Array<
    Record<string, unknown>
  >
  return res.map((r) => ({
    chunk_id: String(r.chunk_id),
    page_id: String(r.page_id),
    chunk_index: Number(r.chunk_index),
    chunk_text: String(r.chunk_text ?? ""),
    heading_path: String(r.heading_path ?? ""),
    score: 1 / (1 + Number(r._distance ?? 0)),
  }))
}

export function vectorDeletePage(vault: string, pageId: string): Promise<void> {
  return serialize(vault, async () => {
    const tbl = await openTable(vault)
    if (tbl) await tbl.delete(`page_id = ${sqlStr(pageId)}`)
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
