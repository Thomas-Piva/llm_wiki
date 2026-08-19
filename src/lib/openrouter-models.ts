/**
 * Live model catalog for OpenRouter.
 *
 * The preset ships a short hand-written list, which goes stale: OpenRouter
 * fronts 400+ models and rotates them constantly, so a pinned id eventually
 * points at something retired. This asks the gateway what it actually serves
 * today (`GET /api/v1/models`, public — no key needed) and hands the ids to the
 * model picker.
 *
 * Failure is not an error state worth surfacing: the picker is a shortcut over
 * a free-text field, so a failed fetch just falls back to the preset's static
 * list and the user can still type any id.
 */
import { getHttpFetch } from "@/lib/tauri-fetch"

const MODELS_URL = "https://openrouter.ai/api/v1/models"
/** Catalog is stable over a session; refetch at most this often. */
const CACHE_TTL_MS = 30 * 60 * 1000

export interface OpenRouterModel {
  id: string
  name: string
  contextLength: number | null
  /** Present when the model can think; absent for plain completion models. */
  reasoning: {
    /** Thinking cannot be turned off — reasoning-off requests will fail. */
    mandatory: boolean
    /** Thinking runs unless the request says otherwise. */
    defaultEnabled: boolean
  } | null
}

let cache: { at: number; models: OpenRouterModel[] } | null = null
let inFlight: Promise<OpenRouterModel[]> | null = null

function parseModel(raw: unknown): OpenRouterModel | null {
  if (typeof raw !== "object" || raw === null) return null
  const obj = raw as Record<string, unknown>
  const id = typeof obj.id === "string" ? obj.id.trim() : ""
  if (!id) return null

  const rawReasoning = obj.reasoning
  const reasoning = typeof rawReasoning === "object" && rawReasoning !== null
    ? {
        mandatory: (rawReasoning as Record<string, unknown>).mandatory === true,
        defaultEnabled: (rawReasoning as Record<string, unknown>).default_enabled === true,
      }
    : null

  return {
    id,
    name: typeof obj.name === "string" && obj.name.trim() ? obj.name.trim() : id,
    contextLength: typeof obj.context_length === "number" ? obj.context_length : null,
    reasoning,
  }
}

/**
 * Fetch the catalog, newest first. Concurrent calls share one request, and a
 * fetched list is reused for CACHE_TTL_MS. Returns [] rather than throwing.
 */
export async function fetchOpenRouterModels(signal?: AbortSignal): Promise<OpenRouterModel[]> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.models
  if (inFlight) return inFlight

  inFlight = (async () => {
    try {
      const httpFetch = await getHttpFetch()
      const res = await httpFetch(MODELS_URL, { signal })
      if (!res.ok) return cache?.models ?? []
      const payload = await res.json() as { data?: unknown }
      const rows = Array.isArray(payload.data) ? payload.data : []
      // `created` is a unix timestamp; newest first puts current models in the
      // first screenful, which is what a picker capped at a dozen chips shows.
      const models = rows
        .map((row) => ({
          model: parseModel(row),
          created: typeof (row as Record<string, unknown>)?.created === "number"
            ? (row as Record<string, unknown>).created as number
            : 0,
        }))
        .filter((entry): entry is { model: OpenRouterModel; created: number } => entry.model !== null)
        .sort((a, b) => b.created - a.created)
        .map((entry) => entry.model)

      if (models.length > 0) cache = { at: Date.now(), models }
      return models
    } catch {
      return cache?.models ?? []
    } finally {
      inFlight = null
    }
  })()

  return inFlight
}

/** Test seam: drop the cached catalog. */
export function __resetOpenRouterModelCache(): void {
  cache = null
  inFlight = null
}
