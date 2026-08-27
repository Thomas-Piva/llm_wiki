/** Browser shim for @tauri-apps/plugin-opener. */
export async function open(path: string) { window.open(path, "_blank", "noopener") }
export async function openUrl(url: string) { window.open(url, "_blank", "noopener") }
export async function openPath(path: string) { window.open("/file?path=" + encodeURIComponent(path), "_blank") }
export async function revealItemInDir(_p: string) {}
