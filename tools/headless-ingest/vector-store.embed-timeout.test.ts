/**
 * La `fetch` dell'embedding deve avere un tetto e ritentare una volta sola
 * sul timeout, non in eterno, e NON ritentare gli errori HTTP veri.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test"
import { embedTexts } from "./vector-store"

const vera = globalThis.fetch
let chiamate = 0

afterEach(() => { globalThis.fetch = vera; chiamate = 0 })

describe("embedTexts", () => {
  it("passa un signal alla fetch (senza, una richiesta appesa blocca tutto)", async () => {
    let visto: RequestInit | undefined
    globalThis.fetch = (async (_u: any, o: any) => {
      visto = o
      return new Response(JSON.stringify({ data: [{ embedding: [1, 2, 3] }] }), { status: 200 })
    }) as any
    const v = await embedTexts(["ciao"], { endpoint: "http://x/v1/embeddings", model: "m" })
    expect(v).toEqual([[1, 2, 3]])
    expect(visto?.signal).toBeDefined()
  })

  it("sul timeout riprova UNA volta, poi si arrende", async () => {
    globalThis.fetch = (async () => {
      chiamate++
      const e = new Error("timed out"); e.name = "TimeoutError"; throw e
    }) as any
    await expect(embedTexts(["ciao"], { endpoint: "http://x", model: "m" })).rejects.toThrow(/2 tentativi/)
    expect(chiamate).toBe(2)
  })

  it("un timeout seguito da una risposta buona riesce", async () => {
    globalThis.fetch = (async () => {
      chiamate++
      if (chiamate === 1) { const e = new Error("timed out"); e.name = "TimeoutError"; throw e }
      return new Response(JSON.stringify({ data: [{ embedding: [7] }] }), { status: 200 })
    }) as any
    expect(await embedTexts(["ciao"], { endpoint: "http://x", model: "m" })).toEqual([[7]])
    expect(chiamate).toBe(2)
  })

  it("NON ritenta un 402: ripeterlo brucia quota", async () => {
    globalThis.fetch = (async () => {
      chiamate++
      return new Response("Insufficient credits", { status: 402 })
    }) as any
    await expect(embedTexts(["ciao"], { endpoint: "http://x", model: "m" })).rejects.toThrow(/HTTP 402/)
    expect(chiamate).toBe(1)
  })
})
