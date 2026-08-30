import { promises as fs } from "node:fs"
import path from "node:path"
import type { Tool } from "@modelcontextprotocol/sdk/types.js"
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js"
import { readNote, listNotes, writeNote, appendNote, searchNotes, readImage, openSource, VaultError } from "./vault-fs.js"
import { buildGraph, createMissingPage, formatGraph, kebab, nuovoId } from "./vault-graph.js"
import { buildSignedImageUrl } from "./image-url.js"
import {
  configLlm,
  flussoOpenAI,
  potaSulFlusso,
  PROMPT_VOCE,
  scriviInStreaming,
  type Prova,
} from "./page-stream.js"

// Filenames checked, in order, for the vault's usage rules — the actual
// content an agent needs before writing (frontmatter schema, folder
// purposes, anti-orphan/wikilink rules, what's read-only). AGENTS.md/
// AGENT.md (the emerging cross-vendor convention) comes first: a caller
// reaching this tool over MCP is a remote agent regardless of vendor, and
// even Claude itself can't invoke this vault's local Claude Code skills
// through a remote MCP session — so the vendor-neutral file is what
// actually applies here. CLAUDE.md is the fallback for vaults that only
// have that one; README.md is the fallback for vaults with neither.
const CONVENTIONS_FILENAMES = ["AGENTS.md", "AGENT.md", "CLAUDE.md", "README.md"]

// Optional second capability bundled into this MCP server: read/write access
// to an Obsidian-style Company Brain vault, independent of any LLM Wiki
// project. Only registered when VAULT_ROOT is configured — most LLM Wiki
// users won't set this, and the tool list should stay empty for them rather
// than exposing broken vault_* tools that always error.
export interface VaultToolsConfig {
  vaultRoot: string
  readonlyPrefixes: string[]
}

