/**
 * Le regole di scrittura del vault, in un posto solo — D2, D3, D4, D5.
 *
 * Stanno qui e non sparse nei chiamanti perché ogni scrittura headless passa
 * per `write_file` / `write_file_atomic` in `invoke-shim.ts`: un punto unico,
 * quindi una regola che vale davvero per tutti invece di N copie che divergono.
 * È la stessa lezione di `isDerivedPage`, dove una copia che dimenticava due
 * nomi sembrava identica finché non lo era.
 */
import { randomBytes } from "node:crypto"

/** Frontmatter grezzo + corpo. Un file senza `---` torna `null` come blocco. */
export function splitFrontmatter(content: string): { fm: string | null; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content)
  if (!m) return { fm: null, body: content }
  return { fm: m[1], body: content.slice(m[0].length) }
}

export function frontmatterField(fm: string, name: string): string | null {
  const m = new RegExp(`^${name}:\\s*(.*)$`, "m").exec(fm)
  return m ? m[1].trim() : null
}

/**
 * D2 + D4 — ogni pagina nasce con un'identità e un'etichetta di visibilità.
 *
 * `id:` perché oggi l'identità di una pagina **è il suo nome di file**
 * (`lint-structural-core.ts:195` risolve col solo basename): rinominare rompe
 * ogni collegamento in entrata, in silenzio, e il lint sul vault della cliente
 * conta già **5.254 link rotti**. `visibility:` perché filtrare *dopo* la
 * ricerca è il difetto documentato dei prototipi — perdita di risultati e
 * recall che crolla sulle query selettive; il campo costa una riga adesso,
 * rimetterlo dopo significa riscrivere il motore di ricerca.
 *
 * Non tocca **mai** un valore già presente: arricchisce, non normalizza.
 */
export function ensureIdentity(
  content: string,
  opts: { newId: () => string; defaultVisibility?: string },
): string {
  const { fm, body } = splitFrontmatter(content)
  if (fm === null) return content // una pagina senza frontmatter non se lo inventa qui

  const righe = fm.split(/\r?\n/)
  const mancante = (nome: string) => frontmatterField(fm, nome) === null

  const aggiunte: string[] = []
  if (mancante("id")) aggiunte.push(`id: ${opts.newId()}`)
  if (mancante("visibility")) aggiunte.push(`visibility: ${opts.defaultVisibility ?? "all"}`)
  if (aggiunte.length === 0) return content

  // in testa: l'identità si legge prima del titolo, come in ogni formato che
  // separa la chiave dal contenuto
  return `---\n${[...aggiunte, ...righe].join("\n")}\n---\n${body}`
}

/**
 * D5 — sul vault della cliente si aggiunge, non si cancella.
 *
 * Il caso da evitare non è teorico: una fusione di quasi-doppioni cancella un
 * file, e ogni `[[nome-morto]]` smette di risolvere **senza dare errore**.
 * Fondere è una decisione, e la prende lei: i candidati finiscono in un
 * referto, non in una `rm`.
 *
 * Si blocca solo la cancellazione delle **pagine del wiki**. I temporanei, la
 * cache e i grezzi restano cancellabili: il vincolo è sulla conoscenza scritta,
 * non sul disco.
 */
export function isWikiPage(absPath: string): boolean {
  const parti = absPath.split(/[\\/]/).filter(Boolean)
  const ultimo = parti[parti.length - 1] ?? ""
  if (!ultimo.toLowerCase().endsWith(".md")) return false
  // il segmento `wiki` deve avere qualcosa sotto: la cartella stessa non è una pagina
  const i = parti.lastIndexOf("wiki")
  return i >= 0 && i < parti.length - 1
}

/** `c-7f3a91` — corto, leggibile in un frontmatter, e non è il nome del file. */
export function nuovoIdPagina(): string {
  return `c-${randomBytes(3).toString("hex")}`
}

/** Acceso di default: sul box di una cliente il valore sicuro è "non cancellare". */
export function appendOnlyEnabled(): boolean {
  return (process.env.VAULT_APPEND_ONLY ?? "1") !== "0"
}

/**
 * D3 — il grafo causale si accende dove serve, non ovunque.
 *
 * Motivo, dalla ricerca sui prodotti enterprise: GraphRAG su tutto costa
 * **10-30×** l'indicizzazione, l'estrazione delle relazioni è accurata al
 * 60-85%, e sulle domande normali **perde** contro la ricerca vettoriale
 * (recall@5 32,5% contro 67%). Vince solo sul ragionamento fra documenti — cioè
 * il troubleshooting, che è il caso da accendere a mano.
 *
 * Precedenza: la nota, poi l'`_index.md` della cartella risalendo, poi spento.
 */
export function causalGraphFlag(fm: string | null): boolean | null {
  if (!fm) return null
  const v = frontmatterField(fm, "causal_graph")
  if (v === null) return null
  return /^(true|yes|on|1)$/i.test(v)
}

export interface LettoreIndice {
  (folder: string): Promise<string | null>
}

/**
 * Risale da `concepts/salute/nota` fino alla radice cercando chi si esprime.
 * `readIndex` riceve la cartella relativa e torna il contenuto del suo
 * `_index.md`, oppure null.
 */
export async function causalGraphEnabled(
  pageId: string,
  readIndex: LettoreIndice,
  noteFrontmatter?: string | null,
): Promise<boolean> {
  const dallaNota = causalGraphFlag(noteFrontmatter ?? null)
  if (dallaNota !== null) return dallaNota

  const parti = pageId.split("/").slice(0, -1)
  while (parti.length > 0) {
    const cartella = parti.join("/")
    const idx = await readIndex(cartella)
    const flag = causalGraphFlag(splitFrontmatter(idx ?? "").fm)
    if (flag !== null) return flag
    parti.pop()
  }
  const radice = await readIndex(".")
  return causalGraphFlag(splitFrontmatter(radice ?? "").fm) ?? false
}
