#!/usr/bin/env bun
/**
 * D0 — scrive su richiesta la voce che un `[[collegamento]]` cerca e non trova.
 *
 *   bun tools/headless-ingest/generate-runner.ts --project <vault> --title "Metamedicina"
 *        [--folder concepts] [--dry]
 *
 * Le tre fonti di verità sono già tutte sul disco e nessuna va indovinata:
 *
 *   prove    ← l'indice LanceDB (le pagine che parlano davvero dell'argomento)
 *   vicini   ← i `page_id` di quelle stesse pagine, cioè bersagli che ESISTONO
 *   regole   ← `schema.md` del vault, se c'è
 *
 * ⛔ Non sovrascrive mai (D5): se la voce esiste, si ferma e lo dice.
 */
import { promises as fs } from "node:fs"
import { basename, join } from "node:path"

import {
  generaPagina,
  leggiFlusso,
  potaCollegamenti,
  scriviInStreaming,
  type FlussoTesto,
  type Prova,
} from "./generate-page"
import { embedTexts, vectorSearchChunks } from "./vector-store"

function arg(nome: string): string | undefined {
  const i = process.argv.indexOf(nome)
  return i >= 0 ? process.argv[i + 1] : undefined
}

/** ⛔ Per un interruttore serve la presenza, non il valore.
 *
 *  `arg("--dry")` restituisce l'argomento **successivo**, che per un flag in
 *  fondo alla riga non c'è: `undefined`. Il controllo `!== undefined` lo
 *  leggeva come «non richiesto» e la prova a vuoto **ha scritto sul disco** —
 *  nel vault di una cliente. Un interruttore si legge con `includes`. */
function flag(nome: string): boolean {
  return process.argv.includes(nome)
}

function kebab(nome: string): string {
  return nome
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

/** Le pagine che l'indice associa all'argomento: sono le prove **e** i vicini. */
export async function raccogliProve(
  vault: string,
  titolo: string,
  cfg: Record<string, any>,
  quante = 6,
): Promise<Prova[]> {
  const [v] = await embedTexts([titolo], cfg)
  if (!v) return []
  const pezzi = await vectorSearchChunks(vault, v, quante * 6)
  const perPagina = new Map<string, string>()
  for (const c of pezzi) {
    if (perPagina.size >= quante && !perPagina.has(c.page_id)) continue
    const prima = perPagina.get(c.page_id) ?? ""
    if (prima.length < 1200) perPagina.set(c.page_id, `${prima}\n${c.chunk_text}`.trim())
  }
  return [...perPagina.entries()].map(([page_id, testo]) => ({ page_id, testo: testo.slice(0, 1200) }))
}

/** Il flusso vero verso un endpoint OpenAI-compatibile. */
export function flussoOpenAI(base: string, key: string, model: string) {
  return async function* (prompt: string): FlussoTesto {
    const res = await fetch(`${base.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.3,
        stream: true,
        // `enabled: false`, non `effort: "none"`: l'effort è per-modello e non
        // tutti dichiarano di accettare "none" — misurato altrove, 6,3 s → 15,0 s
        // per chiamata, in silenzio.
        reasoning: { enabled: false },
      }),
    })
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} dal modello`)
    yield* leggiFlusso(res.body as unknown as AsyncIterable<Uint8Array>)
  }
}

async function main() {
  const vault = arg("--project")
  const titolo = arg("--title")
  if (!vault || !titolo) {
    console.error('uso: --project <vault> --title "Nome della voce" [--folder concepts] [--dry]')
    process.exit(2)
  }
  const cartella = arg("--folder") ?? "concepts"
  const rel = `wiki/${cartella}/${kebab(titolo)}.md`

  // D5 — solo aggiunta. Un nome già preso è preso ovunque si trovi.
  try {
    await fs.access(join(vault, ...rel.split("/")))
    console.error(`già esiste: ${rel} — non tocco niente`)
    process.exit(1)
  } catch {
    /* non c'è: si può scrivere */
  }

  const stato = JSON.parse(await fs.readFile(join(vault, ".llm-wiki", "app-state.json"), "utf8"))
  const prove = await raccogliProve(vault, titolo, stato.embeddingConfig)
  // I vicini sono i `page_id` delle prove: bersagli che esistono per costruzione,
  // e sono la ragione per cui qui i wikilink non si indovinano.
  //
  // ⚠️ Ma non tutti vanno bene. D1 separa le **fonti** dalle **voci**, e una
  // voce enciclopedica che rimanda a
  // `7-dropbox--14-0triuneproject--16-05libriericerche--35-notebooklm-…`
  // è un collegamento valido e illeggibile: tecnicamente risolve, e nessuno lo
  // seguirà mai. Si tengono i vicini che sono a loro volta voci; le fonti
  // restano nell'indice, dove servono, e la voce può nascere senza collegamenti
  // invece che con collegamenti sbagliati.
  const vicini = prove
    .filter((p) => /^(concepts|entities|docs)\//.test(p.page_id))
    .map((p) => basename(p.page_id))
  const ammessi = new Set(vicini)

  console.error(`fonti: ${prove.length} · vicini: ${vicini.slice(0, 6).join(", ") || "(nessuno)"}`)

  const llm = stato.llmConfig ?? {}
  const flusso = flussoOpenAI(llm.customEndpoint, llm.apiKey, arg("--model") ?? llm.model)

  if (flag("--dry")) {
    let n = 0
    for await (const p of generaPagina(titolo, prove, vicini, flusso)) {
      process.stdout.write(p)
      n += p.length
    }
    console.error(`\n\n[dry] ${n} battute, niente scritto su disco`)
    return
  }

  const oggi = new Date().toISOString().slice(0, 10)
  const fm = [
    "---",
    `id: c-${Math.abs(hash(titolo)).toString(16).slice(0, 6)}`,
    `title: ${titolo}`,
    `summary: Voce generata su richiesta dalle fonti già indicizzate.`,
    `tags: [${cartella.split("/")[0]}]`,
    "aliases: []",
    "status: draft",
    "visibility: all",
    `created: ${oggi}`,
    `updated: ${oggi}`,
    `related: ${vicini.slice(0, 5).map((v) => `[[${v}]]`).join(",")}`,
    "---",
  ].join("\n")

  // La potatura avviene sul flusso, pezzo per pezzo? No: un collegamento può
  // essere spezzato fra due pezzi. Si accumula, si pota, si scrive — e la
  // scrittura resta progressiva riga per riga.
  const n = await scriviInStreaming(vault, rel, fm, potaSulFlusso(generaPagina(titolo, prove, vicini, flusso), ammessi))
  console.error(`scritto ${rel} · ${n} battute`)
}

/** Pota i collegamenti tenendo conto che `[[` e `]]` possono cadere in pezzi diversi. */
export async function* potaSulFlusso(f: FlussoTesto, ammessi: Set<string>): FlussoTesto {
  let coda = ""
  for await (const pezzo of f) {
    coda += pezzo
    // si emette fino all'ultima parentesi aperta non ancora chiusa
    const aperta = coda.lastIndexOf("[[")
    const chiusa = coda.lastIndexOf("]]")
    const sicuro = aperta > chiusa ? aperta : coda.length
    if (sicuro > 0) {
      yield potaCollegamenti(coda.slice(0, sicuro), ammessi)
      coda = coda.slice(sicuro)
    }
  }
  if (coda) yield potaCollegamenti(coda, ammessi)
}

function hash(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return h
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e))
    process.exit(1)
  })
}
