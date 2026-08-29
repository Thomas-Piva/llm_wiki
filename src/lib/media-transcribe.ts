import { getFileSize, readFileAsBase64 } from "@/commands/fs"
import { getHttpFetch } from "@/lib/tauri-fetch"
import type { MediaIngestConfig } from "@/stores/wiki-store"

const GROQ_TRANSCRIPTION_URL = "https://api.groq.com/openai/v1/audio/transcriptions"
const GROQ_MODEL = "whisper-large-v3-turbo"

// Groq's hard upload limit; ffmpeg's mono/16kHz/32kbps extraction (Task 5)
// keeps most sources well under this, but long meeting recordings (1-2h)
// can still exceed it — split into equal byte ranges rather than failing.
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024

interface ByteRange {
  startByte: number
  endByte: number
}

export function splitBySizeForTest(totalBytes: number, maxBytes: number): ByteRange[] {
  if (totalBytes <= maxBytes) return [{ startByte: 0, endByte: totalBytes }]
  const segmentCount = Math.ceil(totalBytes / maxBytes)
  const segmentSize = Math.ceil(totalBytes / segmentCount)
  const segments: ByteRange[] = []
  for (let start = 0; start < totalBytes; start += segmentSize) {
    segments.push({ startByte: start, endByte: Math.min(start + segmentSize, totalBytes) })
  }
  return segments
}

interface TranscriptionRequest {
  url: string
  headers: Record<string, string>
  model: string
}

/**
 * True for the failures a second provider can actually rescue: the quota ran
 * out, the provider is rate-limiting, or its side broke. An unreadable file
 * would fail identically everywhere, so retrying it elsewhere just wastes the
 * other quota too.
 */
export function isWorthFailingOver(message: string): boolean {
  const m = message.toLowerCase()
  return (
    m.includes("429") ||
    m.includes("rate limit") ||
    m.includes("quota") ||
    m.includes("too many requests") ||
    m.includes("capacity") ||
    m.includes("503") ||
    m.includes("502") ||
    m.includes("500") ||
    m.includes("timeout") ||
    m.includes("fetch failed")
  )
}

/**
 * The provider to try when the configured one is out of quota.
 *
 * Groq's free tier resets daily, and with hours of recordings to get through
 * that ceiling arrives well before the work does. Rather than stopping the
 * queue until tomorrow, fall through to whichever OpenAI-compatible endpoint is
 * also configured — the fields for both already exist, so this needs no new
 * setting, only both of them filled in.
 *
 * Returns null when there is no second provider: then the queue does pause, and
 * says why.
 */
export function fallbackConfigFor(config: MediaIngestConfig): MediaIngestConfig | null {
  if (config.audioVideoBackend === "groq") {
    // A chat model with audio input has no daily ceiling, so it is the fallback
    // that actually unblocks an archive; a second Whisper endpoint is the
    // second choice.
    if (config.audioVideoChatModel?.trim()) return { ...config, audioVideoBackend: "chat" }
    if (config.audioVideoCustomEndpoint.trim()) return { ...config, audioVideoBackend: "custom" }
    return null
  }
  return config.audioVideoToken.trim() ? { ...config, audioVideoBackend: "groq" } : null
}

/** Ask a chat model to read the audio out. Same credentials as captioning. */
const TRANSCRIBE_PROMPT =
  "Trascrivi fedelmente questo audio, nella lingua in cui è parlato. Restituisci solo il testo trascritto, senza commenti, senza riassunti e senza aggiungere nulla."

async function transcribeViaChat(
  audioBytes: Uint8Array,
  config: MediaIngestConfig,
  signal?: AbortSignal,
): Promise<string> {
  const base = (config.audioVideoCustomEndpoint || "https://openrouter.ai/api/v1").replace(/\/+$/, "")
  const httpFetch = await getHttpFetch()
  const response = await httpFetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(config.audioVideoCustomToken ? { Authorization: `Bearer ${config.audioVideoCustomToken}` } : {}),
    },
    body: JSON.stringify({
      model: config.audioVideoChatModel,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: TRANSCRIBE_PROMPT },
          { type: "input_audio", input_audio: { data: bytesToBase64(audioBytes), format: "mp3" } },
        ],
      }],
    }),
    signal,
  })
  if (!response.ok) {
    const text = await response.text().catch(() => "")
    throw new Error(`Transcription request failed: HTTP ${response.status}: ${text}`)
  }
  const json = (await response.json()) as any
  const content = json?.choices?.[0]?.message?.content
  if (typeof content !== "string") {
    throw new Error("Transcription response missing message content")
  }
  return content.trim()
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ""
  const CHUNK = 0x8000 // argument list limits make one big spread throw
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

