import { randomUUID, randomBytes, timingSafeEqual } from "node:crypto"
import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"
import type { Response } from "express"
import type { OAuthServerProvider, AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js"
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js"
import type { OAuthClientInformationFull, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js"
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js"
import { InvalidGrantError } from "@modelcontextprotocol/sdk/server/auth/errors.js"

// Same pattern as company-brain-kit/modules/mcp-server (the vault MCP):
// any MCP host self-registers via DCR (POST /register, SDK-native,
// rate-limited to 20/hour) with its own real redirect_uri — no more
// hardcoding a callback URL per platform. Registration alone grants zero
// access; authorize() below gates every request behind a password only the
// vault/WhatsApp owner knows, regardless of which client is asking.
const CODE_TTL_MS = 5 * 60 * 1000
const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000
const PENDING_APPROVAL_TTL_MS = 5 * 60 * 1000

interface StoredCode {
  clientId: string
  codeChallenge: string
  scopes: string[]
  expiresAt: number
}

interface StoredToken {
  clientId: string
  scopes: string[]
  expiresAt: number
}

interface PendingApproval {
  client: OAuthClientInformationFull
  params: AuthorizationParams
  expiresAt: number
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

/**
 * Where the granted authorisations live between restarts.
 *
 * Set OAUTH_STATE_FILE to enable; unset keeps the previous in-memory behaviour.
 * Holding these only in memory meant every service restart silently revoked the
 * connection: the client still showed as linked, then asked to reconnect on the
 * next call. Fine while the only user was the person doing the restart, wrong
 * once someone else depends on it.
 */
const STATE_FILE = process.env.OAUTH_STATE_FILE?.trim() || ""

interface PersistedState {
  clients: Record<string, OAuthClientInformationFull>
  accessTokens: Record<string, StoredToken>
  refreshTokens: Record<string, StoredToken>
}

function loadState(): PersistedState {
  const empty: PersistedState = { clients: {}, accessTokens: {}, refreshTokens: {} }
  if (!STATE_FILE) return empty
  try {
    const parsed = JSON.parse(readFileSync(STATE_FILE, "utf8"))
    return {
      clients: parsed.clients ?? {},
      accessTokens: parsed.accessTokens ?? {},
      refreshTokens: parsed.refreshTokens ?? {},
    }
  } catch {
    // Missing or corrupt state is not fatal: the client re-authorises once,
    // which is exactly the old behaviour rather than a new failure mode.
    return empty
  }
}

/** Write via a temp file + rename so a crash mid-write cannot truncate the state. */
function saveState(state: PersistedState): void {
  if (!STATE_FILE) return
  try {
    mkdirSync(dirname(STATE_FILE), { recursive: true })
    const tmp = `${STATE_FILE}.tmp`
    writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 })
    renameSync(tmp, STATE_FILE)
  } catch (err) {
    console.error("[oauth] could not persist state:", err instanceof Error ? err.message : err)
  }
}

class DynamicClientsStore implements OAuthRegisteredClientsStore {
  private readonly clients = new Map<string, OAuthClientInformationFull>()
  onChange?: () => void

  constructor(initial: Record<string, OAuthClientInformationFull> = {}) {
    for (const [id, client] of Object.entries(initial)) this.clients.set(id, client)
  }

  entries(): Record<string, OAuthClientInformationFull> {
    return Object.fromEntries(this.clients)
  }

  async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    return this.clients.get(clientId)
  }

  async registerClient(
    client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">
  ): Promise<OAuthClientInformationFull> {
    const full = client as OAuthClientInformationFull
    this.clients.set(full.client_id, full)
    this.onChange?.()
    return full
  }
}

function renderApprovalForm(requestId: string, clientName: string, error?: string): string {
  const errorHtml = error ? `<p style="color:#b00020;margin:0 0 12px">${error}</p>` : ""
  return `<!doctype html>
<html lang="it"><head><meta charset="utf-8"><title>Autorizza accesso</title>
<meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="font-family:system-ui,sans-serif;max-width:420px;margin:80px auto;padding:0 16px">
<h1 style="font-size:18px">Autorizza accesso a LLM Wiki</h1>
<p>Client: <strong>${clientName}</strong></p>
${errorHtml}
<form method="POST" action="/authorize/approve">
<input type="hidden" name="requestId" value="${requestId}">
<input type="password" name="password" placeholder="Password" autofocus
  style="width:100%;padding:8px;font-size:16px;box-sizing:border-box;margin-bottom:12px">
<button type="submit" style="width:100%;padding:8px;font-size:16px">Autorizza</button>
</form>
</body></html>`
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!)
}

