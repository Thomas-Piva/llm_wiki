/**
 * D0 — il grafo delle entità si estrae **all'ingest**, non alla domanda.
 * D3 — e solo dove qualcuno l'ha acceso.
 *
 * Le due direttive stanno nello stesso file perché sono la stessa decisione
 * vista da due lati: cosa si calcola una volta sola, e su quali cartelle.
 *
 * **Perché non gira su tutto.** Misurato: l'estrazione costa $0,0134 per milione
 * di caratteri col modello scelto — $1,74 sull'intero vault della cliente, ~$67
 * sul Dropbox completo. Non è il prezzo a fermarci, è il tempo: a concorrenza 8
 * sono 15 ore per il vault e 593 per il Dropbox. Quindi si accende per cartella.
 *
 * **Perché questo modello.** Banco su 16 passaggi veri del corpus, 8 etichette,
 * criterio meccanico (un'entità che non compare **alla lettera** nel testo è
 * inventata) più la copertura del consenso fra modelli:
 *
 *     modello                        ms   entità  inventate  consenso  $/Mchar
 *     inclusionai/ling-3.0-flash    188      84      0%        96,4%    0,0134  ← scelto
 *     gemini-2.5-flash-lite         156     127      0%        96,4%    0,0747  ← ripiego
 *     deepseek-v4-flash-0731      1.198      89      0%        55,4%    0,0241  ← era in uso
 *
 * Gemini ne trovava 127 contro 84, ma erano **le stesse contate cinque volte**
 * (`il creare` · `modulo del creare` · `tre moduli essenziali`), mentre ling
 * estrae la forma canonica. È lo stesso difetto dei quasi-doppioni nel vault:
 * una parte nasce qui, nell'estrazione, non solo nella generazione.
 */
import { promises as fs } from "node:fs"
import { join } from "node:path"

import { causalGraphFlag, frontmatterField, splitFrontmatter } from "./note-policy"

export const ETICHETTE = [
  "persona",
  "organizzazione",
  "luogo",
  "concetto",
  "opera",
  "data",
  "importo",
  "prodotto",
] as const

export interface Entita {
  testo: string
  tipo: string
}

export interface RigaGrafo {
  page_id: string
  entita: Entita[]
  /**
   * D3 — le relazioni tipizzate escono solo dove il grafo causale è acceso.
   *
   * `origine: "ESTRATTO"` significa tre cose, tutte verificate: i due capi sono
   * entità trovate nel testo, la `prova` compare alla lettera, e un secondo
   * passaggio ha giudicato che quella citazione **sostiene** la relazione.
   *
   * Misurato sullo stesso passaggio, prima e dopo:
   *
   *     solo estrazione            5 archi, 2 sbagliati
   *       ↳ `Milena Battaglia —causa→ teoria polivagale`  (la citazione dice *insegna*)
   *       ↳ `seminario —precede→ Lecco`                   (dice *si è tenuto a*)
   *     + giudizio                 3 archi, 1 discutibile
   *     + tolto il tipo `precede`  2 archi, 0 sbagliati
   *
   * Le citazioni erano vere in tutti e cinque i casi: era il **legame** a non
   * esserci. Estrarre e giudicare sono due compiti diversi, e chiederli nella
   * stessa risposta è la ragione per cui «il modello inventa le relazioni».
   */
  relazioni: Array<{ da: string; a: string; tipo: string; prova: string; origine: "ESTRATTO" }>
  causale: boolean
}

/** Chi parla col modello. Iniettabile, così i test non toccano la rete. */
export type ChiamaModello = (prompt: string) => Promise<string>

const PROMPT_ENTITA = (etichette: string, testo: string) =>
  `Estrai le entità dal testo. Tipi ammessi: ${etichette}.
Rispondi SOLO con JSON: {"entita":[{"testo":"...","tipo":"..."}]}
Ogni "testo" deve comparire ALLA LETTERA nel documento. Usa la forma canonica:
"creare", non "il creare" e non "modulo del creare".

TESTO:
${testo}`

const PROMPT_GIUDIZIO = (archi: string) =>
  `Per ogni relazione qui sotto decidi se la CITAZIONE la sostiene davvero.
Non basta che citazione e relazione parlino delle stesse cose: la citazione deve
affermare proprio quel legame. "X insegna Y" non è "X causa Y". "Il seminario si
è tenuto a Lecco" non è "seminario precede Lecco".
Rispondi SOLO con JSON: {"esiti":[{"i":0,"sostiene":true},{"i":1,"sostiene":false}]}

${archi}`

