/** Browser shim for @tauri-apps/plugin-http — native fetch (subject to CORS). */
export const fetch = globalThis.fetch.bind(globalThis)
