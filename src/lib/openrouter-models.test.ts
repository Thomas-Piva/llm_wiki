import { describe, it, expect, beforeEach, vi } from "vitest"

const mockFetch = vi.fn()
vi.mock("@/lib/tauri-fetch", () => ({
  getHttpFetch: async () => mockFetch,
}))

import { fetchOpenRouterModels, __resetOpenRouterModelCache } from "./openrouter-models"

function payload(rows: unknown[]) {
  return { ok: true, json: async () => ({ data: rows }) }
}

const FLASH = {
  id: "deepseek/deepseek-v4-flash-0731",
  name: "DeepSeek: V4 Flash",
  created: 200,
  context_length: 128_000,
  reasoning: { mandatory: false, default_enabled: true },
}
const THINKER = {
  id: "openai/o3",
  name: "OpenAI: o3",
  created: 300,
  context_length: 200_000,
  reasoning: { mandatory: true, default_enabled: true },
}
const PLAIN = { id: "meta-llama/llama-4", name: "Llama 4", created: 100, context_length: 64_000 }

describe("openrouter model catalog", () => {
  beforeEach(() => {
    __resetOpenRouterModelCache()
    mockFetch.mockReset()
  })

  it("returns models newest first", async () => {
    mockFetch.mockResolvedValue(payload([PLAIN, FLASH, THINKER]))
    const models = await fetchOpenRouterModels()
    expect(models.map((m) => m.id)).toEqual([
      "openai/o3",
      "deepseek/deepseek-v4-flash-0731",
      "meta-llama/llama-4",
    ])
  })

  it("carries the thinking flags the picker warns on", async () => {
    mockFetch.mockResolvedValue(payload([FLASH, THINKER, PLAIN]))
    const models = await fetchOpenRouterModels()
    const byId = Object.fromEntries(models.map((m) => [m.id, m]))

    // Thinking that cannot be switched off — the model stays slow for ingest
    // whatever the reasoning setting says.
    expect(byId["openai/o3"].reasoning).toEqual({ mandatory: true, defaultEnabled: true })
    // Thomas's model: off is allowed, but thinking runs unless asked otherwise.
    expect(byId["deepseek/deepseek-v4-flash-0731"].reasoning)
      .toEqual({ mandatory: false, defaultEnabled: true })
    expect(byId["meta-llama/llama-4"].reasoning).toBeNull()
  })

  it("serves a second call from cache without refetching", async () => {
    mockFetch.mockResolvedValue(payload([FLASH]))
    await fetchOpenRouterModels()
    await fetchOpenRouterModels()
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it("shares one request between concurrent callers", async () => {
    mockFetch.mockResolvedValue(payload([FLASH]))
    const [a, b] = await Promise.all([fetchOpenRouterModels(), fetchOpenRouterModels()])
    expect(mockFetch).toHaveBeenCalledTimes(1)
    expect(a).toEqual(b)
  })

  it("returns empty instead of throwing when the gateway is unreachable", async () => {
    // The picker is a shortcut over a free-text field: a failed catalog leaves
    // the preset's static chips in place rather than breaking Settings.
    mockFetch.mockRejectedValue(new Error("offline"))
    await expect(fetchOpenRouterModels()).resolves.toEqual([])
  })

  it("returns empty on a non-ok response", async () => {
    mockFetch.mockResolvedValue({ ok: false, json: async () => ({}) })
    await expect(fetchOpenRouterModels()).resolves.toEqual([])
  })

  it("skips malformed rows rather than surfacing blank entries", async () => {
    mockFetch.mockResolvedValue(payload([FLASH, null, { name: "no id" }, 42]))
    const models = await fetchOpenRouterModels()
    expect(models.map((m) => m.id)).toEqual(["deepseek/deepseek-v4-flash-0731"])
  })
})
