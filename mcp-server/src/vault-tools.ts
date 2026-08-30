import { promises as fs } from "node:fs"
import path from "node:path"
import type { Tool } from "@modelcontextprotocol/sdk/types.js"
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js"
import { readNote, listNotes, writeNote, appendNote, searchNotes, VaultError } from "./vault-fs.js"
import { buildGraph, createMissingPage, formatGraph } from "./vault-graph.js"

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
    description: "Read the raw content (including frontmatter) of a markdown note at a vault-relative path.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "Vault-relative path, e.g. entities/clienti/mbm-edilizia.md" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "vault_list_notes",
    description: "List markdown note paths under a folder (or the whole vault if omitted).",
    inputSchema: {
      type: "object",
      properties: { folder: { type: "string", description: "Vault-relative folder, e.g. entities/clienti" } },
      additionalProperties: false,
    },
  },
  {
    name: "vault_search_notes",
    description: "Full-text search across all markdown notes in the vault.",
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
    description: "Create or overwrite a markdown note's full content at a vault-relative path. Call vault_get_conventions first — the vault enforces a specific frontmatter schema, folder purposes, and minimum outgoing wikilinks per note.",
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
      "Create the page a [[wikilink]] points to when it doesn't exist yet. APPEND-ONLY: if a page with that name already exists anywhere in the vault it is left untouched and the existing path is returned — this tool never overwrites, merges or deletes. The new page gets the vault's frontmatter plus a stable id and an aliases list, so a later merge or rename cannot break inbound links.",
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

export async function callVaultTool(name: string, args: Record<string, unknown>, config: VaultToolsConfig) {
  try {
    switch (name) {
      case "vault_get_conventions":
        return textResult(await readConventions(config.vaultRoot))
      case "vault_read_note":
        return textResult(await readNote(config.vaultRoot, stringArg(args.path, "path")))
      case "vault_list_notes": {
        const folder = typeof args.folder === "string" && args.folder.trim() ? args.folder : "."
        const notes = await listNotes(config.vaultRoot, folder)
        return textResult(notes.join("\n") || "(no notes found)")
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
      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`)
    }
  } catch (err) {
    if (err instanceof McpError) throw err
    return vaultError(err)
  }
}
