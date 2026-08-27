/**
 * Headless config: load the desktop app's `app-state.json` and hydrate the
 * wiki-store with it, exactly as the app does at launch. The ingest pipeline
 * reads every setting (llmConfig, mineruConfig, embeddingConfig, media/source
 * watch, …) through `useWikiStore.getState()`, so hydrating the store is all
 * it takes to run with the client's real configuration — zero reconfig.
 *
 * Env overrides (HEADLESS_LLM_*) win, for CI / a box without the client's
 * app-state.json.
 */
import { existsSync, readFileSync } from "node:fs"
import { useWikiStore } from "@/stores/wiki-store"
import type { LlmConfig } from "@/stores/wiki-store"
import { findLlmPreset } from "@/components/settings/llm-presets"
import { resolveConfig } from "@/components/settings/preset-resolver"
import { getTaskLlmConfig } from "@/lib/llm-task-routing"

/** app-state.json keys that map 1:1 onto wiki-store fields. */
const HYDRATE_KEYS = [
  "llmConfig",
  "globalLlmConfig",
  "providerConfigs",
  "customLlmPresets",
  "activePresetId",
  "taskModelRouting",
  "projectLlmOverrides",
  "searchApiConfig",
  "embeddingConfig",
  "multimodalConfig",
  "proxyConfig",
  "scheduledImportConfig",
  "sourceWatchConfig",
  "mineruConfig",
  "mediaIngestConfig",
  "apiConfig",
  "generalConfig",
  "outputLanguage",
] as const

export interface HeadlessConfig {
  llmConfig: LlmConfig
  appState: Record<string, unknown>
}

function applyEnvOverrides(cfg: LlmConfig): LlmConfig {
  const e = process.env
  return {
    ...cfg,
    ...(e.HEADLESS_LLM_PROVIDER ? { provider: e.HEADLESS_LLM_PROVIDER as LlmConfig["provider"] } : {}),
    ...(e.HEADLESS_LLM_MODEL ? { model: e.HEADLESS_LLM_MODEL } : {}),
    ...(e.HEADLESS_LLM_ENDPOINT ? { customEndpoint: e.HEADLESS_LLM_ENDPOINT } : {}),
    ...(e.HEADLESS_LLM_API_KEY ? { apiKey: e.HEADLESS_LLM_API_KEY } : {}),
  }
}

/**
 * Read app-state.json (if given), push its known keys into the wiki-store,
 * resolve the effective llmConfig and return it. Immutable: never mutates the
 * loaded JSON.
 */
export function loadHeadlessConfig(opts: { appStatePath?: string }): HeadlessConfig {
  let appState: Record<string, unknown> = {}
  if (opts.appStatePath) {
    if (!existsSync(opts.appStatePath)) {
      throw new Error(`[config] app-state.json not found: ${opts.appStatePath}`)
    }
    appState = JSON.parse(readFileSync(opts.appStatePath, "utf8"))
  }

  const patch: Record<string, unknown> = {}
  for (const k of HYDRATE_KEYS) {
    // Skip nulls: a `null` in app-state (e.g. never-configured mineruConfig)
    // must NOT clobber the store's default object, or downstream reads like
    // `mineruConfig.backend` would throw on null.
    if (k in appState && appState[k] != null) patch[k] = appState[k]
  }
  if (Object.keys(patch).length > 0) {
    useWikiStore.setState(patch as never)
  }

  // Reproduce exactly what the desktop app does so "the provider I picked
  // drives the ingest" holds headless too:
  //   1) App.tsx@launch: if an active preset is set, resolve it over llmConfig
  //      (providerConfigs[presetId]) and make that the global config.
  //   2) The real ingest path (ingest-queue.ts / dedup-queue.ts) then calls
  //      getTaskLlmConfig("ingest"), which routes to the ingest-specific preset
  //      if one is configured, else falls back to the global config.
  const s = useWikiStore.getState()
  if (s.activePresetId) {
    const preset = findLlmPreset(s.activePresetId, s.customLlmPresets)
    if (preset) {
      const resolved = resolveConfig(preset, s.providerConfigs[s.activePresetId], s.llmConfig)
      useWikiStore.setState({ llmConfig: resolved } as never)
      console.error(`[config] active preset "${s.activePresetId}" → provider=${resolved.provider} model=${resolved.model}`)
    }
  }

  // getTaskLlmConfig reads the store snapshot; returns the effective INGEST
  // provider (honours taskModelRouting.ingestPresetId + projectLlmOverride).
  const llmConfig = applyEnvOverrides(getTaskLlmConfig("ingest"))
  useWikiStore.setState({ llmConfig } as never)

  return { llmConfig, appState }
}
