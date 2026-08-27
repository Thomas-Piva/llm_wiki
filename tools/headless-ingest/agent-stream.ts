/**
 * Server-side AGENT for the web UI — mirrors the app's integrated agent
 * (agent_start_turn_stream) as an OpenAI-tool-calling loop over the LLM API:
 * the model decides, calls tools (wiki search / read / write pages), we run
 * them against the vault, feed results back, and loop until it answers.
 * Streamed to the browser as "agent-event" SSE (toolStart/toolEnd/
 * referenceAdded/messageDelta/done) — the same events the chat panel renders.
 *
 * Tools: wiki_search, wiki_read, wiki_write (mirrors wiki.search/read_page/
 * write_page). SHELL/CLI execution is intentionally NOT exposed: spawning
 * full-auto CLIs from a network endpoint is an RCE surface. The brain is the
 * LLM API (HEADLESS_LLM_*); the tools are ours and sandboxed to the vault.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises"
import { resolve, join, dirname, sep } from "node:path"
import { spawn } from "node:child_process"
import { rgSearch } from "./vault-api"

const enc = new TextEncoder()
const MAX_STEPS = 6

interface AgentConfig { provider: "api" | "claude" | "codex"; model: string; endpoint: string; apiKey: string }

/** Resolve the chat brain from Settings (app-state.json's llmConfig), so the
 *  provider chosen in the web Settings (Claude Code CLI / Codex CLI / an API
 *  provider) drives the chat. Env (AGENT_PROVIDER/AGENT_MODEL/HEADLESS_LLM_*)
 *  overrides for ops. */
async function resolveConfig(vault: string): Promise<AgentConfig> {
  let lc: any = {}
  try {
    const st = JSON.parse(await readFile(join(vault, ".llm-wiki", "app-state.json"), "utf8"))
    lc = st.llmConfig ?? {}
  } catch { /* defaults below */ }
  const provider = (process.env.AGENT_PROVIDER as any)
    ?? (lc.provider === "claude-code" ? "claude" : lc.provider === "codex-cli" ? "codex" : "api")
  const base = (lc.customEndpoint ?? "").replace(/\/+$/, "")
  const endpoint = process.env.HEADLESS_LLM_ENDPOINT
    ?? (base ? `${base}/chat/completions` : "https://openrouter.ai/api/v1/chat/completions")
  const model = process.env.AGENT_MODEL ?? lc.model ?? process.env.HEADLESS_LLM_MODEL ?? "openai/gpt-4o-mini"
  const apiKey = process.env.HEADLESS_LLM_API_KEY ?? lc.apiKey ?? ""
  return { provider, model, endpoint, apiKey }
}

interface AgentRequest {
  message: string
  sessionId?: string
  runId?: string
  history?: Array<{ role: string; content: unknown }>
}

function sse(sessionId: string, runId: string, event: unknown): Uint8Array {
  return enc.encode(`data: ${JSON.stringify({ sessionId, runId, event })}\n\n`)
}

const TOOLS = [
  {
    type: "function",
    function: {
      name: "wiki_search",
      description: "Cerca nelle pagine wiki del brain per parole chiave. Ritorna titoli, percorsi e snippet.",
      parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    },
  },
  {
    type: "function",
    function: {
      name: "wiki_read",
      description: "Leggi il contenuto completo di una pagina wiki dato il suo path (es. wiki/entities/n8n.md).",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
  },
  {
    type: "function",
    function: {
      name: "wiki_write",
      description: "Crea o aggiorna una pagina wiki (path sotto wiki/). Usa solo se l'utente chiede di scrivere/modificare.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
      },
    },
  },
]

function guard(vault: string, p: string): string {
  const abs = resolve(vault, p)
  if (abs !== vault && !abs.startsWith(vault + sep)) throw new Error(`path outside vault: ${p}`)
  return abs
}

