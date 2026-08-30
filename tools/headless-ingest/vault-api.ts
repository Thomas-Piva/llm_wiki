/**
 * App-independent implementation of the desktop app's local API (`/api/v1/*`)
 * that `llm-wiki-mcp-http`'s api-client.ts talks to. Serving this from disk
 * lets the MCP server's `llm_wiki_*` tools work with the WebKit GUI OFF — the
 * MCP code is unchanged; only its LLM_WIKI_API_BASE_URL is repointed here.
 *
 * Everything is read from the markdown on disk:
 *   search  → ripgrep         graph → parsed [[wikilinks]]
 *   files   → directory walk   read  → fs
 *   rescan  → headless enqueue (the ingest timer drains it)
 *   chat    → retrieve-only (the MCP client synthesizes; no server-side LLM)
 *   reviews → .llm-wiki/review.json if present, else empty
 */
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { readFile, writeFile, readdir, stat } from "node:fs/promises"
import { resolve, join, relative, sep, basename } from "node:path"
import { enqueueSources } from "./sources-scan"
import { embedTexts, vectorSearchChunks } from "./vector-store"
import { r2rConfigFor, r2rSearch, r2rHealth } from "./r2r-search"
import { runStructuralLintOnDisk } from "./lint-runner"

const execFileAsync = promisify(execFile)

export interface ApiCtx {
  vault: string
  projectName: string
}

export interface ApiReply {
  status: number
  body: unknown
}

// ── helpers ────────────────────────────────────────────────────────────────

export function titleFrom(content: string, path: string): string {
  const fm = /^---\n([\s\S]*?)\n---/.exec(content)
  if (fm) {
    const m = /^title:\s*["']?(.+?)["']?\s*$/m.exec(fm[1])
    if (m) return m[1].trim()
  }
  const h = /^#\s+(.+)$/m.exec(content)
  if (h) return h[1].trim()
  return basename(path).replace(/\.md$/, "")
}

function insideVault(vault: string, abs: string): boolean {
  return abs === vault || abs.startsWith(vault + sep)
}

async function walk(
  dir: string,
  vault: string,
  recursive: boolean,
  cap: { n: number; max: number },
): Promise<any[]> {
  let entries: Awaited<ReturnType<typeof readdir>>
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const out: any[] = []
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.name.startsWith(".")) continue
    if (cap.n >= cap.max) break
    const abs = join(dir, e.name)
    const node: any = { name: e.name, path: relative(vault, abs), isDir: e.isDirectory() }
    cap.n++
    if (e.isDirectory() && recursive) node.children = await walk(abs, vault, recursive, cap)
    out.push(node)
  }
  return out
}

/** ripgrep, literal + case-insensitive; rank files by match count. */
export async function rgSearch(vault: string, query: string, topK: number) {
  const wiki = join(vault, "wiki")
  if (!query.trim()) return []
  let countsOut = ""
  try {
    const { stdout } = await execFileAsync(
      "rg",
      ["-F", "-i", "-c", "--color", "never", query, wiki],
      { maxBuffer: 16 * 1024 * 1024 },
    )
    countsOut = stdout
  } catch (err: any) {
    if (err?.code === 1) return [] // no matches
    throw err
  }
  const ranked = countsOut
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const i = line.lastIndexOf(":")
      return { file: line.slice(0, i), count: Number(line.slice(i + 1)) || 0 }
    })
    .sort((a, b) => b.count - a.count)
    .slice(0, topK)

  const results = []
  for (const { file, count } of ranked) {
    let content = ""
    try {
      content = await readFile(file, "utf8")
    } catch {
      continue
    }
    const lower = content.toLowerCase()
    const idx = lower.indexOf(query.toLowerCase())
    const snippet = idx >= 0 ? content.slice(Math.max(0, idx - 60), idx + 140).replace(/\s+/g, " ").trim() : ""
    results.push({
      path: relative(vault, file),
      title: titleFrom(content, file),
      snippet,
      score: count,
      titleMatch: titleFrom(content, file).toLowerCase().includes(query.toLowerCase()),
      images: [],
      vectorScore: null, // keyword-only headless; semantic (LanceDB) is a later add
    })
  }
  return results
}

