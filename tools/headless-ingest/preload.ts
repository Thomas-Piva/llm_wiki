/**
 * Bun preload: swap the Tauri seams for headless equivalents BEFORE any
 * app module is imported. Registered as `--preload`, so the virtual
 * modules are in place when `ingest.ts` (and its transitive imports)
 * resolve `@tauri-apps/api/core` etc.
 */
import { plugin } from "bun"
import { invoke } from "./invoke-shim"
import { installMockLlm } from "./mock-llm"
import * as eventBus from "./tauri-event-bus"

// In-memory stand-in for the Tauri store plugin (persistence layer). Nothing
// the ingest path needs actually has to survive; keep values in a Map.
class MemStore {
  private m = new Map<string, unknown>()
  static async load() {
    return new MemStore()
  }
  async get<T>(key: string): Promise<T | undefined> {
    return this.m.get(key) as T | undefined
  }
  async set(key: string, value: unknown): Promise<void> {
    this.m.set(key, value)
  }
  async delete(key: string): Promise<boolean> {
    return this.m.delete(key)
  }
  async entries(): Promise<[string, unknown][]> {
    return [...this.m.entries()]
  }
  async save(): Promise<void> {}
}

plugin({
  name: "tauri-headless-shim",
  setup(build) {
    build.module("@tauri-apps/api/core", () => ({
      exports: { invoke },
      loader: "object",
    }))
    build.module("@tauri-apps/plugin-store", () => ({
      exports: { Store: MemStore, LazyStore: MemStore, load: MemStore.load },
      loader: "object",
    }))
    // Event bus so the CLI transports (claude/codex) work headless.
    build.module("@tauri-apps/api/event", () => ({
      exports: {
        listen: eventBus.listen,
        once: eventBus.once,
        emit: eventBus.emit,
        emitTo: eventBus.emitTo,
        TauriEvent: eventBus.TauriEvent,
      },
      loader: "object",
    }))
  },
})

if (process.env.SPIKE_MOCK_LLM === "1") {
  installMockLlm()
  console.error("[preload] mock LLM installed")
}
