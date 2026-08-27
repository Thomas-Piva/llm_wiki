/**
 * Headless queue runner. Reads the same persisted worklist the desktop app
 * writes — `<project>/.llm-wiki/ingest-queue.json` (a bare IngestTask[]) — and
 * drives each pending task through the unchanged `autoIngest`. On the VPS the
 * GUI stays off, so this process is the sole writer of the queue file.
 *
 * Concurrency is a knob, not the default: ingest is I/O-bound (MinerU + LLM are
 * remote), so N parallel tasks overlap network waits at ~0 extra CPU. Keep it
 * low on the VPS (CPUQuota-capped), raise it on a beefy box for bulk backfill.
 */
import { promises as fs } from "node:fs"
import { join } from "node:path"
import { autoIngest } from "@/lib/ingest"
import type { LlmConfig } from "@/stores/wiki-store"
import { type IngestTask, readQueue, writeQueue } from "./queue-store"

export interface RunOptions {
  project: string
  llmConfig: LlmConfig
  concurrency?: number
  /** Skip sources larger than this many bytes (park heavy files). */
  maxSize?: number
  /** Storage O(1): delete the source file after it ingests cleanly. The
   *  wiki markdown is the durable output; originals live in the archive
   *  (Dropbox/Drive). Only deletes on status "done", never on failure. */
  deleteAfter?: boolean
  signal?: AbortSignal
}

export interface RunReport {
  processed: number
  done: number
  failed: number
  skipped: number
  deleted: number
}

async function sourceSize(project: string, task: IngestTask): Promise<number> {
  try {
    return (await fs.stat(join(project, task.sourcePath))).size
  } catch {
    return 0
  }
}

/**
 * Process one task end-to-end and return the resulting status patch. Never
 * throws: a failing source must not sink the batch.
 */
async function processTask(
  opts: RunOptions,
  task: IngestTask,
): Promise<Partial<IngestTask>> {
  const abs = join(opts.project, task.sourcePath)
  try {
    await autoIngest(
      opts.project,
      abs,
      opts.llmConfig,
      opts.signal,
      task.folderContext || undefined,
    )
    return { status: "done", error: null }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { status: "failed", error: message, retryCount: task.retryCount + 1 }
  }
}

/** Run a bounded-concurrency pool over an array. */
async function pool<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0
  const runners = Array.from({ length: Math.max(1, limit) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++]
      await worker(item)
    }
  })
  await Promise.all(runners)
}

/**
 * Drain all pending tasks once. Persists status after each task so an
 * interruption loses at most the in-flight work, not the record of what's done.
 */
export async function runQueueOnce(opts: RunOptions): Promise<RunReport> {
  const concurrency = opts.concurrency ?? 1
  const report: RunReport = { processed: 0, done: 0, failed: 0, skipped: 0, deleted: 0 }

  const tasks = await readQueue(opts.project)
  const byId = new Map(tasks.map((t) => [t.id, t]))
  const pending = tasks.filter((t) => t.status === "pending")

  // Persisting inside the pool would race; serialize writes behind one mutex.
  let writeChain: Promise<void> = Promise.resolve()
  const persist = () => {
    writeChain = writeChain.then(() => writeQueue(opts.project, [...byId.values()]))
    return writeChain
  }

  await pool(pending, concurrency, async (task) => {
    if (opts.signal?.aborted) return
    const current = byId.get(task.id)
    if (!current || current.status !== "pending") return

    if (opts.maxSize && (await sourceSize(opts.project, current)) > opts.maxSize) {
      report.skipped++
      console.error(`[queue] SKIP (>${opts.maxSize}B): ${current.sourcePath}`)
      return // leave pending: a run with a larger --max-size can pick it up
    }

    byId.set(task.id, { ...current, status: "processing" })
    await persist()

    const patch = await processTask(opts, current)
    byId.set(task.id, { ...current, ...patch })
    await persist()

    report.processed++
    if (patch.status === "done") {
      report.done++
      if (opts.deleteAfter) {
        try {
          await fs.rm(join(opts.project, current.sourcePath), { force: true })
          report.deleted++
        } catch (err) {
          // A failed delete must not fail the ingest — the page is already
          // written. Log so a full disk / permission issue is visible.
          console.error(`[queue] delete-after failed for ${current.sourcePath}: ${err instanceof Error ? err.message : err}`)
        }
      }
    } else {
      report.failed++
    }
    console.error(`[queue] ${patch.status?.toUpperCase()}: ${current.sourcePath}${patch.error ? ` — ${patch.error}` : ""}`)
  })

  await writeChain
  return report
}
