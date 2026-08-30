/**
 * Il guasto che conta qui è **un grafo che sembra vero**: entità che il modello
 * non ha letto ma prodotto, e archi senza una citazione che li sostenga. Non
 * danno errore, e chi legge il grafo dopo non ha modo di accorgersene.
 * Perciò i test insistono sul filtro, non sulla forma del JSON.
 */
import { promises as fs } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  estraiJson,
  estraiPagina,
  giudicaArchi,
  grafoCausaleAcceso,
  grafoEntitaAcceso,
  scriviRiga,
  soloVerificate,
} from "./entity-extract"

let vault: string
beforeEach(async () => {
  vault = await mkdtemp(join(tmpdir(), "entita-"))
})
afterEach(async () => {
  await rm(vault, { recursive: true, force: true })
})

const TESTO = "Milena Battaglia ha scritto della teoria polivagale. Il trauma causa dissociazione."

describe("il JSON del modello", () => {
  it("si estrae anche avvolto nei backtick", () => {
    expect(estraiJson('```json\n{"entita":[]}\n```')).toEqual({ entita: [] })
  })
  it("una risposta che non è JSON torna null invece di far cadere l'ingest", () => {
    expect(estraiJson("mi dispiace, non posso")).toBeNull()
    expect(estraiJson('{"rotto": ')).toBeNull()
  })
})

describe("⛔ si tiene solo ciò che compare alla lettera", () => {
  it("scarta le entità inventate", () => {
    const r = soloVerificate(
      [
        { testo: "Milena Battaglia", tipo: "persona" },
        { testo: "Sigmund Freud", tipo: "persona" }, // mai nominato
      ],
      TESTO,
    )
    expect(r.map((e) => e.testo)).toEqual(["Milena Battaglia"])
  })

  it("ignora gli accenti e gli spazi doppi, che non sono invenzioni", () => {
    const r = soloVerificate([{ testo: "PERCHÉ  COSÌ", tipo: "concetto" }], "il testo dice perche cosi, ecco")
    expect(r).toHaveLength(1)
  })

  it("scarta i tipi fuori dall'elenco", () => {
    expect(soloVerificate([{ testo: "trauma", tipo: "sentimento" }], TESTO)).toEqual([])
  })

  it("toglie i doppioni della stessa entità", () => {
    const r = soloVerificate(
      [
        { testo: "trauma", tipo: "concetto" },
        { testo: "Trauma", tipo: "concetto" },
      ],
      TESTO,
    )
    expect(r).toHaveLength(1)
  })

  it("regge una risposta malformata senza esplodere", () => {
    expect(soloVerificate([{} as never, null as never, { testo: "", tipo: "persona" }], TESTO)).toEqual([])
  })
})

describe("il giudizio sugli archi", () => {
  it("tiene solo quelli promossi, e l'indice deve tornare", async () => {
    const archi = [
      { da: "trauma", a: "dissociazione", tipo: "causa", prova: "Il trauma causa dissociazione" },
      { da: "Milena", a: "teoria", tipo: "causa", prova: "Milena insegna la teoria" },
    ]
    const r = await giudicaArchi(archi, async () =>
      JSON.stringify({ esiti: [{ i: 0, sostiene: true }, { i: 1, sostiene: false }] }))
    expect(r.map((a) => a.da)).toEqual(["trauma"])
  })

  it("⛔ una risposta illeggibile fa cadere TUTTI gli archi, non passarli", async () => {
    // un grafo con un arco in meno è incompleto; con un arco falso è sbagliato,
    // e il secondo non si vede
    const archi = [{ da: "a", a: "b", tipo: "causa", prova: "x" }]
    expect(await giudicaArchi(archi, async () => "non ho capito")).toEqual([])
    expect(await giudicaArchi(archi, async () => JSON.stringify({ altro: 1 }))).toEqual([])
  })

  it("senza archi non chiama nemmeno il modello", async () => {
    let chiamate = 0
    await giudicaArchi([], async () => { chiamate++; return "" })
    expect(chiamate).toBe(0)
  })
})

