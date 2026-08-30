/**
 * D0 — la conduttura di streaming per `vault_create_missing_page`.
 *
 * ⚠️ **È la seconda implementazione del lettore SSE**, e la duplicazione è
 * deliberata: `tools/headless-ingest/generate-page.ts` sta in un altro pacchetto
 * (altro `package.json`, altro `tsconfig`, altre dipendenze) e non c'è una
 * libreria condivisa fra i due. Importarlo di là farebbe uscire l'output
 * compilato da `dist/`. Le due versioni parlano lo stesso protocollo e hanno
 * ciascuna i propri test; se una cambia, cambia anche l'altra.
 *
 * Qui la superficie è ridotta al minimo: leggere il flusso e passarlo avanti.
 * Le regole su cosa scrivere stanno nel prompt, che è uno solo.
 */
import { promises as fs } from "node:fs"
import path from "node:path"

export interface Prova {
  path: string
  testo: string
}

/**
 * Da un flusso SSE OpenAI-compatibile al solo testo.
 *
 * Il resto parziale si conserva fra un pacchetto e l'altro: il confine dei
 * pacchetti non è il confine delle righe, e un evento spezzato a metà darebbe
 * JSON troncato che finisce in silenzio nel `catch` — la pagina uscirebbe con
 * dei buchi senza che nessuno lo veda.
 */
export async function* leggiFlusso(
  sorgente: AsyncIterable<Uint8Array | string>,
): AsyncGenerator<string, void, unknown> {
  const dec = new TextDecoder()
  let resto = ""
  for await (const pezzo of sorgente) {
    resto += typeof pezzo === "string" ? pezzo : dec.decode(pezzo, { stream: true })
    const righe = resto.split("\n")
    resto = righe.pop() ?? ""
    for (const riga of righe) {
      const r = riga.trim()
      if (!r.startsWith("data:")) continue
      const carico = r.slice(5).trim()
      if (carico === "[DONE]") return
      try {
        const t = JSON.parse(carico)?.choices?.[0]?.delta?.content
        if (typeof t === "string" && t) yield t
      } catch {
        /* keep-alive o commento: non è un errore */
      }
    }
  }
}

export const PROMPT_VOCE = (titolo: string, vicini: string[], prove: Prova[]) =>
  `Scrivi una voce enciclopedica in italiano su «${titolo}», per un vault di note.

REGOLE
- Solo ciò che le FONTI sostengono. Se non basta, dillo in una riga.
- Collegamenti: usa ESCLUSIVAMENTE questi nomi, scritti come [[nome]]:
  ${vicini.length ? vicini.join(", ") : "(nessuno: non mettere collegamenti)"}
  Non inventare altri bersagli e non scrivere mai il percorso dentro le parentesi.
- Niente frontmatter: lo mette il chiamante.
- Comincia con "# ${titolo}", poi la prosa. Da 150 a 400 parole.

FONTI
${prove.map((p, i) => `[${i + 1}] ${p.path}\n${p.testo}`).join("\n\n")}`

/** Toglie i collegamenti verso bersagli che non esistono; il testo resta. */
export function potaCollegamenti(testo: string, ammessi: Set<string>): string {
  return testo.replace(/\[\[([^\]|#]+)((?:#[^\]|]*)?(?:\|[^\]]*)?)\]\]/g, (intero, bersaglio, coda) => {
    const nome = String(bersaglio).trim()
    if (ammessi.has(nome)) return intero
    const etichetta = /\|([^\]]*)/.exec(String(coda))?.[1]?.trim()
    return etichetta || nome
  })
}

/** Pota tenendo conto che `[[` e `]]` possono cadere in pezzi diversi. */
export async function* potaSulFlusso(
  f: AsyncGenerator<string, void, unknown>,
  ammessi: Set<string>,
): AsyncGenerator<string, void, unknown> {
  let coda = ""
  for await (const pezzo of f) {
    coda += pezzo
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

/** Il flusso vero verso un endpoint OpenAI-compatibile. */
export function flussoOpenAI(base: string, key: string, model: string) {
  return async function* (prompt: string): AsyncGenerator<string, void, unknown> {
    const res = await fetch(`${base.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.3,
        stream: true,
        reasoning: { enabled: false },
      }),
    })
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} dal modello`)
    yield* leggiFlusso(res.body as unknown as AsyncIterable<Uint8Array>)
  }
}

/** `llmConfig` dal vault. Null se non è utilizzabile. */
export async function configLlm(
  vaultRoot: string,
): Promise<{ base: string; key: string; model: string } | null> {
  try {
    const raw = await fs.readFile(path.join(vaultRoot, ".llm-wiki", "app-state.json"), "utf8")
    const c = JSON.parse(raw).llmConfig
    const base = String(c?.customEndpoint ?? "")
    if (!base || !c?.apiKey || !c?.model) return null
    return { base, key: String(c.apiKey), model: String(c.model) }
  } catch {
    return null
  }
}

/**
 * Scrive la pagina mentre arriva e riferisce a ogni pezzo.
 *
 * `onPezzo` è ciò che rende lo streaming visibile all'agente: senza, il testo
 * comparirebbe tutto insieme alla fine, che è esattamente ciò che D0 non vuole.
 * Un'interruzione lascia la pagina a metà — che si vede e si rigenera — invece
 * del nulla.
 */
export async function scriviInStreaming(
  vaultRoot: string,
  relPath: string,
  frontmatter: string,
  flusso: AsyncGenerator<string, void, unknown>,
  onPezzo?: (testo: string, totale: number) => void,
): Promise<number> {
  const abs = path.join(vaultRoot, ...relPath.split("/"))
  await fs.mkdir(path.dirname(abs), { recursive: true })
  const f = await fs.open(abs, "w")
  let n = 0
  try {
    await f.write(`${frontmatter}\n\n`)
    for await (const pezzo of flusso) {
      await f.write(pezzo)
      n += pezzo.length
      onPezzo?.(pezzo, n)
    }
    if (n > 0) await f.write("\n")
  } finally {
    await f.close()
  }
  return n
}
