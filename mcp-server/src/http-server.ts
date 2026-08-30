#!/usr/bin/env node
// Streamable HTTP transport for the LLM Wiki MCP server — same shape as the
// vault (company-brain-kit/modules/mcp-server) and OpenWA bridges built the
// same night: session-based StreamableHTTPServerTransport, dual auth
// (static bearer for clients without OAuth support + DCR/password-gated
// OAuth for everyone else), Cloudflare Tunnel in front. Unlike those two,
// this one also auto-starts a Quick Tunnel when no custom domain is
// configured — see quick-tunnel.ts — so it works out of the box for anyone
// running LLM Wiki, not just deployments with their own domain.
import { randomUUID, timingSafeEqual } from "node:crypto"
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js"
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js"
import type { Request, Response, NextFunction } from "express"
import { createToolServer } from "./tool-server.js"
import { LlmWikiOAuthProvider } from "./oauth-provider.js"
import { startQuickTunnel } from "./quick-tunnel.js"
import { verifyImageSig } from "./image-url.js"
import { readImage } from "./vault-fs.js"

const VERSION = "0.1.0"
const PORT = process.env.MCP_HTTP_PORT ? parseInt(process.env.MCP_HTTP_PORT, 10) : 8931
const HOST = process.env.MCP_HTTP_HOST ?? "127.0.0.1"
const TOKEN = process.env.MCP_HTTP_TOKEN
const APPROVAL_PASSWORD = process.env.OAUTH_APPROVAL_PASSWORD

