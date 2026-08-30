/**
 * La creazione automatica dell'indice, su una tabella LanceDB vera.
 *
 * Le due cose che, sbagliate, non danno errore:
 *  - **ricostruire l'indice a ogni passata**: `vectorCompact` gira a fine di
 *    ogni giro del watcher, quindi un controllo mancato trasformerebbe un
 *    lavoro da fare una volta in uno da fare ogni volta — minuti di CPU piena
 *    su un box a due core, per niente;
 *  - **costruirlo su una tabella piccola**: l'IVF addestra i centroidi da un
 *    campione, quindi sotto la soglia produce un indice peggiore della
 *    scansione esatta che sostituisce. In entrambi i casi la ricerca continua
 *    a rispondere, e nulla segnala il problema.
 */
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as lancedb from "@lancedb/lancedb"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  ensureVectorIndex,
  SOGLIA_INDICE_ANN_DEFAULT,
  sogliaIndiceAnn,
  vectorUpsertChunks,
  type IncomingChunk,
} from "./vector-store"

let vault: string

beforeEach(async () => {
  vault = await mkdtemp(join(tmpdir(), "ann-"))
})
afterEach(async () => {
  await rm(vault, { recursive: true, force: true })
})

/** Vettori sparsi ma non identici: l'IVF su dati tutti uguali non addestra. */
function pezzi(da: number, quanti: number): IncomingChunk[] {
  return Array.from({ length: quanti }, (_, k) => {
    const n = da + k
    return {
      chunk_index: k,
      chunk_text: `pezzo ${n}`,
      heading_path: "",
      embedding: Array.from({ length: 8 }, (_, i) => Math.sin(n * (i + 1)) / 2 + 0.5),
    }
  })
}

async function indiciDi(vault: string): Promise<string[]> {
  const db = await lancedb.connect(join(vault, ".llm-wiki", "lancedb"))
  const tbl = await db.openTable("wiki_chunks_v2")
  return (await tbl.listIndices()).flatMap((i) => i.columns)
}

describe("ensureVectorIndex", () => {
  it("senza tabella non inventa nulla", async () => {
    expect(await ensureVectorIndex(vault)).toBe("nessuna tabella")
  })

  it("sotto la soglia lascia la scansione esatta", async () => {
    await vectorUpsertChunks(vault, "p1", pezzi(0, 40))
    expect(await ensureVectorIndex(vault)).toBe("troppo piccola")
    expect(await indiciDi(vault)).not.toContain("vector")
  })

  it("⛔ la seconda chiamata non ricostruisce: dice che c'era già", async () => {
    // Il caso che conta davvero, perché `vectorCompact` chiama questa funzione
    // a ogni fine passata. La soglia si abbassa qui invece di generare
    // cinquantamila righe: quello che si sta provando è il ramo di uscita
    // anticipata, non la costruzione.
    process.env.LANCEDB_ANN_MIN_ROWS = "0"
    try {
      await vectorUpsertChunks(vault, "p1", pezzi(0, 300))
      expect(await ensureVectorIndex(vault)).toBe("creato")
      expect(await indiciDi(vault)).toContain("vector")
      expect(await ensureVectorIndex(vault)).toBe("c'era già")
    } finally {
      delete process.env.LANCEDB_ANN_MIN_ROWS
    }
  }, 120_000)

  it("la soglia di fabbrica non è bassa, e l'ambiente può spostarla", () => {
    // Sotto le poche decine di migliaia di righe la scansione esatta costa
    // meno dell'indice che la sostituirebbe: 248.083 pezzi in 94,9 ms misurati,
    // quindi ~20 ms a cinquantamila.
    expect(SOGLIA_INDICE_ANN_DEFAULT).toBeGreaterThanOrEqual(10_000)
    expect(sogliaIndiceAnn()).toBe(SOGLIA_INDICE_ANN_DEFAULT)

    process.env.LANCEDB_ANN_MIN_ROWS = "1234"
    expect(sogliaIndiceAnn()).toBe(1234)
    // un valore assurdo non deve azzerare la soglia in silenzio
    process.env.LANCEDB_ANN_MIN_ROWS = "non-un-numero"
    expect(sogliaIndiceAnn()).toBe(SOGLIA_INDICE_ANN_DEFAULT)
    delete process.env.LANCEDB_ANN_MIN_ROWS
  })
})
