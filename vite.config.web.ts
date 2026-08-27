import path from "path"
import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"

// Web build of the real llm_wiki frontend: the same SPA, but every Tauri
// binding is aliased to a browser shim (invoke() → HTTP to the light backend).
// Served static under /app/ by the light backend; reached via SSH tunnel.
const r = (p: string) => path.resolve(__dirname, p)
const shim = (f: string) => r(`tools/headless-ingest/web/shims/${f}`)

export default defineConfig({
  base: "/app/",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@tauri-apps/api/core": shim("core.ts"),
      "@tauri-apps/api/event": shim("event.ts"),
      "@tauri-apps/api/window": shim("window.ts"),
      "@tauri-apps/plugin-store": shim("store.ts"),
      "@tauri-apps/plugin-http": shim("http.ts"),
      "@tauri-apps/plugin-opener": shim("opener.ts"),
      "@tauri-apps/plugin-autostart": shim("autostart.ts"),
      "@tauri-apps/plugin-dialog": shim("dialog.ts"),
      "@": r("src"),
    },
  },
  define: { __APP_VERSION__: JSON.stringify("web") },
  build: { outDir: r("tools/headless-ingest/web/dist"), emptyOutDir: true, chunkSizeWarningLimit: 4000 },
})
