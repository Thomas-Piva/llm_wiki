import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { nuovoId } from "./vault-graph.js";

const execFileAsync = promisify(execFile);

export interface SearchMatch {
  path: string;
  line: number;
  snippet: string;
}

export class VaultError extends Error {}

function assertMarkdown(relPath: string): void {
  if (!relPath.toLowerCase().endsWith(".md")) {
    throw new VaultError(`Only .md files are allowed: ${relPath}`);
  }
}

const IMAGE_MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
};

// Generous enough for a captioned figure or a phone photo; guards against an
// agent accidentally requesting a multi-hundred-MB file and blowing up the
// caller's context with a giant base64 blob.
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

function assertImage(relPath: string): string {
  const ext = path.extname(relPath).toLowerCase();
  const mimeType = IMAGE_MIME_TYPES[ext];
  if (!mimeType) {
    throw new VaultError(
      `Not a supported image type: ${relPath} (supported: ${Object.keys(IMAGE_MIME_TYPES).join(", ")})`
    );
  }
  return mimeType;
}

// Robust containment check: path.relative + ".." prefix, not a naive
// string prefix (which "/vault-evil" would pass without a separator boundary).
export function resolveVaultPath(vaultRoot: string, relPath: string): string {
  if (path.isAbsolute(relPath)) {
    throw new VaultError(`Path must be relative to the vault: ${relPath}`);
  }
  const candidate = path.resolve(vaultRoot, relPath);
  const rel = path.relative(vaultRoot, candidate);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new VaultError(`Path escapes the vault: ${relPath}`);
  }
  return candidate;
}

