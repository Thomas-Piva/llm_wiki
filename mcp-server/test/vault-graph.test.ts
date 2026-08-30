/**
 * Due guasti silenziosi da tenere sotto tiro:
 *  - un arco dichiarato rotto che rotto non è (o viceversa): l'agente crea una
 *    pagina che esiste già, o non ne crea una che serve;
 *  - una creazione che **sovrascrive**: sul vault della cliente è la cosa che
 *    abbiamo promesso non succeda mai (D5).
 */
import assert from "node:assert/strict"
import { test } from "node:test"
import { promises as fs } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { buildGraph, createMissingPage, kebab, nuovoId, parseWikilinks } from "../src/vault-graph.js"

async function conVault(fn: (vault: string) => Promise<void>): Promise<void> {
  const vault = await mkdtemp(join(tmpdir(), "vaultgraph-"))
  try {
    await fn(vault)
  } finally {
    await rm(vault, { recursive: true, force: true })
  }
}

async function nota(vault: string, rel: string, body: string) {
  const p = join(vault, rel)
  await fs.mkdir(join(p, ".."), { recursive: true })
  await fs.writeFile(p, body)
}

test("i wikilink: bersaglio, etichetta, ancora, incorporati", () => {
  assert.deepEqual(parseWikilinks("[[a]] e [[b|Bi]] e [[c#sezione]] e ![[d]]"), ["a", "b", "c", "d"])
})

test("un [[esempio]] dentro un blocco di codice è documentazione, non un arco", () => {
  const md = "vero [[reale]]\n\n```\nfinto [[esempio]]\n```\n\ne `[[inline]]`"
  assert.deepEqual(parseWikilinks(md), ["reale"])
})

test("un testo senza collegamenti torna vuoto invece di rompersi", () => {
  assert.deepEqual(parseWikilinks("solo prosa [ e ] sparsi"), [])
})

test("il grafo dà il percorso vero di ogni pagina — è ciò che toglie l'indovinare", async () => {
  await conVault(async (vault) => {
    await nota(vault, "concepts/uno.md", "vedi [[due]]")
    await nota(vault, "entities/due.md", "fine")
    const g = await buildGraph(vault)
    assert.equal(g.nodes.find((n) => n.id === "due")?.path, join("entities", "due.md"))
    assert.deepEqual(g.edges, [{ source: "uno", target: "due" }])
  })
})

test("i collegamenti rotti restano separati dagli archi buoni", async () => {
  await conVault(async (vault) => {
    await nota(vault, "concepts/uno.md", "[[due]] e [[fantasma]]")
    await nota(vault, "concepts/due.md", "fine")
    const g = await buildGraph(vault)
    assert.equal(g.edges.length, 1)
    assert.deepEqual(g.brokenLinks, [{ from: "uno", target: "fantasma" }])
  })
})

test("anche il collegamento scritto col percorso viene risolto", async () => {
  // misurate 55 occorrenze in una sola passata: dichiararle rotte sarebbe falso
  await conVault(async (vault) => {
    await nota(vault, "concepts/uno.md", "[[entities/due]]")
    await nota(vault, "entities/due.md", "fine")
    const g = await buildGraph(vault)
    assert.deepEqual(g.brokenLinks, [])
    assert.deepEqual(g.edges, [{ source: "uno", target: "due" }])
  })
})

test("le orfane si vedono, e l'autocitazione non conta", async () => {
  await conVault(async (vault) => {
    await nota(vault, "concepts/uno.md", "[[due]] e [[uno]]")
    await nota(vault, "concepts/due.md", "fine")
    await nota(vault, "concepts/sola.md", "nessuno mi cita")
    const g = await buildGraph(vault)
    assert.deepEqual(g.orphans.sort(), ["sola", "uno"])
    assert.deepEqual(g.edges, [{ source: "uno", target: "due" }])
  })
})

test("restringere a una cartella non fa risultare rotti i link che escono", async () => {
  // misurato sul vault della cliente: chiedendo solo `entities/` uscivano
  // **692 collegamenti rotti** che puntavano a pagine vere in `concepts/`.
  // Un numero così manda l'agente a creare pagine che esistono già.
  await conVault(async (vault) => {
    await nota(vault, "entities/persona.md", "vedi [[metamedicina]]")
    await nota(vault, "concepts/metamedicina.md", "fine")
    const g = await buildGraph(vault, "entities")
    assert.deepEqual(g.brokenLinks, [])
    assert.deepEqual(g.edges, [{ source: "persona", target: "metamedicina" }])
    assert.deepEqual(g.nodes.map((n) => n.id), ["persona"]) // mostra solo la cartella chiesta
  })
})

test("un vault vuoto non fa esplodere il grafo", async () => {
  await conVault(async (vault) => {
    const g = await buildGraph(vault)
    assert.deepEqual(g.nodes, [])
    assert.deepEqual(g.orphans, [])
  })
})

test("la pagina creata porta id, aliases e visibility", async () => {
  await conVault(async (vault) => {
    const r = await createMissingPage(vault, {
      title: "Metamedicina",
      related: ["uno"],
      aliases: ["meta-medicina"],
      today: "2026-08-30",
    })
    assert.equal(r.created, true)
    assert.equal(r.path, "concepts/metamedicina.md")
    const testo = await fs.readFile(join(vault, r.path), "utf8")
    assert.ok(testo.includes(`id: ${r.id}`))
    assert.ok(testo.includes("aliases: [meta-medicina]"))
    assert.ok(testo.includes("visibility: all"))
    assert.ok(testo.includes("related: [[uno]]"))
    assert.ok(testo.includes("created: 2026-08-30"))
  })
})

test("⛔ non sovrascrive MAI una pagina che esiste", async () => {
  await conVault(async (vault) => {
    await nota(vault, "concepts/metamedicina.md", "CONTENUTO ORIGINALE")
    const r = await createMissingPage(vault, { title: "Metamedicina" })
    assert.equal(r.created, false)
    assert.equal(
      await fs.readFile(join(vault, "concepts/metamedicina.md"), "utf8"),
      "CONTENUTO ORIGINALE",
    )
  })
})

test("⛔ e nemmeno se la pagina sta in un'ALTRA cartella", async () => {
  // `schema.md` vieta due file con lo stesso nome: un nome preso è preso ovunque
  await conVault(async (vault) => {
    await nota(vault, "entities/metamedicina.md", "ORIGINALE ALTROVE")
    const r = await createMissingPage(vault, { title: "Metamedicina" })
    assert.equal(r.created, false)
    assert.equal(r.path, join("entities", "metamedicina.md"))
  })
})

test("il nome del file è kebab-case, accenti compresi", () => {
  assert.equal(kebab("Metamedicina Applicata"), "metamedicina-applicata")
  assert.equal(kebab("Perché così"), "perche-cosi")
  assert.equal(kebab("  A/B  test "), "a-b-test")
})

test("un titolo che non produce un nome valido viene rifiutato", async () => {
  await conVault(async (vault) => {
    await assert.rejects(() => createMissingPage(vault, { title: "   " }))
    await assert.rejects(() => createMissingPage(vault, { title: "!!!" }))
  })
})

test("l'id è diverso a ogni pagina: due voci non collassano in un nodo", () => {
  const ids = new Set(Array.from({ length: 50 }, () => nuovoId()))
  assert.equal(ids.size, 50)
})
