import { describe, it, expect } from "bun:test"

// Read the source to verify constants exist and have correct values.
// The function is not easily unit-testable (depends on filesystem walk),
// so we verify the constants that control the behavior.
describe("wikiGraphBatch", () => {
  it("has GRAPH_TTL_MS of 15 minutes", async () => {
    const src = await Bun.file("tools/headless-ingest/web-invoke.ts").text()
    const match = src.match(/GRAPH_TTL_MS\s*=\s*([^\n\/]+)/)
    expect(match).toBeTruthy()
    const expr = match![1].trim()
    // Eval the expression (safe - it's our own source) or match the pattern
    const ms = expr.includes("*") ? eval(expr) : Number(expr.replace(/_/g, ""))
    expect(ms).toBe(15 * 60 * 1000)
  })

  it("has GRAPH_FILE_READ_CONCURRENCY of 16", async () => {
    const src = await Bun.file("tools/headless-ingest/web-invoke.ts").text()
    const match = src.match(/GRAPH_FILE_READ_CONCURRENCY\s*=\s*(\d+)/)
    expect(match).toBeTruthy()
    expect(Number(match![1])).toBe(16)
  })
})
