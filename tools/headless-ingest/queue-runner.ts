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
import { autoIngest, TRANSCRIPT_MISSING } from "@/lib/ingest"
import type { LlmConfig } from "@/stores/wiki-store"
import { type IngestTask, readQueue, writeQueue } from "./queue-store"
import { indexPagesInR2R } from "./r2r-search"

/** Recordings: the only inputs gated by a daily transcription allowance. */
const MEDIA_EXTENSIONS = /\.(mp3|m4a|wav|ogg|flac|aac|wma|mp4|mov|mkv|avi|webm|m4v)$/i

export interface RunOptions {
  project: string
  llmConfig: LlmConfig
  /**
   * Tasks in flight when the work is local: extraction, chunking, embedding.
   * This one is bounded by cores and RAM, and on a shared VPS it is what keeps
   * the provider's fair-use alarm quiet.
   */
  concurrency?: number
  /**
   * Tasks in flight when the work is a model writing a page.
   *
   * These are two different resources and they were sharing one knob. A full
   * classic-mode run consumed 3.9 seconds of CPU in total: it is not computing,
   * it is waiting on the network. Throttling it to protect the cores throttles
   * nothing that needed protecting, and turns days of waiting into weeks.
   * Ignored in fast mode, where no model is called per document.
   */
  llmConcurrency?: number
  /** Skip sources larger than this many bytes (park heavy files). */
  maxSize?: number
  /** Storage O(1): delete the source file after it ingests cleanly. The
   *  wiki markdown is the durable output; originals live in the archive
   *  (Dropbox/Drive). Only deletes on status "done", never on failure. */
  deleteAfter?: boolean
  /** Skip the two LLM passes; extract, write the source page, index it. */
  fast?: boolean
  /** Una chiamata invece di due: niente passo di Analisi (prova D). */
  singleCall?: boolean
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
    const written = await autoIngest(
      opts.project,
      abs,
      opts.llmConfig,
      opts.signal,
      task.folderContext || undefined,
      undefined,
      opts.fast ? { fast: true } : opts.singleCall ? { singleCall: true } : undefined,
    )
    // Put the fresh pages in the semantic index straight away, so a document is
    // searchable the moment it lands rather than at the next full reindex.
    await indexPagesInR2R(opts.project, written)
    return { status: "done", error: null }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // A daily allowance running out is not a failed document — the same file
    // transcribes fine tomorrow. Marking it "failed" would bury it: nothing
    // retries a failed task, so an evening of recordings would be lost silently
    // and look like a completed run.
    if (isDailyQuotaExhausted(message)) {
      return { status: "pending", error: message }
    }
    // Un blocco FILE tagliato a metà non è un documento rotto: è una risposta
    // che si è fermata dove finiva il budget di token. La stessa fonte,
    // rigenerata, di solito riesce — misurato: la stessa corsa sullo stesso
    // lotto dà da 8 a 53 troncamenti a seconda di come gira.
    //
    // Segnarlo `failed` lo seppelliva: `failed` è terminale, nessuno lo
    // ripesca, e le quattro pagine su cinque scritte bene restavano lì senza
    // che il documento risultasse mai completato. Torna in coda, con un tetto
    // ai tentativi perché un documento che fallisce sempre non deve girare
    // per sempre.
    if (isTruncationFailure(message) && task.retryCount < MAX_TRUNCATION_RETRIES) {
      return { status: "pending", error: message, retryCount: task.retryCount + 1 }
    }
    return { status: "failed", error: message, retryCount: task.retryCount + 1 }
  }
}

/**
 * Tre tentativi. Un troncamento va e viene con la lunghezza della risposta, e
 * tre giri bastano a coprire quella variabilità; oltre, il documento ha un
 * problema suo e continuare costa senza servire.
 */
const MAX_TRUNCATION_RETRIES = 3

/** La generazione si è fermata a metà di un blocco, non ha prodotto spazzatura. */
export function isTruncationFailure(message: string): boolean {
  return /truncated wiki file\(s\) could not be repaired/i.test(message)
}

/** Provider is out of allowance for today, as opposed to broken or refusing. */
export function isDailyQuotaExhausted(message: string): boolean {
  // The transcription step logs its own 429 and returns the raw bytes, so the
  // message that reaches here is the binary guard's, not the provider's.
  if (message.includes(TRANSCRIPT_MISSING)) return true
  return (
    /HTTP 429/.test(message) &&
    /per day|daily|ASPD|TPD|RPD/i.test(message)
  ) || /rate limit reached.*per day/i.test(message)
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
  // Local work is bounded by the box; remote work is bounded by the provider.
  const concurrency = opts.fast ? (opts.concurrency ?? 1) : (opts.llmConcurrency ?? opts.concurrency ?? 1)
  const report: RunReport = { processed: 0, done: 0, failed: 0, skipped: 0, deleted: 0 }

  // Set once the provider says "not until tomorrow"; makes the rest of this run
  // skip recordings instead of re-asking for every one of them.
  let quotaSpent = false

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

    // Once the transcription allowance is gone, every further recording costs a
    // pointless round-trip to be told the same thing. Park them and keep going
    // with documents and images — that is the whole point of separate queues.
    if (quotaSpent && MEDIA_EXTENSIONS.test(current.sourcePath)) {
      report.skipped++
      return
    }

    byId.set(task.id, { ...current, status: "processing" })
    await persist()

    const patch = await processTask(opts, current)
    if (patch.status === "pending" && isDailyQuotaExhausted(patch.error ?? "")) {
      if (!quotaSpent) {
        console.error("[queue] quota giornaliera di trascrizione esaurita — audio in pausa, il resto prosegue")
      }
      quotaSpent = true
    }
    byId.set(task.id, { ...current, ...patch })
    await persist()

    report.processed++
    if (patch.status === "pending") {
      // Parked, not finished and not broken: it stays in the queue for the
      // next run. Counting it as processed would overstate progress.
      report.processed--
      report.skipped++
    } else if (patch.status === "done") {
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
