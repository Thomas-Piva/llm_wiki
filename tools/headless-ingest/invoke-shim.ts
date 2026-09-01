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
import { isStructuredText, structuredToText } from "@/lib/structured-text"
import { appendOnlyEnabled, ensureIdentity, isWikiPage, nuovoIdPagina } from "./note-policy"
import {
  embedTexts,
  vectorUpsertChunks,
  vectorSearchChunks,
  vectorDeletePage,
  vectorCountChunks,
  vectorClearChunks,
} from "./vector-store"
import { toMarkdown } from "@firecrawl/anydoc"

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

// Office/document formats anydoc converts to Markdown locally (pure Rust, no ML,
// no network, ~5ms). Mirrors the native Rust `preprocess_file`
// (docx-rs/calamine/office_oxide) that this headless shim used to stub out, so
// `.docx/.pptx/.xlsx/...` yield real text instead of raw OOXML. PDF is excluded
// on purpose — it stays on MinerU (OCR + image extraction anydoc's text path skips).
const OFFICE_EXTS = new Set([
  "docx", "doc", "docm", "pptx", "ppt", "pps", "pptm", "ppsx", "ppsm", "pot",
  "xlsx", "xls", "xlsm", "xlsb", "ods", "odt", "odp", "rtf", "epub", "csv",
])

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

/**
 * Run a local extraction tool and return its stdout. Never hangs, never leaks.
 *
 * Two ways a spawned tool stops an ingest dead, both paid for in production:
 *
 *  1. **stderr nobody reads.** Node opens a pipe for stderr whether or not you
 *     listen to it. A malformed PDF makes `pdftotext` print thousands of
 *     "Syntax Error" lines; once ~64 KB of them fill the pipe buffer, the tool
 *     blocks inside write() and waits for a reader that never comes. It shows
 *     up as a process consuming **zero CPU** — asleep, not working. On the
 *     client's box that cost **ten and a half hours** of an overnight run,
 *     silently: the service still read as "activating".
 *  2. **No deadline.** A tool that genuinely takes forever on one pathological
 *     file blocks every file behind it.
 *
 * So: stderr is discarded at the OS level (`ignore` — no pipe, nothing to
 * fill), and a timeout kills the process and gives back whatever it produced.
 * Partial text beats a stalled queue.
 */
function runTool(bin: string, argv: string[], timeoutMs = 5 * 60_000): Promise<string> {
  return new Promise((resolve) => {
    // stdin ignored, stdout piped, stderr ignored: the only pipe is the one
    // this function actually drains.
    const child = spawn(bin, argv, { stdio: ["ignore", "pipe", "ignore"] })
    let out = ""
    let settled = false
    const done = (why?: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (why) console.warn(`[${bin}] ${why} — ${out.length} caratteri raccolti da ${argv[argv.length - 1]}`)
      resolve(out)
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      done(`superati ${Math.round(timeoutMs / 1000)}s, interrotto`)
    }, timeoutMs)
    child.stdout.on("data", (d) => { out += d })
    child.on("error", (e) => done(`non eseguibile: ${e.message}`))
    child.on("close", () => done())
  })
}

/**
 * HEIC/HEIF — il formato di ogni foto scattata con un iPhone.
 *
 * Sta in `IMAGE_SOURCE_EXTENSIONS` come gli altri, quindi l'ingest lo tratta da
 * immagine e prova a farne la didascalia. Ma nessun modello di visione accetta
 * `image/heic`, e la tabella dei mime qui sopra non lo conosce: partiva come
 * `application/octet-stream`, la didascalia falliva, e a valle la guardia sul
 * binario buttava il documento. Misurato: **2 su 2** nel campione di prova, e
 * 240 file così nelle cartelle da ingerire — foto, tutte perse in silenzio.
 *
 * Rimedio: convertirlo in JPEG appena prima di darlo al modello. Non tocca il
 * file sorgente — il vault resta com'è.
 *
 * Se nessuno dei due convertitori è installato si torna al comportamento
 * precedente: **una macchina senza libheif non peggiora**, la didascalia salta
 * come faceva prima. Da qui il ritorno `null` invece di un'eccezione.
 */
const HEIC_EXTS = new Set([".heic", ".heif"])