// Granted authorisations survive a restart when OAUTH_STATE_FILE is set; codes
// and pending approvals deliberately do not — they live five minutes and a
// restart mid-handshake is better retried than resumed.
export class LlmWikiOAuthProvider implements OAuthServerProvider {
  readonly clientsStore: DynamicClientsStore
  private codes = new Map<string, StoredCode>()
  private accessTokens: Map<string, StoredToken>
  private refreshTokens: Map<string, StoredToken>
  private pendingApprovals = new Map<string, PendingApproval>()

  constructor(private readonly approvalPassword: string) {
    const state = loadState()
    this.clientsStore = new DynamicClientsStore(state.clients)
    this.accessTokens = new Map(Object.entries(state.accessTokens))
    this.refreshTokens = new Map(Object.entries(state.refreshTokens))
    this.clientsStore.onChange = () => this.persist()
  }

  private persist(): void {
    saveState({
      clients: this.clientsStore.entries(),
      accessTokens: Object.fromEntries(this.accessTokens),
      refreshTokens: Object.fromEntries(this.refreshTokens),
    })
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    const requestId = randomUUID()
    this.pendingApprovals.set(requestId, { client, params, expiresAt: Date.now() + PENDING_APPROVAL_TTL_MS })
    res.send(renderApprovalForm(requestId, escapeHtml(client.client_name ?? client.client_id)))
  }

  async approve(requestId: string | undefined, password: string | undefined, res: Response): Promise<void> {
    const pending = requestId ? this.pendingApprovals.get(requestId) : undefined
    if (!pending || pending.expiresAt < Date.now()) {
      res.status(400).send(`<!doctype html><p>Richiesta scaduta o non valida. Riprova il collegamento dal client MCP.</p>`)
      return
    }
    if (!password || !safeEqual(password, this.approvalPassword)) {
      res
        .status(401)
        .send(renderApprovalForm(requestId!, escapeHtml(pending.client.client_name ?? pending.client.client_id), "Password errata."))
      return
    }
    this.pendingApprovals.delete(requestId!) // one-time use

    const { client, params } = pending
    const code = randomUUID()
    this.codes.set(code, {
      clientId: client.client_id,
      codeChallenge: params.codeChallenge,
      scopes: params.scopes ?? [],
      expiresAt: Date.now() + CODE_TTL_MS,
    })
    const target = new URL(params.redirectUri)
    target.searchParams.set("code", code)
    if (params.state !== undefined) target.searchParams.set("state", params.state)
    res.redirect(target.toString())
  }

  async challengeForAuthorizationCode(_client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    const stored = this.codes.get(authorizationCode)
    if (!stored || stored.expiresAt < Date.now()) throw new InvalidGrantError("Invalid or expired authorization code")
    return stored.codeChallenge
  }

  async exchangeAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<OAuthTokens> {
    const stored = this.codes.get(authorizationCode)
    if (!stored || stored.expiresAt < Date.now()) throw new InvalidGrantError("Invalid or expired authorization code")
    if (stored.clientId !== client.client_id) throw new InvalidGrantError("Authorization code was not issued to this client")
    this.codes.delete(authorizationCode) // one-time use

    const accessToken = randomBytes(32).toString("hex")
    const refreshToken = randomBytes(32).toString("hex")
    this.accessTokens.set(accessToken, {
      clientId: client.client_id,
      scopes: stored.scopes,
      expiresAt: Date.now() + ACCESS_TOKEN_TTL_MS,
    })
    this.refreshTokens.set(refreshToken, { clientId: client.client_id, scopes: stored.scopes, expiresAt: Infinity })
    this.persist()

    return {
      access_token: accessToken,
      token_type: "bearer",
      expires_in: ACCESS_TOKEN_TTL_MS / 1000,
      refresh_token: refreshToken,
      scope: stored.scopes.join(" "),
    }
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string): Promise<OAuthTokens> {
    const stored = this.refreshTokens.get(refreshToken)
    if (!stored) throw new InvalidGrantError("Invalid refresh token")
    if (stored.clientId !== client.client_id) throw new InvalidGrantError("Refresh token was not issued to this client")

    const accessToken = randomBytes(32).toString("hex")
    this.accessTokens.set(accessToken, {
      clientId: client.client_id,
      scopes: stored.scopes,
      expiresAt: Date.now() + ACCESS_TOKEN_TTL_MS,
    })
    // Anche il rinnovo va scritto: senza, un riavvio dopo un refresh riporta
    // il token vecchio, gia' scaduto, e il client rifa' il login comunque.
    this.persist()
    return {
      access_token: accessToken,
      token_type: "bearer",
      expires_in: ACCESS_TOKEN_TTL_MS / 1000,
      refresh_token: refreshToken,
      scope: stored.scopes.join(" "),
    }
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const stored = this.accessTokens.get(token)
    if (!stored || stored.expiresAt < Date.now()) throw new Error("Invalid or expired access token")
    return { token, clientId: stored.clientId, scopes: stored.scopes, expiresAt: Math.floor(stored.expiresAt / 1000) }
  }
}
