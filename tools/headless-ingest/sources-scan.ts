/**
 * Populate the ingest queue from the filesystem, so the headless engine does
 * not depend on the GUI to enqueue work. Walks `<project>/raw/sources`, and for
 * every file not already queued, appends a pending task.
 *
 * Task ids are DERIVED from the source path (`src:<relpath>`) so re-scans are
 * idempotent: a file that's already done/pending/failed is never duplicated.
 * autoIngest itself skips unchanged sources via its content cache, so
 * re-queuing a done file that later changes is safe and cheap.
 */
import { promises as fs } from "node:fs"
import { join, relative, dirname, basename } from "node:path"
import { type IngestTask, readQueue, writeQueue } from "./queue-store"

const SOURCES_REL = "raw/sources"

/**
 * Vault-relative paths of files already ingested (file-snapshot keys ARE the
 * sourcePath). Used to skip re-queuing work that's done — critical on a vault
 * migrated from the GUI, whose queue tasks carry `ingest-<ts>` ids that would
 * never match our `src:<relpath>` ids, so id-only dedup would re-enqueue
 * everything. Deduping by path + snapshot makes a full re-scan idempotent.
 */
async function ingestedPaths(project: string): Promise<Set<string>> {
  try {
    const raw = await fs.readFile(join(project, ".llm-wiki", "file-snapshot.json"), "utf8")
    return new Set(Object.keys(JSON.parse(raw)?.files ?? {}))
  } catch {
    return new Set()
  }
}

/** "raw/sources/AI/papers/x.pdf" → "AI > papers" (matches the GUI's folderContext). */
function folderContextFor(relFromSources: string): string {
  const dir = dirname(relFromSources)
  if (dir === "." || dir === "") return ""
  return dir.split("/").join(" > ")
}

async function walkFiles(dir: string, acc: string[]): Promise<void> {
  let entries: Awaited<ReturnType<typeof fs.readdir>>
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (e.name.startsWith(".")) continue // .cache, dotfiles
    const full = join(dir, e.name)
    if (e.isDirectory()) await walkFiles(full, acc)
    else if (e.isFile()) acc.push(full)
  }
}

/**
 * Scan raw/sources and append pending tasks for any new files. Returns the
 * number of tasks added.
 */
export async function enqueueSources(project: string): Promise<number> {
  const sourcesRoot = join(project, SOURCES_REL)
  const files: string[] = []
  await walkFiles(sourcesRoot, files)

  const existing = await readQueue(project)
  const knownPaths = new Set(existing.map((t) => t.sourcePath))
  const ingested = await ingestedPaths(project)
  const now = Date.now()

  const additions: IngestTask[] = []
  for (const abs of files) {
    const sourcePath = join(SOURCES_REL, relative(sourcesRoot, abs))
    // Dedup by PATH (not id) + skip already-ingested, so a migrated vault's
    // `ingest-<ts>` tasks and done files don't get re-queued as `src:` dupes.
    if (knownPaths.has(sourcePath) || ingested.has(sourcePath)) continue
    const id = `src:${sourcePath}`
    additions.push({
      id,
      projectId: "headless",
      sourcePath,
      folderContext: folderContextFor(relative(sourcesRoot, abs)),
      status: "pending",
      addedAt: now,
      error: null,
      retryCount: 0,
    })
  }

  if (additions.length > 0) {
    await writeQueue(project, [...existing, ...additions])
    console.error(`[scan] enqueued ${additions.length} new source(s) from ${SOURCES_REL}/`)
  } else {
    console.error(`[scan] no new sources under ${SOURCES_REL}/ (${basename(project)})`)
  }
  return additions.length
}

/**
 * Enqueue ONE known source by its vault-relative path (e.g. "raw/sources/foo.pdf")
 * without walking the whole sources tree — the O(1) path for a single upload or
 * web clip. Returns false if it's already queued.
 */
export async function enqueueOne(project: string, relPath: string): Promise<boolean> {
  const existing = await readQueue(project)
  const id = `src:${relPath}`
  if (existing.some((t) => t.id === id)) return false
  const relFromSources = relPath.startsWith(`${SOURCES_REL}/`)
    ? relPath.slice(SOURCES_REL.length + 1)
    : relPath
  const task: IngestTask = {
    id,
    projectId: "headless",
    sourcePath: relPath,
    folderContext: folderContextFor(relFromSources),
    status: "pending",
    addedAt: Date.now(),
    error: null,
    retryCount: 0,
  }
  await writeQueue(project, [...existing, task])
  return true
}