async function main(): Promise<void> {
  if (!TOKEN && HOST !== "127.0.0.1" && HOST !== "localhost" && HOST !== "::1") {
    console.error(
      `Refusing to start: MCP_HTTP_HOST=${HOST} exposes this server beyond localhost but MCP_HTTP_TOKEN is unset. ` +
      "Set MCP_HTTP_TOKEN or bind to 127.0.0.1.",
    )
    process.exit(1)
  }
  if (!TOKEN) {
    console.error("[llm-wiki-mcp-http] WARNING: MCP_HTTP_TOKEN unset — static bearer auth disabled.")
  }

  // Resolve the public URL BEFORE building the app: OAuth's issuer/redirect
  // metadata must exactly match how clients actually reach this server, so
  // whether it comes from env (a stable named tunnel) or a freshly-started
  // Quick Tunnel, it has to be known before mcpAuthRouter is constructed.
  let publicHostname = process.env.MCP_PUBLIC_HOSTNAME
  let quickTunnelUrl: string | undefined
  if (!publicHostname) {
    console.error("[llm-wiki-mcp-http] MCP_PUBLIC_HOSTNAME not set — starting a Cloudflare Quick Tunnel (no domain required)...")
    try {
      const tunnel = await startQuickTunnel(PORT)
      quickTunnelUrl = tunnel.url
      publicHostname = new URL(tunnel.url).hostname
      console.error(`[llm-wiki-mcp-http] Quick Tunnel ready: ${tunnel.url} (changes on every restart)`)
      process.on("SIGINT", () => { tunnel.stop(); process.exit(0) })
      process.on("SIGTERM", () => { tunnel.stop(); process.exit(0) })
    } catch (err) {
      console.error(
        `[llm-wiki-mcp-http] Could not start a Quick Tunnel: ${err instanceof Error ? err.message : String(err)}. ` +
        "Remote access (OAuth, and any client outside this machine) is unavailable. " +
        "The server still works for localhost-only clients.",
      )
    }
  }
  if (publicHostname && !APPROVAL_PASSWORD) {
    console.error(
      "Refusing to start: a public hostname is configured (OAuth/DCR would be enabled) but OAUTH_APPROVAL_PASSWORD is unset. " +
      "Without it, anyone who self-registers a client via DCR gets an auto-approved token.",
    )
    process.exit(1)
  }

  const oauthProvider = publicHostname ? new LlmWikiOAuthProvider(APPROVAL_PASSWORD!) : undefined

  function checkBearer(req: Request, res: Response, next: NextFunction): void {
    const header = req.headers.authorization ?? ""
    if (TOKEN) {
      const expected = `Bearer ${TOKEN}`
      if (header.length === expected.length && timingSafeEqual(Buffer.from(header), Buffer.from(expected))) {
        next()
        return
      }
    }
    const [scheme, token] = header.split(" ")
    if (oauthProvider && scheme === "Bearer" && token) {
      oauthProvider
        .verifyAccessToken(token)
        .then(() => next())
        .catch(() => res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null }))
      return
    }
    if (!TOKEN && !oauthProvider) {
      next() // no auth configured at all — localhost-only per the guard above
      return
    }
    res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null })
  }

  const ALLOWED_HOSTS = process.env.MCP_HTTP_ALLOWED_HOSTS?.split(",").map((h) => h.trim()).filter(Boolean)
    ?? (publicHostname ? [publicHostname] : undefined)
  const app = createMcpExpressApp(ALLOWED_HOSTS?.length ? { host: HOST, allowedHosts: ALLOWED_HOSTS } : { host: HOST })
  app.set("trust proxy", 1) // Cloudflare Tunnel (named or Quick) is the only reverse proxy in front
  app.get("/healthz", (_req, res) => res.json({ ok: true, version: VERSION, publicUrl: quickTunnelUrl ?? (publicHostname ? `https://${publicHostname}` : null) }))

  // ── GET /vimg — l'unico punto del server senza autenticazione ──────────────
  //
  // Serve UNA immagine del vault a chi presenta un URL firmato. Esiste perché
  // ChatGPT e gran parte dei connettori mostrano un'immagine markdown ma NON
  // rendono il contenuto inline dell'MCP: senza questa route `vault_read_image`
  // restituisce byte che il client non disegna.
  //
  // ⚠️ Due difese, in quest'ordine, e nessuna delle due è ridondante:
  //
  //   1. la FIRMA dice che l'URL l'ha emesso questo server e non è scaduto;
  //   2. `resolveVaultPath` dice che il file è dentro il vault.
  //
  // La seconda serve anche quando la prima passa: un percorso malevolo firmato
  // con la chiave giusta — un bug a monte, non un attacco esterno — supererebbe
  // il controllo della firma. Senza il secondo cancello quella sarebbe lettura
  // arbitraria di file su una porta esposta a internet.
  //
  // I nomi dei parametri sono `p`/`e`/`s` perché li scrive già
  // `buildSignedImageUrl`: cambiarli qui renderebbe invalido ogni URL emesso.
  app.get("/vimg", async (req, res) => {
    const vaultRoot = process.env.VAULT_ROOT?.trim()
    const secret = process.env.MCP_HTTP_TOKEN
    // Senza segreto nessun URL può essere valido. Rispondere 404 invece di
    // firmare con stringa vuota: un server che accetta qualunque firma è
    // peggio di uno che nega tutto.
    if (!vaultRoot || !secret) return void res.status(404).end()

    const relPath = String(req.query.p ?? "")
    const exp = Number(req.query.e)
    const sig = String(req.query.s ?? "")

    if (!relPath || !verifyImageSig(relPath, exp, sig, secret)) {
      return void res.status(403).json({ error: "bad or expired signature" })
    }

    try {
      const { base64, mimeType } = await readImage(vaultRoot, relPath)
      // La cache non deve sopravvivere all'URL: un browser che tiene l'immagine
      // più a lungo della firma serve un contenuto il cui link è già scaduto.
      const residuo = Math.max(0, exp - Math.floor(Date.now() / 1000))
      res.setHeader("Content-Type", mimeType)
      res.setHeader("Cache-Control", `private, max-age=${residuo}`)
      res.send(Buffer.from(base64, "base64"))
    } catch (err) {
      // `resolveVaultPath` LANCIA quando il percorso esce dal vault: senza
      // questo catch diventerebbe un 500, cioè un difetto travestito da guasto.
      const msg = err instanceof Error ? err.message : String(err)
      if (/escapes the vault|must be relative|not a supported image/i.test(msg)) {
        return void res.status(403).json({ error: "forbidden path" })
      }
      res.status(404).json({ error: "not found" })
    }
  })

  if (oauthProvider && publicHostname) {
    const publicUrl = new URL(`https://${publicHostname}`)
    app.use(
      mcpAuthRouter({
        provider: oauthProvider,
        issuerUrl: publicUrl,
        resourceServerUrl: new URL("/mcp", publicUrl),
        scopesSupported: ["mcp"],
      }),
    )
    app.post("/authorize/approve", async (req, res) => {
      await oauthProvider.approve(req.body?.requestId, req.body?.password, res)
    })
  }

  const transports: Record<string, StreamableHTTPServerTransport> = {}

  app.post("/mcp", checkBearer, async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined
    try {
      let transport: StreamableHTTPServerTransport
      if (sessionId && transports[sessionId]) {
        transport = transports[sessionId]
      } else if (!sessionId && isInitializeRequest(req.body)) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => { transports[sid] = transport },
        })
        transport.onclose = () => {
          const sid = transport.sessionId
          if (sid) delete transports[sid]
        }
        const server = createToolServer()
        await server.connect(transport)
        await transport.handleRequest(req, res, req.body)
        return
      } else {
        res.status(400).json({ jsonrpc: "2.0", error: { code: -32000, message: "Bad Request: No valid session ID provided" }, id: null })
        return
      }
      await transport.handleRequest(req, res, req.body)
    } catch (err) {
      console.error("[llm-wiki-mcp-http] error handling POST /mcp:", err)
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null })
      }
    }
  })

  async function handleSessionRequest(req: Request, res: Response): Promise<void> {
    const sessionId = req.headers["mcp-session-id"] as string | undefined
    const transport = sessionId ? transports[sessionId] : undefined
    if (!transport) {
      res.status(400).send("Invalid or missing session ID")
      return
    }
    await transport.handleRequest(req, res)
  }
  app.get("/mcp", checkBearer, handleSessionRequest)
  app.delete("/mcp", checkBearer, handleSessionRequest)

  app.listen(PORT, HOST, () => {
    const publicUrl = quickTunnelUrl ? `${quickTunnelUrl}/mcp` : publicHostname ? `https://${publicHostname}/mcp` : null
    console.error(
      `LLM Wiki MCP HTTP server v${VERSION} listening on http://${HOST}:${PORT}/mcp ` +
      `(static token: ${TOKEN ? "yes" : "no"}, OAuth/DCR: ${oauthProvider ? "yes" : "no"})` +
      (publicUrl ? `\nPublic URL: ${publicUrl}` : ""),
    )
  })
}

main().catch((err) => {
  console.error("Failed to start LLM Wiki MCP HTTP server:", err)
  process.exit(1)
})
