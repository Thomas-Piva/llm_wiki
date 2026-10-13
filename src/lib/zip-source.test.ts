import JSZip from "jszip"
import { beforeEach, describe, expect, it, vi } from "vitest"

const fsMocks = vi.hoisted(() => ({
  createDirectory: vi.fn<() => Promise<void>>(),
  fileExists: vi.fn<() => Promise<boolean>>(),
  readFileAsBase64: vi.fn<() => Promise<{ base64: string; mimeType: string }>>(),
  writeFileBase64: vi.fn<(path: string, base64: string) => Promise<void>>(),
}))

vi.mock("@/commands/fs", () => ({
  createDirectory: fsMocks.createDirectory,
  fileExists: fsMocks.fileExists,
  readFileAsBase64: fsMocks.readFileAsBase64,
  writeFileBase64: fsMocks.writeFileBase64,
}))

import { expandZipSource, extractionDirFor, isZipSource, safeEntryPath } from "./zip-source"

async function zipOf(files: Record<string, string>): Promise<string> {
  const zip = new JSZip()
  for (const [p, c] of Object.entries(files)) zip.file(p, c)
  return finalizza(zip)
}

/**
 * Un archivio con un nome di voce MALEVOLO davvero.
 *
 * `zip.file("../../fuori.txt", ...)` non serve a niente: JSZip normalizza il
 * nome mentre lo aggiunge, quindi l'archivio che ne esce e' innocuo e il test
 * passerebbe senza aver mai messo alla prova la guardia. Il primo giro me
 * l'ha detto in faccia — la voce arrivava come `fuori.txt`. Qui il nome si
 * forza nella mappa interna, che e' quello che fa un archivio ostile vero.
 */
async function zipConNomeGrezzo(nome: string, contenuto: string, altri: Record<string, string>): Promise<string> {
  const zip = new JSZip()
  for (const [p, c] of Object.entries(altri)) zip.file(p, c)
  zip.file("segnaposto", contenuto)
  const voce = zip.files["segnaposto"]
  voce.name = nome
  zip.files[nome] = voce
  delete zip.files["segnaposto"]
  return finalizza(zip)
}

async function finalizza(zip: JSZip): Promise<string> {
  const bytes = await zip.generateAsync({ type: "uint8array" })
  let s = ""
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}

beforeEach(() => {
  vi.clearAllMocks()
  fsMocks.createDirectory.mockResolvedValue(undefined)
  fsMocks.fileExists.mockResolvedValue(false)
  fsMocks.writeFileBase64.mockResolvedValue(undefined)
})

describe("riconoscimento", () => {
  it("vede gli archivi e non confonde gli altri formati", () => {
    expect(isZipSource("/raw/sources/pratica.zip")).toBe(true)
    expect(isZipSource("/raw/sources/PRATICA.ZIP")).toBe(true)
    expect(isZipSource("/raw/sources/perizia.pdf")).toBe(false)
    expect(isZipSource("/raw/sources/zip")).toBe(false)
  })

  it("estrae accanto all'archivio, senza sovrascriverlo", () => {
    expect(extractionDirFor("/raw/sources/pratica.zip")).toBe("/raw/sources/pratica-contenuto")
  })
})

describe("zip-slip — la parte che non deve cedere", () => {
  it("rifiuta ogni nome che esce dalla cartella", () => {
    for (const cattivo of [
      "../fuori.txt",
      "../../.ssh/authorized_keys",
      "a/../../b.txt",
      "C:/Windows/system.ini",
      "sotto\\..\\..\\fuori.txt",
    ]) {
      expect(safeEntryPath("/dest", cattivo), cattivo).toBeNull()
    }
  })

  it("accetta i nomi normali e li normalizza", () => {
    expect(safeEntryPath("/dest", "doc.pdf")).toBe("/dest/doc.pdf")
    expect(safeEntryPath("/dest", "./sotto//doc.pdf")).toBe("/dest/sotto/doc.pdf")
    expect(safeEntryPath("/dest/", "a/b/c.txt")).toBe("/dest/a/b/c.txt")
  })

  // Un percorso assoluto dentro un archivio non e' un'evasione: si ri-radica
  // nella cartella di destinazione, come fa `unzip` da sempre. Rifiutarlo
  // farebbe sparire in silenzio un file legittimo che si chiama cosi'.
  it("ri-radica i percorsi assoluti invece di buttarli via", () => {
    expect(safeEntryPath("/dest", "/etc/passwd")).toBe("/dest/etc/passwd")
    expect(safeEntryPath("/dest", "/home/utente/perizia.pdf")).toBe("/dest/home/utente/perizia.pdf")
  })

  // JSZip normalizza i nomi delle voci sia in scrittura sia in lettura, quindi
  // per questa strada un `../../` non arriva mai a `safeEntryPath`: la guardia
  // e' una SECONDA linea, provata da sola qui sopra. Quello che questo test
  // deve garantire e' l'invariante che conta davvero, e che vale comunque
  // cambiasse libreria: niente viene scritto fuori dalla cartella di sbocco.
  it("qualunque cosa contenga l'archivio, non scrive mai fuori dalla sua cartella", async () => {
    fsMocks.readFileAsBase64.mockResolvedValue({
      base64: await zipConNomeGrezzo("../../fuori.txt", "cattivo", { "dentro.txt": "buono" }),
      mimeType: "application/zip",
    })

    const r = await expandZipSource("/raw/sources/male.zip")

    expect(fsMocks.writeFileBase64).toHaveBeenCalled()
    for (const [path] of fsMocks.writeFileBase64.mock.calls) {
      expect(path.startsWith("/raw/sources/male-contenuto/"), path).toBe(true)
    }
    for (const f of r.files) {
      expect(f.startsWith("/raw/sources/male-contenuto/"), f).toBe(true)
    }
    for (const [dir] of fsMocks.createDirectory.mock.calls as unknown as string[][]) {
      expect(dir.startsWith("/raw/sources/male-contenuto"), dir).toBe(true)
    }
  })
})

describe("apertura", () => {
  it("restituisce i file veri e salta il rumore del sistema operativo", async () => {
    fsMocks.readFileAsBase64.mockResolvedValue({
      base64: await zipOf({
        "perizia.pdf": "%PDF-1.4 finta",
        "allegati/foto.jpg": "jpegfinto",
        "__MACOSX/._perizia.pdf": "spazzatura",
        ".DS_Store": "spazzatura",
      }),
      mimeType: "application/zip",
    })

    const r = await expandZipSource("/raw/sources/pratica.zip")

    expect(r.files.sort()).toEqual([
      "/raw/sources/pratica-contenuto/allegati/foto.jpg",
      "/raw/sources/pratica-contenuto/perizia.pdf",
    ])
  })

  it("non riscrive ciò che c'è già, ma lo restituisce lo stesso", async () => {
    fsMocks.fileExists.mockResolvedValue(true)
    fsMocks.readFileAsBase64.mockResolvedValue({
      base64: await zipOf({ "doc.txt": "contenuto" }),
      mimeType: "application/zip",
    })

    const r = await expandZipSource("/raw/sources/pratica.zip")

    expect(r.files).toEqual(["/raw/sources/pratica-contenuto/doc.txt"])
    expect(fsMocks.writeFileBase64).not.toHaveBeenCalled()
  })

  it("si ferma prima di scendere all'infinito negli archivi annidati", async () => {
    const r = await expandZipSource("/raw/sources/troppo.zip", 2)
    expect(r.files).toEqual([])
    expect(r.skipped.join(" ")).toMatch(/annidati/)
    expect(fsMocks.readFileAsBase64).not.toHaveBeenCalled()
  })
})
