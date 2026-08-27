/** Browser shim for @tauri-apps/api/window — desktop window controls, no-op. */
const noop = async () => {}
const stub = {
  label: "main", listen: async () => () => {}, once: async () => () => {},
  emit: noop, setTitle: noop, minimize: noop, maximize: noop, unmaximize: noop,
  close: noop, show: noop, hide: noop, setFocus: noop, isMaximized: async () => false,
  onCloseRequested: async () => () => {}, onResized: async () => () => {},
}
export function getCurrentWindow() { return stub as any }
export function getCurrent() { return stub as any }
export class Window { constructor() { return stub as any } }
export const appWindow = stub as any