export function loadVaultToolsConfig(): VaultToolsConfig | undefined {
  const vaultRoot = process.env.VAULT_ROOT?.trim()
  if (!vaultRoot) return undefined
  const readonlyPrefixes = (process.env.VAULT_READONLY_PREFIXES ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
  return { vaultRoot, readonlyPrefixes }
}

export const VAULT_TOOLS: Tool[] = [
  {
    name: "vault_get_conventions",
    description: "Read the vault's usage rules: frontmatter schema, folder structure and purpose, wikilink/anti-orphan conventions, and which areas are read-only (e.g. immutable source material). Call this FIRST, before writing or navigating the vault with the other vault_* tools — writing a note without following these rules produces a note the vault's own tooling treats as broken (orphaned, wrong schema, or written into a read-only area).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "vault_read_note",
    description: "Read the raw content (including frontmatter) of a markdown note at a vault-relative path. If the note embeds images and the user wants to see them, the ![](media/...) targets are real files — resolve them against the vault root and pass them to vault_read_image. To reach the document the note was built from, use vault_open_source.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "Vault-relative path, e.g. entities/clienti/mbm-edilizia.md" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "vault_list_notes",
    description:
      "LOOKING FOR AN IMAGE? Call this with kind:\"images\" — that is the only way to get a real image path, and vault_read_image needs an exact one. Do not guess paths from what a note references: image files sit in folders no markdown listing shows, so a guessed path returns nothing and the vault looks empty when it is not. " +
      "IT RETURNS PATHS, NOT PICTURES: when the user asked to see, show, or list images, follow up with vault_read_image on each one — a list of filenames is not what they asked for. " +
      "Extracted figures (the ones with generated captions) live under wiki/media; raw/sources holds the untouched originals. " +
      "Otherwise: lists markdown note paths under a folder, or the whole vault if omitted.",
    inputSchema: {
      type: "object",
      properties: {
        folder: { type: "string", description: "Vault-relative folder, e.g. entities/clienti or wiki/media" },
        kind: {
          type: "string",
          enum: ["notes", "images"],
          description: "notes = .md (default), images = png/jpg/jpeg/gif/webp/svg/bmp/tiff",
        },
        limit: { type: "number", description: "Max paths returned, default 200" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "vault_search_notes",
    description: "Full-text search across all markdown notes in the vault. It returns matching lines, not whole notes: follow up with vault_read_note on the paths that matter. If the words the user chose do not appear anywhere but the topic clearly should exist, the vault indexes meaning too — llm_wiki_search finds passages that never use those exact words.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Text to search for" },
        limit: { type: "number", description: "Max results, default 20" },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "vault_write_note",
    description: "Overwrite an existing note's full content at a vault-relative path. To create a NEW entry about a topic, use vault_create_missing_page instead: it grounds the page in what the vault already contains and links only to pages that exist, while this tool writes exactly what you give it — so any [[link]] you invent here lands as a broken one. Call vault_get_conventions first: the vault enforces a frontmatter schema, folder purposes, and a minimum of outgoing wikilinks.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Vault-relative path, must end in .md" },
        content: { type: "string", description: "Full file content, including frontmatter if applicable" },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "vault_graph",
    description:
      "Read the vault's [[wikilink]] graph straight from disk: every page with its REAL vault-relative path, its outgoing links, the links that point at nothing, and the pages nobody cites. Call this before writing a [[link]] — it tells you the exact page id to use instead of guessing a path, and lists the missing targets you may want to create with vault_create_missing_page.",
    inputSchema: {
      type: "object",
      properties: {
        folder: { type: "string", description: "Restrict to a vault-relative folder, e.g. concepts" },
        limit: { type: "number", description: "Max rows per section, default 200" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "vault_create_missing_page",
    description:
      "THE way to create a new page in the vault — use this whenever asked to create, add or write an entry about a topic, and for the page a dangling [[wikilink]] points to. Do not hand-write a new page with vault_write_note: this tool first asks the semantic index which existing pages are about this title, so the entry is grounded in what the vault actually holds and its [[links]] point only at pages that exist, instead of being guessed. APPEND-ONLY: if a page with that name already exists anywhere in the vault it is left untouched and the existing path is returned — this tool never overwrites, merges or deletes. The new page gets the vault's frontmatter plus a stable id and an aliases list, so a later merge or rename cannot break inbound links.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Human title, e.g. Metamedicina. The filename is derived in kebab-case." },
        folder: { type: "string", description: "Target folder, default concepts" },
        summary: { type: "string", description: "One-line summary for the frontmatter" },
        body: { type: "string", description: "Markdown body. Omit for a stub placeholder." },
        aliases: { type: "array", items: { type: "string" }, description: "Alternative names that must keep resolving to this page" },
        related: { type: "array", items: { type: "string" }, description: "Page ids to link out to (anti-orphan rule)" },
        visibility: { type: "string", description: "Visibility label the search pre-filters on. Default: all" },
        generate: {
          type: "boolean",
          description:
            "Write the prose too, streamed. The entry is synthesised from the pages the semantic index already associates with this title, and it may only link to those pages -- so its [[links]] are never guessed. Progress notifications carry the text as it is produced. Without this the page is a stub.",
        },
      },
      required: ["title"],
      additionalProperties: false,
    },
  },
  {
    name: "vault_append_note",
    description: "Append text to the end of a markdown note, creating it if it doesn't exist. Call vault_get_conventions first if the note doesn't exist yet — new notes still need the vault's frontmatter schema.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Vault-relative path, must end in .md" },
        content: { type: "string", description: "Text to append" },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "vault_read_image",
    description:
      "Read an image from the vault. Returns it inline AND as a signed HTTPS link, because clients differ: some render MCP image content, others (ChatGPT among them) only render a markdown image URL. Large images are downscaled first — a 2752x1536 figure goes from 6,835 KB to 346 KB and reads identically, since a model downsamples it anyway. The link is HMAC-signed, expires within the hour, and grants read of that one image only.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Vault-relative path to the image (png, jpg, gif, webp, svg, bmp, tiff)" },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "vault_open_source",
    description:
      "Get back to the original a note was built from. Notes keep the path of the file they came from, but the file itself is not on disk — keeping hundreds of GB of originals next to the vault was never possible. Given the note, this mints a temporary Dropbox download link from that path, or points at the local copy when one exists.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Vault-relative path of the note whose source you want" },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
]

const VAULT_TOOL_NAMES = new Set(VAULT_TOOLS.map((t) => t.name))

export function isVaultTool(name: string): boolean {
  return VAULT_TOOL_NAMES.has(name)
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] }
}

function vaultError(err: unknown): never {
  const message = err instanceof VaultError ? err.message : err instanceof Error ? err.message : String(err)
  throw new McpError(ErrorCode.InternalError, message)
}

function stringArg(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new McpError(ErrorCode.InvalidParams, `${name} is required`)
  }
  return value
}

async function readConventions(vaultRoot: string): Promise<string> {
  for (const filename of CONVENTIONS_FILENAMES) {
    try {
      const content = await fs.readFile(path.join(vaultRoot, filename), "utf8")
      return `# Conventions (${filename})\n\n${content}`
    } catch {
      continue // try the next filename
    }
  }
  return `No conventions file found at vault root (checked: ${CONVENTIONS_FILENAMES.join(", ")}). Proceed with generic Markdown; no vault-specific schema to follow.`
}

/** Ciò che serve alla generazione e che il server sa procurare: le fonti dal
 *  motore di ricerca, e un modo per riferire l'avanzamento. */
