/**
 * Semantic search backed by R2R instead of the built-in LanceDB store.
 *
 * Same contract as `semanticSearch` in vault-api.ts — `{path, title, snippet,
 * score, vectorScore}` — so the UI, the MCP server and the clipper see no
 * difference. Which backend answers is decided by `r2rConfig` in app-state.json:
 *
 *   "r2rConfig": { "enabled": true, "baseUrl": "http://127.0.0.1:7272" }
 *
 * Ingest writes the vault-relative path into each document's metadata, so a hit
 * maps straight back to a file. Documents ingested without it (anything indexed
 * outside this app) fall back to resolving the title against the page index.
 */
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { createHash } from "node:crypto"

export interface R2RConfig {
  enabled: boolean
  baseUrl: string
  timeoutMs?: number
}

/** R2RConfig from app-state.json, only when it's actually usable. */
export async function r2rConfigFor(vault: string): Promise<R2RConfig | null> {
  try {
    const raw = await readFile(join(vault, ".llm-wiki", "app-state.json"), "utf8")
    const state = JSON.parse(raw)
    // The settings panel writes it under embeddingConfig (it is the semantic
    // search backend); a top-level r2rConfig is honoured too, for hand-editing
    // on a box with no GUI.
    const cfg = state.embeddingConfig?.r2r ?? state.r2rConfig
    return cfg && cfg.enabled && cfg.baseUrl ? cfg : null
  } catch {
    return null
  }
}

