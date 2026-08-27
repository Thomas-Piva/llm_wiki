/**
 * Fase 1 — feasibility spike.
 *
 * Goal: prove `ingest.ts` runs OUTSIDE the WebKit webview. We import the real
 * `autoIngest`, feed it one tiny text source through the Node fs shim, and let
 * a mock LLM stand in for the model. Success = a wiki page written to disk by
 * the unmodified pipeline. That validates the shim approach before building
 * the full headless engine (Fase 2).
 *
 * Run:
 *   SPIKE_MOCK_LLM=1 bun --preload ./tools/headless-ingest/preload.ts \
 *     ./tools/headless-ingest/spike.ts
 */
import { promises as fs } from "node:fs"
import { join } from "node:path"
import { autoIngest } from "@/lib/ingest"
import type { LlmConfig } from "@/stores/wiki-store"

const PROJECT = "/tmp/headless-spike/proj"
const SOURCE_REL = "raw/sources/nota-di-prova.txt"

const llmConfig: LlmConfig = {
  provider: "custom",
  apiKey: "mock-key",
  model: "mock-model",
  ollamaUrl: "",
  customEndpoint: "http://mock.local/v1/chat/completions",
  maxContextSize: 128_000,
  apiMode: "chat_completions",
  streamingEnabled: true,
  requestTimeoutMinutes: 5,
}

async function scaffold(): Promise<string> {
  await fs.rm(PROJECT, { recursive: true, force: true })
  await fs.mkdir(join(PROJECT, "raw/sources"), { recursive: true })
  await fs.mkdir(join(PROJECT, "wiki"), { recursive: true })
  const source = join(PROJECT, SOURCE_REL)
  await fs.writeFile(
    source,
    "Nota di prova per l'ingest headless.\n\n" +
      "Questa nota serve a verificare che la pipeline di ingest generi una pagina wiki " +
      "fuori dalla webview. Deve produrre un file markdown collegato all'indice.\n",
    "utf8",
  )
  return source
}

async function listWiki(): Promise<string[]> {
  const dir = join(PROJECT, "wiki")
  const out: string[] = []
  async function walk(d: string) {
    for (const e of await fs.readdir(d, { withFileTypes: true })) {
      const full = join(d, e.name)
      if (e.isDirectory()) await walk(full)
      else out.push(full)
    }
  }
  await walk(dir).catch(() => {})
  return out
}

async function main() {
  const source = await scaffold()
  console.error(`[spike] project=${PROJECT}`)
  console.error(`[spike] source=${source}`)

  const written: string[] = []
  const t0 = Date.now()
  const result = await autoIngest(
    PROJECT,
    source,
    llmConfig,
    undefined,
    undefined,
    (rel) => {
      written.push(rel)
      console.error(`[spike]   onFileWritten: ${rel}`)
    },
  )
  const ms = Date.now() - t0

  console.error(`\n[spike] autoIngest returned ${result.length} path(s) in ${ms}ms:`)
  for (const r of result) console.error(`[spike]   ${r}`)

  const wikiFiles = await listWiki()
  console.error(`\n[spike] files under wiki/ (${wikiFiles.length}):`)
  for (const f of wikiFiles) console.error(`[spike]   ${f}`)

  const page = wikiFiles.find((f) => f.endsWith("hello-headless.md"))
  if (page) {
    console.error(`\n[spike] ---- ${page} ----`)
    console.error(await fs.readFile(page, "utf8"))
  }

  const ok = result.length > 0 && wikiFiles.length > 0
  console.error(`\n[spike] RESULT: ${ok ? "PASS ✅ (page written headless)" : "FAIL ❌ (no page written)"}`)
  process.exit(ok ? 0 : 1)
}

main().catch((err) => {
  console.error("\n[spike] THREW:", err)
  process.exit(2)
})