export interface DepsGenerazione {
  cercaProve?: (query: string, topK: number) => Promise<Prova[]>
  onPezzo?: (testo: string, totale: number) => void
}

/**
 * D0 — la voce si scrive su richiesta, in streaming, e i suoi collegamenti non
 * si indovinano.
 *
 * I bersagli ammessi sono **i nomi delle pagine che l'indice ha restituito**:
 * esistono per costruzione. È la differenza che si misura — sul percorso vecchio
 * fino a 82 collegamenti verso pagine inesistenti e 55 scritti col percorso, che
 * il motore non risolve e che spariscono senza dare errore.
 *
 * ⛔ Non sovrascrive (D5): se il nome è già preso, si ferma.
 */
async function generaVoce(
  args: Record<string, unknown>,
  config: VaultToolsConfig,
  deps: DepsGenerazione,
) {
  const titolo = stringArg(args.title, "title")
  const cartella = (typeof args.folder === "string" && args.folder.trim() ? args.folder : "concepts")
    .replace(/^\/+|\/+$/g, "")
  const slug = kebab(titolo)
  if (!slug) throw new McpError(ErrorCode.InvalidParams, `"${titolo}" non produce un nome valido`)

  const esistenti = await listNotes(config.vaultRoot, ".").catch(() => [] as string[])
  const collisione = esistenti.find((p) => (p.split("/").pop() ?? p) === `${slug}.md`)
  if (collisione) return textResult(`Non creata — esiste già: ${collisione}. Nulla è stato scritto.`)

  const llm = await configLlm(config.vaultRoot)
  if (!llm) return textResult("Non generata — manca la configurazione del modello nel vault.")
  if (!deps.cercaProve) return textResult("Non generata — il motore di ricerca non è raggiungibile.")

  const prove = await deps.cercaProve(titolo, 6)
  if (prove.length === 0) {
    // Una voce senza fonti sarebbe inventata, e una voce inventata è peggio di
    // una voce che manca: sembra conoscenza.
    return textResult(`Non generata — nessuna fonte nell'indice sostiene «${titolo}».`)
  }
  // D1 — si rimanda a **voci**, non a fonti. Una pagina enciclopedica che punta
  // a `7-dropbox--14-0triuneproject--16-05libriericerche--35-notebooklm-…` ha un
  // collegamento tecnicamente valido e illeggibile: risolve, e nessuno lo
  // seguirà mai. Meglio una voce senza collegamenti che con collegamenti
  // sbagliati; le fonti restano nell'indice, dove servono davvero.
  const vicini = prove
    .filter((p) => /(^|\/)(concepts|entities|docs)\//.test(p.path))
    .map((p) => (p.path.split("/").pop() ?? p.path).replace(/\.md$/i, ""))
  const ammessi = new Set(vicini)

  const oggi = new Date().toISOString().slice(0, 10)
  const frontmatter = [
    "---",
    `id: ${nuovoId()}`,
    `title: ${titolo}`,
    "summary: Voce generata su richiesta dalle fonti già indicizzate.",
    `tags: [${cartella.split("/")[0]}]`,
    `aliases: [${(Array.isArray(args.aliases) ? args.aliases.map(String) : []).join(", ")}]`,
    "status: draft",
    `visibility: ${typeof args.visibility === "string" ? args.visibility : "all"}`,
    `created: ${oggi}`,
    `updated: ${oggi}`,
    `related: ${vicini.slice(0, 5).map((v) => `[[${v}]]`).join(",")}`,
    "---",
  ].join("\n")

  const rel = `${cartella}/${slug}.md`
  const flusso = potaSulFlusso(
    flussoOpenAI(llm.base, llm.key, llm.model)(PROMPT_VOCE(titolo, vicini, prove)),
    ammessi,
  )
  const n = await scriviInStreaming(config.vaultRoot, rel, frontmatter, flusso, deps.onPezzo)
  return textResult(
    `Scritta ${rel} · ${n} battute · fonti: ${prove.length} · collegamenti ammessi: ${vicini.join(", ")}`,
  )
}

export async function callVaultTool(
  name: string,
  args: Record<string, unknown>,
  config: VaultToolsConfig,
  deps: DepsGenerazione = {},
) {
  try {
    switch (name) {
      case "vault_get_conventions":
        return textResult(await readConventions(config.vaultRoot))
      case "vault_read_note":
        return textResult(await readNote(config.vaultRoot, stringArg(args.path, "path")))
      case "vault_list_notes": {
        const folder = typeof args.folder === "string" && args.folder.trim() ? args.folder : "."
        const kind = args.kind === "images" ? "images" : "notes"
        const limit = Number.isFinite(Number(args.limit)) ? Math.max(1, Number(args.limit)) : 200
        const tutti = await listNotes(config.vaultRoot, folder, kind)
        // Un vault reale ne ha decine di migliaia: restituirli tutti riempie il
        // contesto del chiamante e non lo aiuta. Dire quanti sono, invece, sì.
        const mostrati = tutti.slice(0, limit)
        const coda = tutti.length > mostrati.length
          ? `\n\n(${mostrati.length} di ${tutti.length} — alza limit o restringi folder)`
          : ""
        return textResult((mostrati.join("\n") || `(no ${kind} found)`) + coda)
      }
      case "vault_search_notes": {
        const limit = typeof args.limit === "number" ? args.limit : 20
        const matches = await searchNotes(config.vaultRoot, stringArg(args.query, "query"), limit)
        if (matches.length === 0) return textResult("(no matches)")
        return textResult(matches.map((m) => `${m.path}:${m.line}: ${m.snippet}`).join("\n"))
      }
      case "vault_graph": {
        const folder = typeof args.folder === "string" && args.folder.trim() ? args.folder : "."
        const limit = typeof args.limit === "number" ? args.limit : 200
        return textResult(formatGraph(await buildGraph(config.vaultRoot, folder), limit))
      }
      case "vault_create_missing_page": {
        if (args.generate === true) return generaVoce(args, config, deps)
        const res = await createMissingPage(config.vaultRoot, {
          title: stringArg(args.title, "title"),
          folder: typeof args.folder === "string" ? args.folder : undefined,
          summary: typeof args.summary === "string" ? args.summary : undefined,
          body: typeof args.body === "string" ? args.body : undefined,
          aliases: Array.isArray(args.aliases) ? args.aliases.map(String) : undefined,
          related: Array.isArray(args.related) ? args.related.map(String) : undefined,
          visibility: typeof args.visibility === "string" ? args.visibility : undefined,
          readonlyPrefixes: config.readonlyPrefixes,
        })
        return textResult(
          res.created
            ? `Created ${res.path} (id ${res.id})`
            : `Not created — ${res.reason}. Nothing was overwritten.`,
        )
      }
      case "vault_write_note":
        await writeNote(config.vaultRoot, stringArg(args.path, "path"), stringArg(args.content, "content"), config.readonlyPrefixes)
        return textResult(`Wrote ${args.path}`)
      case "vault_append_note":
        await appendNote(config.vaultRoot, stringArg(args.path, "path"), stringArg(args.content, "content"), config.readonlyPrefixes)
        return textResult(`Appended to ${args.path}`)
      case "vault_read_image": {
        const p = stringArg(args.path, "path")
        // Un percorso inventato dà ENOENT, e l'errore nudo si legge come "questa
        // immagine non c'è" — da lì un agente conclude che il vault non ne ha,
        // e lo dice con sicurezza. È successo: ha tirato a indovinare venti
        // percorsi prima di arrivarci. L'errore deve dire dove si trova la
        // risposta, non solo che il tentativo è fallito.
        const { base64, mimeType } = await readImage(config.vaultRoot, p).catch((err) => {
          const msg = err instanceof Error ? err.message : String(err)
          if (/ENOENT|no such file/i.test(msg)) {
            throw new VaultError(
              `No image at "${p}". Do not try another guess: call vault_list_notes with kind:"images" ` +
              `to get real paths — image files live in folders the markdown listing never shows.`,
            )
          }
          throw err
        })
        // Inline E link: nessuno dei due basta da solo. Il contenuto inline
        // serve ai client che lo disegnano; il link serve a ChatGPT e simili,
        // che mostrano solo un'immagine markdown. Il link manca quando il
        // server non ha segreto o hostname pubblico — allora resta l'inline.
        const url = buildSignedImageUrl(p)
        const content: Array<Record<string, unknown>> = [{ type: "image", data: base64, mimeType }]
        if (url) content.push({ type: "text", text: `![${path.basename(p)}](${url})` })
        return { content }
      }
      case "vault_open_source": {
        const res = await openSource(config.vaultRoot, stringArg(args.path, "path"))
        if (res.sources.length === 0) return textResult("No source path recorded in that note.")
        const righe = res.links.map((l) =>
          l.url ? `- ${l.source}\n  ${l.url}`
          : l.local ? `- ${l.source}\n  local: ${l.local}`
          : `- ${l.source}\n  unavailable: ${l.error}`,
        )
        return textResult(righe.join("\n"))
      }
      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`)
    }
  } catch (err) {
    if (err instanceof McpError) throw err
    return vaultError(err)
  }
}