/** Build a wikilink graph from all wiki/*.md in one ripgrep pass. */
export async function buildGraph(vault: string, q?: string, nodeType?: string, limit = 500) {
  const wiki = join(vault, "wiki")
  let out = ""
  try {
    const { stdout } = await execFileAsync(
      "rg",
      ["-o", "--no-heading", "--color", "never", "-r", "$1", String.raw`\[\[([^\]#|]+)`, wiki],
      { maxBuffer: 32 * 1024 * 1024 },
    )
    out = stdout
  } catch (err: any) {
    if (err?.code !== 1) throw err
  }
  const nodes = new Map<string, { id: string; label: string; nodeType: string; path?: string; linkCount: number }>()
  const edges: Array<{ source: string; target: string }> = []
  const ensure = (id: string, path?: string) => {
    const key = id.trim()
    if (!nodes.has(key)) {
      const type = path ? (path.split("/")[1] ?? "other") : "other"
      nodes.set(key, { id: key, label: key, nodeType: type, path, linkCount: 0 })
    } else if (path && !nodes.get(key)!.path) {
      nodes.get(key)!.path = path
      nodes.get(key)!.nodeType = path.split("/")[1] ?? "other"
    }
    return key
  }
  for (const line of out.split("\n")) {
    if (!line) continue
    const i = line.indexOf(":")
    if (i < 0) continue
    const file = line.slice(0, i)
    const target = line.slice(i + 1).trim()
    if (!target) continue
    const src = ensure(basename(file).replace(/\.md$/, ""), relative(vault, file))
    const dst = ensure(target)
    edges.push({ source: src, target: dst })
    nodes.get(src)!.linkCount++
    nodes.get(dst)!.linkCount++
  }
  let list = [...nodes.values()]
  if (q) list = list.filter((n) => n.label.toLowerCase().includes(q.toLowerCase()))
  if (nodeType) list = list.filter((n) => n.nodeType === nodeType)
  list = list.sort((a, b) => b.linkCount - a.linkCount).slice(0, limit)
  const keep = new Set(list.map((n) => n.id))
  return { nodes: list, edges: edges.filter((e) => keep.has(e.source) && keep.has(e.target)) }
}

// ── semantic read (LanceDB) — the MCP `llm_wiki_search` vector path ─────────

const pageIndexCache = new Map<string, { at: number; map: Map<string, string> }>()

/** page_id → vault-relative path, cached 120s. Lets a vector hit resolve back
 *  to its file.
 *
 *  Due convenzioni convivono, e la mappa accetta entrambe:
 *
 *    basename          `foo`               ← desktop: ingest.ts e embedAllPages
 *    percorso da wiki/ `sources/foo`       ← headless: embed-backfill.ts
 *
 *  Non è un capriccio: su questo vault **104 file su 10.942 condividono il
 *  basename**. Con la sola chiave corta le loro righe si sovrascriverebbero a
 *  vicenda e la ricerca ne perderebbe una a testa, senza dare errore. Il
 *  percorso è univoco per costruzione, quindi il percorso è la chiave che
 *  scrive il backfill; il basename resta accettato perché è ciò che produce
 *  l'app desktop, e un indice misto deve risolvere lo stesso.
 *
 *  Sulla chiave corta vince il primo incontrato (comportamento di sempre); su
 *  quella lunga non c'è nulla da dirimere. */
async function pageIndex(vault: string): Promise<Map<string, string>> {
  const hit = pageIndexCache.get(vault)
  const nowSec = Math.floor(process.uptime())
  if (hit && nowSec - hit.at < 120) return hit.map
  const map = new Map<string, string>()
  try {
    const { stdout } = await execFileAsync("rg", ["--files", "-g", "*.md", join(vault, "wiki")], {
      maxBuffer: 32 * 1024 * 1024,
    })
    for (const f of stdout.split("\n").filter(Boolean)) {
      const rel = relative(vault, f)
      const short = basename(f).replace(/\.md$/, "")
      if (!map.has(short)) map.set(short, rel)
      // `wiki/sources/foo.md` → `sources/foo`, la chiave che scrive il backfill
      const long = relative(join(vault, "wiki"), f).replace(/\.md$/, "").split(sep).join("/")
      if (long !== short) map.set(long, rel)
    }
  } catch {
    /* no wiki files */
  }
  pageIndexCache.set(vault, { at: nowSec, map })
  return map
}

