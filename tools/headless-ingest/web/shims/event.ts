/** Browser shim for @tauri-apps/api/event. Real in-process bus so streamed
 *  "agent-event"s from the server can reach the chat panel's listener. */
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

/** Dispatch an event to all listeners — used by the invoke shim for SSE streams. */
export function __dispatch(event: string, payload: unknown): void {
  listeners.get(event)?.forEach((cb) => { try { cb({ payload }) } catch { /* ignore */ } })
}

export async function emit(event: string, payload?: unknown): Promise<void> { __dispatch(event, payload) }
export async function emitTo(_t: string, event: string, payload?: unknown): Promise<void> { __dispatch(event, payload) }
export const TauriEvent = {} as Record<string, string>