export function buildTranscriptionRequestForTest(config: MediaIngestConfig): TranscriptionRequest {
  if (config.audioVideoBackend === "custom") {
    const base = config.audioVideoCustomEndpoint.replace(/\/+$/, "")
    return {
      url: `${base}/audio/transcriptions`,
      headers: config.audioVideoCustomToken
        ? { Authorization: `Bearer ${config.audioVideoCustomToken}` }
        : {},
      // Custom endpoints don't necessarily speak Groq's exact model name —
      // "whisper-1" is the de facto OpenAI-compatible default most
      // self-hosted/third-party Whisper servers accept.
      model: "whisper-1",
    }
  }
  return {
    url: GROQ_TRANSCRIPTION_URL,
    headers: { Authorization: `Bearer ${config.audioVideoToken}` },
    model: GROQ_MODEL,
  }
}

async function transcribeSegment(
  audioBytes: Uint8Array,
  fileName: string,
  request: TranscriptionRequest,
  signal?: AbortSignal,
): Promise<string> {
  const httpFetch = await getHttpFetch()
  const form = new FormData()
  form.append("file", new Blob([bytesToUploadBody(audioBytes)], { type: "audio/mpeg" }), fileName)
  form.append("model", request.model)

  const response = await httpFetch(request.url, {
    method: "POST",
    headers: request.headers,
    body: form,
    signal,
  })
  if (!response.ok) {
    const text = await response.text().catch(() => "")
    throw new Error(`Transcription request failed: HTTP ${response.status}: ${text}`)
  }
  const json = (await response.json()) as { text?: string }
  // `""` is a legitimate result (silent segment). A *missing* field means the
  // endpoint answered with a shape we don't understand — defaulting that to ""
  // would silently drop a whole segment out of a joined transcript.
  if (typeof json.text !== "string") {
    throw new Error("Transcription response missing 'text' field")
  }
  return json.text.trim()
}

/**
 * Transcribes an audio file (already extracted/compressed by
 * `extract_audio_track`) via Groq or a custom OpenAI-compatible endpoint.
 * Splits into byte-range segments when the file exceeds Groq's 25MB
 * upload limit, transcribing each segment independently and joining the
 * results with blank lines — segment boundaries may cut mid-sentence,
 * which is an acceptable trade-off for very long recordings versus
 * failing outright.
 */
export async function transcribeAudio(
  audioPath: string,
  config: MediaIngestConfig,
  signal?: AbortSignal,
): Promise<string> {
  if (config.audioVideoBackend === "groq" && !config.audioVideoToken.trim()) {
    throw new Error("Groq API token is not configured (Settings → Media ingestion)")
  }
  if (config.audioVideoBackend === "custom" && !config.audioVideoCustomEndpoint.trim()) {
    throw new Error("Custom transcription endpoint is not configured (Settings → Media ingestion)")
  }
  if (config.audioVideoBackend === "chat" && !config.audioVideoChatModel?.trim()) {
    throw new Error("Nessun modello chat con ingresso audio configurato (Impostazioni → Media)")
  }

  const totalBytes = await getFileSize(audioPath)
  const segments = splitBySizeForTest(totalBytes, MAX_UPLOAD_BYTES)
  const fileName = audioPath.split("/").pop() ?? "audio.mp3"
  const { base64 } = await readFileAsBase64(audioPath)
  const fullBytes = base64ToBytes(base64)

  const run = async (cfg: MediaIngestConfig) => {
    const one = cfg.audioVideoBackend === "chat"
      ? (bytes: Uint8Array) => transcribeViaChat(bytes, cfg, signal)
      : (bytes: Uint8Array) => transcribeSegment(bytes, fileName, buildTranscriptionRequestForTest(cfg), signal)
    if (segments.length === 1) return one(fullBytes)
    const transcripts: string[] = []
    for (const segment of segments) {
      transcripts.push(await one(fullBytes.slice(segment.startByte, segment.endByte)))
    }
    return transcripts.join("\n\n")
  }

  try {
    return await run(config)
  } catch (err) {
    // Out of quota is not a broken file: the same audio will transcribe fine
    // somewhere else. Switching providers keeps hours of recordings moving
    // instead of parking the whole queue until the allowance resets.
    const fallback = isQuotaError(err) ? fallbackConfigFor(config) : null
    if (!fallback) throw err
    console.warn(
      `[media] ${config.audioVideoBackend} a quota su "${fileName}" — passo a ${fallback.audioVideoBackend}`,
    )
    return run(fallback)
  }
}

/**
 * Distinguishes "come back later" from "this will never work".
 *
 * Only the first is worth retrying elsewhere; a malformed file would fail on
 * every provider, and silently trying them all would just hide the real error.
 */
export function isQuotaError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return (
    /HTTP (429|402|413|5\d\d)\b/.test(message) ||
    /rate.?limit|quota|too many requests|insufficient|capacity|overloaded/i.test(message)
  )
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** Same `Uint8Array` -> `ArrayBuffer` narrowing MinerU's upload path uses. */
function bytesToUploadBody(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}
