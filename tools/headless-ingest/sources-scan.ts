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

/** "raw/sources/AI/papers/x.pdf" → "AI > papers" (matches the GUI's folderContext). */
function folderContextFor(relFromSources: string): string {
  const dir = dirname(relFromSources)
  if (dir === "." || dir === "") return ""
  return dir.split("/").join(" > ")
}

/**
 * I percorsi gia' ingeriti secondo `file-snapshot.json` (le sue chiavi SONO i
 * sourcePath). Serve al caso che la sola coda non copre: un vault migrato
 * dall'interfaccia, dove i task portano id `ingest-<ts>` e i file sono gia'
 * stati lavorati — senza questo, una riscansione completa li rimetterebbe
 * tutti in lavorazione.
 *
 * ⚠️ Recuperata dal box della cliente, dove esisteva gia' e non era mai stata
 * committata. E' la quarta volta su questo progetto: il difetto (d) qui sotto
 * era stato risolto la' e non nel repo, quindi il portatile — che gira sul
 * repo — se lo e' ripreso pari pari, 225 doppioni.
 */
async function ingestedPaths(project: string): Promise<Set<string>> {
  const out = new Set<string>()
  try {
    const raw = await fs.readFile(join(project, ".llm-wiki", "file-snapshot.json"), "utf8")
    for (const k of Object.keys(JSON.parse(raw)?.files ?? {})) out.add(k)
  } catch { /* nessuno snapshot: non e' un errore */ }

  // ⚠️ `file-snapshot.json` da solo NON basta, e la prova costa cara. Sul vault
  // della cliente era fermo ad agosto con 11.004 voci mentre le fonti ingerite
  // erano 43.087. Il 17/10/2026 un clic su «Refresh» nel pannello File Sync
  // (`rescan_project_files`) ha rimesso in coda **40.456 documenti**: il 93%
  // aveva gia' una pagina. A cascata: un PDF che uccideva il processo per OOM e
  // veniva ritentato all'infinito, e una settimana senza scrivere una pagina.
  //
  // Due elenchi in piu', entrambi in `.llm-wiki/` e tenuti aggiornati dal giro
  // notturno, entrambi relativi a `raw/sources/`:
  //  · `sorgenti-ingerite.txt` — le fonti citate dal campo `sources:` delle
  //    pagine, cioe' il registro vero di cio' che e' stato ingerito;
  //  · `dropbox-ignorati.txt` — cio' che e' stato messo da parte DI PROPOSITO
  //    (scansioni, immagini, audio, formati Apple, archivi): una decisione, non
  //    una dimenticanza, e una riscansione non deve annullarla.
  // Se mancano, si ricade sul comportamento di prima: un vault senza questi
  // file non ha il problema per cui esistono.
  for (const nome of ["sorgenti-ingerite.txt", "dropbox-ignorati.txt"]) {
    try {
      const testo = await fs.readFile(join(project, ".llm-wiki", nome), "utf8")
      for (const riga of testo.split("\n")) {
        const r = riga.trim()
        if (r) out.add(r.startsWith(`${SOURCES_REL}/`) ? r : join(SOURCES_REL, r))
      }
    } catch { /* elenco assente */ }
  }
  return out
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
  const knownIds = new Set(existing.map((t) => t.id))
  // Anche per PERCORSO, non solo per id. L'id qui e' derivato (`src:<path>`),
  // ma le voci create dall'interfaccia hanno id propri — `ingest-1787662678762-7r4fey`
  // — e per quelle il confronto sugli id non trova niente: lo stesso file
  // rientrava in coda una seconda volta e veniva rilavorato.
  // Misurato sulla coda vera: **225 doppioni su 1.087 voci preesistenti**, un
  // quinto. Non da' errore, costa solo tempo e chiamate — che e' il motivo per
  // cui e' passato inosservato.
  const knownPaths = new Set(existing.map((t) => t.sourcePath))
  const ingested = await ingestedPaths(project)
  const now = Date.now()

  const additions: IngestTask[] = []
  for (const abs of files) {
    const sourcePath = join(SOURCES_REL, relative(sourcesRoot, abs))
    const id = `src:${sourcePath}`
    if (knownIds.has(id) || knownPaths.has(sourcePath) || ingested.has(sourcePath)) continue
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
