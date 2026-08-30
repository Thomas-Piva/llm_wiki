/**
 * Backfill the native vector index, one page at a time, resumably.
 *
 * `embedAllPages` walks the whole tree in one pass. On a 10.783-page vault that
 * is roughly five hours of saturated CPU, and an interruption at hour four
 * throws away hour four: the function has progress reporting but no memory of
 * what it already did. On a box shared with a service that must stay
 * responsive, a job that cannot be stopped is a job that cannot be run.
 *
 * So the walk lives here and the work stays there: every page goes through the
 * unchanged `embedPage`, which is what writes the row shape `searchByEmbedding`
 * expects. Re-implementing the writer would risk an index the reader cannot
 * use — the bug would surface as "search finds nothing", days later.
 *
 * Two guards make it safe to leave running on someone else's machine:
 *
 *   - **load**: before each page, if the 1-minute load average is above the
 *     ceiling, wait. The box runs WhatsApp for a client; a backfill that
 *     starves it is worse than no backfill.
 *   - **window**: `--max-minutes` stops cleanly at the end of a nightly slot,
 *     leaving state on disk for the next run.
 *
 * State is written through a temp file and renamed, so a kill mid-write leaves
 * the previous state intact rather than a truncated one.
 */
import { promises as fs } from "node:fs"
import { readFileSync } from "node:fs"
import { join, relative } from "node:path"

import { createAsyncLimiter, embedPage, isDerivedPage } from "@/lib/embedding"
import { useWikiStore } from "@/stores/wiki-store"
import { loadHeadlessConfig } from "./config"
import { vectorCompact } from "./vector-store"

interface BackfillState {
  /** pageIds already indexed. The whole point of the file. */
  done: string[]
  /** pageId → last error. Retried on the next run; a page that always fails is visible. */
  failed: Record<string, string>
  startedAt: string
  updatedAt: string
  charsDone: number
}

const EMPTY: BackfillState = {
  done: [], failed: {}, startedAt: "", updatedAt: "", charsDone: 0,
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}

export function statePath(vault: string): string {
  return join(vault, ".llm-wiki", "embed-backfill.json")
}

/**
 * What is still to do, given what the state file remembers.
 *
 * Kept pure and exported because it is the one piece whose failure is silent:
 * get it wrong and the job restarts from zero after four hours, which looks
 * exactly like a job that is simply slow.
 */
export function pagesToDo<T extends { pageId: string }>(
  pages: T[],
  state: Pick<BackfillState, "done">,
): T[] {
  const done = new Set(state.done)
  return pages.filter((p) => !done.has(p.pageId))
}

export async function readState(vault: string): Promise<BackfillState> {
  try {
    const raw = await fs.readFile(statePath(vault), "utf8")
    return { ...EMPTY, ...(JSON.parse(raw) as Partial<BackfillState>) }
  } catch {
    return { ...EMPTY, startedAt: new Date().toISOString() }
  }
}

export async function writeState(vault: string, s: BackfillState): Promise<void> {
  const p = statePath(vault)
  await fs.mkdir(join(vault, ".llm-wiki"), { recursive: true })
  const tmp = `${p}.tmp`
  await fs.writeFile(tmp, JSON.stringify({ ...s, updatedAt: new Date().toISOString() }, null, 1))
  await fs.rename(tmp, p)   // atomico: un kill a metà lascia intatto il precedente
}

/** Every `.md` under `wiki/`, as pageIds relative to that root. */
export async function wikiPages(vault: string): Promise<{ pageId: string; abs: string }[]> {
  const root = join(vault, "wiki")
  const out: { pageId: string; abs: string }[] = []
  async function walk(dir: string): Promise<void> {
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = join(dir, e.name)
      if (e.isDirectory()) await walk(p)
      else if (e.name.endsWith(".md")) {
        out.push({ pageId: relative(root, p).replace(/\.md$/i, ""), abs: p })
      }
    }
  }
  await walk(root)
  out.sort((a, b) => a.pageId.localeCompare(b.pageId))
  return out
}

