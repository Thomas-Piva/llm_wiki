/**
 * Zero-cost stand-in for the LLM endpoint so the spike can exercise the
 * whole ingest pipeline (parse → generate → parseFileBlocks → write) with
 * no API key and no tokens spent. It speaks the OpenAI streaming wire
 * (`data: {choices:[{delta:{content}}]}` … `data: [DONE]`), which the
 * `custom` provider in llm-client expects.
 *
 * The generation call must return `---FILE: …---` blocks or the pipeline
 * writes nothing; the analysis call just needs to be plausible prose. We
 * tell them apart by a marker in the outgoing prompt.
 */

function sse(chunks: string[]): Response {
  const enc = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) {
        const payload = JSON.stringify({ choices: [{ delta: { content: c } }] })
        controller.enqueue(enc.encode(`data: ${payload}\n\n`))
      }
      controller.enqueue(enc.encode("data: [DONE]\n\n"))
      controller.close()
    },
  })
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  })
}

const GENERATED_PAGE = `---FILE: wiki/hello-headless.md---
---
title: Hello Headless
summary: Prima pagina generata dal motore ingest headless.
tags: [concepts]
status: stable
---

# Hello Headless

Questa pagina prova che l'ingest gira fuori dalla webview. Collega [[index]].
---END FILE---
`

const ANALYSIS = "Il documento sorgente e' una nota di prova. Genera una singola pagina wiki che ne riassume il contenuto e la collega all'indice."

/** Install a fetch that answers only the LLM URL; everything else 404s. */
export function installMockLlm(): void {
  const realFetch = globalThis.fetch.bind(globalThis)
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input?.url ?? ""
    const bodyText = typeof init?.body === "string" ? init.body : ""
    const isChat = /chat\/completions|\/v1\/messages|generateContent/.test(url) || bodyText.includes('"messages"')
    if (!isChat) {
      // Not the LLM: let anything else through (there should be nothing).
      return realFetch(input, init)
    }
    // Generation prompt carries the FILE-block contract; analysis does not.
    const isGeneration = bodyText.includes("---FILE:") || bodyText.includes("---END FILE---")
    return isGeneration ? sse([GENERATED_PAGE]) : sse([ANALYSIS])
  }) as typeof globalThis.fetch
}
