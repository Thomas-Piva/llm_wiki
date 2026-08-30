/**
 * Tre guasti silenziosi, e sono tutti qui:
 *  - il flusso SSE spezzato a metà evento → la pagina esce con dei buchi e
 *    nessuno se ne accorge, perché il JSON troncato finisce in un `catch`;
 *  - un `[[collegamento]]` inventato → un arco che sparisce senza errore, cioè
 *    il difetto che questa strada doveva chiudere;
 *  - una voce scritta senza fonti → sembra conoscenza e non lo è.
 */
import { promises as fs } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  generaPagina,
  leggiFlusso,
  potaCollegamenti,
  scriviInStreaming,
  type FlussoTesto,
} from "./generate-page"

let vault: string
beforeEach(async () => {
  vault = await mkdtemp(join(tmpdir(), "genpag-"))
})
afterEach(async () => {
  await rm(vault, { recursive: true, force: true })
})

async function* daPezzi(pezzi: string[]) {
  for (const p of pezzi) yield p
}
async function raccogli(f: FlussoTesto): Promise<string> {
  let s = ""
  for await (const p of f) s += p
  return s
}
const evento = (t: string) => `data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n`

describe("lettura del flusso", () => {
  it("mette insieme il testo di più eventi", async () => {
    const out = await raccogli(leggiFlusso(daPezzi([evento("Ciao "), evento("mondo"), "data: [DONE]\n"])))
    expect(out).toBe("Ciao mondo")
  })

  it("⛔ un evento spezzato fra due pacchetti non si perde", async () => {
    // il caso vero: il confine dei pacchetti non è il confine delle righe
    const e = evento("intero")
    const meta = Math.floor(e.length / 2)
    const out = await raccogli(leggiFlusso(daPezzi([e.slice(0, meta), e.slice(meta), "data: [DONE]\n"])))
    expect(out).toBe("intero")
  })

  it("regge i byte, non solo le stringhe", async () => {
    const enc = new TextEncoder()
    const out = await raccogli(leggiFlusso(daPezzi([enc.encode(evento("però")) as never])))
    expect(out).toBe("però")
  })

  it("si ferma su [DONE] e ignora ciò che segue", async () => {
    const out = await raccogli(leggiFlusso(daPezzi([evento("a"), "data: [DONE]\n", evento("b")])))
    expect(out).toBe("a")
  })

  it("commenti e righe vuote non sono errori", async () => {
    const out = await raccogli(leggiFlusso(daPezzi([": keep-alive\n\n", evento("a"), "data: non-json\n"])))
    expect(out).toBe("a")
  })

  it("un delta senza contenuto non produce niente", async () => {
    const out = await raccogli(leggiFlusso(daPezzi(['data: {"choices":[{"delta":{}}]}\n', evento("x")])))
    expect(out).toBe("x")
  })
})

describe("la voce si genera solo se le fonti la sostengono", () => {
  it("senza fonti non chiama il modello e lo dichiara", async () => {
    let chiamate = 0
    const out = await raccogli(
      generaPagina("Metamedicina", [], [], () => {
        chiamate++
        return daPezzi(["prosa inventata"])
      }),
    )
    expect(chiamate).toBe(0)
    expect(out).toContain("Nessuna fonte")
    expect(out).not.toContain("prosa inventata")
  })

  it("i vicini ammessi finiscono nel prompt, e le fonti pure", async () => {
    let visto = ""
    await raccogli(
      generaPagina(
        "Metamedicina",
        [{ page_id: "fonte-a", testo: "il corpo parla" }],
        ["trauma", "dissociazione"],
        (p) => {
          visto = p
          return daPezzi(["ok"])
        },
      ),
    )
    expect(visto).toContain("trauma, dissociazione")
    expect(visto).toContain("il corpo parla")
    expect(visto).toContain("# Metamedicina")
  })

  it("senza vicini dice esplicitamente di non mettere collegamenti", async () => {
    let visto = ""
    await raccogli(
      generaPagina("X", [{ page_id: "a", testo: "b" }], [], (p) => {
        visto = p
        return daPezzi([""])
      }),
    )
    expect(visto).toContain("non mettere collegamenti")
  })
})

describe("⛔ potatura dei collegamenti inventati", () => {
  const ammessi = new Set(["trauma", "dissociazione"])

  it("tiene quelli veri e sfronda quelli inventati", () => {
    const r = potaCollegamenti("Il [[trauma]] porta a [[fantasma]] e [[dissociazione]].", ammessi)
    expect(r).toBe("Il [[trauma]] porta a fantasma e [[dissociazione]].")
  })

  it("di un collegamento inventato con etichetta resta l'etichetta", () => {
    expect(potaCollegamenti("vedi [[fantasma|la nota]]", ammessi)).toBe("vedi la nota")
  })

  it("il collegamento scritto col percorso NON passa", () => {
    // sono i 55 che sparivano in silenzio: il motore risolve per nome
    expect(potaCollegamenti("vedi [[concepts/trauma]]", ammessi)).toBe("vedi concepts/trauma")
  })

  it("l'ancora non fa perdere il bersaglio buono", () => {
    expect(potaCollegamenti("[[trauma#sintomi]]", ammessi)).toBe("[[trauma#sintomi]]")
  })

  it("un testo senza collegamenti resta identico", () => {
    expect(potaCollegamenti("prosa semplice", ammessi)).toBe("prosa semplice")
  })
})

describe("scrittura in streaming", () => {
  it("il file cresce e finisce col frontmatter davanti", async () => {
    const n = await scriviInStreaming(vault, "concepts/x.md", "---\nid: c-1\n---", daPezzi(["# X\n", "corpo"]))
    const testo = await fs.readFile(join(vault, "concepts", "x.md"), "utf8")
    expect(testo.startsWith("---\nid: c-1\n---\n\n")).toBe(true)
    expect(testo).toContain("# X\ncorpo")
    expect(n).toBe("# X\ncorpo".length)
  })

  it("un flusso che si interrompe lascia il pezzo scritto, non il vuoto", async () => {
    async function* rotto() {
      yield "# X\n\nprima parte"
      throw new Error("connessione caduta")
    }
    await expect(
      scriviInStreaming(vault, "concepts/y.md", "---\nid: c-2\n---", rotto() as FlussoTesto),
    ).rejects.toThrow("connessione caduta")
    const testo = await fs.readFile(join(vault, "concepts", "y.md"), "utf8")
    expect(testo).toContain("prima parte")
  })

  it("crea le cartelle che mancano", async () => {
    await scriviInStreaming(vault, "concepts/a/b/z.md", "---\n---", daPezzi(["ok"]))
    expect(await fs.readFile(join(vault, "concepts", "a", "b", "z.md"), "utf8")).toContain("ok")
  })
})
