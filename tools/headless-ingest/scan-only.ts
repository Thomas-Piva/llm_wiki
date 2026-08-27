/**
 * Enqueue-only entrypoint: scan `<project>/raw/sources` and append pending tasks
 * for any new files, WITHOUT draining. This replaces the retired GUI Source Watch
 * for the Dropbox auto-feed (ingest-runner copies a folder, then calls this to
 * queue it); the CPU-capped `llm-wiki-ingest` service does the actual draining.
 *
 * Usage: bun tools/headless-ingest/scan-only.ts <project-abs-path>
 */
import { enqueueSources } from "./sources-scan"

const project = process.argv[2] || process.env.VAULT || process.cwd()
const n = await enqueueSources(project)
console.log(`[scan-only] enqueued ${n} new source(s) for ${project}`)