/** True when the service answers — used by the settings panel to show status. */
export async function r2rHealth(cfg: R2RConfig): Promise<{ ok: boolean; documents?: number; error?: string }> {
  try {
    const base = cfg.baseUrl.replace(/\/$/, "")
    const health = await fetch(`${base}/v3/health`, { signal: AbortSignal.timeout(4000) })
    if (!health.ok) return { ok: false, error: `health ${health.status}` }
    let documents: number | undefined
    try {
      const r = await fetch(`${base}/v3/documents?limit=1`, { signal: AbortSignal.timeout(4000) })
      const j: any = await r.json()
      documents = j?.total_entries ?? j?.results?.length
    } catch {
      /* count is a nicety, not a requirement */
    }
    return { ok: true, documents }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

/**
 * A document id that is a pure function of the vault path, so re-ingesting a
 * page replaces its entry instead of adding a second copy of it.
 */
function documentId(relPath: string): string {
  const h = createHash("md5").update(relPath).digest("hex")
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

/**
 * The engine refuses any multipart part over 1024 KB — `{"detail":"Part
 * exceeded maximum size of 1024KB."}` — and that is a hard limit of its upload
 * layer, not something a longer timeout fixes.
 *
 * It bit exactly where it hurts most: a single book yielded 1.086.368
 * characters of text, the page was written to disk, the queue marked it DONE,
 * and it never entered the index. Present in the vault, invisible to search.
 *
 * So: split rather than truncate. Each part is its own record carrying the same
 * `path` in metadata, so a hit still points back to one page. Measured in
 * BYTES, because the limit is on bytes and Italian text is full of two-byte
 * characters — counting characters would sail straight past it.
 */
/**
 * 400 KB, non 900. Due vincoli distinti, e solo il primo è del protocollo:
 *  - il motore rifiuta oltre 1024 KB per parte (errore netto, immediato)
 *  - su due core, una parte da 900 KB non finisce di indicizzarsi in cinque
 *    minuti; una da 216 KB risponde `202` subito. Misurato sul box del cliente.
 * Parti più piccole costano qualche record in più per libro e comprano
 * robustezza: se una fallisce, si perde un pezzo, non il volume.
 */
export const PART_LIMIT_BYTES = 400_000

export function splitForUpload(content: string): string[] {
  if (Buffer.byteLength(content, "utf8") <= PART_LIMIT_BYTES) return [content]
  const parts: string[] = []
  let buf = ""
  const flush = () => {
    if (buf) parts.push(buf)
    buf = ""
  }
  // Taglio sui confini di riga: un pezzo che spezza una parola a metà
  // produce un frammento che non corrisponderà a nessuna ricerca.
  for (const line of content.split("\n")) {
    if (Buffer.byteLength(line, "utf8") > PART_LIMIT_BYTES) {
      // Una riga più grande del limite intero: succede davvero, perché
      // `pdftotext` su certi PDF restituisce pagine senza un solo a capo.
      // Qui il confine di riga non esiste e si taglia a byte.
      flush()
      const bytes = Buffer.from(line, "utf8")
      for (let o = 0; o < bytes.length; o += PART_LIMIT_BYTES) {
        // `toString` su un taglio a metà di un carattere multibyte
        // produce il segno di sostituzione: accettabile su un confine
        // ogni 900 KB, e comunque meglio di un documento non indicizzato.
        parts.push(bytes.subarray(o, o + PART_LIMIT_BYTES).toString("utf8"))
      }
      continue
    }
    if (buf && Buffer.byteLength(buf, "utf8") + Buffer.byteLength(line, "utf8") + 1 > PART_LIMIT_BYTES) {
      flush()
    }
    buf = buf ? `${buf}\n${line}` : line
  }
  flush()
  return parts
}

function titleOf(content: string, relPath: string): string {
  const fm = /^---\s*\n([\s\S]*?)\n---/.exec(content)
  const t = fm && /^title:\s*["']?(.+?)["']?\s*$/m.exec(fm[1])
  if (t?.[1]?.trim()) return t[1].trim()
  const h = /^#\s+(.+)$/m.exec(content)
  if (h?.[1]?.trim()) return h[1].trim()
  return relPath.split("/").pop()!.replace(/\.md$/, "")
}

/**
 * Drop a record only when it is genuinely stuck.
 *
 * The client giving up does NOT mean the engine did: a 590 KB book keeps
 * chunking and embedding for many minutes after the request times out, and
 * deleting it then would throw away work that was about to succeed. So ask what
 * state it is actually in, and remove it only if that state is terminal — an
 * abandoned record is poison, because the id comes from the path and every
 * later attempt would be waved through as "already exists".
 */
async function discardIfStuck(base: string, relPath: string): Promise<void> {
  const id = documentId(relPath)
  try {
    const res = await fetch(`${base}/v3/documents/${id}`, { signal: AbortSignal.timeout(20_000) })
    if (res.ok) {
      const status = (await res.json())?.results?.ingestion_status
      if (["success", "embedding", "parsing", "pending", "enriching"].includes(status)) {
        console.warn(`[r2r] ${relPath}: ancora in lavorazione (${status}), lo lascio finire`)
        return
      }
    } else if (res.status === 404) {
      return // nothing was written; a later pass will do it
    }
    await fetch(`${base}/v3/documents/${id}`, { method: "DELETE", signal: AbortSignal.timeout(30_000) })
  } catch {
    /* best effort: a stale record is still better than a crashed ingest */
  }
}

/**
 * Add (or replace) pages in the semantic index. Fast mode: chunk and embed, no
 * model call. Failure is logged, never fatal — the page is on disk regardless,
 * and a reindex can pick it up later.
 */
export async function indexPagesInR2R(vault: string, relPaths: string[]): Promise<number> {
  const cfg = await r2rConfigFor(vault)
  if (!cfg || relPaths.length === 0) return 0
  const base = cfg.baseUrl.replace(/\/$/, "")
  let indexed = 0
  for (const rel of relPaths) {
    if (!rel.endsWith(".md")) continue
    try {
      const content = await readFile(join(vault, rel), "utf8")
      if (!content.trim()) continue
      const parts = splitForUpload(content)
      if (parts.length > 1) {
        console.warn(`[r2r] ${rel}: ${Buffer.byteLength(content, "utf8")} byte → ${parts.length} parti`)
      }
      const title = titleOf(content, rel)
      let allOk = true
      for (const [i, part] of parts.entries()) {
        // Una sola parte conserva l'id derivato dal percorso, così un
        // reingest sostituisce invece di duplicare; le successive lo
        // qualificano, altrimenti si sovrascriverebbero a vicenda.
        const key = i === 0 ? rel : `${rel}#${i}`
        const form = new FormData()
        form.append("raw_text", part)
        form.append(
          "metadata",
          JSON.stringify({
            path: rel,
            title: parts.length > 1 ? `${title} (${i + 1}/${parts.length})` : title,
            source: "vault",
          }),
        )
        form.append("ingestion_mode", "fast")
        form.append("id", documentId(key))
        // Chunking and embedding a book takes minutes, not seconds. A fixed
        // two-minute ceiling left a 590 KB volume as a document record with zero
        // chunks: present, counted, and unsearchable. Scale with the text.
        const budgetMs = Math.min(20 * 60_000, 90_000 + part.length * 0.6)
        const res = await fetch(`${base}/v3/documents`, {
          method: "POST",
          body: form,
          signal: AbortSignal.timeout(budgetMs),
        })
        if (res.ok || res.status === 409) continue
        allOk = false
        // Lo stato da solo non dice niente: il "400" che ha lasciato dodici
        // libri fuori dall'indice era `Part exceeded maximum size of 1024KB`,
        // e senza il corpo della risposta è rimasto un numero per giorni.
        const detail = await res.text().catch(() => "")
        console.warn(`[r2r] index ${key}: HTTP ${res.status} ${detail.slice(0, 200)}`)
        await discardIfStuck(base, key)
      }
      if (allOk) indexed++
    } catch (err) {
      console.warn(`[r2r] index ${rel}:`, (err as Error).message)
      // Leave nothing half-written: the id is derived from the path, so an
      // empty record would make every later attempt a no-op "already exists".
      await discardIfStuck(base, rel)
    }
  }
  return indexed
}

/**
 * Nearest-neighbour over R2R's chunks, collapsed to the best chunk per page.
 * `resolvePath` maps a page id (markdown basename) to a vault-relative path;
 * it's the same index keyword search uses.
 */
export async function r2rSearch(
  cfg: R2RConfig,
  query: string,
  topK: number,
  resolvePath: (pageId: string) => string | undefined,
): Promise<any[]> {
  if (!query.trim()) return []
  let chunks: any[]
  try {
    const res = await fetch(`${cfg.baseUrl.replace(/\/$/, "")}/v3/retrieval/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, search_settings: { limit: Math.max(topK * 3, 12) } }),
      signal: AbortSignal.timeout(cfg.timeoutMs ?? 20000),
    })
    if (!res.ok) throw new Error(`search ${res.status}`)
    const json: any = await res.json()
    chunks = json?.results?.chunk_search_results ?? []
  } catch (err) {
    console.warn("[r2r-search] query failed:", (err as Error).message)
    return []
  }

  const bestByPath = new Map<string, { score: number; text: string; title: string }>()
  for (const c of chunks) {
    const meta = c?.metadata ?? {}
    // path written at ingest; otherwise recover it from the title/basename
    const path: string | undefined =
      meta.path ?? resolvePath(String(meta.page_id ?? meta.title ?? "").replace(/\.md$/, ""))
    if (!path) continue
    const prev = bestByPath.get(path)
    if (!prev || c.score > prev.score) {
      bestByPath.set(path, { score: c.score, text: String(c.text ?? ""), title: String(meta.title ?? "") })
    }
  }

  const out: any[] = []
  for (const [path, hit] of [...bestByPath.entries()].sort((a, b) => b[1].score - a[1].score)) {
    out.push({
      path,
      title: hit.title || path.split("/").pop()!.replace(/\.md$/, ""),
      snippet: hit.text.slice(0, 200).replace(/\s+/g, " ").trim(),
      score: hit.score,
      titleMatch: false,
      images: [],
      vectorScore: hit.score,
    })
    if (out.length >= topK) break
  }
  return out
}