async function heicToJpeg(path: string): Promise<Buffer | null> {
  const out = join(tmpdir(), `heic-${createHash("sha1").update(path).digest("hex").slice(0, 12)}.jpg`)
  // `heif-convert` (libheif) è il decodificatore dedicato; ImageMagick è il
  // ripiego perché c'è già su molte macchine. Ordine: il più specifico prima.
  const tentativi: Array<[string, string[]]> = [
    ["heif-convert", ["-q", "90", path, out]],
    ["magick", [path, out]],
    ["convert", [path, out]],
  ]
  // Distinguere "il convertitore non c'e'" da "c'e' e ha rifiutato il file" e'
  // la differenza fra "installa libheif" e "questo file e' rotto": due diagnosi
  // opposte. Un messaggio che le confonde manda a cercare nel posto sbagliato —
  // e' gia' successo con «nessun parser disponibile» su file che il parser
  // ce l'avevano eccome.
  let provati = 0
  for (const [bin, argv] of tentativi) {
    const esito = await new Promise<"ok" | "fallito" | "assente">((resolve) => {
      const child = spawn(bin, argv, { stdio: "ignore" })
      const timer = setTimeout(() => { child.kill("SIGKILL"); resolve("fallito") }, 60_000)
      child.on("error", () => { clearTimeout(timer); resolve("assente") })
      child.on("close", (code) => { clearTimeout(timer); resolve(code === 0 ? "ok" : "fallito") })
    })
    if (esito === "assente") continue
    provati++
    if (esito === "fallito") continue
    try {
      const buf = await fs.readFile(out)
      await fs.unlink(out).catch(() => {})
      if (buf.length > 0) return buf
    } catch {
      /* il convertitore ha detto ok ma non ha scritto: si prova il prossimo */
    }
  }
  console.warn(
    provati === 0
      ? `[heic] nessun convertitore installato (heif-convert o ImageMagick) — "${basename(path)}" senza didascalia`
      : `[heic] ${provati} convertitore/i hanno rifiutato "${basename(path)}" — file rotto o codec HEVC mancante nella libheif installata`,
  )
  return null
}

