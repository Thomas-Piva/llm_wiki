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

export async function readQueue(project: string): Promise<IngestTask[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(queuePath(project), "utf8"))
    return Array.isArray(parsed) ? parsed : (parsed.tasks ?? [])
  } catch {
    return []
  }
}

/** Atomic write: temp file + rename, so a crash never leaves a half queue. */
export async function writeQueue(project: string, tasks: IngestTask[]): Promise<void> {
  const p = queuePath(project)
  await fs.mkdir(dirname(p), { recursive: true })
  const tmp = `${p}.tmp-${process.pid}`
  await fs.writeFile(tmp, JSON.stringify(tasks, null, 2), "utf8")
  await fs.rename(tmp, p)
}
