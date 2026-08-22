import { describe, expect, it } from "vitest"
import { resolveIngestReasoning } from "./reasoning-capabilities"
import { getProviderConfig } from "./llm-providers"
import { resolveConfig } from "@/components/settings/preset-resolver"
import type { LlmConfig } from "@/stores/wiki-store"

const openRouter: LlmConfig = {
  provider: "custom",
  apiKey: "k",
  model: "openai/gpt-5.6-luna",
  ollamaUrl: "",
  customEndpoint: "https://openrouter.ai/api/v1",
  maxContextSize: 128000,
  apiMode: "chat_completions",
}

describe("ingest reasoning is settable instead of hardcoded off", () => {
  it("defaults to off, preserving the behaviour ingest had when it was hardcoded", () => {
    expect(resolveIngestReasoning(openRouter)).toEqual({ mode: "off" })
  })

  it("uses the configured mode when the user picks one", () => {
    expect(resolveIngestReasoning({ ...openRouter, ingestReasoning: { mode: "low" } }))
      .toEqual({ mode: "low" })
  })

  it("keeps chat reasoning independent of ingest reasoning", () => {
    const config: LlmConfig = {
      ...openRouter,
      reasoning: { mode: "high" },
      ingestReasoning: { mode: "off" },
    }
    expect(resolveIngestReasoning(config)).toEqual({ mode: "off" })
    expect(config.reasoning).toEqual({ mode: "high" })
  })

  it("reaches the wire: off disables thinking, low asks for low effort", () => {
    // The payload is what actually matters. A model that rejects disabling
    // reasoning (OpenRouter's ox-alpha answers 400 "Reasoning is mandatory")
    // is only usable because this second form can be selected.
    const off = getProviderConfig(openRouter).buildBody(
      [{ role: "user", content: "hi" }],
      { reasoning: resolveIngestReasoning(openRouter) },
    ) as Record<string, unknown>
    expect(off.reasoning).toEqual({ enabled: false })

    const withLow = { ...openRouter, ingestReasoning: { mode: "low" as const } }
    const low = getProviderConfig(withLow).buildBody(
      [{ role: "user", content: "hi" }],
      { reasoning: resolveIngestReasoning(withLow) },
    ) as Record<string, unknown>
    expect(low.reasoning).toEqual({ effort: "low" })
  })

  it("survives the preset resolver, which drops fields it does not carry", () => {
    const resolved = resolveConfig(
      { id: "openrouter", label: "OpenRouter", provider: "custom", baseUrl: "https://openrouter.ai/api/v1" } as never,
      { ingestReasoning: { mode: "low" } },
      openRouter,
    )
    expect(resolved.ingestReasoning).toEqual({ mode: "low" })
    expect(resolveIngestReasoning(resolved)).toEqual({ mode: "low" })
  })
})
