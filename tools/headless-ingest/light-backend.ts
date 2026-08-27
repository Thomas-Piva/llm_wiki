/**
 * App-independent vault backend (Fase 3). Serves keyword search + page reads
 * straight from the markdown on disk, so the heavy WebKit GUI can stay OFF
 * permanently while queries (MCP bridge, bot, extension) still work.
 *
 * Keyword search = ripgrep over wiki/ (80ms on ~9k files) — the same "read from
 * disk" the GUI's api_server does, without the webview. Semantic (LanceDB) can
 * be added later as a second endpoint; keyword covers the common case.
 *
 *   VAULT=/home/claude/headless-vps PORT=19829 \
 *     bun ./tools/headless-ingest/light-backend.ts
 *
 * Optional bearer auth: set LIGHT_BACKEND_TOKEN and send `Authorization: Bearer`.
 */
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises"
import { resolve, join, sep, basename } from "node:path"
import { createHash, timingSafeEqual } from "node:crypto"
import { handleVaultApi } from "./vault-api"
import { enqueueOne } from "./sources-scan"
import { dispatchInvoke } from "./web-invoke"
import { agentStream } from "./agent-stream"

// Built web SPA (real llm_wiki frontend, Tauri bindings shimmed to HTTP).
const DIST = join(import.meta.dir, "web", "dist")

const execFileAsync = promisify(execFile)

const VAULT = resolve(process.env.VAULT ?? process.cwd())
const WIKI = join(VAULT, "wiki")
const PORT = Number(process.env.PORT ?? "19829")
const TOKEN = process.env.LIGHT_BACKEND_TOKEN ?? ""
// Self-contained browser UI (client-side render; the VPS only serves data).
const UI_HTML = await readFile(join(import.meta.dir, "ui", "index.html"), "utf8").catch(() => "")

