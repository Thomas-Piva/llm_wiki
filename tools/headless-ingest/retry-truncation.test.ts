/**
 * Il messaggio vero, preso dai log di produzione: deve essere riconosciuto come
 * riprovabile. Un errore di scrittura su disco, invece, no — quello non
 * migliora riprovando.
 */
import { isTruncationFailure, isDailyQuotaExhausted } from "./queue-runner"

const casi: [string, boolean][] = [
  ["Ingest incomplete: 1 truncated wiki file(s) could not be repaired: wiki/concepts/cuore.md", true],
  ["Ingest incomplete: 2 truncated wiki file(s) could not be repaired: wiki/log.md, wiki/x.md", true],
  ["Ingest incomplete: 1 wiki file write failure(s)", false],
  ["Generation failed: LLM endpoint error 429: temporarily rate-limited upstream", false],
  ["ENOSPC: no space left on device", false],
]
for (const [msg, atteso] of casi) {
  const got = isTruncationFailure(msg)
  if (got !== atteso) throw new Error(`atteso ${atteso} per "${msg.slice(0, 60)}", ottenuto ${got}`)
}
// Le due condizioni non devono sovrapporsi: una quota esaurita non è un troncamento.
if (isTruncationFailure("rate limit reached, 200 requests per day")) throw new Error("quota scambiata per troncamento")
if (isDailyQuotaExhausted(casi[0][0])) throw new Error("troncamento scambiato per quota")
console.log(`ok · ${casi.length} messaggi classificati correttamente, nessuna sovrapposizione`)
process.exit(0)
