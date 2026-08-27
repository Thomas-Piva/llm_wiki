/** Browser shim for @tauri-apps/plugin-dialog. `open` picks local files and
 *  UPLOADS them to the VPS (/upload → raw/sources), returning their server
 *  paths — so the app's import flow (copy + rescan) ingests them and the File
 *  Sync panel shows live progress. Alerts via window.*. */
export async function open(opts: any = {}): Promise<string | string[] | null> {
  // "Pick a destination directory" (import flow) has no meaning on the web —
  // there's a single server-side vault. Return a non-null marker without a
  // picker so the caller proceeds (import_project_archive ignores it).
  if (opts.directory && opts.createDirectories) return "vault"
  return new Promise((resolve) => {
    const input = document.createElement("input")
    input.type = "file"
    if (opts.multiple) input.multiple = true
    if (opts.directory) (input as any).webkitdirectory = true
    if (Array.isArray(opts.filters)) {
      const exts = opts.filters.flatMap((f: any) => f.extensions ?? []).map((e: string) => "." + e)
      if (exts.length) input.accept = exts.join(",")
    }
    input.onchange = async () => {
      const files = Array.from(input.files ?? [])
      if (!files.length) return resolve(null)
      const fd = new FormData()
      for (const f of files) fd.append("files", f)
      try {
        const res = await fetch("/upload", { method: "POST", body: fd })
        const data = await res.json()
        const paths: string[] = Array.isArray(data.files) ? data.files : []
        // Folder import (directory picker) uploads every file in the folder —
        // return them ALL so the caller ingests the whole folder, not just one.
        const asArray = opts.multiple || (opts.directory && !opts.createDirectories)
        resolve(asArray ? paths : (paths[0] ?? null))
      } catch {
        resolve(null)
      }
    }
    input.oncancel = () => resolve(null)
    input.click()
  })
}
// Return a filename (never null) so the export flow proceeds; the actual
// download is handled by the core shim intercepting export_project_archive.
export async function save(opts: any = {}): Promise<string | null> {
  return opts?.defaultPath ?? "export.llmwiki.zip"
}
export async function message(msg: string) { window.alert(msg) }
export async function ask(msg: string) { return window.confirm(msg) }
export async function confirm(msg: string) { return window.confirm(msg) }
