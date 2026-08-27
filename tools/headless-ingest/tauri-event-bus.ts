/**
 * In-process event bus that stands in for @tauri-apps/api/event in the headless
 * ingest engine. The CLI transports (claude-cli-transport.ts / codex) register
 * `listen("claude-cli:<id>", cb)` and the invoke shim's *_cli_spawn emits those
 * events as the subprocess streams — so the ingest can use the claude/codex CLI
 * as its generation model, headless.
 */
export type UnlistenFn = () => void

const listeners = new Map<string, Set<(e: { payload: any }) => void>>()

export async function listen<T = unknown>(event: string, cb: (e: { payload: T }) => void): Promise<UnlistenFn> {
  let set = listeners.get(event)
  if (!set) { set = new Set(); listeners.set(event, set) }
  set.add(cb as any)
  return () => { set!.delete(cb as any) }
}

export async function once<T = unknown>(event: string, cb: (e: { payload: T }) => void): Promise<UnlistenFn> {
  const un = await listen<T>(event, (e) => { un(); cb(e) })
  return un
}

/** Emit to all listeners of an event (used by the *_cli_spawn shim). */
export function emitEvent(event: string, payload: unknown): void {
  listeners.get(event)?.forEach((cb) => { try { cb({ payload }) } catch { /* ignore */ } })
}

export async function emit(event: string, payload?: unknown): Promise<void> { emitEvent(event, payload) }
export async function emitTo(_t: string, event: string, payload?: unknown): Promise<void> { emitEvent(event, payload) }
export const TauriEvent = {} as Record<string, string>