/** EmbeddingConfig from app-state.json, only if actually usable. */
async function embeddingConfigFor(vault: string): Promise<Record<string, any> | null> {
  try {
    const raw = await readFile(join(vault, ".llm-wiki", "app-state.json"), "utf8")
    const cfg = JSON.parse(raw).embeddingConfig
    return cfg && cfg.enabled && cfg.endpoint && cfg.model ? cfg : null
  } catch {
    return null
  }
}

/**
 * Testuale (ripgrep) e semantica (LanceDB) insieme, fuse per percorso: una
 * pagina trovata in due modi compare una volta sola, e porta con sé il punteggio
 * vettoriale.
 *
 * ⛔ Esportata perché ha **due** chiamanti, ed è così che si è scoperto il
 * problema: l'API la faceva, l'interfaccia web no. Il sito passava da
 * `web-invoke.ts`, che cercava con il solo ripgrep e rispondeva `vectorHits: 0`
 * a ogni domanda — un indice da 7 ms lì accanto, e nessuno che lo interrogasse.
 * Una sola implementazione, due chiamanti.
 */
export async function ricercaIbrida(vault: string, query: string, topKRaw: number) {
  const topK = Math.min(50, Number(topKRaw) || 20)
  const [keyword, semantic] = await Promise.all([
    rgSearch(vault, query, topK),
    semanticSearch(vault, query, topK),
  ])
  const merged = new Map<string, any>()
  for (const r of keyword) merged.set(r.path, r)
  for (const r of semantic) {
    const ex = merged.get(r.path)
    if (ex) ex.vectorScore = r.vectorScore
    else merged.set(r.path, r)
  }
  return {
    results: [...merged.values()],
    mode: semantic.length ? "hybrid" : "keyword",
    tokenHits: keyword.length,
    vectorHits: semantic.length,
  }
}

/** Embed the query, nearest-neighbour over the chunk table, collapse to best
 *  chunk per page, resolve paths. Returns [] when embeddings aren't configured
 *  or the index is empty — search then stays keyword-only. */
async function semanticSearch(vault: string, query: string, topK: number) {
  // LanceDB per prima, R2R solo se LanceDB non risponde.
  //
  // L'ordine era invertito, e con ragione finché l'indice nativo era vuoto:
  // R2R teneva tutto il corpus. Misurato sullo stesso corpus, stesse 200
  // domande, top-5:
  //
  //     R2R + Postgres   p50 1.706,7 ms   p95 2.111,9 ms   488 MB, 1 container, 1 porta
  //     LanceDB tarato   p50     4,3 ms   p95     7,4 ms   recall@5 99,7%, nessun processo
  //
  // Il ripiego non è cortesia: durante la migrazione l'indice nativo si riempie
  // a pezzi, e una ricerca che torna vuota è indistinguibile da «non c'è
  // nulla». Finché R2R è acceso risponde lui; quando verrà spento questo ramo
  // diventa morto da solo, senza altre modifiche.
  const lance = await lanceSearch(vault, query, topK)
  if (lance.length > 0) return lance

  const r2r = await r2rConfigFor(vault)
  if (r2r) {
    const idx = await pageIndex(vault)
    return r2rSearch(r2r, query, topK, (id) => idx.get(id))
  }
  return []
}

