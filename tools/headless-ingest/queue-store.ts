/**
 * Shared access to the persisted ingest worklist
 * (`<project>/.llm-wiki/ingest-queue.json`) — the same file the desktop app
 * writes. Kept tiny and dependency-free so both the queue runner and the
 * source scanner read/write one consistent shape.
 */
import { promises as fs } from "node:fs"
import { join, dirname } from "node:path"

/** Mirror of ingest-queue.ts IngestTask — the on-disk shape. */
export interface IngestTask {
  id: string
  projectId: string
  sourcePath: string // relative to project, e.g. "raw/sources/a/b.pdf"
  folderContext: string
  status: "pending" | "processing" | "done" | "failed" | "cancelled"
  addedAt: number
  error: string | null
  retryCount: number
  autoStart?: boolean
}

const QUEUE_REL = ".llm-wiki/ingest-queue.json"

export function queuePath(project: string): string {
  return join(project, QUEUE_REL)
}

export function queueBackupPath(project: string): string {
  return `${queuePath(project)}.bak`
}

function parseTasks(raw: string): IngestTask[] {
  const parsed = JSON.parse(raw)
  return Array.isArray(parsed) ? parsed : (parsed.tasks ?? [])
}

/**
 * Read the worklist. Missing file means an empty queue; **unreadable file does
 * not**.
 *
 * ⛔ This used to be one `catch { return [] }`, and the caller writes whatever
 * it read straight back — so a single bad read did not degrade, it **deleted**.
 * It happened on a client's box: 1,087 entries became a 3-byte `[]` because an
 * external script rewrote the file in place and a run read it mid-write. No
 * error, no log, no way to notice until someone counted.
 *
 * Now the two cases are told apart. No file at all is a legitimately empty
 * queue. A file that exists but will not parse is a fault: try the backup, and
 * if that fails too, throw — the run stops and the queue survives. A stopped
 * ingest is visible and resumes on its own; a deleted queue is neither.
 */
export async function readQueue(project: string): Promise<IngestTask[]> {
  const p = queuePath(project)
  const bak = queueBackupPath(project)

  let raw: string
  try {
    raw = await fs.readFile(p, "utf8")
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(`[queue] ${p} non leggibile: ${(err as Error).message}`)
    }
    // Nessun file. È la coda vuota del primo avvio — a meno che un backup
    // esista, nel qual caso il file c'era e non c'è più: quello va recuperato,
    // non ignorato.
    try {
      return parseTasks(await fs.readFile(bak, "utf8"))
    } catch {
      return []
    }
  }

  try {
    return parseTasks(raw)
  } catch (err) {
    const motivo = (err as Error).message
    try {
      const recuperata = parseTasks(await fs.readFile(bak, "utf8"))
      console.warn(`[queue] ${p} illeggibile (${motivo}) — ripreso dal backup: ${recuperata.length} voci`)
      return recuperata
    } catch {
      throw new Error(
        `[queue] ${p} esiste ma non si legge (${motivo}) e il backup non aiuta. ` +
          `Mi fermo invece di sovrascriverlo: la coda resta dov'è.`,
      )
    }
  }
}

/**
 * Atomic write: temp file, fsync, rename — so a crash or a concurrent read
 * never sees half a queue.
 *
 * `fsync` before the rename because rename is atomic for *visibility*, not for
 * durability: without it the metadata can land before the bytes, and a power
 * cut leaves a file that exists and is empty.
 *
 * The previous copy is kept as `.bak`, which is what makes the recovery in
 * `readQueue` more than a dead branch.
 */
export async function writeQueue(project: string, tasks: IngestTask[]): Promise<void> {
  const p = queuePath(project)
  await fs.mkdir(dirname(p), { recursive: true })

  // Il backup è la copia *precedente*, presa prima di toccare il file. Se manca
  // non è un errore: è la prima scrittura.
  await fs.copyFile(p, queueBackupPath(project)).catch(() => {})

  const tmp = `${p}.tmp-${process.pid}`
  const handle = await fs.open(tmp, "w")
  try {
    await handle.writeFile(JSON.stringify(tasks, null, 2), "utf8")
    await handle.sync()
  } finally {
    await handle.close()
  }
  await fs.rename(tmp, p)
}