/** I tre tipi sono quelli decisi, e non uno di più.
 *
 * Ne avevo aggiunto un quarto, `precede`, e produceva spazzatura sistematica
 * sulle date: *«il seminario si è tenuto a Lecco nel 2024»* diventava
 * `seminario —precede→ 2024`, che è una relazione temporale sbagliata con una
 * citazione giusta. Un tipo in più non è una capacità in più: è una porta da
 * cui esce rumore. */
const PROMPT_RELAZIONI = (testo: string, entita: string) =>
  `Dal testo, elenca le relazioni CAUSALI fra queste entità: ${entita}.
Tipi ammessi: causa, sintomo-di, risolto-da.
Rispondi SOLO con JSON: {"relazioni":[{"da":"...","a":"...","tipo":"...","prova":"citazione esatta dal testo"}]}
La "prova" deve comparire ALLA LETTERA nel testo. Se non ci sono relazioni esplicite, rispondi {"relazioni":[]}.

TESTO:
${testo}`

/** Accenti e spazi normalizzati: il confronto "compare alla lettera" non deve
 *  cadere su una `à` scritta in due modi diversi. */
function norm(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim()
}

/** Il JSON del modello arriva spesso avvolto in ```json … ```. */
export function estraiJson(risposta: string): any {
  const pulito = risposta.replace(/```(?:json)?\s*/g, "").replace(/```/g, "").trim()
  const i = pulito.indexOf("{")
  const j = pulito.lastIndexOf("}")
  if (i < 0 || j <= i) return null
  try {
    return JSON.parse(pulito.slice(i, j + 1))
  } catch {
    return null
  }
}

/**
 * Scarta ciò che il modello non ha letto ma inventato.
 *
 * Non è una rifinitura: è **il** criterio di qualità del banco, ed è meccanico
 * apposta — non dipende dal mio giudizio. Un'entità che non compare alla lettera
 * nel documento è inventata, e un grafo costruito su entità inventate è peggio
 * di nessun grafo, perché sembra vero.
 */
export function soloVerificate(entita: Entita[], testo: string): Entita[] {
  const t = norm(testo)
  const visti = new Set<string>()
  const out: Entita[] = []
  for (const e of entita) {
    const nome = String(e?.testo ?? "").trim()
    const tipo = String(e?.tipo ?? "").trim().toLowerCase()
    if (!nome || !(ETICHETTE as readonly string[]).includes(tipo)) continue
    if (!t.includes(norm(nome))) continue
    const chiave = `${tipo}|${norm(nome)}`
    if (visti.has(chiave)) continue
    visti.add(chiave)
    out.push({ testo: nome, tipo })
  }
  return out
}

/** D3 — il flag della cartella, con la nota che può smentirla. */
export async function grafoCausaleAcceso(
  pageId: string,
  leggiIndice: (folder: string) => Promise<string | null>,
  frontmatterNota?: string | null,
): Promise<boolean> {
  const dallaNota = causalGraphFlag(frontmatterNota ?? null)
  if (dallaNota !== null) return dallaNota
  const parti = pageId.split("/").slice(0, -1)
  while (parti.length > 0) {
    const flag = causalGraphFlag(splitFrontmatter((await leggiIndice(parti.join("/"))) ?? "").fm)
    if (flag !== null) return flag
    parti.pop()
  }
  return causalGraphFlag(splitFrontmatter((await leggiIndice(".")) ?? "").fm) ?? false
}

/** `entity_graph: true` accende l'estrazione; eredita dagli `_index.md` risalendo. */
export async function grafoEntitaAcceso(
  pageId: string,
  leggiIndice: (folder: string) => Promise<string | null>,
  frontmatterNota?: string | null,
): Promise<boolean> {
  const leggi = (fm: string | null): boolean | null => {
    if (!fm) return null
    const v = frontmatterField(fm, "entity_graph")
    return v === null ? null : /^(true|yes|on|1)$/i.test(v)
  }
  const dallaNota = leggi(frontmatterNota ?? null)
  if (dallaNota !== null) return dallaNota
  const parti = pageId.split("/").slice(0, -1)
  while (parti.length > 0) {
    const f = leggi(splitFrontmatter((await leggiIndice(parti.join("/"))) ?? "").fm)
    if (f !== null) return f
    parti.pop()
  }
  return leggi(splitFrontmatter((await leggiIndice(".")) ?? "").fm) ?? false
}

