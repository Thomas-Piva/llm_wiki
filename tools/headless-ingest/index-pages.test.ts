/**
 * Il guasto silenzioso di questo modulo è la **chiave**: se il `page_id` non è
 * quello che la ricerca sa risolvere, l'indice si popola lo stesso e le
 * risposte spariscono senza un errore. Da qui i casi sotto.
 */
import { promises as fs } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { embeddingConfigFor, pageIdFor, titleFor } from "./index-pages"

let vault: string

beforeEach(async () => {
  vault = await mkdtemp(join(tmpdir(), "indexpages-"))
})
afterEach(async () => {
  await rm(vault, { recursive: true, force: true })
})

describe("la chiave della pagina", () => {
  it("è il percorso sotto wiki/, non il basename", () => {
    // 104 file su 10.942 nel vault della cliente condividono il basename:
    // con la chiave corta si sovrascriverebbero a vicenda
    expect(pageIdFor("wiki/sources/foo.md")).toBe("sources/foo")
    expect(pageIdFor("wiki/entities/dentro/tre.md")).toBe("entities/dentro/tre")
  })

  it("tiene distinti due file con lo stesso nome in cartelle diverse", () => {
    expect(pageIdFor("wiki/sources/nota.md")).not.toBe(pageIdFor("wiki/concepts/nota.md"))
  })

  it("accetta i separatori di Windows", () => {
    expect(pageIdFor("wiki\\sources\\foo.md")).toBe("sources/foo")
  })

  it("rifiuta ciò che non è una pagina del wiki", () => {
    expect(pageIdFor("raw/sources/foo.md")).toBeNull() // fuori da wiki/
    expect(pageIdFor("wiki/foto.png")).toBeNull() // non markdown
    expect(pageIdFor("wiki")).toBeNull() // la cartella stessa
    expect(pageIdFor("")).toBeNull()
  })

  it("una pagina alla radice di wiki/ resta senza barra", () => {
    expect(pageIdFor("wiki/uno.md")).toBe("uno")
  })
})

describe("il titolo", () => {
  it("viene dal frontmatter quando c'è", () => {
    expect(titleFor('---\ntitle: "Metamedicina"\nstatus: ok\n---\n\n# Altro\n', "x")).toBe(
      "Metamedicina",
    )
  })

  it("altrimenti dal primo titolo di primo livello", () => {
    expect(titleFor("# Teoria polivagale\n\ncorpo", "x")).toBe("Teoria polivagale")
  })

  it("in mancanza di tutto, l'ultimo pezzo dell'id — non l'id intero", () => {
    expect(titleFor("solo corpo", "sources/nota-lunga")).toBe("nota-lunga")
  })
})

describe("la configurazione degli embedding", () => {
  async function scriviStato(obj: unknown) {
    await fs.mkdir(join(vault, ".llm-wiki"), { recursive: true })
    await fs.writeFile(join(vault, ".llm-wiki", "app-state.json"), JSON.stringify(obj))
  }

  it("passa solo se è davvero utilizzabile", async () => {
    await scriviStato({ embeddingConfig: { enabled: true, endpoint: "http://x", model: "m" } })
    expect(await embeddingConfigFor(vault)).not.toBeNull()
  })

  it("spenta, senza endpoint o senza modello vale come assente", async () => {
    for (const cfg of [
      { enabled: false, endpoint: "http://x", model: "m" },
      { enabled: true, endpoint: "", model: "m" },
      { enabled: true, endpoint: "http://x", model: "" },
    ]) {
      await scriviStato({ embeddingConfig: cfg })
      expect(await embeddingConfigFor(vault)).toBeNull()
    }
  })

  it("senza file, o con un file corrotto, non esplode", async () => {
    expect(await embeddingConfigFor(vault)).toBeNull()
    await scriviStato("{ non è json" as never)
    await fs.writeFile(join(vault, ".llm-wiki", "app-state.json"), "{ non è json")
    expect(await embeddingConfigFor(vault)).toBeNull()
  })
})
