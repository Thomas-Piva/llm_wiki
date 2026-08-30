/**
 * Queste regole valgono per OGNI scrittura headless, quindi un errore qui non
 * rompe un caso: rompe il vault. I due guasti che costano di più:
 *  - arricchire una pagina **sovrascrivendo** un `id:` già dato → l'identità
 *    cambia sotto i piedi ai collegamenti che la citano;
 *  - un `delete_file` che passa il filtro → un `[[nome-morto]]` che smette di
 *    risolvere senza dare errore.
 */
import { describe, expect, it } from "vitest"

import {
  appendOnlyEnabled,
  causalGraphEnabled,
  causalGraphFlag,
  ensureIdentity,
  frontmatterField,
  isWikiPage,
  nuovoIdPagina,
  splitFrontmatter,
} from "./note-policy"

const idFinto = () => "c-abc123"

describe("frontmatter", () => {
  it("separa blocco e corpo", () => {
    const { fm, body } = splitFrontmatter("---\ntitle: X\n---\ncorpo\n")
    expect(fm).toBe("title: X")
    expect(body).toBe("corpo\n")
  })

  it("un file senza blocco resta tutto corpo", () => {
    expect(splitFrontmatter("# solo testo").fm).toBeNull()
  })

  it("i tre trattini dentro il corpo non aprono un blocco", () => {
    expect(splitFrontmatter("testo\n---\nfinto: si\n---\n").fm).toBeNull()
  })

  it("legge un campo, e distingue assente da vuoto", () => {
    expect(frontmatterField("title: X\naliases:", "title")).toBe("X")
    expect(frontmatterField("title: X\naliases:", "aliases")).toBe("")
    expect(frontmatterField("title: X", "id")).toBeNull()
  })
})

describe("D2/D4 — identità e visibilità", () => {
  it("aggiunge id e visibility quando mancano", () => {
    const out = ensureIdentity("---\ntitle: X\n---\ncorpo\n", { newId: idFinto })
    expect(out).toContain("id: c-abc123")
    expect(out).toContain("visibility: all")
    expect(out).toContain("title: X")
    expect(out.endsWith("corpo\n")).toBe(true)
  })

  it("⛔ non tocca un id già presente — cambiarlo romperebbe i link in entrata", () => {
    const gia = "---\nid: c-originale\ntitle: X\n---\ncorpo\n"
    expect(ensureIdentity(gia, { newId: idFinto })).toBe(gia.replace(
      "id: c-originale",
      "visibility: all\nid: c-originale",
    ))
    expect(ensureIdentity(gia, { newId: idFinto })).toContain("id: c-originale")
    expect(ensureIdentity(gia, { newId: idFinto })).not.toContain("c-abc123")
  })

  it("con entrambi i campi già scritti restituisce il file identico", () => {
    const completo = "---\nid: c-x\nvisibility: privata\ntitle: X\n---\ncorpo\n"
    expect(ensureIdentity(completo, { newId: idFinto })).toBe(completo)
  })

  it("una pagina senza frontmatter non se lo inventa", () => {
    expect(ensureIdentity("# solo testo", { newId: idFinto })).toBe("# solo testo")
  })

  it("la visibilità predefinita è configurabile", () => {
    const out = ensureIdentity("---\nid: c-x\n---\n", { newId: idFinto, defaultVisibility: "interna" })
    expect(out).toContain("visibility: interna")
  })
})

describe("D5 — quali file sono pagine del wiki", () => {
  it("riconosce una pagina, anche annidata e su Windows", () => {
    expect(isWikiPage("/opt/vault/wiki/concepts/x.md")).toBe(true)
    expect(isWikiPage("C:\\vault\\wiki\\x.md")).toBe(true)
  })

  it("non è una pagina: fuori da wiki/, non markdown, la cartella stessa", () => {
    expect(isWikiPage("/opt/vault/raw/sources/x.md")).toBe(false)
    expect(isWikiPage("/opt/vault/wiki/foto.png")).toBe(false)
    expect(isWikiPage("/opt/vault/wiki")).toBe(false)
  })

  it("una cartella che si chiama wiki dentro i grezzi conta lo stesso", () => {
    // conservativo di proposito: meglio proteggere un file in più che perderne uno
    expect(isWikiPage("/opt/vault/raw/wiki/x.md")).toBe(true)
  })

  it("append-only è acceso di default, e si spegne solo esplicitamente", () => {
    const prima = process.env.VAULT_APPEND_ONLY
    try {
      delete process.env.VAULT_APPEND_ONLY
      expect(appendOnlyEnabled()).toBe(true)
      process.env.VAULT_APPEND_ONLY = "1"
      expect(appendOnlyEnabled()).toBe(true)
      process.env.VAULT_APPEND_ONLY = "0"
      expect(appendOnlyEnabled()).toBe(false)
    } finally {
      if (prima === undefined) delete process.env.VAULT_APPEND_ONLY
      else process.env.VAULT_APPEND_ONLY = prima
    }
  })
})

describe("D3 — il grafo causale si accende dove serve", () => {
  const indici: Record<string, string> = {
    "concepts/salute": "---\ncausal_graph: true\n---\n",
    ".": "---\ncausal_graph: false\n---\n",
  }
  const leggi = async (folder: string) => indici[folder] ?? null

  it("spento se nessuno si esprime", async () => {
    expect(await causalGraphEnabled("concepts/altro/x", async () => null)).toBe(false)
  })

  it("la cartella lo accende, e la nota lo eredita", async () => {
    expect(await causalGraphEnabled("concepts/salute/x", leggi)).toBe(true)
  })

  it("la nota può smentire la cartella", async () => {
    expect(await causalGraphEnabled("concepts/salute/x", leggi, "causal_graph: false")).toBe(false)
  })

  it("si risale fino alla radice quando le cartelle tacciono", async () => {
    expect(await causalGraphEnabled("concepts/altro/dentro/x", leggi)).toBe(false)
  })

  it("legge le forme vere di un sì", () => {
    for (const v of ["true", "yes", "on", "1", "TRUE"]) {
      expect(causalGraphFlag(`causal_graph: ${v}`)).toBe(true)
    }
    expect(causalGraphFlag("causal_graph: false")).toBe(false)
    expect(causalGraphFlag("altro: true")).toBeNull()
  })
})

describe("l'id", () => {
  it("è diverso a ogni pagina", () => {
    expect(new Set(Array.from({ length: 100 }, nuovoIdPagina)).size).toBe(100)
  })
})