/** Run a tool, returning the string result + any page reference to surface. */
async function runTool(
  vault: string,
  name: string,
  args: any,
): Promise<{ result: string; ref?: { title: string; path: string; snippet?: string } }> {
  if (name === "wiki_search") {
    const pages = await rgSearch(vault, String(args.query ?? ""), 8)
    if (!pages.length) return { result: "Nessuna pagina trovata." }
    return { result: pages.map((p) => `- ${p.title} (${p.path}): ${p.snippet}`).join("\n") }
  }
  if (name === "wiki_read") {
    const content = await readFile(guard(vault, args.path), "utf8").catch(() => "")
    if (!content) return { result: `Pagina non trovata: ${args.path}` }
    return {
      result: content.slice(0, 8000),
      ref: { title: args.path.split("/").pop()?.replace(/\.md$/, "") ?? args.path, path: args.path },
    }
  }
  if (name === "wiki_write") {
    const abs = guard(vault, args.path)
    await mkdir(dirname(abs), { recursive: true })
    await writeFile(abs, String(args.content ?? ""), "utf8")
    return { result: `Scritto ${args.path}`, ref: { title: args.path, path: args.path } }
  }
  return { result: `Tool sconosciuto: ${name}` }
}

async function callLlm(messages: any[], stream: boolean, cfg: AgentConfig): Promise<Response> {
  return fetch(cfg.endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({ model: cfg.model, messages, tools: TOOLS, stream }),
  })
}

/** Local CLI brain (claude/codex) with its own tools, cwd = vault. Streams
 *  stdout as messageDelta. User-authorized full-tool mode (password + tailnet). */
