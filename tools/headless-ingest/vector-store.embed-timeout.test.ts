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

describe("entroIlLimite", () => {
  it("lascia stare i pezzi normali", async () => {
    const { entroIlLimite } = await import("./vector-store")
    const t = "un pezzo normale di qualche centinaio di caratteri ".repeat(10)
    expect(entroIlLimite(t)).toBe(t)
  })

  it("taglia un pezzo enorme sotto gli 8.000 byte", async () => {
    const { entroIlLimite } = await import("./vector-store")
    const t = "x".repeat(50_000)
    expect(Buffer.byteLength(entroIlLimite(t), "utf8")).toBeLessThanOrEqual(8_000)
  })

  // Il caso che un tetto in CARATTERI non coprirebbe: 8.000 caratteri da 4
  // byte sono 32.000 byte, quindi fino a 32.000 token.
  it("misura in byte: 8.000 caratteri multibyte vengono tagliati lo stesso", async () => {
    const { entroIlLimite } = await import("./vector-store")
    const t = "𝔄".repeat(8_000) // 4 byte l'uno
    expect(t.length).toBeGreaterThanOrEqual(8_000)
    expect(Buffer.byteLength(entroIlLimite(t), "utf8")).toBeLessThanOrEqual(8_000)
  })

  it("e' davvero applicato alla richiesta che parte", async () => {
    let corpo: any
    globalThis.fetch = (async (_u: any, o: any) => {
      corpo = JSON.parse(o.body)
      return new Response(JSON.stringify({ data: [{ embedding: [1] }] }), { status: 200 })
    }) as any
    await embedTexts(["y".repeat(30_000)], { endpoint: "http://x", model: "m" })
    expect(Buffer.byteLength(corpo.input[0], "utf8")).toBeLessThanOrEqual(8_000)
  })
})