/** Il ramo nativo: interroga la tabella dei pezzi in `<vault>/.llm-wiki/lancedb`. */
async function lanceSearch(vault: string, query: string, topK: number) {
  const cfg = await embeddingConfigFor(vault)
  if (!cfg || !query.trim()) return []
  let qvec: number[] | undefined
  try {
    ;[qvec] = await embedTexts([query], cfg)
  } catch (err) {
    console.warn("[vault-api] embed query failed:", (err as Error).message)
    return []
  }
  if (!qvec) return []
  // Si pesca largo perché poi si raggruppa per pagina, e un libro spezzato in
  // mille pezzi può occupare da solo i primi candidati. Misurate le pagine
  // **distinte** per profondità, sul corpus vero (131.301 pezzi):
  //
  //     domanda                        top20  top60  top200
  //     il metodo triune                  20     51     154
  //     cos'è la metamedicina              9     15      81
  //     teoria polivagale e trauma         3      7      16   ← la concentrata
  //
  // A venti candidati nove domande su dieci hanno già più pagine di quante ne
  // servano: **il problema non è generale**. Ma sulla decima venti bastano per
  // tre pagine sole, e sessanta ne danno sette. Pescare il doppio costa una
  // scansione in memoria che nel p50 non si vede, e alza il caso peggiore.
  const chunks = await vectorSearchChunks(vault, qvec, Math.max(topK * 6, 30))
  if (!chunks.length) return []
  const idx = await pageIndex(vault)
  const bestByPage = new Map<string, (typeof chunks)[number]>()
  for (const c of chunks) {
    const prev = bestByPage.get(c.page_id)
    if (!prev || c.score > prev.score) bestByPage.set(c.page_id, c)
  }
  const out: any[] = []
  for (const [pageId, c] of [...bestByPage.entries()].sort((a, b) => b[1].score - a[1].score)) {
    const path = idx.get(pageId)
    if (!path) continue
    let title = pageId
    try {
      title = titleFrom(await readFile(join(vault, path), "utf8"), path)
    } catch {
      /* keep page id */
    }
    out.push({
      path,
      title,
      snippet: c.chunk_text.slice(0, 200).replace(/\s+/g, " ").trim(),
      score: c.score,
      titleMatch: false,
      images: [],
      vectorScore: c.score,
    })
    if (out.length >= topK) break
  }
  return out
}

async function readReviews(vault: string) {
  try {
    const raw = await readFile(join(vault, ".llm-wiki", "review.json"), "utf8")
    const parsed = JSON.parse(raw)
    const reviews = Array.isArray(parsed) ? parsed : (parsed.reviews ?? [])
    return reviews
  } catch {
    return []
  }
}

// ── router ───────────────────────────────────────────────────────────────

