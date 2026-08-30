/**
 * Turn structured files into the prose they contain.
 *
 * `json`, `xml`, `yaml`, `html` are all accepted as sources, but none of them
 * had a parser: they fell through to a raw `readFile` and went into the index
 * as-is. For a small JSON that is survivable; for an HTML page it means the
 * index fills with `<div class="wrapper">` instead of what the page says, and
 * every one of those tokens competes with real text at search time.
 *
 * Deliberately not a dependency. Turndown and cheerio are the right tools for
 * *rendering* HTML; here the goal is the opposite — throw the markup away and
 * keep the words. That is a few regexes, and a few regexes do not justify
 * shipping a DOM to every user.
 */
import yaml from "js-yaml"

export const STRUCTURED_EXTENSIONS = new Set(["json", "xml", "yaml", "yml", "html", "htm", "xhtml", "svg"])

export function isStructuredText(ext: string): boolean {
  return STRUCTURED_EXTENSIONS.has(ext.toLowerCase().replace(/^\./, ""))
}

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  eacute: "é", egrave: "è", agrave: "à", igrave: "ì", ograve: "ò", ugrave: "ù",
  hellip: "…", mdash: "—", ndash: "–", laquo: "«", raquo: "»", euro: "€",
}

export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m)
}

/**
 * Markup out, words in. `<script>`/`<style>` bodies go first — they are code,
 * not content, and left in they are the single largest source of noise in a
 * saved web page.
 */
export function markupToText(raw: string): string {
  return decodeEntities(
    raw
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1\s*>/gi, " ")
      // block-level tags become newlines so sentences do not fuse together
      .replace(/<\/?(p|div|br|li|tr|h[1-6]|section|article|header|footer|blockquote)\b[^>]*>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t ]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .replace(/^[ \t]+|[ \t]+$/gm, "")
    .trim()
}

/** Chiavi che non sono contenuto: rumore in ogni export, in ogni formato. */
const CHIAVI_RUMORE = /^(_?id|uuid|guid|hash|etag|checksum|md5|sha\d*|token|createdat|updatedat|timestamp)$/i

/**
 * Walk a parsed object and write it back as `chiave: valore` lines.
 *
 * The keys are kept because in an export they usually *are* the meaning
 * ("cliente", "importo", "scadenza"); the ones that are only plumbing are
 * dropped. Numbers and booleans stay: a date or an amount is exactly what
 * someone will search for.
 */
export function treeToText(value: unknown, depth = 0, key?: string): string {
  const indent = "  ".repeat(Math.min(depth, 6))
  if (value === null || value === undefined) return ""
  if (Array.isArray(value)) {
    return value.map((v) => treeToText(v, depth, key)).filter(Boolean).join("\n")
  }
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .filter(([k]) => !CHIAVI_RUMORE.test(k))
      .map(([k, v]) => treeToText(v, depth + 1, k))
      .filter(Boolean)
      .join("\n")
  }
  const testo = String(value).trim()
  if (!testo) return ""
  return key ? `${indent}${key}: ${testo}` : `${indent}${testo}`
}

/**
 * Best-effort conversion. **Never throws**: a malformed file falls back to its
 * own bytes, which is exactly what happened before this existed — so the worst
 * case is the old behaviour, not a failed ingest.
 */
export function structuredToText(raw: string, ext: string): string {
  const e = ext.toLowerCase().replace(/^\./, "")
  try {
    if (e === "html" || e === "htm" || e === "xhtml") return markupToText(raw) || raw
    if (e === "xml" || e === "svg") return markupToText(raw) || raw
    if (e === "json") return treeToText(JSON.parse(raw)) || raw
    if (e === "yaml" || e === "yml") return treeToText(yaml.load(raw)) || raw
  } catch {
    // JSON troncato, YAML con un rientro storto, HTML che non è HTML: meglio il
    // grezzo di un documento perso.
    return raw
  }
  return raw
}
