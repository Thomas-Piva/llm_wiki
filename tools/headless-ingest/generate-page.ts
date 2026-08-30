/**
 * D0 — la pagina leggibile si scrive **su richiesta**, in streaming.
 *
 * È l'altra metà della decisione: all'ingest si costruisce il grafo (una volta,
 * su tutto), e la prosa si paga solo per le voci che qualcuno apre davvero.
 * Il conto che ha deciso: scrivere una pagina per documento costa **$90 col
 * prompt e $2.100 con l'agente** su 8.800 documenti, e nessuno leggerà 3.964
 * pagine di fattura. Le poche decine di voci che una persona apre costano $12.
 *
 * ⭐ **Il guadagno non è solo il costo: i wikilink smettono di essere indovinati.**
 * Misurato sul percorso attuale: fino a **82 collegamenti verso pagine che non
 * esistono** e **55 scritti col percorso**, che il motore non risolve e che
 * spariscono *senza dare errore*. Qui i vicini arrivano dal grafo già calcolato:
 * al modello resta la prosa, e i bersagli sono noti prima di scrivere.
 *
 * In streaming perché una voce lunga, generata a blocco, si vede comparire dopo
 * trenta secondi di niente; e perché una generazione interrotta lascia comunque
 * il testo scritto fino a quel punto invece di lasciare il vuoto.
 */
import { promises as fs } from "node:fs"
import { join } from "node:path"

export interface Prova {
  page_id: string
  testo: string
}

/** Un pezzo di testo alla volta, come arriva. */
export type FlussoTesto = AsyncGenerator<string, void, unknown>

/**
 * Legge un flusso SSE OpenAI-compatibile e restituisce solo il testo.
 *
 * ⚠️ **Il confine dei pacchetti non è il confine delle righe.** Un evento può
 * arrivare spezzato a metà, e concatenare senza tenere il resto produce JSON
 * troncato che finisce silenziosamente nel `catch`: la pagina esce con dei buchi
 * e nessuno se ne accorge. Per questo il resto parziale si conserva.
 */
export async function* leggiFlusso(
  righe: AsyncIterable<Uint8Array | string>,
): FlussoTesto {
  const dec = new TextDecoder()
  let resto = ""
  for await (const pezzo of righe) {
    resto += typeof pezzo === "string" ? pezzo : dec.decode(pezzo, { stream: true })
    const parti = resto.split("\n")
    resto = parti.pop() ?? "" // l'ultima riga può essere monca: si tiene
    for (const riga of parti) {
      const r = riga.trim()
      if (!r.startsWith("data:")) continue
      const carico = r.slice(5).trim()
      if (carico === "[DONE]") return
      try {
        const t = JSON.parse(carico)?.choices?.[0]?.delta?.content
        if (typeof t === "string" && t) yield t
      } catch {
        /* un evento non-JSON (commento, keep-alive) non è un errore */
      }
    }
  }
}

const PROMPT = (titolo: string, vicini: string[], prove: Prova[]) =>
  `Scrivi una voce enciclopedica in italiano su «${titolo}», per un vault di note.

REGOLE
- Solo ciò che le FONTI sostengono. Se non basta a scrivere una voce, dillo in una riga.
- Collegamenti: usa ESCLUSIVAMENTE questi nomi, scritti come [[nome]]:
  ${vicini.length ? vicini.join(", ") : "(nessuno: non mettere collegamenti)"}
  Non inventare altri bersagli e non scrivere mai il percorso dentro le doppie parentesi.
- Niente frontmatter: lo mette il chiamante.
- Comincia con "# ${titolo}", poi la prosa. Da 150 a 400 parole.

FONTI
${prove.map((p, i) => `[${i + 1}] ${p.page_id}\n${p.testo}`).join("\n\n")}`

/**
 * Genera la voce, un pezzo alla volta.
 *
 * `chiamaFlusso` è iniettabile per la stessa ragione dell'estrattore: un test
 * che dipende dalla rete non è un test.
 */
export async function* generaPagina(
  titolo: string,
  prove: Prova[],
  vicini: string[],
  chiamaFlusso: (prompt: string) => FlussoTesto,
): FlussoTesto {
  if (prove.length === 0) {
    // Nessuna fonte, nessuna voce: una pagina inventata è peggio di una pagina
    // che manca, perché sembra conoscenza.
    yield `# ${titolo}\n\n> [!warning] Nessuna fonte nell'indice sostiene questa voce.\n> Non è stata scritta per non inventarla.\n`
    return
  }
  yield* chiamaFlusso(PROMPT(titolo, vicini, prove))
}

/**
 * Scrive mentre arriva, invece di aspettare la fine.
 *
 * Il file nasce col frontmatter già a posto, poi cresce. Un'interruzione lascia
 * una pagina a metà — che si vede, si rilegge e si rigenera — invece di lasciare
 * il nulla. Restituisce quante battute sono state scritte.
 */
export async function scriviInStreaming(
  vault: string,
  relPath: string,
  frontmatter: string,
  flusso: FlussoTesto,
): Promise<number> {
  const abs = join(vault, ...relPath.split("/"))
  await fs.mkdir(join(abs, ".."), { recursive: true })
  const f = await fs.open(abs, "w")
  let scritte = 0
  try {
    await f.write(`${frontmatter}\n\n`)
    for await (const pezzo of flusso) {
      await f.write(pezzo)
      scritte += pezzo.length
    }
    if (scritte > 0) await f.write("\n")
  } finally {
    await f.close()
  }
  return scritte
}

/** Toglie i `[[collegamenti]]` che non puntano a una pagina esistente.
 *
 *  Rete di sicurezza, non fiducia: il prompt elenca i bersagli ammessi, ma un
 *  modello che ne aggiunge uno produce un arco che sparisce in silenzio — ed è
 *  esattamente il difetto che questa strada doveva chiudere. Il testo resta,
 *  cadono solo le parentesi. */
export function potaCollegamenti(testo: string, ammessi: Set<string>): string {
  return testo.replace(/\[\[([^\]|#]+)((?:#[^\]|]*)?(?:\|[^\]]*)?)\]\]/g, (intero, bersaglio, coda) => {
    const nome = String(bersaglio).trim()
    if (ammessi.has(nome)) return intero
    const etichetta = /\|([^\]]*)/.exec(String(coda))?.[1]?.trim()
    return etichetta || nome
  })
}