/** Handle a request whose pathname starts with /api/v1. */
export async function handleVaultApi(
  method: string,
  pathname: string,
  params: URLSearchParams,
  body: any,
  ctx: ApiCtx,
): Promise<ApiReply> {
  const rest = pathname.replace(/^\/api\/v1/, "")
  const project = { id: "current", name: ctx.projectName, path: ctx.vault, current: true }

  if (rest === "/health") {
    return { status: 200, body: { ok: true, status: "ok", enabled: true, mcpEnabled: true, authRequired: false, authConfigured: false, backend: "headless-light" } }
  }
  if (rest === "/projects") {
    return { status: 200, body: { projects: [project], currentProject: project } }
  }

  // Everything else is /projects/:id/<action> — the id is ignored (single vault).
  const m = /^\/projects\/[^/]+\/(.+)$/.exec(rest)
  if (!m) return { status: 404, body: { ok: false, error: `no route: ${rest}` } }
  const action = m[1]

  if (action.startsWith("files/content")) {
    const rel = params.get("path") ?? ""
    const abs = resolve(ctx.vault, rel)
    if (!insideVault(ctx.vault, abs)) return { status: 400, body: { ok: false, error: "path escapes vault" } }
    try {
      return { status: 200, body: { path: rel, content: await readFile(abs, "utf8") } }
    } catch {
      return { status: 404, body: { ok: false, error: "not found" } }
    }
  }
  if (action.startsWith("files")) {
    const root = params.get("root") ?? "wiki"
    const recursive = params.get("recursive") !== "false"
    const max = Math.min(10000, Number(params.get("maxFiles") ?? "5000"))
    const roots = root === "all" ? ["wiki", "raw/sources"] : [root === "sources" ? "raw/sources" : "wiki"]
    const cap = { n: 0, max }
    const files: any[] = []
    for (const r of roots) files.push(...(await walk(join(ctx.vault, r), ctx.vault, recursive, cap)))
    return { status: 200, body: { files, truncated: cap.n >= max } }
  }
  if (action === "search") {
    return { status: 200, body: await ricercaIbrida(ctx.vault, String(body?.query ?? ""), Number(body?.topK ?? 20)) }
  }
  if (action === "lint") {
    // Structural findings (orphans, broken links, pages with no outlinks),
    // computed next to the disk. No LLM involved.
    const { findings, pages } = await runStructuralLintOnDisk(ctx.vault)
    const type = params.get("type")
    const filtered = type ? findings.filter((f) => f.type === type) : findings
    const counts = findings.reduce<Record<string, number>>((acc, f) => {
      acc[f.type] = (acc[f.type] ?? 0) + 1
      return acc
    }, {})
    return { status: 200, body: { findings: filtered, pages, counts, total: findings.length } }
  }
  if (action === "r2r/status") {
    const cfg = await r2rConfigFor(ctx.vault)
    if (!cfg) return { status: 200, body: { enabled: false } }
    return { status: 200, body: { enabled: true, baseUrl: cfg.baseUrl, ...(await r2rHealth(cfg)) } }
  }
  if (action === "graph") {
    const g = await buildGraph(ctx.vault, params.get("q") ?? undefined, params.get("nodeType") ?? undefined, Math.min(2000, Number(params.get("limit") ?? "500")))
    return { status: 200, body: g }
  }
  if (action === "reviews/resolve") {
    // Mark the given review ids resolved in .llm-wiki/review.json (bulk).
    const ids: string[] = Array.isArray(body?.ids) ? body.ids : []
    const actionLabel = typeof body?.action === "string" ? body.action : "resolved"
    const path = join(ctx.vault, ".llm-wiki", "review.json")
    let reviews: any[] = []
    try {
      const parsed = JSON.parse(await readFile(path, "utf8"))
      reviews = Array.isArray(parsed) ? parsed : (parsed.reviews ?? [])
    } catch {
      return { status: 200, body: { resolved: [], notFound: ids, count: 0 } }
    }
    const idSet = new Set(ids)
    const resolved: string[] = []
    for (const r of reviews) {
      if (idSet.has(r.id)) {
        r.resolved = true
        r.resolvedAction = actionLabel
        resolved.push(r.id)
      }
    }
    if (resolved.length) {
      const tmp = path + ".tmp"
      await writeFile(tmp, JSON.stringify(reviews, null, 2), "utf8")
      const { rename } = await import("node:fs/promises")
      await rename(tmp, path)
    }
    const notFound = ids.filter((id) => !resolved.includes(id))
    return { status: 200, body: { resolved, notFound, count: resolved.length } }
  }
  if (action === "reviews") {
    const reviews = await readReviews(ctx.vault)
    return { status: 200, body: { projectId: "current", status: "unresolved", count: reviews.length, reviews } }
  }
  if (action === "sources/rescan") {
    const queued = await enqueueSources(ctx.vault)
    return { status: 200, body: { ok: true, queued, note: "sources enqueued; the headless ingest timer will drain them" } }
  }
  if (action === "chat") {
    // No server-side LLM headless: retrieve and hand references back so the MCP
    // client (ChatGPT/Claude) does the synthesis — the intended MCP topology.
    const message = String(body?.message ?? "")
    const results = await rgSearch(ctx.vault, message, Math.min(20, Number(body?.topK ?? 8)))
    return {
      status: 200,
      body: {
        projectId: "current",
        sessionId: String(body?.sessionId ?? "headless"),
        mode: String(body?.mode ?? "standard"),
        message: {
          role: "assistant",
          content:
            "Headless mode: no server-side chat model. Retrieved the most relevant pages below — " +
            "synthesize the answer from them, or call llm_wiki_read_file / vault_read_note for full text.",
        },
        references: results.map((r) => ({ title: r.title, path: r.path, kind: "wiki", snippet: r.snippet, score: r.score })),
        toolEvents: [],
        events: [],
        usage: { referenceCount: results.length },
      },
    }
  }

  return { status: 404, body: { ok: false, error: `no route: ${action}` } }
}
