/**
 * `wiki_graph_batch` alimenta l'albero delle pagine della UI web. Deve leggere
 * solo la testa delle pagine: leggerle intere su un vault grande faceva morire
 * il server per memoria e l'albero restava vuoto.
 */
import { afterEach, describe, expect, it, setSystemTime } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { dispatchInvoke } from "./web-invoke"

let radice = ""
afterEach(async () => { if (radice) await rm(radice, { recursive: true, force: true }) })

describe("wiki_graph_batch", () => {
  it("prende titolo, tipo e tag dalla testa e non legge il corpo", async () => {
    radice = await mkdtemp(join(tmpdir(), "grafo-"))
    await mkdir(join(radice, "wiki/sources"), { recursive: true })
    const corpo = "[[un-link]] ".repeat(200_000) // ~2,4 MB dopo la testa
    await writeFile(
      join(radice, "wiki/sources/pagina.md"),
      `---\ntitle: "Estratto conto marzo"\ntype: source\ntags: [banca, "2024"]\n---\n\n${corpo}`,
    )
    const nodi = (await dispatchInvoke("wiki_graph_batch", { projectPath: radice }, radice)) as any[]
    expect(nodi).toHaveLength(1)
    expect(nodi[0]).toMatchObject({
      id: "pagina", label: "Estratto conto marzo", type: "source", tags: ["banca", "2024"], links: [],
    })
  })
})

describe("wiki_graph_batch e la cache", () => {
  afterEach(() => setSystemTime())

  it("scaduta: risponde subito con la copia vecchia e la rifà in sottofondo", async () => {
    radice = await mkdtemp(join(tmpdir(), "grafo-swr-"))
    await mkdir(join(radice, "wiki"), { recursive: true })
    await writeFile(join(radice, "wiki/a.md"), "# A")
    const ids = (r: unknown) => (r as any[]).map((n) => n.id).sort()

    const primo = await dispatchInvoke("wiki_graph_batch", {}, radice)
    expect(ids(primo)).toEqual(["a"])
    await writeFile(join(radice, "wiki/b.md"), "# B")

    // Dentro il TTL: stessa copia, nessuna ricostruzione.
    expect(await dispatchInvoke("wiki_graph_batch", {}, radice)).toBe(primo)

    // Oltre il TTL: la risposta e' ancora quella vecchia (nessuna attesa)...
    setSystemTime(new Date(Date.now() + 16 * 60 * 1000))
    expect(await dispatchInvoke("wiki_graph_batch", {}, radice)).toBe(primo)

    // ...e poco dopo arriva quella nuova, ricostruita in sottofondo.
    let dopo: unknown = primo
    for (let i = 0; i < 50 && dopo === primo; i++) {
      await new Promise((r) => setTimeout(r, 20))
      dopo = await dispatchInvoke("wiki_graph_batch", {}, radice)
    }
    expect(ids(dopo)).toEqual(["a", "b"])
  })
})
