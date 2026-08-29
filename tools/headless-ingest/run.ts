/**
 * Headless ingest CLI. Points at a project, hydrates config from its
 * app-state.json (or HEADLESS_LLM_* env), scans raw/sources into the queue,
 * and drains it through the unchanged pipeline — no webview, no GUI.
 *
 *   bun --preload ./tools/headless-ingest/preload.ts \
 *     ./tools/headless-ingest/run.ts \
 *     --project /home/claude/claudewiki --scan --delete-after \
 *     --concurrency 1 [--llm-concurrency 16] --max-size 12M [--fast]
 *
 * Modes:
 *   (default)  one pass: [--scan] then drain the queue, then exit.
 *   --watch    stay up; re-scan+drain on filesystem changes under raw/sources.
 *
 * Production trigger on the VPS = a systemd (--user) timer running the default
 * one-pass mode, so idle CPU is 0. --watch is for interactive/dev use.
 */
import { watch } from "node:fs"
import { join } from "node:path"
import { loadHeadlessConfig } from "./config"
import { runQueueOnce } from "./queue-runner"
import { enqueueSources } from "./sources-scan"

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}
function has(name: string): boolean {
  return process.argv.includes(name)
}

function parseSize(s: string | undefined): number | undefined {
  if (!s) return undefined
  const m = /^(\d+(?:\.\d+)?)\s*([KMG]?)B?$/i.exec(s.trim())
  if (!m) throw new Error(`--max-size: bad value "${s}" (use e.g. 12M, 500K, 1G)`)
  const mult = { "": 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3 }[m[2].toUpperCase()]!
  return Math.floor(parseFloat(m[1]) * mult)
}

async function main() {
  const project = flag("--project")
  if (!project) throw new Error("--project <path> is required")

  const { llmConfig } = loadHeadlessConfig({ appStatePath: flag("--config") })
  const concurrency = Number(flag("--concurrency") ?? "1")
  // Classic mode waits on a remote model rather than the CPU, so it can run
  // far wider than the local pipeline without touching the cores.
  const llmConcurrency = Number(flag("--llm-concurrency") ?? String(concurrency))
  const maxSize = parseSize(flag("--max-size"))
  const deleteAfter = has("--delete-after")
  // No page written by a model: extract, store, index. See AutoIngestOptions.fast.
  const fast = has("--fast")
  // Prova D: una chiamata invece di due. Ignorato in modalità veloce, che di
  // chiamate non ne fa nessuna.
  const singleCall = has("--single-call")
  const doScan = has("--scan")

  console.error(
    `[run] project=${project} provider=${llmConfig.provider} model=${llmConfig.model} ` +
      `concurrency=${concurrency}${fast ? "" : ` llm-concurrency=${llmConcurrency}`}${maxSize ? ` max-size=${maxSize}B` : ""}` +
      `${deleteAfter ? " delete-after" : ""}${fast ? " FAST(no-llm)" : singleCall ? " UNA-CHIAMATA" : ""}${doScan ? " scan" : ""}`,
  )

  const cycle = async () => {
    if (doScan) await enqueueSources(project)
    const t0 = Date.now()
    const report = await runQueueOnce({ project, llmConfig, concurrency, llmConcurrency, maxSize, deleteAfter, fast, singleCall })
    console.error(`[run] cycle in ${Date.now() - t0}ms:`, report)
    return report
  }

  if (!has("--watch")) {
    const report = await cycle()
    // Non-zero only if everything attempted failed — a mixed batch is a success.
    process.exit(report.processed > 0 && report.done === 0 ? 1 : 0)
  }

  // Watch mode: initial pass, then debounce filesystem events under raw/sources.
  await cycle()
  const sourcesRoot = join(project, "raw/sources")
  let timer: ReturnType<typeof setTimeout> | null = null
  let running = false
  let dirty = false
  const schedule = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(async () => {
      if (running) {
        dirty = true
        return
      }
      running = true
      try {
        await cycle()
      } catch (err) {
        console.error("[run] cycle error:", err)
      } finally {
        running = false
        if (dirty) {
          dirty = false
          schedule()
        }
      }
    }, 2000)
  }
  try {
    watch(sourcesRoot, { recursive: true }, () => schedule())
    console.error(`[run] watching ${sourcesRoot} (Ctrl-C to stop)`)
  } catch (err) {
    console.error(`[run] recursive watch unavailable (${err instanceof Error ? err.message : err}); staying idle. Use a timer instead.`)
  }
}

main().catch((err) => {
  console.error("[run] FATAL:", err)
  process.exit(2)
})
