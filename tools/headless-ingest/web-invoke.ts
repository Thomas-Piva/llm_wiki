/**
 * Server-side dispatcher for the browser `invoke()` shim. The real llm_wiki
 * frontend calls ~69 Tauri commands; served over the web, each browser invoke
 * POSTs here and we run the disk-backed equivalent.
 *
 * TRUST MODEL — localhost only. This is mounted on the light-backend, which
 * binds 127.0.0.1. It is reached ONLY through an SSH tunnel (the operator
 * already has shell access to the box), exactly like the desktop app's own
 * local API on :19828, which is likewise unauthenticated on loopback. It is
 * NOT for network exposure; do not bind it to a routable interface without
 * adding auth. Every path is additionally sandboxed to VAULT so even a bug in
 * the frontend can't touch files outside the project.
 *
 * Implemented: filesystem + wiki (search, page links, related, create page,
 * text-selection edit, rescan). Stubbed safe: vector/embedding/history/watchers/
 * settings (empty/no-op). Refused: agent/CLI/media (desktop-only) throw a clear
 * "not available on web" so the UI degrades instead of silently lying.
 */
import { promises as fs } from "node:fs"
import { createHash } from "node:crypto"
import { resolve, dirname, extname, join, relative, sep, basename } from "node:path"
import { isStructuredText, structuredToText } from "@/lib/structured-text"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { ricercaIbrida, rgSearch, titleFrom } from "./vault-api"
import { runStructuralLintOnDisk } from "./lint-runner"
import { r2rHealth } from "./r2r-search"
import { appendOnlyEnabled, ensureIdentity, isWikiPage, nuovoIdPagina } from "./note-policy"
import { enqueueSources } from "./sources-scan"
import { readQueue } from "./queue-store"
import {
  embedTexts,
  vectorUpsertChunks,
  vectorSearchChunks,
  vectorDeletePage,
  vectorCountChunks,
  vectorClearChunks,
} from "./vector-store"

// ── web search (Exa/Tavily/Brave/SearXNG), replicating the Rust providers ────
function hostLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "")
  } catch {
    return "web"
  }
}
function normWebResult(v: any): { title: string; source: string; url: string; snippet: string } {
  const m = v?.metadata ?? {}
  const title = v?.title ?? m.title ?? "Untitled"
  const url = v?.url ?? v?.link ?? m.sourceURL ?? m.url ?? v?.original ?? ""
  const snippet =
    v?.snippet ?? v?.content ?? v?.description ?? m.description ?? v?.summary ?? v?.text ?? v?.markdown ?? ""
  return { title: String(title), source: hostLabel(String(url)), url: String(url), snippet: String(snippet).slice(0, 500) }
}
async function webSearchHttp(query: string, cfg: any, n: number) {
  if (!query.trim()) return []
  const provider = cfg?.provider
  const key = cfg?.apiKey ?? ""
  let arr: any[] = []
  if (provider === "exa") {
    const r = await fetch("https://api.exa.ai/search", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key },
      body: JSON.stringify({ query, numResults: n, type: "auto", contents: { text: { maxCharacters: 500 }, summary: {} } }),
    })
    const j: any = await r.json()
    if (!r.ok) throw new Error(`Exa ${r.status}: ${JSON.stringify(j).slice(0, 160)}`)
    arr = j.results ?? []
  } else if (provider === "tavily") {
    const r = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ api_key: key, query, max_results: n, search_depth: "advanced", include_answer: false }),
    })
    const j: any = await r.json()
    if (!r.ok) throw new Error(`Tavily ${r.status}: ${JSON.stringify(j).slice(0, 160)}`)
    arr = j.results ?? []
  } else if (provider === "brave") {
    const r = await fetch(
      `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${Math.min(n, 20)}`,
      { headers: { accept: "application/json", "X-Subscription-Token": key } },
    )
    const j: any = await r.json()
    if (!r.ok) throw new Error(`Brave ${r.status}: ${JSON.stringify(j).slice(0, 160)}`)
    arr = j.web?.results ?? []
  } else if (provider === "searxng") {
    const base = String(cfg?.searXngUrl ?? "").trim().replace(/\/$/, "")
    if (!base) throw new Error("SearXNG URL not configured")
    const r = await fetch(`${base}/search?q=${encodeURIComponent(query)}&format=json`, { headers: { accept: "application/json" } })
    const j: any = await r.json()
    if (!r.ok) throw new Error(`SearXNG ${r.status}`)
    arr = j.results ?? []
  } else {
    throw new Error(`web search provider "${provider}" not supported headless — use exa, tavily, brave, or searxng`)
  }
  return arr.slice(0, n).map(normWebResult)
}