function assertWritable(relPath: string, readonlyPrefixes: string[]): void {
  const normalized = relPath.replace(/^\.\//, "");
  for (const prefix of readonlyPrefixes) {
    const p = prefix.replace(/\/$/, "");
    if (normalized === p || normalized.startsWith(p + "/")) {
      throw new VaultError(`Path is read-only (${prefix}): ${relPath}`);
    }
  }
}

export async function readNote(vaultRoot: string, relPath: string): Promise<string> {
  assertMarkdown(relPath);
  const target = resolveVaultPath(vaultRoot, relPath);
  return fs.readFile(target, "utf8");
}

/**
 * Above this edge length a model gains nothing: the image is downsampled before
 * it ever reaches the attention layer. Measured on a real 2752x1536 figure from
 * the vault, sending it whole costs 6,835 KB; at 1568 px it is 346 KB and reads
 * identically. Twenty times lighter, same answer.
 */
const MCP_MAX_EDGE = 1568;
/** Under this, resizing costs more than it saves. */
const RESIZE_ABOVE_BYTES = 700 * 1024;

async function shrink(target: string): Promise<Buffer | null> {
  try {
    // ImageMagick is already on the box; a resize does not justify a native
    // npm dependency. `1568x1568>` only ever shrinks, never enlarges.
    const { stdout } = await execFileAsync(
      "convert",
      [target, "-resize", `${MCP_MAX_EDGE}x${MCP_MAX_EDGE}>`, "-quality", "85", "jpeg:-"],
      { maxBuffer: 64 * 1024 * 1024, encoding: "buffer" as any }
    );
    const buf = stdout as unknown as Buffer;
    return buf.length ? buf : null;
  } catch {
    return null; // fall back to the original rather than failing the read
  }
}

export async function readImage(
  vaultRoot: string,
  relPath: string
): Promise<{ base64: string; mimeType: string }> {
  const mimeType = assertImage(relPath);
  const target = resolveVaultPath(vaultRoot, relPath);
  const stat = await fs.stat(target);

  // A large photo used to be refused outright. Resizing it is both what the
  // model wants and what keeps it under the transport limit, so the only files
  // still rejected are the pathological ones.
  if (stat.size > RESIZE_ABOVE_BYTES && mimeType !== "image/svg+xml") {
    const resized = await shrink(target);
    if (resized && resized.length < stat.size) {
      return { base64: resized.toString("base64"), mimeType: "image/jpeg" };
    }
  }
  if (stat.size > MAX_IMAGE_BYTES) {
    throw new VaultError(
      `Image too large (${Math.round(stat.size / 1024 / 1024)}MB, max ${MAX_IMAGE_BYTES / 1024 / 1024}MB) and could not be resized: ${relPath}`
    );
  }
  const buf = await fs.readFile(target);
  return { base64: buf.toString("base64"), mimeType };
}

/**
 * Recover the original a note was built from.
 *
 * Notes keep the Dropbox path they came from, but the file itself is not on the
 * box — keeping 400 GB of originals on a 53 GB disk was never possible. The link
 * stays alive because the path is enough: given it, we mint a temporary download
 * URL from the Dropbox API, the same way `vault_read_image` already returns one.
 */
export async function openSource(
  vaultRoot: string,
  notePath: string
): Promise<{ sources: string[]; links: Array<{ source: string; url?: string; local?: string; error?: string }> }> {
  const content = await readNote(vaultRoot, notePath);
  const sources = new Set<string>();

  const fm = /^---\s*\n([\s\S]*?)\n---/.exec(content);
  if (fm) {
    // `source: "[[slug]]"`, `sources: [a, b]`, or a plain scalar — accept all three
    for (const m of fm[1].matchAll(/^sources?:\s*(.+)$/gm)) {
      const raw = m[1].trim();
      const list = raw.startsWith("[") ? raw.slice(1, -1).split(",") : [raw];
      for (const item of list) {
        const cleaned = item.trim().replace(/^["'\[]+|["'\]]+$/g, "").trim();
        if (cleaned) sources.add(cleaned);
      }
    }
  }
  // Body references like `dropbox/0_TRIUNE_PROJECT/...` count too
  for (const m of content.matchAll(/(?:^|[\s(])((?:raw\/sources\/)?dropbox\/[^\s)\]]+)/g)) {
    sources.add(m[1]);
  }

  const links: Array<{ source: string; url?: string; local?: string; error?: string }> = [];
  for (const source of sources) {
    // still on disk? then just say where
    try {
      const local = resolveVaultPath(vaultRoot, source.replace(/^raw\/sources\//, "raw/sources/"));
      await fs.stat(local);
      links.push({ source, local: path.relative(vaultRoot, local) });
      continue;
    } catch {
      /* not local — fetch a link instead */
    }
    try {
      const dropboxPath =
        "/" +
        source
          .replace(/^raw\/sources\//, "")
          .replace(/^dropbox\//, "")
          .replace(/^\/+/, "")
          // Apple Pages files are OCR'd into `<name>.pages.txt` before ingest;
          // the original on Dropbox is still the .pages.
          .replace(/\.pages\.txt$/i, ".pages");
      const { stdout } = await execFileAsync(
        "python3",
        ["/opt/r2r/dropbox_api.py", "link", dropboxPath],
        { timeout: 30000 }
      );
      links.push({ source, url: String(stdout).trim() });
    } catch (err) {
      links.push({ source, error: (err as Error).message.slice(0, 200) });
    }
  }
  return { sources: [...sources], links };
}

/**
 * Elenca i file di un tipo sotto una cartella.
 *
 * ⚠️ `kind: "images"` non è una comodità: senza, le immagini del vault sono
 * **invisibili**. Nessun tool le elenca — la ricerca guarda il testo, il grafo
 * guarda le pagine, e questo elenco guardava solo i `.md`. Misurato sul vault
 * di una cliente: **9.890 immagini in 812 cartelle**, e un agente a cui era
 * stato chiesto di mostrarne una ha concluso che «le immagini stanno su
 * Dropbox, non nel filesystem» — scambiando "non le trovo" per "non ci sono".
 *
 * `vault_read_image` esiste da prima, ma senza un modo di scoprire un percorso
 * era uno strumento che si può usare solo se già si sa la risposta.
 */
const IMAGE_EXTS = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".tiff"];

export async function listNotes(
  vaultRoot: string,
  relFolder: string = ".",
  kind: "notes" | "images" = "notes",
): Promise<string[]> {
  const target = resolveVaultPath(vaultRoot, relFolder);
  const entries = await fs.readdir(target, { recursive: true, withFileTypes: true });
  const vuole = (nome: string) => {
    const n = nome.toLowerCase();
    return kind === "images" ? IMAGE_EXTS.some((e) => n.endsWith(e)) : n.endsWith(".md");
  };
  return entries
    .filter((e) => e.isFile() && vuole(e.name))
    .map((e) => path.relative(vaultRoot, path.join(e.parentPath, e.name)))
    .sort();
}

// ── Regole del vault (D2/D4) sulla strada MCP ────────────────────────────────
//
// Questa e' la TERZA strada di scrittura del vault, accanto a invoke-shim.ts
// (ingest headless) e web-invoke.ts (il sito). Le altre due passano da
// note-policy.ts; questa scriveva con un fs.writeFile diretto, quindi una nota
// creata dall'agente nasceva **senza `id:`**.
//
// Perche' conta: l'identita' di una pagina e' oggi il suo nome di file, quindi
// rinominarla o fonderla rompe ogni `[[collegamento]]` in entrata **in
// silenzio**. Sul vault della cliente il lint conta gia' 5.254 link rotti.
//
// La regola piu' importante non e' aggiungere l'id: e' **non perderlo**. Se
// l'agente riscrive una pagina che un id ce l'aveva, quell'id va conservato,
// altrimenti ogni riscrittura cambia l'identita' della nota sotto i piedi ai
// suoi collegamenti.

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function frontmatterField(content: string, nome: string): string | null {
  const fm = FRONTMATTER.exec(content);
  if (!fm) return null;
  const riga = new RegExp(`^${nome}:\\s*(.*)$`, "m").exec(fm[1]);
  return riga ? riga[1].trim() : null;
}

/** Una pagina del wiki: `.md` sotto `wiki/`, non la cartella stessa. */
export function isWikiPage(relPath: string): boolean {
  const parti = relPath.split(/[\\/]/).filter(Boolean);
  if (!(parti[parti.length - 1] ?? "").toLowerCase().endsWith(".md")) return false;
  const i = parti.lastIndexOf("wiki");
  return i >= 0 && i < parti.length - 1;
}

/**
 * Aggiunge `id:` e `visibility:` se mancano, riusando l'id gia' sul disco.
 * Non tocca mai un valore presente: arricchisce, non normalizza.
 */
export function ensureIdentity(content: string, idEsistente: string | null): string {
  const fm = FRONTMATTER.exec(content);
  if (!fm) return content; // niente frontmatter: non se lo inventa qui
  const aggiunte: string[] = [];
  if (frontmatterField(content, "id") === null) aggiunte.push(`id: ${idEsistente ?? nuovoId()}`);
  if (frontmatterField(content, "visibility") === null) aggiunte.push("visibility: all");
  if (aggiunte.length === 0) return content;
  const righe = fm[1].split(/\r?\n/);
  return `---\n${[...aggiunte, ...righe].join("\n")}\n---\n${content.slice(fm[0].length)}`;
}

export async function writeNote(
  vaultRoot: string,
  relPath: string,
  content: string,
  readonlyPrefixes: string[]
): Promise<void> {
  assertMarkdown(relPath);
  assertWritable(relPath, readonlyPrefixes);
  const target = resolveVaultPath(vaultRoot, relPath);
  await fs.mkdir(path.dirname(target), { recursive: true });

  let daScrivere = content;
  if (isWikiPage(relPath)) {
    // L'id della versione gia' su disco, se c'e': una riscrittura non deve
    // cambiare l'identita' della pagina.
    const precedente = await fs.readFile(target, "utf8").catch(() => null);
    daScrivere = ensureIdentity(content, precedente ? frontmatterField(precedente, "id") : null);
  }
  await fs.writeFile(target, daScrivere, "utf8");
}

export async function appendNote(
  vaultRoot: string,
  relPath: string,
  content: string,
  readonlyPrefixes: string[]
): Promise<void> {
  assertMarkdown(relPath);
  assertWritable(relPath, readonlyPrefixes);
  const target = resolveVaultPath(vaultRoot, relPath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const exists = await fs
    .access(target)
    .then(() => true)
    .catch(() => false);
  // Aggiungere in fondo a una pagina che esiste non tocca il suo frontmatter,
  // quindi lì l'identità è già a posto. Ma `appendNote` su un file **che non
  // esiste** lo crea: quella è una pagina nuova a tutti gli effetti, e senza
  // questo ramo nascerebbe senza `id:` come prima.
  const daAggiungere = !exists && isWikiPage(relPath) ? ensureIdentity(content, null) : content;
  await fs.appendFile(target, (exists ? "\n" : "") + daAggiungere, "utf8");
}

// rg via execFile (argv array, never a shell string) + a "--" sentinel so a
// query starting with "-" can't be parsed as an rg flag.
export async function searchNotes(
  vaultRoot: string,
  query: string,
  limit: number = 20
): Promise<SearchMatch[]> {
  if (!query.trim()) {
    throw new VaultError("query must not be empty");
  }
  let stdout: string;
  try {
    const result = await execFileAsync(
      "rg",
      ["--json", "-g", "*.md", "--", query, vaultRoot],
      { maxBuffer: 10 * 1024 * 1024 }
    );
    stdout = result.stdout;
  } catch (err) {
    const e = err as { code?: number; message: string };
    if (e.code === 1) return []; // rg exit code 1 = no matches, not an error
    throw new VaultError(`search failed: ${e.message}`);
  }
  const matches: SearchMatch[] = [];
  for (const line of stdout.split("\n")) {
    if (!line) continue;
    const event = JSON.parse(line);
    if (event.type !== "match") continue;
    matches.push({
      path: path.relative(vaultRoot, event.data.path.text),
      line: event.data.line_number,
      snippet: event.data.lines.text.trim(),
    });
    if (matches.length >= limit) break;
  }
  return matches;
}
