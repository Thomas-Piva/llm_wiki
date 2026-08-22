import { describe, expect, it } from "vitest"
import { backfillMediaExtensions, normalizeSourceWatchConfig } from "./source-watch-config"
import { AUDIO_VIDEO_SOURCE_EXTENSIONS, IMAGE_SOURCE_EXTENSIONS } from "./media-extensions"

describe("media-extension backfill (one-time, at the storage boundary)", () => {
  it("adds the media extensions to an old persisted config that predates this feature", () => {
    const oldPersistedConfig = {
      includeExtensions: ["md", "pdf", "docx"], // realistic pre-feature saved list
    }
    const result = normalizeSourceWatchConfig(backfillMediaExtensions(oldPersistedConfig))
    for (const ext of AUDIO_VIDEO_SOURCE_EXTENSIONS) {
      expect(result.includeExtensions).toContain(ext)
    }
    for (const ext of IMAGE_SOURCE_EXTENSIONS) {
      expect(result.includeExtensions).toContain(ext)
    }
    // Original entries are preserved, not replaced.
    expect(result.includeExtensions).toContain("md")
    expect(result.includeExtensions).toContain("pdf")
    expect(result.includeExtensions).toContain("docx")
    expect(result.mediaExtensionsMerged).toBe(true)
  })

  it("does not duplicate media extensions for a fresh config that already has them", () => {
    const result = normalizeSourceWatchConfig(undefined) // falls back to DEFAULT_SOURCE_WATCH_CONFIG
    const mp4Count = result.includeExtensions.filter((e) => e === "mp4").length
    expect(mp4Count).toBe(1)
  })

  it("keeps an empty include-list empty, because empty means no extension filter", () => {
    // `importSourceFiles` clears includeExtensions to bypass the watcher
    // allow-list for explicit imports; backfilling media there would turn that
    // allow-all into a media-only filter and reject every document.
    const result = normalizeSourceWatchConfig(backfillMediaExtensions({ includeExtensions: [] }))
    expect(result.includeExtensions).toEqual([])
  })

  it("lets the user untick mp4 and mp3 and keeps them off", () => {
    // The bug this guards: the union used to run inside normalize, so the
    // settings UI re-added mp4/mp3 in the same tick it removed them and the
    // checkbox bounced straight back to ticked.
    const afterUnticking = {
      includeExtensions: ["md", "pdf", "png"], // mp4 and mp3 removed by the user
      mediaExtensionsMerged: true,
    }
    const result = normalizeSourceWatchConfig(afterUnticking)
    expect(result.includeExtensions).not.toContain("mp4")
    expect(result.includeExtensions).not.toContain("mp3")
    expect(result.includeExtensions).toContain("png")
  })

  it("does not resurrect turned-off media when the config is re-read from disk", () => {
    const saved = {
      includeExtensions: ["md", "pdf"], // every media extension turned off
      mediaExtensionsMerged: true,
    }
    const result = normalizeSourceWatchConfig(backfillMediaExtensions(saved))
    for (const ext of [...AUDIO_VIDEO_SOURCE_EXTENSIONS, ...IMAGE_SOURCE_EXTENSIONS]) {
      expect(result.includeExtensions).not.toContain(ext)
    }
  })
})