/** Map the headless ingest queue → the app's FileChangeQueue so the web UI's
 *  File Sync panel shows live pending→processing→done as the server ingests. */
async function fileChangeQueue(vault: string) {
  const tasks = (await readQueue(vault)).map((t) => ({
    id: t.id,
    projectId: t.projectId || "headless",
    path: t.sourcePath,
    kind: "created" as const,
    status: t.status === "cancelled" ? "superseded" : t.status,
    createdAt: t.addedAt,
    updatedAt: t.addedAt,
    retryCount: t.retryCount ?? 0,
    error: t.error ?? null,
    needsRerun: false,
  }))
  return { version: 1, tasks }
}

const execFileAsync = promisify(execFile)

const MIME: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
}

/** Resolve a client path and refuse anything outside the vault. */
function guard(vault: string, p: string): string {
  const abs = resolve(p.startsWith("/") ? p : join(vault, p))
  if (abs !== vault && !abs.startsWith(vault + sep)) {
    throw new Error(`path outside vault: ${p}`)
  }
  return abs
}

interface FileNode { name: string; path: string; is_dir: boolean; children?: FileNode[] }

async function listDir(dir: string, includeHidden: boolean, maxDepth: number | undefined, depth: number): Promise<FileNode[]> {
  let entries: Awaited<ReturnType<typeof fs.readdir>>
  try { entries = await fs.readdir(dir, { withFileTypes: true }) } catch { return [] }
  const out: FileNode[] = []
  for (const e of entries) {
    if (!includeHidden && e.name.startsWith(".")) continue
    const full = join(dir, e.name)
    const node: FileNode = { name: e.name, path: full, is_dir: e.isDirectory() }
    if (e.isDirectory() && (maxDepth === undefined || depth < maxDepth)) {
      node.children = await listDir(full, includeHidden, maxDepth, depth + 1)
    }
    out.push(node)
  }
  return out
}

const OUT_LINK = /\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g

async function wikiBasenameMap(vault: string): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  const walk = async (d: string) => {
    let es: Awaited<ReturnType<typeof fs.readdir>>
    try { es = await fs.readdir(d, { withFileTypes: true }) } catch { return }
    for (const e of es) {
      if (e.name.startsWith(".")) continue
      const full = join(d, e.name)
      if (e.isDirectory()) await walk(full)
      else if (e.name.endsWith(".md")) map.set(e.name.replace(/\.md$/, "").toLowerCase(), full)
    }
  }
  await walk(join(vault, "wiki"))
  return map
}

async function pageLinks(vault: string, filePath: string) {
  const abs = guard(vault, filePath)
  const content = await fs.readFile(abs, "utf8").catch(() => "")
  const map = await wikiBasenameMap(vault)
  const outgoing: any[] = [], missing: any[] = []
  const seen = new Set<string>()
  for (const m of content.matchAll(OUT_LINK)) {
    const name = m[1].trim()
    const key = name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    const target = map.get(key)
    if (target) outgoing.push({ title: name, path: relative(vault, target) })
    else missing.push({ title: name })
  }
  const myName = basename(abs).replace(/\.md$/, "")
  const backlinks: any[] = []
  try {
    const { stdout } = await execFileAsync("rg", ["-l", "-F", `[[${myName}`, join(vault, "wiki")], { maxBuffer: 8 * 1024 * 1024 })
    for (const f of stdout.split("\n").filter(Boolean)) {
      if (resolve(f) === abs) continue
      backlinks.push({ title: basename(f).replace(/\.md$/, ""), path: relative(vault, f) })
    }
  } catch { /* rg exit 1 = none */ }
  return { outgoing, backlinks, missing }
}

const LINK_RE = /\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g

// Cache the batch so repeated graph opens cost the VPS ~0: build once, serve
// cached for TTL. The heavy force-layout runs in the browser, not here.
const GRAPH_TTL_MS = 120_000
const graphCache = new Map<string, { ts: number; data: unknown }>()

/** Read every wiki page ONCE, server-side, and return the graph node data
 *  ({id,label,type,path,links}). One HTTP call replaces ~1600 read_file calls,
 *  so the web graph/tree loads fast instead of round-tripping per file. */
