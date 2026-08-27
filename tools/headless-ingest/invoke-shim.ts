/**
 * Node implementations of the Tauri `invoke("<cmd>", args)` seam that
 * `src/commands/fs.ts` (and the ingest pipeline behind it) rely on.
 *
 * The whole desktop app reaches the filesystem through a handful of Rust
 * commands. Headless, we replace those commands with plain Node `fs` so
 * `ingest.ts` runs unchanged outside the WebKit webview.
 *
 * Anything not listed throws on purpose: a run surfaces exactly which
 * command the ingest path still needs, and we add it deliberately.
 */
import { promises as fs, statSync } from "node:fs"
import { createHash } from "node:crypto"
import { spawn, type ChildProcess } from "node:child_process"
import { dirname, join, basename, extname } from "node:path"
import { tmpdir } from "node:os"
import { emitEvent } from "./tauri-event-bus"
import {
  embedTexts,
  vectorUpsertChunks,
  vectorSearchChunks,
  vectorDeletePage,
  vectorCountChunks,
  vectorClearChunks,
} from "./vector-store"

const CLAUDE_BIN = process.env.AGENT_CLAUDE_BIN ?? "/home/claude/.local/bin/claude"
const CODEX_BIN = process.env.AGENT_CODEX_BIN ?? "/opt/node25/bin/codex"
const cliChildren = new Map<string, ChildProcess>()

/** Serialize the chat history into a single prompt for `-p`. */
function messagesToPrompt(messages: any[]): string {
  return (messages ?? [])
    .map((m) => {
      const c = typeof m.content === "string"
        ? m.content
        : Array.isArray(m.content)
          ? m.content.map((p: any) => (typeof p === "string" ? p : p?.text ?? "")).join("")
          : ""
      return m.role === "system" ? c : `${m.role}: ${c}`
    })
    .join("\n\n")
}

/** Spawn claude/codex, streaming stdout back as `<kind>-cli:<streamId>` events
 *  (one line each) + a `:done` event — the protocol the CLI transports expect.
 *  Full-tool, cwd = the project (user-authorized). Returns immediately. */
function spawnCliTransport(kind: "claude" | "codex", args: any): void {
  const streamId = String(args.streamId)
  const cwd = args.workingDirectory || process.cwd()
  const prompt = messagesToPrompt(args.messages)
  const model = args.model ? String(args.model) : ""
  const bin = kind === "claude" ? CLAUDE_BIN : CODEX_BIN
  const cargs = kind === "claude"
    ? ["-p", "--dangerously-skip-permissions", "--output-format", "stream-json", "--verbose", ...(model ? ["--model", model] : []), prompt]
    : ["exec", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox", ...(model ? ["-m", model] : []), prompt]
  const child = spawn(bin, cargs, { cwd, env: process.env })
  cliChildren.set(streamId, child)
  child.stdin?.end()
  let buf = ""
  let err = ""
  const evt = `${kind}-cli:${streamId}`
  child.stdout?.on("data", (d) => {
    if (kind === "codex") { emitEvent(evt, d.toString()); return }
    buf += d.toString()
    const lines = buf.split("\n")
    buf = lines.pop() ?? ""
    for (const l of lines) if (l.trim()) emitEvent(evt, l)
  })
  child.stderr?.on("data", (d) => { err += d.toString() })
  const finish = (code: number) => {
    if (buf.trim()) emitEvent(evt, buf)
    cliChildren.delete(streamId)
    emitEvent(`${evt}:done`, { code, stderr: err })
  }
  child.on("close", (c) => finish(c ?? 0))
  child.on("error", (e) => { err += e.message; finish(1) })
}

interface FileNode {
  name: string
  path: string
  is_dir: boolean
  children?: FileNode[]
}

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
}

async function listDir(
  path: string,
  includeHidden: boolean,
  maxDepth: number | undefined,
  depth: number,
): Promise<FileNode[]> {
  let entries: Awaited<ReturnType<typeof fs.readdir>>
  try {
    entries = await fs.readdir(path, { withFileTypes: true })
  } catch {
    return []
  }
  const out: FileNode[] = []
  for (const e of entries) {
    if (!includeHidden && e.name.startsWith(".")) continue
    const full = join(path, e.name)
    const isDir = e.isDirectory()
    const node: FileNode = { name: e.name, path: full, is_dir: isDir }
    if (isDir && (maxDepth === undefined || depth < maxDepth)) {
      node.children = await listDir(full, includeHidden, maxDepth, depth + 1)
    }
    out.push(node)
  }
  return out
}

