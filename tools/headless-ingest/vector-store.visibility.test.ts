/**
 * D4 — la colonna dei permessi, provata su una tabella LanceDB vera.
 *
 * Due cose che, sbagliate, non danno errore:
 *  - la migrazione che **ricalcola** invece di aggiungere una costante: su
 *    248.083 righe sarebbe una notte di lavoro al posto di un secondo;
 *  - il filtro applicato **dopo** la ricerca: torna meno risultati del richiesto
 *    e il recall crolla proprio sulle domande selettive, cioè quelle dove i
 *    permessi contano. Il test controlla che il conteggio non cambi e che il
 *    filtro selezioni davvero.
 */
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as lancedb from "@lancedb/lancedb"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  ensureVisibilityColumn,
  vectorCountChunks,
  vectorSearchChunks,
  vectorUpsertChunks,
  VISIBILITY_DEFAULT,
} from "./vector-store"

let vault: string

beforeEach(async () => {
  vault = await mkdtemp(join(tmpdir(), "vis-"))
})
afterEach(async () => {
  await rm(vault, { recursive: true, force: true })
})

const vec = (n: number) => Array.from({ length: 8 }, (_, i) => (i === n % 8 ? 1 : 0))

function pezzi(quanti: number, visibility?: string) {
  return Array.from({ length: quanti }, (_, i) => ({
    chunk_index: i,
    chunk_text: `testo ${i}`,
    heading_path: "",
    embedding: vec(i),
    ...(visibility ? { visibility } : {}),
  }))
}

/** Una tabella scritta com'era PRIMA di D4: nessuna colonna `visibility`. */
async function tabellaVecchia(quante: number) {
  const db = await lancedb.connect(join(vault, ".llm-wiki", "lancedb"))
  await db.createTable(
    "wiki_chunks_v2",
    Array.from({ length: quante }, (_, i) => ({
      chunk_id: `vecchia#${i}`,
      page_id: "vecchia",
      chunk_index: i,
      chunk_text: `testo ${i}`,
      heading_path: "",
      vector: vec(i),
    })),
  )
}

describe("D4 — migrazione della colonna", () => {
  it("aggiunge la colonna a un indice esistente senza perdere righe", async () => {
    await tabellaVecchia(20)
    expect(await vectorCountChunks(vault)).toBe(20)

    expect(await ensureVisibilityColumn(vault)).toBe("aggiunta")

    // ⛔ il numero di righe è il controllo che conta: se la migrazione
    // ricalcolasse o riscrivesse, qui si vedrebbe
    expect(await vectorCountChunks(vault)).toBe(20)
    const r = await vectorSearchChunks(vault, vec(3), 5)
    expect(r.length).toBeGreaterThan(0)
    expect(r[0].visibility).toBe(VISIBILITY_DEFAULT)
  })

  it("è idempotente: chiamarla due volte non fa danni", async () => {
    await tabellaVecchia(5)
    expect(await ensureVisibilityColumn(vault)).toBe("aggiunta")
    expect(await ensureVisibilityColumn(vault)).toBe("c'era già")
    expect(await vectorCountChunks(vault)).toBe(5)
  })

  it("su un vault senza indice non esplode", async () => {
    expect(await ensureVisibilityColumn(vault)).toBe("nessuna tabella")
  })
})

describe("D4 — il pre-filtro", () => {
  it("le righe nuove nascono con l'etichetta predefinita", async () => {
    await vectorUpsertChunks(vault, "pagina", pezzi(4))
    const r = await vectorSearchChunks(vault, vec(0), 4)
    expect(r.every((x) => x.visibility === VISIBILITY_DEFAULT)).toBe(true)
  })

  it("filtra su quello che è stato chiesto, e scarta il resto", async () => {
    await vectorUpsertChunks(vault, "pubblica", pezzi(4))
    await vectorUpsertChunks(vault, "riservata", pezzi(4, "interna"))

    const tutte = await vectorSearchChunks(vault, vec(0), 20)
    expect(tutte.length).toBe(8)

    const solo = await vectorSearchChunks(vault, vec(0), 20, { visibility: ["interna"] })
    expect(solo.length).toBe(4)
    expect(solo.every((x) => x.page_id === "riservata")).toBe(true)

    const due = await vectorSearchChunks(vault, vec(0), 20, { visibility: ["all", "interna"] })
    expect(due.length).toBe(8)
  })

  it("un'etichetta che non esiste torna vuoto, non tutto", async () => {
    // il guasto peggiore sarebbe il contrario: un filtro ignorato che mostra
    // ciò che doveva restare nascosto
    await vectorUpsertChunks(vault, "pagina", pezzi(4))
    expect(await vectorSearchChunks(vault, vec(0), 20, { visibility: ["inesistente"] })).toEqual([])
  })

  it("un'etichetta con un apice non rompe la clausola SQL", async () => {
    await vectorUpsertChunks(vault, "pagina", pezzi(2, "l'interna"))
    const r = await vectorSearchChunks(vault, vec(0), 10, { visibility: ["l'interna"] })
    expect(r.length).toBe(2)
  })

  it("senza filtro il comportamento è quello di prima", async () => {
    await vectorUpsertChunks(vault, "a", pezzi(3))
    await vectorUpsertChunks(vault, "b", pezzi(3, "interna"))
    expect((await vectorSearchChunks(vault, vec(0), 20)).length).toBe(6)
  })
})