async function wikiGraphBatch(vault: string) {
  const cached = graphCache.get(vault)
  if (cached && Date.now() - cached.ts < GRAPH_TTL_MS) return cached.data
  const wiki = join(vault, "wiki")
  const out: Array<{ id: string; label: string; type: string; path: string; links: string[] }> = []
  const walk = async (dir: string) => {
    let es: Awaited<ReturnType<typeof fs.readdir>>
    try { es = await fs.readdir(dir, { withFileTypes: true }) } catch { return }
    for (const e of es) {
      if (e.name.startsWith(".")) continue
      const full = join(dir, e.name)
      if (e.isDirectory()) { await walk(full); continue }
      if (!e.name.endsWith(".md")) continue
      const content = await fs.readFile(full, "utf8").catch(() => "")
      const fm = /^---\n([\s\S]*?)\n---/.exec(content)
      let type = "other"
      const tags: string[] = []
      if (fm) {
        const t = /^type:\s*["']?([^"'\n]+)/m.exec(fm[1])
        if (t) type = t[1].trim().toLowerCase()
        const tg = /^tags:\s*\[(.+?)\]/m.exec(fm[1])
        if (tg) tags.push(...tg[1].split(",").map((x) => x.trim().replace(/["']/g, "")))
      }
      const links: string[] = []
      for (const m of content.matchAll(LINK_RE)) links.push(m[1].trim())
      out.push({ id: e.name.replace(/\.md$/, ""), label: titleFrom(content, full), type, path: full, links, tags })
    }
  }
  await walk(wiki)
  graphCache.set(vault, { ts: Date.now(), data: out })
  return out
}

/** Main dispatch. `vault` is the absolute project root. */
export async function dispatchInvoke(cmd: string, args: any, vault: string): Promise<unknown> {
  const A = args ?? {}
  switch (cmd) {
    case "wiki_graph_batch": return wikiGraphBatch(vault)
    // ── filesystem ──
    case "read_file": {
      // Mirror the desktop: prefer a fresh `.cache/<name>.txt` (MinerU/media
      // extracted text) so opening a parsed PDF shows its markdown, not bytes.
      const p = guard(vault, A.path)
      const cache = join(dirname(p), ".cache", `${basename(p)}.txt`)
      try {
        const [cs, os] = await Promise.all([fs.stat(cache), fs.stat(p)])
        if (cs.mtimeMs >= os.mtimeMs) return fs.readFile(cache, "utf8")
      } catch { /* no fresh cache */ }
      const grezzo = await fs.readFile(p, "utf8")
      // Stessa regola dell'altra shim: json/xml/yaml/html diventano il testo che
      // contengono, non la loro sintassi. Applicarla a una strada sola vorrebbe
      // dire che il sito e l'ingest indicizzano lo stesso file in modo diverso.
      const ext = extname(p).toLowerCase().replace(/^\./, "")
      return isStructuredText(ext) ? structuredToText(grezzo, ext) : grezzo
    }
    /**
     * Pull the text a PDF already contains, locally.
     *
     * Most PDFs are digital: the words are in the file, and reading them is a
     * copy, not an interpretation. Sending those to a cloud parser costs a
     * network round-trip and a fee for something `pdftotext` does in
     * milliseconds — measured on this vault, 765 PDFs a minute, and 18 of 20
     * came out with full text.
     *
     * Returns "" for the rest: those are scans, where there is genuinely no
     * text to copy and OCR is the only way. The caller falls back to MinerU.
     */
    case "pdf_extract_text": {
      const p = guard(vault, A.path)
      try {
        const { stdout } = await execFileAsync(
          "pdftotext",
          ["-layout", "-enc", "UTF-8", p, "-"],
          { maxBuffer: 64 * 1024 * 1024, timeout: 120_000 },
        )
        return stdout
      } catch {
        return ""
      }
    }
    case "write_file":
    case "write_file_atomic": {
      const p = guard(vault, A.path)
      await fs.mkdir(dirname(p), { recursive: true })
      // Le stesse regole di `invoke-shim.ts`, perché questa è **l'altra** strada
      // per scrivere nel vault: la usa l'interfaccia web. Le avevo messe su una
      // sola delle due, e una regola che vale a metà non è una regola.
      await fs.writeFile(p, isWikiPage(p) ? ensureIdentity(A.contents, { newId: nuovoIdPagina }) : A.contents, "utf8")
      return null
    }
    case "write_file_base64": {
      const p = guard(vault, A.path)
      await fs.mkdir(dirname(p), { recursive: true })
      await fs.writeFile(p, Buffer.from(A.base64, "base64"))
      return null
    }
    case "read_file_as_base64": {
      const buf = await fs.readFile(guard(vault, A.path))
      return { base64: buf.toString("base64"), mimeType: MIME[extname(A.path).toLowerCase()] ?? "application/octet-stream" }
    }
    case "list_directory": return listDir(guard(vault, A.path), !!A.includeHidden, A.maxDepth, 0)
    case "create_directory": await fs.mkdir(guard(vault, A.path), { recursive: true }); return null
    case "delete_file": {
      const p = guard(vault, A.path)
      // D5 — dal sito si aggiunge, non si cancella. Una pagina che sparisce fa
      // smettere di risolvere ogni `[[nome-morto]]` senza dare errore.
      if (isWikiPage(p) && appendOnlyEnabled()) {
        console.warn(`[policy] cancellazione rifiutata (append-only): ${p}. Per disattivare: VAULT_APPEND_ONLY=0`)
        return null
      }
      await fs.rm(p, { force: true })
      return null
    }
    case "copy_file": {
      const d = guard(vault, A.destination)
      await fs.mkdir(dirname(d), { recursive: true })
      await fs.copyFile(guard(vault, A.source), d)
      return null
    }
    case "copy_directory": await fs.cp(guard(vault, A.source), guard(vault, A.destination), { recursive: true }); return []
    case "file_exists": return fs.access(guard(vault, A.path)).then(() => true).catch(() => false)
    case "get_file_size": return (await fs.stat(guard(vault, A.path))).size
    case "get_file_modified_time": return Math.floor((await fs.stat(guard(vault, A.path))).mtimeMs / 1000)
    case "get_file_md5": return createHash("md5").update(await fs.readFile(guard(vault, A.path))).digest("hex")
    case "preprocess_file": return "no preprocessing needed"

    // Structural lint next to the disk: the client-side version reads every page
    // over HTTP, which does not finish on a vault of this size.
    case "structural_lint": return runStructuralLintOnDisk(vault)

    // The engine listens on loopback of THIS machine, so the reachability check
    // has to run here — the browser can't see it.
    case "r2r_status": {
      const baseUrl = String(A.baseUrl ?? "").trim()
      if (!baseUrl) return { ok: false, error: "no base url" }
      return r2rHealth({ enabled: true, baseUrl })
    }

    // ── wiki ──
    case "search_project": {
      // Era solo ripgrep: `vectorHits: 0` a ogni domanda, con l'indice
      // vettoriale inutilizzato accanto. Ora è la stessa funzione che serve
      // l'API e l'MCP.
      return ricercaIbrida(vault, String(A.query ?? ""), Number(A.topK ?? 20))
    }
    case "get_page_links": return pageLinks(vault, A.filePath ?? A.path)
    case "find_related_wiki_pages": {
      const r = await rgSearch(vault, String(A.sourceName ?? "").replace(/\.[a-z0-9]+$/i, ""), 8)
      return r.map((x) => x.path)
    }
    case "create_missing_wiki_page": {
      const slug = String(A.title).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
      const rel = `wiki/concepts/${slug}.md`
      const p = guard(vault, rel)
      await fs.mkdir(dirname(p), { recursive: true })
      await fs.writeFile(p, A.content ?? `---\ntitle: "${A.title}"\n---\n\n# ${A.title}\n`, { flag: "wx" }).catch(() => {})
      return rel
    }
    case "apply_text_selection_edit": {
      const p = guard(vault, A.filePath)
      const cur = await fs.readFile(p, "utf8")
      const next = cur.replace(`${A.prefix}${A.selectedText}${A.suffix}`, `${A.prefix}${A.replacement}${A.suffix}`)
      await fs.writeFile(p, next, "utf8")
      return next
    }
    // Enqueue newly-uploaded sources and kick the headless ingest unit so it
    // processes them now; the File Sync panel then shows live progress via
    // get_file_change_queue. Fixed command (no user input) → not an RCE surface.
    case "rescan_project_files": {
      // Explicit "Refresh" — walk raw/sources for new files, enqueue, drain.
      await enqueueSources(vault).catch(() => 0)
      execFileAsync("systemctl", ["--user", "start", "--no-block", "llm-wiki-ingest-ui.service"]).catch(() => {})
      return { queue: await fileChangeQueue(vault), changedTasks: [] }
    }
    case "start_ingest_drain": {
      // O(1) trigger: files are already enqueued (upload/clip) — just drain the
      // queue, no full sources walk. Kicked after enqueueSourceIngest on web.
      execFileAsync("systemctl", ["--user", "start", "--no-block", "llm-wiki-ingest-ui.service"]).catch(() => {})
      return { ok: true }
    }
    case "rebuild_wiki_index": { await enqueueSources(vault).catch(() => 0); return { ok: true } }
    case "start_project_file_watcher": return { queue: await fileChangeQueue(vault), changedTasks: [] }
    case "get_file_change_queue": return fileChangeQueue(vault)
    case "retry_file_change_task":
    case "ignore_file_change_task": return { version: 1, tasks: [] }

    // ── project / window / settings: single-vault, no-op-safe ──
    case "open_project":
    case "create_project": return { name: basename(vault), path: vault }
    case "open_project_folder":
    case "open_path_in_project":
    case "stop_project_file_watcher":
    case "set_close_behavior":
    case "set_proxy_env":
    case "api_server_reload_config":
    case "set_file_history_settings": return null
    case "api_server_status": return "running"
    case "clip_server_status": return "disabled"
    case "remote_mcp_status": return { running: true, publicUrl: process.env.REMOTE_MCP_URL || null }
    case "mcp_server_entry_path": return ""
    case "get_file_history_settings": return { enabled: false, maxVersionsPerFile: 0 }
    case "get_file_history_stats": return { bytes: 0, files: 0, entries: 0 }
    case "list_file_history": return []
    case "agent_list_skills": return []

    // ── embeddings + vector store (LanceDB, real) ──
    // Lets the Settings "Reindex all embeddings" button (embedAllPages runs in
    // the browser) actually embed the whole vault through this dispatcher.
    case "embedding_fetch": {
      const [v] = await embedTexts([String(A.text)], A.cfg)
      return v
    }
    case "embedding_fetch_batch":
      return embedTexts(A.texts as string[], A.cfg)
    case "vector_upsert_chunks":
      await vectorUpsertChunks(vault, A.pageId, A.chunks)
      return null
    case "vector_search_chunks":
      return vectorSearchChunks(vault, A.queryEmbedding, Number(A.topK))
    case "vector_delete_page":
      await vectorDeletePage(vault, A.pageId)
      return null
    case "vector_count_chunks":
      return vectorCountChunks(vault)
    case "vector_clear_chunks":
      await vectorClearChunks(vault)
      return null
    case "vector_optimize_chunks":
    case "vector_drop_legacy":
      return null
    case "vector_legacy_row_count":
      return 0

    // ── desktop-only: refuse clearly so the UI degrades ──
    case "agent_start_turn":
    case "agent_start_turn_stream":
    case "agent_cancel_turn":
    case "claude_cli_spawn":
    case "claude_cli_kill":
    case "claude_cli_detect":
    case "codex_cli_spawn":
    case "codex_cli_kill":
    case "codex_cli_detect":
    // ── vault import/export ──
    case "export_project_archive":
      // The browser download is handled by the core shim (fetch /export → blob).
      // If it ever reaches here, it's a no-op success.
      return null
    case "import_project_archive": {
      // Unzip an uploaded .llmwiki.zip into the vault (sandboxed paths only).
      const { default: JSZip } = await import("jszip")
      const rel = String(A.archivePath).startsWith(vault) ? relative(vault, String(A.archivePath)) : String(A.archivePath)
      const abs = guard(vault, rel)
      const zip = await JSZip.loadAsync(await fs.readFile(abs))
      for (const entry of Object.values(zip.files)) {
        if (entry.dir) continue
        let dest: string
        try {
          dest = guard(vault, entry.name) // rejects path traversal outside the vault
        } catch {
          continue
        }
        await fs.mkdir(dirname(dest), { recursive: true })
        await fs.writeFile(dest, Buffer.from(await entry.async("uint8array")))
      }
      return vault
    }

    // ── file version history: not kept headless — safe no-ops ──
    case "clear_file_history":
    case "restore_file_history":
      return null

    // ── remote MCP: managed as an external systemd service on the VPS ──
    case "remote_mcp_start":
      return { running: true, publicUrl: process.env.REMOTE_MCP_URL || null }

    case "web_search":
      return webSearchHttp(String(A.query ?? ""), A.config ?? {}, Math.min(20, Number(A.maxResults ?? 10)))

    case "extract_audio_track":
    case "download_media_url":
    case "anytxt_search":
      throw new Error(`"${cmd}" is not available in the web version (desktop-only feature).`)

    default:
      throw new Error(`web invoke: unhandled command "${cmd}"`)
  }
}
