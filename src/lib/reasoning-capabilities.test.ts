import { describe, expect, it } from "vitest"
import type { LlmConfig } from "@/stores/wiki-store"
import { normalizeReasoningForProvider, resolveReasoningCapabilities } from "./reasoning-capabilities"

function config(provider: LlmConfig["provider"], model: string): LlmConfig {
  return {
    provider,
    model,
    apiKey: "key",
    ollamaUrl: "http://localhost:11434",
    customEndpoint: "https://gateway.example/v1",
    maxContextSize: 128_000,
  }
}

describe("reasoning capabilities", () => {
  it("does not infer vendor-private controls from a custom gateway model name", () => {
    const cfg = config("custom", "Qwen3-thinking-only")
    expect(resolveReasoningCapabilities(cfg).modes).toEqual(["auto"])
    expect(normalizeReasoningForProvider(cfg, { mode: "off" })).toEqual({ mode: "auto" })
  })

  it("does not offer off for thinking-required Gemini and Claude models", () => {
    expect(resolveReasoningCapabilities(config("google", "gemini-2.5-pro")).modes)
      .not.toContain("off")
    expect(resolveReasoningCapabilities(config("anthropic", "claude-opus-4-7")).modes)
      .not.toContain("off")
    expect(resolveReasoningCapabilities(config("anthropic", "claude-sonnet-4-6")).modes)
      .not.toContain("custom")
  })

  it("limits OpenAI reasoning models to representable effort levels", () => {
    expect(resolveReasoningCapabilities(config("openai", "gpt-5.4")).modes)
      .toEqual(["auto", "off", "low", "medium", "high"])
    expect(normalizeReasoningForProvider(config("openai", "gpt-5.4"), { mode: "max" }))
      .toEqual({ mode: "auto" })
  })

  it("withholds Off from o-series models, which reject effort none", () => {
    // GPT-5 and later document reasoning_effort: "none"; o1/o3/o4 predate it.
    // Offering Off there would turn every ingest call into a request error.
    expect(resolveReasoningCapabilities(config("openai", "o3")).modes)
      .toEqual(["auto", "low", "medium", "high"])
    expect(normalizeReasoningForProvider(config("openai", "o3"), { mode: "off" }))
      .toEqual({ mode: "auto" })
    // …while a GPT-5-family model keeps the caller's Off intact.
    expect(normalizeReasoningForProvider(config("openai", "gpt-5.4"), { mode: "off" }))
      .toEqual({ mode: "off" })
  })

  it("normalizes custom budgets to positive integer values", () => {
    const cfg = config("anthropic", "claude-sonnet-4-5")
    expect(normalizeReasoningForProvider(cfg, { mode: "custom", budgetTokens: 2048.9 }))
      .toEqual({ mode: "custom", budgetTokens: 2048 })
    expect(normalizeReasoningForProvider(cfg, { mode: "custom", budgetTokens: 10 }))
      .toEqual({ mode: "custom", budgetTokens: 1024 })
    expect(normalizeReasoningForProvider(cfg, { mode: "custom", budgetTokens: 99_999 }))
      .toEqual({ mode: "custom", budgetTokens: 32_768 })
    expect(normalizeReasoningForProvider(cfg, { mode: "custom", budgetTokens: 0 }))
      .toEqual({ mode: "auto" })
  })
})
