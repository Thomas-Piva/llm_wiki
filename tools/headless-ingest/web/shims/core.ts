import { __dispatch } from "./event"

/** Browser shim for @tauri-apps/api/core — invoke() over HTTP to the light backend. */
export async function invoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  // Grounded chat: stream the server agent turn, re-emitting each SSE payload as
  // an "agent-event" so the chat panel's listener receives it.
  if (cmd === "agent_start_turn_stream") {
    const req = (args as any)?.request ?? {}
    const res = await fetch("/agent-stream", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(req),
    })
    if (!res.ok || !res.body) throw new Error(`agent stream failed (${res.status})`)
    const reader = res.body.getReader()
    const dec = new TextDecoder()
    let buf = ""
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      const parts = buf.split("\n\n")
      buf = parts.pop() ?? ""
      for (const part of parts) {
        const line = part.split("\n").find((l) => l.startsWith("data:"))
        if (!line) continue
        try { __dispatch("agent-event", JSON.parse(line.slice(5).trim())) } catch { /* partial */ }
      }
    }
    return "" as T
  }
  if (cmd === "agent_cancel_turn") return null as T

  // Export vault: trigger a browser download of the server-built zip.
  if (cmd === "export_project_archive") {
    const a = document.createElement("a")
    a.href = "/export"
    a.download = ""
    document.body.appendChild(a)
    a.click()
    a.remove()
    return null as T
  }

  const res = await fetch("/invoke", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cmd, args: args ?? {} }),
  })
  let data: any
  try { data = await res.json() } catch { throw new Error(`invoke ${cmd}: bad response`) }
  if (!res.ok || data?.error) throw new Error(data?.error ?? `invoke ${cmd} failed (${res.status})`)
  return data.result as T
}

/** Local files are served by the backend's /file endpoint (sandboxed to vault). */
export function convertFileSrc(path: string): string {
  return "/file?path=" + encodeURIComponent(path)
}

export function isTauri(): boolean { return false }
export function transformCallback(): number { return 0 }

/** Streaming channel stub — desktop agent/CLI streams are unavailable on web. */
export class Channel<T = unknown> {
  onmessage: ((message: T) => void) | null = null
  id = 0
}
export async function addPluginListener() { return { unregister() {} } }
export class PluginListener { unregister() {} }
