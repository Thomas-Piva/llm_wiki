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
import type { LlmConfig, SourceWatchConfig } from "@/stores/wiki-store"
import { findLlmPreset } from "@/components/settings/llm-presets"
import { resolveConfig } from "@/components/settings/preset-resolver"
import { getTaskLlmConfig } from "@/lib/llm-task-routing"
import { backfillMediaExtensions, normalizeSourceWatchConfig } from "@/lib/source-watch-config"

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
  sourceWatchConfig: SourceWatchConfig
}

/**
 * `sourceWatchConfig` ha DUE forme, e sono diverse.
 *
 *   su disco (app-state.json)   { "<projectId>": {...}, "default": {...} }
 *   nello store (wiki-store)    { maxFileSizeMb, includeExtensions, ... }
 *
 * `saveSourceWatchConfig` scrive la mappa (project-store.ts), `loadSourceWatchConfig`
 * la srotola prima di darla alla UI. L'idratazione headless copiava invece la
 * chiave così com'era, quindi nello store finiva la **mappa** dentro un campo
 * tipizzato come oggetto: ogni `sourceWatchConfig.maxFileSizeMb` letto headless
 * valeva `undefined` e ricadeva sul default, silenziosamente — il tipo diceva
 * che andava tutto bene.
 *
 * Qui si fa quello che fa `loadSourceWatchConfig`: risolvi per progetto, poi
 * `default`, poi i valori di fabbrica.
 */
export function resolveSourceWatchConfig(
  appState: Record<string, unknown>,
  projectPath?: string,
): SourceWatchConfig {
  const mappa = appState.sourceWatchConfig as Record<string, unknown> | undefined
  if (!mappa || typeof mappa !== "object") return normalizeSourceWatchConfig(undefined)

  // già srotolata (un app-state scritto da una versione che salvava piatto)
  if ("maxFileSizeMb" in mappa || "includeExtensions" in mappa) {
    return normalizeSourceWatchConfig(backfillMediaExtensions(mappa as Partial<SourceWatchConfig>))
  }

  const registro = (appState.projectRegistry ?? {}) as Record<string, { path?: string }>
  const id = projectPath
    ? Object.keys(registro).find((k) => normalizza(registro[k]?.path) === normalizza(projectPath))
    : undefined

  const voce = (id ? mappa[id] : undefined) ?? mappa.default
  if (!voce || typeof voce !== "object") return normalizeSourceWatchConfig(undefined)
  return normalizeSourceWatchConfig(backfillMediaExtensions(voce as Partial<SourceWatchConfig>))
}

/** Confronto di percorsi tollerante alla barra finale e ai separatori Windows. */
function normalizza(p: string | undefined): string {
  return (p ?? "").replace(/\\/g, "/").replace(/\/+$/, "")
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
export function loadHeadlessConfig(opts: { appStatePath?: string; projectPath?: string }): HeadlessConfig {
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
  // la mappa per progetto non è la forma che lo store dichiara: si srotola qui
  const sourceWatchConfig = resolveSourceWatchConfig(appState, opts.projectPath)
  patch.sourceWatchConfig = sourceWatchConfig
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

  return { llmConfig, appState, sourceWatchConfig }
}