/** Dispatch a Tauri command name to its Node equivalent. */
export async function invoke<T = unknown>(cmd: string, args: any = {}): Promise<T> {
  switch (cmd) {
    case "read_file": {
      // Mirror the Rust `read_file`: prefer a sibling `.cache/<name>.txt`
      // when it is at least as new as the source. MinerU (PDF) and the media
      // pipeline write their extracted text there, so reading the original
      // PDF path transparently returns the parsed markdown. Falls back to
      // reading the file directly. `extractImages` is ignored (text-first).
      const src = String(args.path)
      const cache = join(dirname(src), ".cache", `${basename(src)}.txt`)
      try {
        const [cs, os] = await Promise.all([fs.stat(cache), fs.stat(src)])
        if (cs.mtimeMs >= os.mtimeMs) return (await fs.readFile(cache, "utf8")) as T
      } catch { /* no fresh cache — read the file itself */ }
      return (await fs.readFile(src, "utf8")) as T
    }

    case "read_file_as_base64": {
      const buf = await fs.readFile(args.path)
      const mimeType = MIME_BY_EXT[extname(args.path).toLowerCase()] ?? "application/octet-stream"
      return { base64: buf.toString("base64"), mimeType } as T
    }

    case "write_file":
    case "write_file_atomic":
      await fs.mkdir(dirname(args.path), { recursive: true })
      await fs.writeFile(args.path, args.contents, "utf8")
      return undefined as T

    case "write_file_base64":
      await fs.mkdir(dirname(args.path), { recursive: true })
      await fs.writeFile(args.path, Buffer.from(args.base64, "base64"))
      return undefined as T

    case "create_directory":
      await fs.mkdir(args.path, { recursive: true })
      return undefined as T

    case "delete_file":
      await fs.rm(args.path, { force: true })
      return undefined as T

    case "copy_file":
      await fs.mkdir(dirname(args.destination), { recursive: true })
      await fs.copyFile(args.source, args.destination)
      return undefined as T

    case "file_exists":
      return (await fs
        .access(args.path)
        .then(() => true)
        .catch(() => false)) as T

    case "get_file_size":
      return statSync(args.path).size as T

    case "get_file_modified_time":
      // Rust returns seconds since epoch; match that for snapshot compares.
      return Math.floor(statSync(args.path).mtimeMs / 1000) as T

    case "get_file_md5": {
      const buf = await fs.readFile(args.path)
      return createHash("md5").update(buf).digest("hex") as T
    }

    case "list_directory":
      return (await listDir(args.path, !!args.includeHidden, args.maxDepth, 0)) as T

    case "find_related_wiki_pages":
      return [] as T

    case "preprocess_file":
      // No-op headless. PDF text extraction is done by MinerU during ingest
      // (it writes `.cache/<name>.txt`, which `read_file` above serves), so
      // there is nothing to pre-extract here. Office/ebook without a native
      // extractor simply read as-is (text-first limitation).
      return "no preprocessing needed" as T

    case "extract_and_save_pdf_images_cmd":
    case "extract_and_save_office_images_cmd":
      // pdfium/OOXML standalone image extraction is native-only. Headless relies
      // on MinerU's own images (from its result zip), so these are no-ops.
      return [] as T

    case "extract_audio_track": {
      // Mirror the Rust command (media_tools.rs): ffmpeg → mono 16kHz 32kbps mp3
      // in a temp dir (kept under Groq's 25MB upload limit). transcribeAudio()
      // then POSTs it over HTTP (headless-ready via getHttpFetch).
      const src = String(args.sourcePath)
      const dir = join(tmpdir(), "llm-wiki-media-import")
      await fs.mkdir(dir, { recursive: true })
      const stem = basename(src).replace(/\.[^.]+$/, "")
      const out = join(dir, `${stem}-${process.pid}-${Date.now()}.mp3`)
      await new Promise<void>((resolveFf, rejectFf) => {
        const ff = spawn(
          "ffmpeg",
          ["-y", "-i", src, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "32k", "-f", "mp3", out],
          { stdio: "ignore" },
        )
        ff.on("error", rejectFf)
        ff.on("close", (code) => (code === 0 ? resolveFf() : rejectFf(new Error(`ffmpeg exit ${code}`))))
      })
      return out as T
    }

    // ── Embeddings + vector store (LanceDB) for semantic ingest/search ──
    case "embedding_fetch": {
      const [v] = await embedTexts([String(args.text)], args.cfg)
      return v as T
    }
    case "embedding_fetch_batch":
      return (await embedTexts(args.texts as string[], args.cfg)) as T
    case "vector_upsert_chunks":
      await vectorUpsertChunks(args.projectPath, args.pageId, args.chunks)
      return undefined as T
    case "vector_search_chunks":
      return (await vectorSearchChunks(args.projectPath, args.queryEmbedding, Number(args.topK))) as T
    case "vector_delete_page":
      await vectorDeletePage(args.projectPath, args.pageId)
      return undefined as T
    case "vector_count_chunks":
      return (await vectorCountChunks(args.projectPath)) as T
    case "vector_clear_chunks":
      await vectorClearChunks(args.projectPath)
      return undefined as T
    case "vector_optimize_chunks":
      return undefined as T // LanceDB compaction is optional headless — skip
    case "vector_legacy_row_count":
      return 0 as T // no v1 table headless
    case "vector_drop_legacy":
      return undefined as T

    // ── CLI providers (claude/codex) for headless ingest generation ──
    case "claude_cli_spawn": spawnCliTransport("claude", args); return undefined as T
    case "codex_cli_spawn": spawnCliTransport("codex", args); return undefined as T
    case "claude_cli_kill":
    case "codex_cli_kill": {
      const child = cliChildren.get(String(args.streamId))
      if (child) { try { child.kill() } catch { /* already gone */ } }
      return undefined as T
    }
    case "claude_cli_detect": return { installed: true, path: CLAUDE_BIN } as T
    case "codex_cli_detect": return { installed: true, path: CODEX_BIN } as T

    default:
      throw new Error(`SHIM: unimplemented invoke("${cmd}") — add it to invoke-shim.ts. args=${JSON.stringify(Object.keys(args))}`)
  }
}
