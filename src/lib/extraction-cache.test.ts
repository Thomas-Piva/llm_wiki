import { describe, expect, it, afterEach } from "vitest"
import { extractionCacheDir, extractionCachePath } from "./extraction-cache"

const PROJ = "/opt/llm-wiki/FENICE"
const SRC = `${PROJ}/raw/sources/dropbox/1_BANCARIO/estratti/marzo.docx`

function conRedirect<T>(fn: () => T): T {
  process.env.LLMWIKI_CACHE_IN_PROJECT = "1"
  try {
    return fn()
  } finally {
    delete process.env.LLMWIKI_CACHE_IN_PROJECT
  }
}

afterEach(() => {
  delete process.env.LLMWIKI_CACHE_IN_PROJECT
})

describe("extraction-cache", () => {
  it("senza la variabile tiene la cache accanto al file, come sempre", () => {
    expect(extractionCachePath(PROJ, SRC)).toBe(
      `${PROJ}/raw/sources/dropbox/1_BANCARIO/estratti/.cache/marzo.docx.txt`,
    )
  })

  it("con la variabile la rispecchia dentro il progetto", () => {
    conRedirect(() => {
      expect(extractionCachePath(PROJ, SRC)).toBe(
        `${PROJ}/.llm-wiki/cache-estrazione/raw/sources/dropbox/1_BANCARIO/estratti/.cache/marzo.docx.txt`,
      )
    })
  })

  // Il punto di tutto l'esercizio: la destinazione NON deve stare sotto il
  // montaggio in sola lettura del Dropbox della cliente.
  it("lo specchio non ricade mai dentro raw/sources", () => {
    conRedirect(() => {
      const p = extractionCachePath(PROJ, SRC)
      expect(p.startsWith(`${PROJ}/${".llm-wiki/cache-estrazione"}/`)).toBe(true)
      expect(p.startsWith(`${PROJ}/raw/sources/`)).toBe(false)
    })
  })

  it("resta dentro il progetto, che le guardie dei path delle shim pretendono", () => {
    conRedirect(() => {
      expect(extractionCacheDir(PROJ, SRC).startsWith(`${PROJ}/`)).toBe(true)
    })
  })

  it("una fonte fuori dal progetto torna alla cache accanto al file", () => {
    conRedirect(() => {
      expect(extractionCachePath(PROJ, "/tmp/altrove/x.pdf")).toBe("/tmp/altrove/.cache/x.pdf.txt")
    })
  })

  it("tollera la barra finale sul percorso del progetto", () => {
    conRedirect(() => {
      expect(extractionCachePath(`${PROJ}/`, SRC)).toBe(extractionCachePath(PROJ, SRC))
    })
  })

  it("una fonte nella radice del progetto non produce doppie barre", () => {
    conRedirect(() => {
      expect(extractionCachePath(PROJ, `${PROJ}/appunti.docx`)).toBe(
        `${PROJ}/.llm-wiki/cache-estrazione/.cache/appunti.docx.txt`,
      )
    })
  })

  it("senza percorso del progetto non inventa uno specchio", () => {
    conRedirect(() => {
      expect(extractionCachePath("", SRC)).toBe(
        `${PROJ}/raw/sources/dropbox/1_BANCARIO/estratti/.cache/marzo.docx.txt`,
      )
    })
  })
})
