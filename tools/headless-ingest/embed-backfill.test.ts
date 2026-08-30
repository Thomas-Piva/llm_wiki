/**
 * The backfill's only silent failure mode is forgetting what it already did:
 * a broken resume looks exactly like a job that is merely slow, and costs a
 * whole night before anyone notices. These tests guard that, and the atomic
 * write that protects the memory from a kill mid-flush.
 */
import { promises as fs } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { isDerivedPage } from "@/lib/embedding"
import { pagesToDo, readState, statePath, wikiPages, writeState } from "./embed-backfill"

let vault: string

beforeEach(async () => {
  vault = await mkdtemp(join(tmpdir(), "backfill-"))
})
afterEach(async () => {
  await rm(vault, { recursive: true, force: true })
})

async function page(rel: string, body = "# titolo\n\ncorpo") {
  const p = join(vault, "wiki", rel)
  await fs.mkdir(join(p, ".."), { recursive: true })
  await fs.writeFile(p, body)
}

describe("ripresa del backfill", () => {
  it("salta le pagine già fatte e tiene le altre", () => {
    const pages = [{ pageId: "a" }, { pageId: "b" }, { pageId: "c" }]
    expect(pagesToDo(pages, { done: ["a", "c"] })).toEqual([{ pageId: "b" }])
  })

  it("senza stato precedente le fa tutte", () => {
    const pages = [{ pageId: "a" }, { pageId: "b" }]
    expect(pagesToDo(pages, { done: [] })).toHaveLength(2)
  })

  it("uno stato che nomina pagine sparite non ne salta di vere", () => {
    // il vault cambia fra una notte e l'altra: pagine cancellate restano
    // nello stato, e non devono far sparire pagine che esistono davvero
    const pages = [{ pageId: "a" }, { pageId: "b" }]
    expect(pagesToDo(pages, { done: ["vecchia", "sparita"] })).toHaveLength(2)
  })

  it("riprende da dove si era fermato, non da zero", async () => {
    await writeState(vault, {
      done: ["x", "y"], failed: {}, startedAt: "", updatedAt: "", charsDone: 100,
    })
    const s = await readState(vault)
    expect(s.done).toEqual(["x", "y"])
    expect(s.charsDone).toBe(100)
  })

  it("senza file di stato riparte pulito invece di esplodere", async () => {
    const s = await readState(vault)
    expect(s.done).toEqual([])
    expect(s.failed).toEqual({})
  })

  it("uno stato corrotto non blocca il lavoro", async () => {
    // un kill durante la scrittura di una versione precedente, o un disco pieno
    await fs.mkdir(join(vault, ".llm-wiki"), { recursive: true })
    await fs.writeFile(statePath(vault), "{ non è json")
    const s = await readState(vault)
    expect(s.done).toEqual([])
  })

  it("scrive passando da un temporaneo, così un kill non tronca la memoria", async () => {
    await writeState(vault, {
      done: ["a"], failed: {}, startedAt: "", updatedAt: "", charsDone: 1,
    })
    // il temporaneo non deve sopravvivere alla rinomina
    await expect(fs.access(`${statePath(vault)}.tmp`)).rejects.toThrow()
    expect(JSON.parse(await fs.readFile(statePath(vault), "utf8")).done).toEqual(["a"])
  })

  it("conserva i falliti, perché una pagina che fallisce sempre va vista", async () => {
    await writeState(vault, {
      done: [], failed: { rotta: "HTTP 429" }, startedAt: "", updatedAt: "", charsDone: 0,
    })
    expect((await readState(vault)).failed).toEqual({ rotta: "HTTP 429" })
  })
})

describe("cammino sul vault", () => {
  it("trova le pagine annidate e ne toglie l'estensione", async () => {
    await page("uno.md")
    await page("concepts/due.md")
    await page("entities/dentro/tre.md")
    const found = (await wikiPages(vault)).map((p) => p.pageId)
    expect(found).toEqual(["concepts/due", "entities/dentro/tre", "uno"])
  })

  it("ignora ciò che non è markdown", async () => {
    await page("vera.md")
    await fs.writeFile(join(vault, "wiki", "foto.png"), "x")
    expect((await wikiPages(vault)).map((p) => p.pageId)).toEqual(["vera"])
  })

  it("su un vault senza wiki/ restituisce vuoto invece di fallire", async () => {
    expect(await wikiPages(vault)).toEqual([])
  })

  it("l'ordine è stabile: due corse notturne vedono la stessa sequenza", async () => {
    await page("b.md")
    await page("a.md")
    await page("c.md")
    expect((await wikiPages(vault)).map((p) => p.pageId)).toEqual(["a", "b", "c"])
  })
})

describe("pagine derivate: si riusa la lista dell'app, non una copia", () => {
  it("esclude le cinque che embedAllPages esclude", () => {
    for (const id of ["index", "log", "overview", "purpose", "schema"]) {
      expect(isDerivedPage(id)).toBe(true)
    }
  })

  it("le esclude anche annidate, non solo alla radice", () => {
    // il caso vero: wiki/log.md a 988 KB aveva tenuto la coda due ore
    expect(isDerivedPage("wiki/log")).toBe(true)
    expect(isDerivedPage("concepts/index")).toBe(true)
  })

  it("non tocca le pagine vere che iniziano allo stesso modo", () => {
    expect(isDerivedPage("indexing-strategie")).toBe(false)
    expect(isDerivedPage("logica-simbolica")).toBe(false)
    expect(isDerivedPage("concepts/metamedicina")).toBe(false)
  })

  it("regge l'estensione, perché i chiamanti non concordano", () => {
    expect(isDerivedPage("log.md")).toBe(true)
    expect(isDerivedPage("wiki/overview.md")).toBe(true)
  })
})
