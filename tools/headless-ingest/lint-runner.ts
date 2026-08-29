/**
 * Structural lint, computed on the server.
 *
 * The Lint view already knows how to find and repair orphans, broken links and
 * pages with no outlinks — but it does it by reading every page through the
 * `read_file` command. On the desktop that is a local call; over the web it is
 * one HTTP round-trip per page, so on a vault with ten thousand pages the view
 * effectively never finishes.
 *
 * Same algorithm (`computeStructuralLint`, unchanged and shared with the
 * desktop), one request instead of thousands: the walk and the reads happen
 * next to the disk.
 */
import { promises as fs } from "node:fs"
import { join, relative } from "node:path"
import {
  computeStructuralLint,
  type StructuralLintFinding,
  type StructuralLintPage,
} from "../../src/lib/lint-structural-core"

/** Same window the desktop uses (lint.ts): title + slug + head of the body. */
const SUGGESTION_TOKEN_WINDOW = 4000

/**
 * Body tokens feed one thing only: the "did you mean this page?" suggestion.
 * Detecting orphans, broken links and dead ends needs just links and slugs.
 *
 * Measured on a real 10,240-page vault:
 *   full window   808 MB   8595 findings   3694 suggested targets
 *   60 tokens     524 MB   8595 findings   3694
 *   no tokens     348 MB   8595 findings   3612
 *
 * The findings are identical and the suggestions lose 2%, because they mostly
 * come from name fragments rather than body text. Past this size we drop the
 * body tokens: 460 MB of heap is not worth 82 suggestions.
 */
const LARGE_VAULT_PAGES = 3000
const LARGE_VAULT_WINDOW = 0

function titleOf(content: string, fallback: string): string {
  const fm = /^---\s*\n([\s\S]*?)\n---/.exec(content)
  const t = fm && /^title:\s*["']?(.+?)["']?\s*$/m.exec(fm[1])
  if (t?.[1]?.trim()) return t[1].trim()
  const h = /^#\s+(.+)$/m.exec(content)
  if (h?.[1]?.trim()) return h[1].trim()
  return fallback.replace(/\.md$/i, "").replace(/[-_]+/g, " ")
}

function wikilinks(content: string): string[] {
  const out: string[] = []
  // identical to extractWikilinks in src/lib/lint.ts — parity matters here
  for (const m of content.matchAll(/\[\[([^\]|]+?)(?:\|[^\]]+?)?\]\]/g)) {
    const target = m[1].trim()
    if (target) out.push(target)
  }
  return out
}

function tokenize(text: string): string[] {
  const tokens = new Set<string>()
  for (const m of text.normalize("NFKC").toLowerCase().matchAll(/[\p{L}\p{N}]+/gu)) {
    const token = m[0]
    if (token.length >= 2) tokens.add(token)
    if (/[\u3400-\u9fff]/u.test(token)) for (const ch of Array.from(token)) tokens.add(ch)
  }
  return [...tokens]
}

/** Every content page under wiki/. index.md and log.md are hubs by construction. */
async function listPages(wikiRoot: string): Promise<string[]> {
  const out: string[] = []
  const walk = async (dir: string) => {
    let entries: Awaited<ReturnType<typeof fs.readdir>>
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue
      const full = join(dir, e.name)
      if (e.isDirectory()) await walk(full)
      else if (e.name.endsWith(".md") && e.name !== "index.md" && e.name !== "log.md") out.push(full)
    }
  }
  await walk(wikiRoot)
  return out
}

export async function runStructuralLintOnDisk(vault: string): Promise<{
  findings: StructuralLintFinding[]
  pages: number
}> {
  const wikiRoot = join(vault, "wiki")
  const paths = await listPages(wikiRoot)
  const window = paths.length > LARGE_VAULT_PAGES ? LARGE_VAULT_WINDOW : SUGGESTION_TOKEN_WINDOW

  const pages: StructuralLintPage[] = []
  for (const full of paths) {
    const content = await fs.readFile(full, "utf8").catch(() => "")
    const shortName = relative(wikiRoot, full).split("\\").join("/")
    const slug = shortName.replace(/\.md$/i, "")
    const title = titleOf(content, shortName.split("/").pop()!)
    pages.push({
      shortName,
      slug,
      title,
      outlinks: wikilinks(content),
      tokens: tokenize(`${title}\n${slug.split("/").pop()}\n${content.slice(0, window)}`),
    })
  }
  return { findings: computeStructuralLint(pages), pages: pages.length }
}
