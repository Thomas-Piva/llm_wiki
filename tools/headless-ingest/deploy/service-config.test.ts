import { readFileSync } from "node:fs"
import { describe, it, expect } from "bun:test"

describe("light-backend.service", () => {
  it("has MemoryMax >= 512M", () => {
    const content = readFileSync("tools/headless-ingest/deploy/llm-wiki-light-backend.service", "utf8")
    const match = content.match(/MemoryMax=(\d+)M/)
    expect(match).toBeTruthy()
    expect(Number(match![1])).toBeGreaterThanOrEqual(512)
  })
})
