/**
 * Seconda implementazione del lettore SSE (l'altra sta in
 * `tools/headless-ingest/generate-page.ts`, pacchetto diverso), e quindi
 * seconda serie di test: due copie che parlano lo stesso protocollo devono
 * essere provate entrambe, o una delle due deriva in silenzio.
 *
 * I guasti che contano: un evento spezzato fra due pacchetti (la pagina esce
 * coi buchi), un collegamento inventato che sopravvive (l'arco sparisce senza
 * errore), un flusso interrotto che lascia il vuoto invece del pezzo scritto.
 */
import assert from "node:assert/strict"
import { test } from "node:test"
import { promises as fs } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  leggiFlusso,
  potaCollegamenti,
  potaSulFlusso,
  PROMPT_VOCE,
  scriviInStreaming,
} from "../src/page-stream.js"

const evento = (t: string) => `data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n`

async function* da(pezzi: (string | Uint8Array)[]) {
  for (const p of pezzi) yield p
}
async function raccogli(f: AsyncGenerator<string, void, unknown>): Promise<string> {
  let s = ""
  for await (const p of f) s += p
  return s
}

test("mette insieme il testo di più eventi e si ferma su [DONE]", async () => {
  assert.equal(await raccogli(leggiFlusso(da([evento("Ciao "), evento("mondo"), "data: [DONE]\n", evento("x")]))), "Ciao mondo")
})

test("⛔ un evento spezzato fra due pacchetti non si perde", async () => {
  const e = evento("intero")
  const m = Math.floor(e.length / 2)
  assert.equal(await raccogli(leggiFlusso(da([e.slice(0, m), e.slice(m)]))), "intero")
})

test("regge i byte e gli accenti", async () => {
  const enc = new TextEncoder()
  assert.equal(await raccogli(leggiFlusso(da([enc.encode(evento("però"))]))), "però")
})

test("keep-alive e righe non-JSON non sono errori", async () => {
  assert.equal(await raccogli(leggiFlusso(da([": ping\n\n", evento("a"), "data: non-json\n"]))), "a")
})

test("i collegamenti inventati cadono, il testo resta", () => {
  const ok = new Set(["trauma"])
  assert.equal(potaCollegamenti("[[trauma]] e [[fantasma]]", ok), "[[trauma]] e fantasma")
  assert.equal(potaCollegamenti("[[fantasma|la nota]]", ok), "la nota")
  // i 55 che sparivano in silenzio: scritti col percorso, non risolvibili
  assert.equal(potaCollegamenti("[[concepts/trauma]]", ok), "concepts/trauma")
})

test("⛔ un collegamento spezzato fra due pezzi viene potato lo stesso", async () => {
  const ok = new Set(["trauma"])
  const out = await raccogli(potaSulFlusso(da(["vedi [[fan", "tasma]] e [[trauma]]"]) as never, ok))
  assert.equal(out, "vedi fantasma e [[trauma]]")
})

test("il prompt elenca solo i bersagli ammessi", () => {
  const p = PROMPT_VOCE("Metamedicina", ["trauma"], [{ path: "a.md", testo: "corpo" }])
  assert.ok(p.includes("trauma"))
  assert.ok(p.includes("corpo"))
  const vuoto = PROMPT_VOCE("X", [], [{ path: "a.md", testo: "b" }])
  assert.ok(vuoto.includes("non mettere collegamenti"))
})

test("scrive mentre arriva e riferisce ogni pezzo", async () => {
  const v = await mkdtemp(join(tmpdir(), "ps-"))
  try {
    const visti: string[] = []
    const n = await scriviInStreaming(v, "concepts/x.md", "---\nid: c-1\n---", da(["# X\n", "corpo"]) as never,
      (t) => visti.push(t))
    assert.deepEqual(visti, ["# X\n", "corpo"]) // in tempo reale, non alla fine
    const testo = await fs.readFile(join(v, "concepts", "x.md"), "utf8")
    assert.ok(testo.startsWith("---\nid: c-1\n---\n\n"))
    assert.ok(testo.includes("# X\ncorpo"))
    assert.equal(n, "# X\ncorpo".length)
  } finally {
    await rm(v, { recursive: true, force: true })
  }
})

test("un flusso interrotto lascia il pezzo scritto, non il vuoto", async () => {
  const v = await mkdtemp(join(tmpdir(), "ps-"))
  try {
    async function* rotto() {
      yield "prima parte"
      throw new Error("connessione caduta")
    }
    await assert.rejects(() => scriviInStreaming(v, "concepts/y.md", "---\n---", rotto() as never))
    assert.ok((await fs.readFile(join(v, "concepts", "y.md"), "utf8")).includes("prima parte"))
  } finally {
    await rm(v, { recursive: true, force: true })
  }
})
