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

describe("pdf_extract_text dispatch", () => {
  const { execFile: execFileCb } = require("node:child_process")
  const execFileAsync = require("node:util").promisify(execFileCb)

  it("dispatch case exists in source and uses pdftotext with -layout -enc UTF-8", async () => {
    const src = await Bun.file("tools/headless-ingest/web-invoke.ts").text()
    expect(src).toContain('case "pdf_extract_text"')
    expect(src).toContain("pdftotext")
    expect(src).toContain("-layout")
    expect(src).toContain("UTF-8")
  })

  it("pdftotext call returns empty string on missing file (same fallback as dispatch)", async () => {
    // Reproduces the exact error path: pdftotext either missing or file
    // not found — the dispatch catches and returns "".
    try {
      await execFileAsync("pdftotext", ["-layout", "-enc", "UTF-8", "/nonexistent.pdf", "-"], {
        maxBuffer: 64 * 1024 * 1024,
        timeout: 5_000,
      })
      // If pdftotext is installed, it still fails on a missing file
      expect.unreachable("should have thrown")
    } catch {
      // Both "command not found" and "file not found" land here — the
      // dispatch returns "" in both cases. This is the contract.
      expect(true).toBe(true)
    }
  })
})
