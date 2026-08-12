import { describe, expect, it } from "vitest"
import {
  splitBySizeForTest,
  buildTranscriptionRequestForTest,
  transcribeAudio,
} from "./media-transcribe"
import type { MediaIngestConfig } from "@/stores/wiki-store"

const baseConfig: MediaIngestConfig = {
  audioVideoEnabled: true,
  audioVideoBackend: "groq",
  audioVideoToken: "",
  audioVideoCustomEndpoint: "",
  audioVideoCustomToken: "",
  imagesEnabled: false,
}

describe("splitBySize", () => {
  it("returns a single segment when under the byte limit", () => {
    const segments = splitBySizeForTest(10_000_000, 25_000_000)
    expect(segments).toEqual([{ startByte: 0, endByte: 10_000_000 }])
  })

  it("keeps a file that is exactly at the limit in one segment", () => {
    expect(splitBySizeForTest(25_000_000, 25_000_000)).toEqual([
      { startByte: 0, endByte: 25_000_000 },
    ])
  })

  it("produces contiguous segments that never exceed the limit", () => {
    const segments = splitBySizeForTest(51_000_001, 25_000_000)
    expect(segments[0].startByte).toBe(0)
    expect(segments[segments.length - 1].endByte).toBe(51_000_001)
    for (const [i, segment] of segments.entries()) {
      expect(segment.endByte - segment.startByte).toBeLessThanOrEqual(25_000_000)
      if (i > 0) expect(segment.startByte).toBe(segments[i - 1].endByte)
    }
  })

  it("splits into equal-ish segments when over the byte limit", () => {
    const segments = splitBySizeForTest(60_000_000, 25_000_000)
    expect(segments.length).toBe(3)
    expect(segments[0]).toEqual({ startByte: 0, endByte: 20_000_000 })
    expect(segments[1]).toEqual({ startByte: 20_000_000, endByte: 40_000_000 })
    expect(segments[2]).toEqual({ startByte: 40_000_000, endByte: 60_000_000 })
  })
})

describe("buildTranscriptionRequest", () => {
  it("targets Groq's endpoint with the groq backend", () => {
    const req = buildTranscriptionRequestForTest({
      audioVideoEnabled: true,
      audioVideoBackend: "groq",
      audioVideoToken: "gsk_test",
      audioVideoCustomEndpoint: "",
      audioVideoCustomToken: "",
      imagesEnabled: false,
    })
    expect(req.url).toBe("https://api.groq.com/openai/v1/audio/transcriptions")
    expect(req.headers.Authorization).toBe("Bearer gsk_test")
  })

  it("targets the custom endpoint with the custom backend", () => {
    const req = buildTranscriptionRequestForTest({
      audioVideoEnabled: true,
      audioVideoBackend: "custom",
      audioVideoToken: "",
      audioVideoCustomEndpoint: "https://my-whisper.example.com/v1",
      audioVideoCustomToken: "secret",
      imagesEnabled: false,
    })
    expect(req.url).toBe("https://my-whisper.example.com/v1/audio/transcriptions")
    expect(req.headers.Authorization).toBe("Bearer secret")
  })

  it("trims a trailing slash from the custom endpoint", () => {
    const req = buildTranscriptionRequestForTest({
      ...baseConfig,
      audioVideoBackend: "custom",
      audioVideoCustomEndpoint: "https://my-whisper.example.com/v1//",
    })
    expect(req.url).toBe("https://my-whisper.example.com/v1/audio/transcriptions")
  })
})

// These reject before any Tauri/network call, so no mocks are needed:
// a regression would surface as a different error message.
describe("transcribeAudio configuration guards", () => {
  it("rejects when the Groq token is missing", async () => {
    await expect(
      transcribeAudio("/tmp/a.mp3", { ...baseConfig, audioVideoBackend: "groq" }),
    ).rejects.toThrow(/Groq API token is not configured/)
  })

  it("rejects when the custom endpoint is missing", async () => {
    await expect(
      transcribeAudio("/tmp/a.mp3", { ...baseConfig, audioVideoBackend: "custom" }),
    ).rejects.toThrow(/Custom transcription endpoint is not configured/)
  })
})