// Real SPA index, patched to auto-open this vault (App.tsx opens lastProject on
// boot). Seeds the store shim's localStorage the first time only.
const PROJECT_NAME = basename(VAULT)
const UI_ZOOM = process.env.UI_ZOOM ?? "1" // 1 = native size (no zoom); override via UI_ZOOM env
const UI_BOOT = `<style>html{zoom:${UI_ZOOM}}</style>`
// Read + patch index.html fresh on every request so a `npm run build:web`
// goes live WITHOUT restarting this (CLI-armed) service — the served index
// always matches the on-disk bundle's hashed asset names. Settings live
// server-side in app-state.json (via /store), so we only inject the UI zoom.
async function appIndexHtml(): Promise<string> {
  const raw = await readFile(join(DIST, "index.html"), "utf8").catch(() => "")
  return raw ? raw.replace("</head>", `${UI_BOOT}</head>`) : raw
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

// ── Server-backed settings store ───────────────────────────────────────────
// Web Settings persist HERE (VPS app-state.json), not the browser — so MinerU /
// model / provider changes are REAL, and the headless engine reads the same
// file. This is what "modify the app directly, like on the VPS/noVNC" means.
const LLM_DIR = join(VAULT, ".llm-wiki")
const APP_STATE = join(LLM_DIR, "app-state.json")
function storeFile(ns: string): string {
  return ns === "app-state.json" ? APP_STATE : join(LLM_DIR, `store-${ns.replace(/[^\w.-]/g, "_")}.json`)
}
async function readStore(ns: string): Promise<Record<string, unknown>> {
  try { return JSON.parse(await readFile(storeFile(ns), "utf8")) } catch { return {} }
}
let storeSeq = 0
async function writeStore(ns: string, obj: Record<string, unknown>): Promise<void> {
  await mkdir(LLM_DIR, { recursive: true })
  const p = storeFile(ns)
  const tmp = `${p}.tmp-${process.pid}-${storeSeq++}` // unique: concurrent writes must not share a tmp
  await writeFile(tmp, JSON.stringify(obj, null, 2), "utf8")
  const { rename } = await import("node:fs/promises")
  await rename(tmp, p)
}
// Serialize read-modify-write so concurrent /store POSTs don't clobber each
// other (the app writes many settings at once on boot).
let storeChain: Promise<void> = Promise.resolve()
function updateStore(ns: string, mutate: (obj: Record<string, unknown>) => void): Promise<void> {
  storeChain = storeChain.then(async () => {
    const obj = await readStore(ns)
    mutate(obj)
    await writeStore(ns, obj)
  }).catch(() => {})
  return storeChain
}

// Seed defaults into app-state.json once, without clobbering existing settings.
{
  const cur = await readStore("app-state.json")
  const proj = { id: "current", name: PROJECT_NAME, path: VAULT }
  let changed = false
  if (!cur.lastProject) { cur.lastProject = proj; changed = true }
  if (!cur.recentProjects) { cur.recentProjects = [proj]; changed = true }
  if (!cur.llmConfig && process.env.HEADLESS_LLM_API_KEY) {
    cur.llmConfig = {
      provider: "custom", apiKey: process.env.HEADLESS_LLM_API_KEY,
      model: process.env.HEADLESS_LLM_MODEL ?? "deepseek/deepseek-chat-v3-0324",
      ollamaUrl: "", customEndpoint: "https://openrouter.ai/api/v1",
      maxContextSize: 128000, apiMode: "chat_completions", streamingEnabled: true,
    }
    changed = true
  }
  if (changed) await writeStore("app-state.json", cur)
}

// ── Password gate (for network-exposed instances). Off when UI_PASSWORD unset
// (the localhost/MCP instance). Login → signed cookie → access. Same UX as the
// old noVNC: address, password, enter.
const UI_PASSWORD = process.env.UI_PASSWORD ?? ""
const AUTH_COOKIE = "wiki_auth"
const AUTH_VALUE = UI_PASSWORD ? createHash("sha256").update("llmwiki::" + UI_PASSWORD).digest("hex") : ""

// FAIL CLOSED — a network-reachable instance MUST have a password. An empty or
// missing UI_PASSWORD must never silently disable the gate: refuse to start
// instead. Only a loopback bind (the localhost MCP backend) may be passwordless.
const BIND_HOST = process.env.HOST ?? "127.0.0.1"
const IS_LOOPBACK = BIND_HOST === "127.0.0.1" || BIND_HOST === "localhost" || BIND_HOST === "::1"
if (!IS_LOOPBACK && !UI_PASSWORD) {
  throw new Error(
    `[security] refusing to bind ${BIND_HOST} without UI_PASSWORD — set UI_PASSWORD, or bind 127.0.0.1.`,
  )
}

/** Constant-time equality — no early-exit timing side-channel on secrets. */
function safeEq(a: string, b: string): boolean {
  const ab = Buffer.from(String(a))
  const bb = Buffer.from(String(b))
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

function authed(req: Request): boolean {
  if (!UI_PASSWORD) return true // only reached on a guarded loopback instance
  const cookie = req.headers.get("cookie") ?? ""
  for (const part of cookie.split(/;\s*/)) {
    const eq = part.indexOf("=")
    if (eq > 0 && part.slice(0, eq) === AUTH_COOKIE && safeEq(part.slice(eq + 1), AUTH_VALUE)) {
      return true
    }
  }
  return false
}

function loginPage(err = false): Response {
  const html = `<!doctype html><html><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>Wiki — accesso</title><style>body{font:15px system-ui;background:#0f1115;color:#e6e9ef;display:grid;place-items:center;height:100vh;margin:0}form{background:#171a21;border:1px solid #262b36;border-radius:12px;padding:28px;width:300px;display:flex;flex-direction:column;gap:12px}h1{font-size:18px;margin:0 0 6px}input{padding:10px 12px;background:#0f1115;border:1px solid #262b36;border-radius:8px;color:#e6e9ef;font-size:15px}button{padding:10px;background:#6ea8fe;border:0;border-radius:8px;color:#0f1115;font-weight:600;cursor:pointer}.e{color:#ff7b72;font-size:13px}</style></head><body><form method=post action=/login><h1>🧠 Wiki</h1>${err ? '<div class=e>Password errata</div>' : ''}<input type=password name=password placeholder=Password autofocus><button>Entra</button></form></body></html>`
  return new Response(html, { status: err ? 401 : 200, headers: { "content-type": "text/html; charset=utf-8" } })
}

/** Keyword search via ripgrep. Query is passed as a FIXED string (-F), never
 *  as shell or regex, so it is injection-safe. */
async function search(q: string, limit: number) {
  if (!q.trim()) return []
  try {
    // -F literal, -i case-insensitive, -n line numbers, -m cap per file.
    const { stdout } = await execFileAsync(
      "rg",
      ["-F", "-i", "-n", "-m", "2", "--no-heading", "--color", "never", q, WIKI],
      { maxBuffer: 8 * 1024 * 1024 },
    )
    const results = []
    for (const line of stdout.split("\n")) {
      if (!line) continue
      // "<abs path>:<lineno>:<text>"
      const m = /^(.*?):(\d+):(.*)$/.exec(line)
      if (!m) continue
      results.push({
        path: m[1].startsWith(WIKI + sep) ? m[1].slice(VAULT.length + 1) : m[1],
        line: Number(m[2]),
        snippet: m[3].slice(0, 300),
      })
      if (results.length >= limit) break
    }
    return results
  } catch (err: any) {
    // rg exits 1 when there are no matches — that's an empty result, not an error.
    if (err?.code === 1) return []
    throw err
  }
}

/** Read a page. Path must resolve INSIDE the vault (no traversal). */
async function readPage(relPath: string): Promise<Response> {
  const abs = resolve(VAULT, relPath)
  if (abs !== VAULT && !abs.startsWith(VAULT + sep)) {
    return json({ error: "path escapes vault" }, 400)
  }
  try {
    return json({ path: relPath, content: await readFile(abs, "utf8") })
  } catch {
    return json({ error: "not found" }, 404)
  }
}

Bun.serve({
  port: PORT,
  // Localhost only: the vault holds personal data. Never bind 0.0.0.0.
  hostname: process.env.HOST ?? "127.0.0.1",
  // Max idle (255s): CLI/agent runs can stay silent for tens of seconds while
  // thinking; the default 10s would drop the SSE stream mid-answer.
  idleTimeout: 255,
  async fetch(req) {
    if (TOKEN) {
      const auth = req.headers.get("authorization") ?? ""
      if (auth !== `Bearer ${TOKEN}`) return json({ error: "unauthorized" }, 401)
    }
    const url = new URL(req.url)

    // ── Web clipper endpoint ──
    // The browser extension (extension/clipper-core.js) POSTs a clip here.
    // Point it at this server's URL with `?token=<UI_PASSWORD>` (the site
    // cookie isn't sent cross-origin). Writes a source file and kicks the
    // headless ingest — the network-reachable equivalent of the desktop's
    // Rust clip_server on :19827.
    if (url.pathname === "/clip" && req.method === "POST") {
      if (UI_PASSWORD && !safeEq(url.searchParams.get("token") ?? "", UI_PASSWORD) && !authed(req)) {
        return json({ error: "unauthorized" }, 401)
      }
      const clip: any = await req.json().catch(() => ({}))
      const title = String(clip.title ?? "clip").trim().slice(0, 120) || "clip"
      const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "clip"
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")
      const rel = `raw/sources/${slug}-${stamp}.md`
      const md =
        `---\ntitle: "${title.replace(/"/g, "'")}"\n` +
        `source_url: ${clip.url ?? ""}\nclipped: ${new Date().toISOString()}\n---\n\n${clip.content ?? ""}\n`
      await Bun.write(join(VAULT, rel), md)
      // Enqueue exactly this file (O(1), no sources walk) then kick the drain.
      await enqueueOne(VAULT, rel).catch(() => false)
      execFileAsync("systemctl", ["--user", "start", "--no-block", "llm-wiki-ingest-ui.service"]).catch(() => {})
      return json({ ok: true, path: rel })
    }

    // ── password gate (network-exposed instances only) ──
    if (UI_PASSWORD) {
      if (url.pathname === "/login") {
        if (req.method === "POST") {
          const form = new URLSearchParams(await req.text())
          if (safeEq(form.get("password") ?? "", UI_PASSWORD)) {
            return new Response(null, {
              status: 302,
              headers: { Location: "/app/", "Set-Cookie": `${AUTH_COOKIE}=${AUTH_VALUE}; HttpOnly; Path=/; SameSite=Lax; Max-Age=2592000` },
            })
          }
          return loginPage(true)
        }
        return loginPage()
      }
      if (!authed(req)) {
        const htmlRoute = url.pathname === "/" || url.pathname === "/ui" || url.pathname === "/app" || url.pathname.startsWith("/app/")
        return htmlRoute ? loginPage() : json({ error: "unauthorized" }, 401)
      }
    }

    // Desktop-app-compatible local API (/api/v1/*) so the MCP server's
    // llm_wiki_* tools work with the GUI off. Served entirely from disk.
    if (url.pathname.startsWith("/api/v1")) {
      let body: unknown = undefined
      if (req.method === "POST") {
        try {
          body = await req.json()
        } catch {
          body = {}
        }
      }
      const reply = await handleVaultApi(req.method, url.pathname, url.searchParams, body, {
        vault: VAULT,
        projectName: basename(VAULT),
      })
      return json(reply.body, reply.status)
    }

    // Web upload: file bytes → raw/sources on the VPS. The ingest is triggered
    // separately (rescan_project_files), and File Sync shows live progress.
    if (url.pathname === "/upload" && req.method === "POST") {
      const form = await req.formData()
      const files: string[] = []
      for (const [, v] of form.entries()) {
        if (v instanceof File && v.name) {
          const abs = join(VAULT, "raw/sources", basename(v.name)) // basename: no path traversal
          await Bun.write(abs, v)
          files.push(abs)
        }
      }
      return json({ ok: true, files })
    }

    // Export the vault as a zip (wiki/ + top-level docs). Excludes raw/sources
    // (can be huge) and lancedb (regenerable). The core shim triggers a browser
    // download of this.
    if (url.pathname === "/export" && req.method === "GET") {
      const { default: JSZip } = await import("jszip")
      const zip = new JSZip()
      const addDir = async (rel: string) => {
        let entries: Awaited<ReturnType<typeof readdir>>
        try {
          entries = await readdir(join(VAULT, rel), { withFileTypes: true })
        } catch {
          return
        }
        for (const e of entries) {
          const r = rel ? `${rel}/${e.name}` : e.name
          if (e.isDirectory()) await addDir(r)
          else zip.file(r, await readFile(join(VAULT, r)))
        }
      }
      await addDir("wiki")
      for (const f of ["schema.md", "purpose.md", "llms.txt", "index.md"]) {
        try {
          zip.file(f, await readFile(join(VAULT, f)))
        } catch {
          /* absent */
        }
      }
      const buf = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" })
      return new Response(buf, {
        headers: {
          "content-type": "application/zip",
          "content-disposition": `attachment; filename="${basename(VAULT)}.llmwiki.zip"`,
        },
      })
    }

    // Server-backed settings store: web Settings read/write the VPS app-state.json.
    if (url.pathname === "/store" && req.method === "GET") {
      return json(await readStore(url.searchParams.get("ns") ?? "app-state.json"))
    }
    if (url.pathname === "/store" && req.method === "POST") {
      const body: any = await req.json().catch(() => ({}))
      const ns = body.ns ?? "app-state.json"
      await updateStore(ns, (obj) => {
        if (body.op === "delete") delete obj[body.key]
        else if (body.op === "clear") for (const k of Object.keys(obj)) delete obj[k]
        else obj[body.key] = body.value
      })
      return json({ ok: true })
    }

    // Grounded chat: retrieve + LLM synthesize, streamed as SSE "agent-event".
    if (url.pathname === "/agent-stream" && req.method === "POST") {
      let reqBody: any = {}
      try { reqBody = await req.json() } catch { /* empty */ }
      return new Response(agentStream(VAULT, reqBody), {
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
      })
    }

    // ── Real web SPA (the actual llm_wiki UI) under /app ──
    // invoke() bridge: browser shim POSTs {cmd,args} here.
    if (url.pathname === "/invoke" && req.method === "POST") {
      let payload: any = {}
      try { payload = await req.json() } catch { /* empty */ }
      try {
        return json({ result: await dispatchInvoke(payload.cmd, payload.args, VAULT) })
      } catch (e: any) {
        return json({ error: e?.message ?? String(e) }, 400)
      }
    }
    // Local file bytes (images referenced by pages), sandboxed to vault.
    if (url.pathname === "/file") {
      const abs = resolve(VAULT, url.searchParams.get("path") ?? "")
      if (abs !== VAULT && !abs.startsWith(VAULT + sep)) return json({ error: "path escapes vault" }, 400)
      const f = Bun.file(abs)
      return (await f.exists()) ? new Response(f) : json({ error: "not found" }, 404)
    }
    // Static SPA assets + client-side-routing fallback.
    if (url.pathname === "/app" || url.pathname.startsWith("/app/")) {
      const rel = url.pathname === "/app" || url.pathname === "/app/" ? "index.html" : url.pathname.slice(5)
      if (rel === "index.html") {
        return new Response(await appIndexHtml(), { headers: { "content-type": "text/html; charset=utf-8" } })
      }
      const f = Bun.file(join(DIST, rel))
      if (await f.exists()) return new Response(f)
      return new Response(await appIndexHtml(), { headers: { "content-type": "text/html; charset=utf-8" } }) // SPA fallback
    }

    // Root → the real SPA. The minimal fallback UI is kept at /lite only.
    if (url.pathname === "/" || url.pathname === "/ui") {
      return new Response(null, { status: 302, headers: { Location: "/app/" } })
    }
    if (url.pathname === "/lite") {
      return new Response(UI_HTML, { headers: { "content-type": "text/html; charset=utf-8" } })
    }

    switch (url.pathname) {
      case "/health":
        return json({ ok: true, vault: VAULT })
      case "/search": {
        const q = url.searchParams.get("q") ?? ""
        const limit = Math.min(100, Number(url.searchParams.get("limit") ?? "20"))
        return json({ query: q, results: await search(q, limit) })
      }
      case "/read":
        return readPage(url.searchParams.get("path") ?? "")
      default:
        return json({ error: "not found", endpoints: ["/health", "/search?q=", "/read?path="] }, 404)
    }
  },
})

console.error(`[light-backend] serving ${WIKI} on :${PORT}${TOKEN ? " (auth on)" : ""}`)