type ArcoCandidato = { da: string; a: string; tipo: string; prova: string }

/**
 * Il giudizio, che l'estrazione non può dare.
 *
 * Misurato: il solo controllo «la citazione compare nel testo» lascia passare
 * **2 archi su 5** — `Milena Battaglia —causa→ teoria polivagale` (la citazione
 * dice *insegna*) e `seminario —precede→ Lecco` (dice *si è tenuto a*). Le
 * citazioni erano vere; era il legame a non esserci.
 *
 * Sono due compiti diversi e vanno chiesti separatamente: **estrarre** è
 * ritrovare qualcosa che sta nel testo, **giudicare** è dire se una frase
 * sostiene una tesi. Chiedere entrambe nella stessa risposta è la ragione per
 * cui il modello «inventa le relazioni»: gliele stiamo facendo produrre nello
 * stesso respiro in cui le cerca.
 *
 * Un solo giro per pagina, non uno per arco. In caso di dubbio o di risposta
 * illeggibile l'arco **cade**: un grafo con un arco in meno è incompleto, uno
 * con un arco falso è sbagliato, e il secondo non si vede.
 */
export async function giudicaArchi(
  archi: ArcoCandidato[],
  chiama: ChiamaModello,
): Promise<ArcoCandidato[]> {
  if (archi.length === 0) return []
  const elenco = archi
    .map((a, i) => `[${i}] relazione: ${a.da} —${a.tipo}→ ${a.a}\n    citazione: "${a.prova}"`)
    .join("\n")
  const esiti = estraiJson(await chiama(PROMPT_GIUDIZIO(elenco)))?.esiti
  if (!Array.isArray(esiti)) return []
  const promossi = new Set(
    esiti.filter((e: any) => e?.sostiene === true).map((e: any) => Number(e.i)),
  )
  return archi.filter((_, i) => promossi.has(i))
}

/** Estrae entità e — solo se il grafo causale è acceso — relazioni tipizzate. */
export async function estraiPagina(
  pageId: string,
  contenuto: string,
  chiama: ChiamaModello,
  causale: boolean,
): Promise<RigaGrafo> {
  const risposta = await chiama(PROMPT_ENTITA(ETICHETTE.join(", "), contenuto))
  const entita = soloVerificate(estraiJson(risposta)?.entita ?? [], contenuto)

  let relazioni: RigaGrafo["relazioni"] = []
  if (causale && entita.length >= 2) {
    const r = estraiJson(await chiama(PROMPT_RELAZIONI(contenuto, entita.map((e) => e.testo).join(", "))))
    const nomi = new Set(entita.map((e) => norm(e.testo)))
    const t = norm(contenuto)
    relazioni = (r?.relazioni ?? [])
      .filter(
        (x: any) =>
          // i due capi devono essere entità verificate, e la prova comparire
          // alla lettera. È il minimo, non la garanzia: vedi il commento su
          // `RigaGrafo.relazioni`.
          nomi.has(norm(String(x?.da ?? ""))) &&
          nomi.has(norm(String(x?.a ?? ""))) &&
          String(x?.prova ?? "").trim() !== "" &&
          t.includes(norm(String(x.prova))),
      )
      .map((x: any) => ({
        da: String(x.da),
        a: String(x.a),
        tipo: String(x.tipo ?? ""),
        prova: String(x.prova),
      }))
    // Il giudizio è il passo che l'estrazione non sa fare. Costa una chiamata
    // per pagina, non per arco.
    relazioni = (await giudicaArchi(relazioni, chiama)).map((a) => ({
      ...a,
      origine: "ESTRATTO" as const,
    }))
  }
  return { page_id: pageId, entita, relazioni, causale }
}

/**
 * Il grafo si scrive in coda a un JSONL, una riga per pagina.
 *
 * Aggiunta, mai riscrittura (D5): un file che si accresce si legge anche a metà
 * corsa, e un'interruzione costa l'ultima riga invece dell'intero grafo.
 */
export async function scriviRiga(vault: string, riga: RigaGrafo): Promise<void> {
  const dir = join(vault, ".llm-wiki")
  await fs.mkdir(dir, { recursive: true })
  await fs.appendFile(join(dir, "entity-graph.jsonl"), `${JSON.stringify(riga)}\n`, "utf8")
}
