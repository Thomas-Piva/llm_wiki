import { describe, it, expect } from "bun:test"

describe("light-backend", () => {
  it("caches index.html in a module-level variable, not per-request", async () => {
    const src = await Bun.file("tools/headless-ingest/light-backend.ts").text()
    // The function should read once and cache, not readFile on every call
    const appIndexHtmlFunc = src.match(/(?:async )?function appIndexHtml[\s\S]*?(?=\n(?:async )?function |\nexport |\nconst server)/)?.[0]
    // After fix: appIndexHtml returns the cached string, no readFile inside
    const hasReadFileInside = appIndexHtmlFunc?.includes("readFile")
    expect(hasReadFileInside).toBe(false)
  })
})
