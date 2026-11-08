/**
 * Una riscansione completa non deve rimettere in coda cio' che e' gia' una
 * pagina, ne' cio' che e' stato messo da parte di proposito.
 *
 * Il 17/10/2026, sul vault della cliente, un clic su «Refresh» ha rimesso in
 * coda 40.456 documenti di cui il 93% era gia' ingerito: il controllo sui
 * doppioni guardava solo `file-snapshot.json`, fermo ad agosto.
 */
import { afterEach, describe, expect, it } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { enqueueSources } from "./sources-scan"
import { readQueue } from "./queue-store"

let radice = ""
afterEach(async () => {
  if (radice) await rm(radice, { recursive: true, force: true })
})

async function vault(file: string[]): Promise<string> {
  radice = await mkdtemp(join(tmpdir(), "scan-registri-"))
  await mkdir(join(radice, ".llm-wiki"), { recursive: true })
  for (const f of file) {
    const p = join(radice, "raw/sources", f)
    await mkdir(join(p, ".."), { recursive: true })
    await writeFile(p, "contenuto")
  }
  return radice
}

describe("enqueueSources e i registri", () => {
  it("salta cio' che il registro delle pagine dice gia' ingerito", async () => {
    const v = await vault(["dropbox/A/fatto.pdf", "dropbox/A/nuovo.pdf"])
    await writeFile(join(v, ".llm-wiki/sorgenti-ingerite.txt"), "dropbox/A/fatto.pdf\n")
    expect(await enqueueSources(v)).toBe(1)
    const q = await readQueue(v)
    expect(q.map((t) => t.sourcePath)).toEqual(["raw/sources/dropbox/A/nuovo.pdf"])
  })

  it("non annulla le decisioni: cio' che e' messo da parte resta fuori", async () => {
    const v = await vault(["dropbox/A/scansione.pdf", "dropbox/A/foto.png", "dropbox/A/nuovo.docx"])
    await writeFile(join(v, ".llm-wiki/dropbox-ignorati.txt"), "dropbox/A/scansione.pdf\ndropbox/A/foto.png\n")
    expect(await enqueueSources(v)).toBe(1)
    const q = await readQueue(v)
    expect(q.map((t) => t.sourcePath)).toEqual(["raw/sources/dropbox/A/nuovo.docx"])
  })

  it("accetta anche righe gia' col prefisso raw/sources", async () => {
    const v = await vault(["dropbox/A/x.pdf"])
    await writeFile(join(v, ".llm-wiki/sorgenti-ingerite.txt"), "raw/sources/dropbox/A/x.pdf\n")
    expect(await enqueueSources(v)).toBe(0)
  })

  it("senza i registri si comporta come prima: tutto cio' che e' nuovo entra", async () => {
    const v = await vault(["a.pdf", "b.pdf"])
    expect(await enqueueSources(v)).toBe(2)
  })

  it("una seconda scansione subito dopo non aggiunge niente", async () => {
    const v = await vault(["a.pdf"])
    expect(await enqueueSources(v)).toBe(1)
    expect(await enqueueSources(v)).toBe(0)
  })
})