async function streamCli(
  controller: ReadableStreamDefaultController<Uint8Array>,
  emit: (c: ReadableStreamDefaultController<Uint8Array>, e: unknown) => void,
  vault: string,
  message: string,
  cfg: AgentConfig,
): Promise<void> {
  const isCodex = cfg.provider === "codex"
  // Absolute paths: the systemd --user PATH doesn't include ~/.local/bin.
  const cmd = isCodex
    ? (process.env.AGENT_CODEX_BIN ?? "/opt/node25/bin/codex")
    : (process.env.AGENT_CLAUDE_BIN ?? "/home/claude/.local/bin/claude")
  // Non-interactive full-tool: skip per-tool approval prompts (they would hang
  // with no stdin). claude uses stream-json so tokens flow live (plain -p buffers
  // the whole answer until exit → the SSE would sit silent and drop).
  const args = isCodex
    ? ["exec", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox", message]
    : ["-p", "--dangerously-skip-permissions", "--output-format", "stream-json", "--verbose", message]
  emit(controller, { type: "toolStart", tool: isCodex ? "codex" : "claude", input: "CLI nel vault" })
  const child = spawn(cmd, args, { cwd: vault, env: process.env })
  child.on("error", (e) => emit(controller, { type: "error", message: `CLI spawn: ${e.message}` }))
  child.stdin.end()
  let err = ""
  let buf = ""
  child.stdout.on("data", (d) => {
    if (isCodex) { emit(controller, { type: "messageDelta", text: d.toString() }); return }
    // claude stream-json: newline-delimited JSON events; pull assistant text.
    buf += d.toString()
    const lines = buf.split("\n")
    buf = lines.pop() ?? ""
    for (const line of lines) {
      const s = line.trim()
      if (!s) continue
      try {
        const ev = JSON.parse(s)
        // Emit assistant text as it streams. (Skip the final "result" event —
        // it repeats the last assistant text, which would duplicate the answer.)
        if (ev.type === "assistant" && ev.message?.content) {
          for (const c of ev.message.content) if (c.type === "text" && c.text) emit(controller, { type: "messageDelta", text: c.text })
        }
      } catch { /* partial line */ }
    }
  })
  child.stderr.on("data", (d) => { err += d.toString() })
  const code: number = await new Promise((res) => {
    child.on("close", (c) => res(c ?? 0))
    child.on("error", () => res(-1))
  })
  emit(controller, { type: "toolEnd", tool: isCodex ? "codex" : "claude", output: code === 0 ? "completato" : `exit ${code}` })
  if (code !== 0 && err.trim()) emit(controller, { type: "messageDelta", text: `\n_(${err.trim().slice(0, 200)})_` })
}

export function agentStream(vault: string, req: AgentRequest): ReadableStream<Uint8Array> {
  const sessionId = req.sessionId ?? "web"
  const runId = req.runId ?? "web"
  const emit = (c: ReadableStreamDefaultController<Uint8Array>, event: unknown) => c.enqueue(sse(sessionId, runId, event))

  return new ReadableStream({
    async start(controller) {
      const cfg = await resolveConfig(vault)
      console.error(`[agent] start provider=${cfg.provider} model=${cfg.model} msg=${JSON.stringify(req.message)?.slice(0, 50)}`)
      try {
        // CLI brain (full-tool, cwd=vault) when the Settings provider is a CLI.
        if (cfg.provider === "claude" || cfg.provider === "codex") {
          await streamCli(controller, emit, vault, req.message, cfg)
          emit(controller, { type: "done" })
          controller.close()
          return
        }
        const history = (req.history ?? []).slice(-6).map((m) => ({
          role: m.role === "assistant" ? "assistant" : "user",
          content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
        }))
        const messages: any[] = [
          {
            role: "system",
            content:
              "Sei l'agente del brain personale di Thomas. Workflow OBBLIGATORIO: (1) wiki_search con parole chiave; " +
              "(2) wiki_read delle 1-2 pagine più rilevanti trovate — NON rispondere solo dagli snippet, leggi sempre " +
              "il contenuto prima; (3) rispondi citando titoli/percorsi. Se dopo aver letto non c'è l'informazione, dillo. " +
              "Rispondi in italiano, conciso. Scrivi pagine (wiki_write) solo se richiesto esplicitamente.",
          },
          ...history,
          { role: "user", content: req.message },
        ]

        for (let step = 0; step < MAX_STEPS; step++) {
          const res = await callLlm(messages, false, cfg)
          if (!res.ok) { emit(controller, { type: "error", message: `LLM HTTP ${res.status}: ${(await res.text()).slice(0, 200)}` }); break }
          const data = await res.json()
          const msg = data?.choices?.[0]?.message
          if (!msg) { emit(controller, { type: "error", message: "risposta LLM vuota" }); break }

          const toolCalls = msg.tool_calls ?? []
          if (toolCalls.length === 0) {
            // Final answer — stream it out as messageDelta chunks.
            const text = String(msg.content ?? "")
            for (let i = 0; i < text.length; i += 24) emit(controller, { type: "messageDelta", text: text.slice(i, i + 24) })
            break
          }

          // Execute each tool call, feed results back.
          messages.push({ role: "assistant", content: msg.content ?? "", tool_calls: toolCalls })
          for (const tc of toolCalls) {
            let args: any = {}
            try { args = JSON.parse(tc.function.arguments || "{}") } catch { /* keep */ }
            const label = tc.function.name === "wiki_search" ? `cerca: ${args.query ?? ""}` : tc.function.name === "wiki_read" ? `leggi: ${args.path ?? ""}` : tc.function.name
            emit(controller, { type: "toolStart", tool: tc.function.name, input: label })
            let out: { result: string; ref?: any }
            try { out = await runTool(vault, tc.function.name, args) } catch (e: any) { out = { result: `errore: ${e?.message ?? e}` } }
            emit(controller, { type: "toolEnd", tool: tc.function.name, output: out.result.slice(0, 120) })
            if (out.ref) emit(controller, { type: "referenceAdded", reference: { title: out.ref.title, path: out.ref.path, kind: "wiki", snippet: out.ref.snippet } })
            messages.push({ role: "tool", tool_call_id: tc.id, content: out.result })
          }
          if (step === MAX_STEPS - 1) {
            emit(controller, { type: "messageDelta", text: "\n\n_(troppi passaggi — mi fermo qui.)_" })
          }
        }
        emit(controller, { type: "done" })
      } catch (e: any) {
        emit(controller, { type: "error", message: e?.message ?? String(e) })
        emit(controller, { type: "done" })
      }
      controller.close()
    },
  })
}
