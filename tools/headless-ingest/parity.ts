/**
 * Fase 1 — Step B: real-model parity. Ingest ONE real source through the
 * headless harness with a real LLM, so its output can be diffed against the
 * GUI-generated page for the same source. Proves the harness produces an
 * equivalent page through the same pipeline (not just that the plumbing runs).
 *
 * No mock: SPIKE_MOCK_LLM must be UNSET so streamChat hits the real endpoint.
 * Config comes from HEADLESS_LLM_* env (provider/model/endpoint/key).
 *
 *   PARITY_PROJECT=/tmp/parity/fenice \
 *   PARITY_SOURCE=/tmp/parity/fenice/raw/sources/<file> \
 *   HEADLESS_LLM_PROVIDER=custom HEADLESS_LLM_MODEL=deepseek/deepseek-v4-flash \
 *   HEADLESS_LLM_ENDPOINT=https://openrouter.ai/api/v1/chat/completions \
 *   HEADLESS_LLM_API_KEY=... \
 *   bun --preload ./tools/headless-ingest/preload.ts ./tools/headless-ingest/parity.ts
 */
import { autoIngest } from "@/lib/ingest"
import { loadHeadlessConfig } from "./config"

async function main() {
  const project = process.env.PARITY_PROJECT
  const source = process.env.PARITY_SOURCE
  if (!project || !source) throw new Error("PARITY_PROJECT and PARITY_SOURCE env are required")

  const { llmConfig } = loadHeadlessConfig({})
  console.error(`[parity] provider=${llmConfig.provider} model=${llmConfig.model} endpoint=${llmConfig.customEndpoint}`)
  console.error(`[parity] project=${project}`)
  console.error(`[parity] source=${source}`)

  const written: string[] = []
  const t0 = Date.now()
  const result = await autoIngest(project, source, llmConfig, undefined, undefined, (rel) => {
    written.push(rel)
    console.error(`[parity]   written: ${rel}`)
  })
  console.error(`[parity] done in ${((Date.now() - t0) / 1000).toFixed(1)}s — ${result.length} path(s)`)
  process.exit(result.length > 0 ? 0 : 1)
}

main().catch((err) => {
  console.error("[parity] THREW:", err)
  process.exit(2)
})
