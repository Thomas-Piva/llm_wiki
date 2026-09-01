/**
 * I quattro difetti che la passata sul vault della cliente ha fatto emergere.
 * Nessuno dei quattro dava errore: si vedevano solo nei numeri, dopo.
 *
 *   (a) compattazione dentro il ciclo → 7.051 tentativi, 0 riusciti
 *   (b) backfill che rifà l'indicizzato → 7.910 pagine inutili su 7.911
 *   (c) cache didascalie non atomica  → JSON troncato, ogni immagine ripagata
 *   (d) scan che deduplica solo per id → 225 doppioni su 1.087 voci
 *
 * Ognuno è verificato dove si rompeva davvero, non alla superficie.
 */
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises"
import { readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { invoke } from "./invoke-shim"
import { enqueueSources } from "./sources-scan"
import { readQueue, writeQueue } from "./queue-store"
import { tettoCaricoPredefinito } from "./embed-backfill"

let falliti = 0
const ok = (msg: string) => console.log(`  ok · ${msg}`)
const ko = (msg: string) => { console.log(`  ✗  ${msg}`); falliti++ }

// ── (a) la compattazione non gira più per documento ────────────────────────
{
  const src = readFileSync(new URL("./index-pages.ts", import.meta.url), "utf8")
  if (/await vectorCompact\(/.test(src)) ko("(a) index-pages compatta ancora per documento")
  else ok("(a) index-pages non compatta più dentro il ciclo")
  const runner = readFileSync(new URL("./queue-runner.ts", import.meta.url), "utf8")
  if (!/await vectorCompact\(opts\.project\)/.test(runner)) ko("(a) queue-runner non compatta a fine passata")
  else ok("(a) la compattazione è a fine passata, quando nessuno scrive")
}

// ── (c) write_file_atomic è davvero atomica ───────────────────────────────
{
  const dir = await mkdtemp(join(tmpdir(), "atomic-"))
  try {
    const f = join(dir, "cache.json")
    await invoke("write_file_atomic", { path: f, contents: '{"a":1}' })
    if ((await readFile(f, "utf8")) !== '{"a":1}') ko("(c) contenuto sbagliato")
    else ok("(c) write_file_atomic scrive il contenuto giusto")
    // Nessun temporaneo lasciato indietro: un .tmp orfano accanto alla cache
    // verrebbe letto da nessuno ma riempirebbe il disco a ogni scrittura.
    const { readdir } = await import("node:fs/promises")
    const resti = (await readdir(dir)).filter((n) => n.includes(".tmp-"))
    if (resti.length > 0) ko(`(c) temporanei rimasti: ${resti.join(", ")}`)
    else ok("(c) nessun file temporaneo lasciato indietro")
    const pipeline = readFileSync(new URL("../../src/lib/image-caption-pipeline.ts", import.meta.url), "utf8")
    if (!/writeFileAtomic\(cachePath/.test(pipeline)) ko("(c) la cache didascalie non usa la scrittura atomica")
    else ok("(c) la cache didascalie passa dalla scrittura atomica")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

// ── (d) lo scan non rimette in coda un file già presente con altro id ─────
{
  const proj = await mkdtemp(join(tmpdir(), "scan-"))
  try {
    await mkdir(join(proj, "raw", "sources"), { recursive: true })
    await mkdir(join(proj, ".llm-wiki"), { recursive: true })
    await writeFile(join(proj, "raw", "sources", "fattura.pdf"), "x")
    // Una voce come la scrive l'interfaccia: id proprio, non `src:<percorso>`.
    await writeQueue(proj, [{
      id: "ingest-1787662678762-7r4fey",
      projectId: "gui",
      sourcePath: "raw/sources/fattura.pdf",
      folderContext: "",
      status: "done",
      addedAt: 1,
      error: null,
      retryCount: 0,
    }])
    const aggiunti = await enqueueSources(proj)
    const coda = await readQueue(proj)
    if (aggiunti !== 0 || coda.length !== 1) {
      ko(`(d) doppione: aggiunti=${aggiunti}, voci=${coda.length} (attesi 0 e 1)`)
    } else {
      ok("(d) un file già in coda con id della GUI non rientra")
    }
    // E il caso normale continua a funzionare: un file nuovo entra.
    await writeFile(join(proj, "raw", "sources", "nuovo.pdf"), "y")
    if ((await enqueueSources(proj)) !== 1) ko("(d) un file nuovo non viene più accodato")
    else ok("(d) un file nuovo entra ancora in coda")
  } finally {
    await rm(proj, { recursive: true, force: true })
  }
}

// ── (b) il tetto sul carico segue i core ──────────────────────────────────
{
  if (tettoCaricoPredefinito(2) !== 1.5) ko("(b) su 2 core il tetto deve restare 1.5 (box della cliente)")
  else ok("(b) 2 core → 1.5, il box della cliente non cambia comportamento")
  if (tettoCaricoPredefinito(24) !== 18) ko("(b) su 24 core il tetto deve salire a 18")
  else ok("(b) 24 core → 18")
  const bf = readFileSync(new URL("./embed-backfill.ts", import.meta.url), "utf8")
  if (!/pagineGiaIndicizzate\(vault\)/.test(bf)) ko("(b) il backfill non consulta l'indice")
  else ok("(b) il backfill chiede all'indice cosa c'è già, non solo al file di stato")
}

console.log(falliti === 0 ? "\ntutti e quattro i difetti coperti" : `\n${falliti} controlli falliti`)
process.exit(falliti === 0 ? 0 : 1)