function loadAvg1(): number {
  try {
    return Number(readFileSync("/proc/loadavg", "utf8").split(" ")[0])
  } catch {
    return 0    // non Linux: nessun freno, ma nemmeno un falso allarme
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Waits until the box is calm enough, or gives up on the deadline. */
async function waitForQuiet(ceiling: number, deadline: number): Promise<boolean> {
  let waited = 0
  while (loadAvg1() > ceiling) {
    if (Date.now() > deadline) return false
    if (waited === 0) console.error(`[backfill] carico ${loadAvg1().toFixed(2)} > ${ceiling}: attendo`)
    await sleep(15_000)
    waited += 15
    if (waited >= 600) {           // dieci minuti di attesa: qualcosa di grosso sta girando
      console.error("[backfill] il box resta carico da 10 minuti, mi fermo per oggi")
      return false
    }
  }
  return true
}

async function main() {
  const vault = arg("--project") ?? process.env.HEADLESS_PROJECT
  if (!vault) throw new Error("serve --project <percorso del vault>")

  const maxMinutes = Number(arg("--max-minutes") ?? "0")
  const loadCeiling = Number(arg("--max-load") ?? "1.5")
  const saveEvery = Number(arg("--save-every") ?? "20")
  // 250: abbastanza raro da non pesare, abbastanza spesso da non far
  // accumulare i frammenti che rendono quadratica la scrittura
  const compactEvery = Number(arg("--compact-every") ?? "250")
  const deadline = maxMinutes > 0 ? Date.now() + maxMinutes * 60_000 : Number.POSITIVE_INFINITY

  // `--config`, come run.ts e gli altri punti d'ingresso headless
  loadHeadlessConfig({ appStatePath: arg("--config") })
  const cfg = useWikiStore.getState().embeddingConfig
  if (!cfg?.enabled || !cfg.model) {
    throw new Error("embeddingConfig assente o disattivato in app-state.json")
  }

  // La concorrenza vale sull'HTTP verso il servizio di embedding, non sulle
  // scritture: quelle vector-store le serializza già per vault. Senza,
  // 24 core stanno fermi ad aspettare una risposta per volta.
  const concorrenza = Number(arg("--concurrency") ?? cfg?.concurrency ?? "8")

  // Una pagina enorme non costa solo il suo tempo: diventa **una sola richiesta**
  // con migliaia di pezzi, e il servizio di embedding la macina tutta prima di
  // accettarne altre — quindi tutti i canali in parallelo restano fermi ad
  // aspettarla. Misurato su questo vault: **144 pagine sopra i 200 KB (85 MB)
  // tenevano in ostaggio le altre 2.630 (21 MB)**, il 5% dei file per l'80% del
  // lavoro.
  //
  // `--max-kb` fa una passata sulle piccole, che finisce in minuti e rende
  // l'indice già utile; i libri si riprendono dopo, senza soglia, mentre il
  // resto è già interrogabile. Non è una scorciatoia: è smettere di lasciare
  // che l'ordine alfabetico decida cosa viene prima.
  const maxKb = Number(arg("--max-kb") ?? "0")

  const tutte = await wikiPages(vault)
  // Stesso filtro di embedAllPages, non una copia: `isDerivedPage` vive in
  // embedding.ts ed è l'unica lista. Una copia che dimentica `purpose` o
  // `schema` sembra identica finché non lo è.
  const pages = tutte.filter((p) => !isDerivedPage(p.pageId))
  const scartate = tutte.length - pages.length
  const state = await readState(vault)
  const done = new Set(state.done)
  let todo = pages.filter((p) => !done.has(p.pageId))
  let rimandate = 0
  if (maxKb > 0) {
    const prima = todo.length
    const misurate = await Promise.all(todo.map(async (p) => {
      try {
        return { p, kb: (await fs.stat(p.abs)).size / 1024 }
      } catch {
        return { p, kb: 0 }   // illeggibile: la lascia passare, fallirà con un messaggio
      }
    }))
    todo = misurate.filter((m) => m.kb <= maxKb).map((m) => m.p)
    rimandate = prima - todo.length
  }

  console.error(
    `[backfill] ${pages.length} pagine · ${done.size} già fatte · ${todo.length} da fare` +
    (scartate ? ` · ${scartate} derivate escluse` : "") +
    (rimandate ? ` · ${rimandate} sopra ${maxKb} KB rimandate` : "") +
    ` · ${concorrenza} in parallelo` +
    (maxMinutes ? ` · finestra ${maxMinutes} min` : "") +
    ` · tetto carico ${loadCeiling}`,
  )

  let fatte = 0
  let fermato = false
  const stop = async (why: string) => {
    fermato = true
    console.error(`[backfill] ${why}`)
    await writeState(vault, { ...state, done: [...done] })
  }
  process.on("SIGINT", () => void stop("interrotto").then(() => process.exit(0)))
  process.on("SIGTERM", () => void stop("terminato").then(() => process.exit(0)))

  const limita = createAsyncLimiter(concorrenza)
  const grandeKb = Number(arg("--warn-kb") ?? "200")

  async function lavora(pageId: string, abs: string): Promise<void> {
    if (fermato || Date.now() > deadline) return
    if (!(await waitForQuiet(loadCeiling, deadline))) { fermato = true; return }

    let content: string
    try {
      content = await fs.readFile(abs, "utf8")
    } catch (err) {
      state.failed[pageId] = `lettura: ${err instanceof Error ? err.message : String(err)}`
      return
    }

    // Una pagina fuori scala si annuncia prima di essere lavorata. `log.md` a
    // 988 KB contro una media di 12 aveva tenuto la coda per due ore, e dal
    // fuori sembrava un blocco: si vedeva solo che non avanzava più.
    const kb = content.length / 1024
    if (kb > grandeKb) {
      console.error(`[backfill] pagina grande: ${pageId} — ${kb.toFixed(0)} KB, ci vorrà`)
    }

    try {
      // deferOptimization: la compattazione si fa a intervalli, non a ogni
      // pagina — rifarebbe lo stesso lavoro diecimila volte.
      const ok = await embedPage(vault, pageId, pageId.split("/").pop() ?? pageId, content, cfg,
        { deferOptimization: true })
      if (ok) {
        done.add(pageId)
        delete state.failed[pageId]
        state.charsDone += content.length
      } else {
        state.failed[pageId] = "embedPage ha restituito false (nessun pezzo indicizzabile)"
      }
    } catch (err) {
      // non si inghiotte: si registra e si prosegue, tornerà al prossimo giro
      state.failed[pageId] = err instanceof Error ? err.message : String(err)
      console.error(`[backfill] ERRORE ${pageId}: ${state.failed[pageId].slice(0, 120)}`)
    }

    fatte++
    if (fatte % compactEvery === 0) {
      const t0 = Date.now()
      try {
        const r = await vectorCompact(vault)
        console.error(`[backfill] compattato in ${((Date.now() - t0) / 1000).toFixed(0)}s` +
          (r ? ` · ${r.fileRimossi} file rimossi` : ""))
      } catch (err) {
        console.error(`[backfill] compattazione fallita: ${err instanceof Error ? err.message : err}`)
      }
    }
    if (fatte % saveEvery === 0) {
      await writeState(vault, { ...state, done: [...done] })
      console.error(`[backfill] ${done.size}/${pages.length} ` +
        `(${((done.size / pages.length) * 100).toFixed(1)}%) · ` +
        `${Object.keys(state.failed).length} falliti · carico ${loadAvg1().toFixed(2)}`)
    }
  }

  await Promise.all(todo.map(({ pageId, abs }) => limita(() => lavora(pageId, abs))))

  await writeState(vault, { ...state, done: [...done] })
  try {
    const r = await vectorCompact(vault)
    console.error(`[backfill] compattazione finale${r ? ` · ${r.fileRimossi} file rimossi` : ""}`)
  } catch (err) {
    console.error(`[backfill] compattazione finale fallita: ${err instanceof Error ? err.message : err}`)
  }
  const rimasti = pages.length - done.size
  console.error(
    `[backfill] fine: ${done.size}/${pages.length} indicizzate · ` +
    `${Object.keys(state.failed).length} falliti · ${rimasti} rimaste`,
  )
  if (rimasti === 0) {
    console.error("[backfill] allineamento completo — si può passare a LanceDB")
  }
}

if (process.argv.some((a) => a.includes("embed-backfill"))) {
  main().catch((err) => {
    console.error(`[backfill] ${err instanceof Error ? err.message : err}`)
    process.exit(1)
  })
}
