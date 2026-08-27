/** Server-backed shim for @tauri-apps/plugin-store. The web app's Settings
 *  persist to the VPS app-state.json via /store (not the browser), so MinerU /
 *  model / provider changes are REAL and the headless engine reads the same
 *  file — the behaviour it had running on the VPS under noVNC. A per-namespace
 *  cache is loaded once; sets write through to the server. */
const caches = new Map<string, Record<string, any>>()
const loading = new Map<string, Promise<Record<string, any>>>()

async function fetchNs(ns: string): Promise<Record<string, any>> {
  if (caches.has(ns)) return caches.get(ns)!
  let p = loading.get(ns)
  if (!p) {
    p = fetch("/store?ns=" + encodeURIComponent(ns))
      .then((r) => (r.ok ? r.json() : {}))
      .catch(() => ({}))
    loading.set(ns, p)
  }
  const obj = await p
  caches.set(ns, obj)
  loading.delete(ns)
  return obj
}

function post(body: unknown): void {
  void fetch("/store", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).catch(() => {})
}

class WebStore {
  constructor(private ns: string) {}
  static async load(path: string) {
    await fetchNs(path)
    return new WebStore(path)
  }
  private c() { return caches.get(this.ns) ?? {} }
  async get<T>(k: string): Promise<T | undefined> { return this.c()[k] as T | undefined }
  async set(k: string, v: unknown) {
    const c = this.c(); c[k] = v; caches.set(this.ns, c)
    post({ ns: this.ns, key: k, value: v })
  }
  async delete(k: string) {
    const c = this.c(); const had = k in c; delete c[k]; caches.set(this.ns, c)
    post({ ns: this.ns, op: "delete", key: k })
    return had
  }
  async has(k: string) { return k in this.c() }
  async entries<T>(): Promise<[string, T][]> { return Object.entries(this.c()) as [string, T][] }
  async keys() { return Object.keys(this.c()) }
  async values<T>() { return Object.values(this.c()) as T[] }
  async save() {}
  async clear() { caches.set(this.ns, {}); post({ ns: this.ns, op: "clear" }) }
  async reload() { caches.delete(this.ns); await fetchNs(this.ns) }
  async onKeyChange() { return () => {} }
  async onChange() { return () => {} }
}
export const Store = WebStore
export const LazyStore = WebStore
export async function load(path: string) { return WebStore.load(path) }