describe("estrazione di una pagina", () => {
  const rispondi = (entita: unknown, relazioni?: unknown) => async (p: string) =>
    p.includes("decidi se la CITAZIONE")
      ? JSON.stringify({ esiti: (relazioni as any[] ?? []).map((_, i) => ({ i, sostiene: true })) })
      : p.includes("relazioni CAUSALI")
        ? JSON.stringify({ relazioni })
        : JSON.stringify({ entita })

  it("senza grafo causale non chiede nemmeno le relazioni", async () => {
    let chiamate = 0
    const r = await estraiPagina("x", TESTO, async (p) => {
      chiamate++
      return JSON.stringify({ entita: [{ testo: "trauma", tipo: "concetto" }] })
    }, false)
    expect(chiamate).toBe(1)
    expect(r.relazioni).toEqual([])
    expect(r.causale).toBe(false)
  })

  it("col grafo causale tiene solo gli archi con una prova nel testo", async () => {
    const r = await estraiPagina(
      "x",
      TESTO,
      rispondi(
        [
          { testo: "trauma", tipo: "concetto" },
          { testo: "dissociazione", tipo: "concetto" },
        ],
        [
          { da: "trauma", a: "dissociazione", tipo: "causa", prova: "Il trauma causa dissociazione" },
          { da: "trauma", a: "dissociazione", tipo: "causa", prova: "frase mai scritta nel documento" },
          { da: "trauma", a: "fantasma", tipo: "causa", prova: "Il trauma causa dissociazione" },
        ],
      ),
      true,
    )
    expect(r.relazioni).toHaveLength(1)
    expect(r.relazioni[0].prova).toContain("Il trauma causa")
    // ogni arco dichiara da dove viene: la citazione c'è, il giudizio no
    expect(r.relazioni[0].origine).toBe("ESTRATTO")
  })

  it("con meno di due entità non prova nemmeno a costruire archi", async () => {
    let chiamate = 0
    await estraiPagina("x", TESTO, async () => {
      chiamate++
      return JSON.stringify({ entita: [{ testo: "trauma", tipo: "concetto" }] })
    }, true)
    expect(chiamate).toBe(1)
  })
})

describe("D3 — i flag, ereditati dalla cartella", () => {
  const indici: Record<string, string> = {
    "concepts/salute": "---\ncausal_graph: true\nentity_graph: true\n---\n",
    "sources": "---\nentity_graph: false\n---\n",
  }
  const leggi = async (f: string) => indici[f] ?? null

  it("spento dove nessuno si esprime", async () => {
    expect(await grafoCausaleAcceso("docs/x", leggi)).toBe(false)
    expect(await grafoEntitaAcceso("docs/x", leggi)).toBe(false)
  })

  it("acceso dove la cartella lo dice, anche annidando", async () => {
    expect(await grafoCausaleAcceso("concepts/salute/dentro/x", leggi)).toBe(true)
    expect(await grafoEntitaAcceso("concepts/salute/x", leggi)).toBe(true)
  })

  it("la nota smentisce la cartella", async () => {
    expect(await grafoCausaleAcceso("concepts/salute/x", leggi, "causal_graph: false")).toBe(false)
    expect(await grafoEntitaAcceso("sources/x", leggi, "entity_graph: true")).toBe(true)
  })

  it("una cartella può spegnerlo per sé", async () => {
    expect(await grafoEntitaAcceso("sources/foo/bar", leggi)).toBe(false)
  })
})

describe("scrittura del grafo", () => {
  it("aggiunge in coda, non riscrive (D5)", async () => {
    await scriviRiga(vault, { page_id: "a", entita: [], relazioni: [], causale: false })
    await scriviRiga(vault, { page_id: "b", entita: [], relazioni: [], causale: false })
    const righe = (await fs.readFile(join(vault, ".llm-wiki", "entity-graph.jsonl"), "utf8"))
      .trim()
      .split("\n")
    expect(righe).toHaveLength(2)
    expect(JSON.parse(righe[0]).page_id).toBe("a")
    expect(JSON.parse(righe[1]).page_id).toBe("b")
  })
})