/** Dispatch a Tauri command name to its Node equivalent. */
export async function invoke<T = unknown>(cmd: string, args: any = {}): Promise<T> {
  switch (cmd) {
    /**
     * Pull the text a PDF already contains, locally.
     *
     * Most PDFs here are digital: the words are in the file, and reading them is
     * a copy, not an interpretation. Sending those to a cloud parser costs a
     * round-trip and a fee for something `pdftotext` does in milliseconds —
     * measured on this vault, 765 PDFs a minute, with 18 of 20 yielding full
     * text. The other two are scans, where there is nothing to copy: those
     * return "" and the caller falls back to MinerU.
     */
    case "pdf_extract_text": {
      return (await runTool("pdftotext", ["-layout", "-enc", "UTF-8", String(args.path), "-"])) as T
    }
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
      } catch { /* no fresh cache — extract or read below */ }
      // Office/document formats → anydoc → Markdown, cached like MinerU's PDF
      // output so re-reads are free. Falls through to raw read if anydoc fails.
      const ext = extname(src).toLowerCase().replace(/^\./, "")
      if (OFFICE_EXTS.has(ext)) {
        try {
          const md = await toMarkdown(src)
          await fs.mkdir(dirname(cache), { recursive: true })
          await fs.writeFile(cache, md, "utf8")
          return md as T
        } catch (e) {
          console.warn(`[anydoc] ${basename(src)} failed, reading raw: ${String(e).slice(0, 140)}`)
        }
      }
      const grezzo = await fs.readFile(src, "utf8")
      // json/xml/yaml/html erano accettati come sorgenti ma non parsati: finivano
      // nell'indice con la loro sintassi, e per una pagina HTML questo significa
      // indicizzare `<div class="wrapper">` invece di ciò che la pagina dice.
      // Non si mette in cache: la conversione costa microsecondi e un file in
      // cache in più e' un file in piu' da invalidare.
      if (isStructuredText(ext)) return structuredToText(grezzo, ext) as T
      return grezzo as T
    }

    case "read_file_as_base64": {
      const ext = extname(String(args.path)).toLowerCase()
      if (HEIC_EXTS.has(ext)) {
        const jpeg = await heicToJpeg(String(args.path))
        if (jpeg) return { base64: jpeg.toString("base64"), mimeType: "image/jpeg" } as T
      }
      const buf = await fs.readFile(args.path)
      const mimeType = MIME_BY_EXT[ext] ?? "application/octet-stream"
      return { base64: buf.toString("base64"), mimeType } as T
    }

    case "write_file":
    case "write_file_atomic": {
      await fs.mkdir(dirname(args.path), { recursive: true })
      // D2 + D4: una pagina del wiki nasce con `id:` e `visibility:`. Non si
      // normalizza nulla di già scritto — si aggiunge solo ciò che manca.
      const contenuto = isWikiPage(args.path)
        ? ensureIdentity(args.contents, { newId: nuovoIdPagina })
        : args.contents
      // `write_file_atomic` qui scriveva come `write_file`: stesso ramo, stessa
      // `writeFile` diretta. Il nome prometteva una garanzia che headless non
      // c'era — e chi lo chiamava (la cache delle didascalie) si e' trovato il
      // file troncato a meta' scrittura con dodici lavoratori in parallelo:
      //
      //   [caption-cache] corrupt cache at .llm-wiki/image-caption-cache.json,
      //   starting empty: JSON Parse error
      //
      // Il risultato non era un errore ma uno spreco silenzioso: cache azzerata,
      // ogni immagine ridescritta da capo, e il conto all'API pagato due volte.
      // File temporaneo + fsync + rename: un kill a meta' lascia intera la
      // versione precedente invece di una troncata. E' la stessa cura gia'
      // applicata alla coda di ingest a luglio, per lo stesso identico guasto.
      if (cmd === "write_file_atomic") {
        const tmp = `${args.path}.tmp-${process.pid}-${Date.now()}`
        const fh = await fs.open(tmp, "w")
        try {
          await fh.writeFile(contenuto, "utf8")
          await fh.sync()
        } finally {
          await fh.close()
        }
        await fs.rename(tmp, args.path)
        return undefined as T
      }
      await fs.writeFile(args.path, contenuto, "utf8")
      return undefined as T
    }

    case "write_file_base64":
      await fs.mkdir(dirname(args.path), { recursive: true })
      await fs.writeFile(args.path, Buffer.from(args.base64, "base64"))
      return undefined as T

    case "create_directory":
      await fs.mkdir(args.path, { recursive: true })
      return undefined as T

    case "delete_file":
      // D5: sul vault della cliente si aggiunge, non si cancella. Una fusione
      // che cancella un file fa smettere di risolvere ogni `[[nome-morto]]`
      // **senza dare errore** — e il lint ne conta già 5.254 di rotti. I
      // candidati alla fusione vanno in un referto, non in una `rm`.
      if (isWikiPage(args.path) && appendOnlyEnabled()) {
        console.warn(
          `[policy] cancellazione rifiutata (append-only): ${args.path}. ` +
            `Per disattivare: VAULT_APPEND_ONLY=0`,
        )
        return undefined as T
      }
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

    /**
     * Pull the images out of a PDF locally.
     *
     * This used to be a no-op, because headless got its images from MinerU's
     * result zip. Now that a digital PDF is read with `pdftotext` and never
     * reaches MinerU, that arrangement would silently drop every figure — a
     * 380,000-character book with 48 illustrations came through with none.
     *
     * `pdfimages` ships in the same package as `pdftotext`: same cost (none),
     * same machine. Decorative fragments are filtered out by size, otherwise a
     * book's bullets and rules would each become a captioned "image".
     */
    case "extract_and_save_pdf_images_cmd": {
      const src = String(args.sourcePath)
      const destDir = String(args.destDir)
      const relTo = String(args.relTo)
      const MIN_EDGE = 200

      // One document must not turn into hundreds of paid captions: a trademark
      // search report came back with 833 embedded fragments. Keep the largest —
      // area is a good proxy for "this is a figure, not a rule or a glyph".
      const MAX_PER_DOC = 40

      const listing = await runTool("pdfimages", ["-list", src], 2 * 60_000)
      // columns: page num type width height ...
      const meta = new Map<string, { page: number; width: number; height: number }>()
      for (const line of listing.split("\n").slice(2)) {
        const c = line.trim().split(/\s+/)
        if (c.length < 5 || !/^\d+$/.test(c[0]) || !/^\d+$/.test(c[1])) continue
        const width = Number(c[3])
        const height = Number(c[4])
        if (width < MIN_EDGE || height < MIN_EDGE) continue
        // `-p` names files <prefix>-<page>-<num>.<ext>, both zero-padded to 3.
        meta.set(`${c[0].padStart(3, "0")}-${c[1].padStart(3, "0")}`, { page: Number(c[0]), width, height })
      }
      if (!meta.size) return [] as T

      await fs.mkdir(destDir, { recursive: true })
      const prefix = join(destDir, "img")
      // `-png` rather than `-all`: `-all` leaves fax-encoded pages as raw
      // .ccitt + .params pairs, which are not images anything can open.
      // Files already on disk when the deadline hits are still usable, so a
      // kill here degrades the result instead of losing it.
      await runTool("pdfimages", ["-png", "-p", src, prefix], 5 * 60_000)

      const files = (await fs.readdir(destDir).catch(() => [] as string[]))
        .filter((f) => /^img-\d+-\d+\.png$/.test(f))
      // Match each file to its row by the page/index in its own name, not by
      // position: the listing includes images that were filtered out, so the
      // two orders do not line up.
      const candidates: Array<{ abs: string; m: { page: number; width: number; height: number } }> = []
      for (const f of files) {
        const key = f.replace(/^img-/, "").replace(/\.png$/, "")
        const m = meta.get(key)
        const abs = join(destDir, f)
        if (!m) {
          await fs.rm(abs, { force: true })
          continue
        }
        candidates.push({ abs, m })
      }
      candidates.sort((a, b) => b.m.width * b.m.height - a.m.width * a.m.height)
      for (const extra of candidates.slice(MAX_PER_DOC)) await fs.rm(extra.abs, { force: true })

      return candidates.slice(0, MAX_PER_DOC).map((c, i) => ({
        index: i + 1,
        mimeType: "image/png",
        page: c.m.page,
        width: c.m.width,
        height: c.m.height,
        relPath: c.abs.startsWith(relTo + "/") ? c.abs.slice(relTo.length + 1) : c.abs,
        absPath: c.abs,
      })) as T
    }
    case "extract_and_save_office_images_cmd":
      // OOXML extraction is still native-only; Office files carry their text
      // through anydoc, and their figures are rarer than in PDFs.
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
