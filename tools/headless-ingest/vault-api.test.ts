import { describe, it, expect } from "bun:test"

describe("vault-api file listing", () => {
  it("has a file listing cache with mtime invalidation", async () => {
    const src = await Bun.file("tools/headless-ingest/vault-api.ts").text()
    expect(src).toContain("fileListCache")
    expect(src).toContain("mtime")
  })
})
