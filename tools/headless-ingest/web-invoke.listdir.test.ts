/**
 * `listDir` non deve attraversare i montaggi. Su un vault vero sono archivi di
 * rete da decine di migliaia di file, e camminarli a ogni apertura faceva
 * morire il server per memoria: risposta vuota, «nessuna pagina wiki».
 */
import { afterEach, describe, expect, it } from "bun:test"
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { listDir } from "./web-invoke"

let radice = ""
afterEach(async () => { if (radice) await rm(radice, { recursive: true, force: true }) })

async function vault() {
  radice = await mkdtemp(join(tmpdir(), "listdir-"))
  await mkdir(join(radice, "wiki/sources"), { recursive: true })
  await writeFile(join(radice, "wiki/sources/pagina.md"), "x")
  await mkdir(join(radice, "raw/sources/dropbox/CARTELLA/sotto"), { recursive: true })
  await writeFile(join(radice, "raw/sources/dropbox/CARTELLA/sotto/doc.pdf"), "x")
  return radice
}

const nomi = (nodi: any[]): string[] =>
  nodi.flatMap((n) => [n.name, ...(n.children ? nomi(n.children) : [])])

describe("listDir e i montaggi", () => {
  it("sullo stesso filesystem scende dappertutto", async () => {
    const v = await vault()
    const dev = (await stat(v)).dev
    const albero = await listDir(v, false, undefined, 0, dev)
    expect(nomi(albero)).toContain("pagina.md")
    expect(nomi(albero)).toContain("doc.pdf")
  })

  it("una cartella su un ALTRO filesystem compare, ma non ci si scende", async () => {
    const v = await vault()
    // Simulo il montaggio: dico a listDir che la radice sta su un altro
    // dispositivo, cosi' ogni sottocartella risulta "altrove".
    const devFinto = (await stat(v)).dev + 1
    const albero = await listDir(v, false, undefined, 0, devFinto)
    const tutti = nomi(albero)
    expect(tutti).toContain("wiki")
    expect(tutti).toContain("raw")
    expect(tutti).not.toContain("pagina.md")
    expect(tutti).not.toContain("doc.pdf")
  })

  it("senza dispositivo di riferimento si comporta come prima", async () => {
    const v = await vault()
    const albero = await listDir(v, false, undefined, 0)
    expect(nomi(albero)).toContain("doc.pdf")
  })
})
