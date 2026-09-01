/**
 * HEIC: la conversione può mancare, ma il documento non deve peggiorare.
 *
 * `read_file_as_base64` ora prova a convertire `.heic`/`.heif` in JPEG prima di
 * consegnare i byte al modello di visione, perché nessun modello accetta
 * `image/heic` e la tabella dei mime lo mandava come `application/octet-stream`.
 *
 * Il caso da presidiare NON è quello felice — quello si vede a occhio, e lo
 * abbiamo visto: due foto vere di iPhone, due didascalie giuste. Il caso da
 * presidiare è **la macchina senza convertitore**: se lì la funzione lanciasse
 * un'eccezione invece di ripiegare, avremmo trasformato "niente didascalia" in
 * "ingest rotto", che è molto peggio del problema che stiamo risolvendo.
 *
 * Qui si passa un `.heic` finto: nessun convertitore al mondo lo converte,
 * quindi si esercita esattamente il ramo del ripiego — su qualunque macchina,
 * con o senza libheif installato.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { invoke } from "./invoke-shim"

const dir = await mkdtemp(join(tmpdir(), "heic-"))
try {
  // Byte arbitrari con estensione .heic: la conversione fallisce di sicuro.
  const finto = join(dir, "finta.heic")
  const contenuto = Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x00, 0x01, 0x02, 0x03])
  await writeFile(finto, contenuto)

  const t0 = Date.now()
  const r = await invoke<{ base64: string; mimeType: string }>("read_file_as_base64", { path: finto })
  const durata = Date.now() - t0

  if (typeof r?.base64 !== "string") throw new Error("deve comunque restituire i byte, non lanciare")
  if (!Buffer.from(r.base64, "base64").equals(contenuto)) {
    throw new Error("senza convertitore i byte devono tornare INTATTI, come prima della modifica")
  }
  if (r.mimeType !== "application/octet-stream") {
    throw new Error(`ripiego atteso application/octet-stream, ricevuto ${r.mimeType}`)
  }
  // Quattro convertitori × 60s di scadenza ciascuno sarebbero quattro minuti:
  // su un file che non è un HEIC devono fallire subito, non consumare il tetto.
  if (durata > 60_000) throw new Error(`ripiego troppo lento (${durata}ms): la scadenza non sta funzionando`)

  // Un file normale non deve nemmeno sfiorare quel ramo.
  const png = join(dir, "vera.png")
  await writeFile(png, Buffer.from("iVBORw0KGgo=", "base64"))
  const q = await invoke<{ mimeType: string }>("read_file_as_base64", { path: png })
  if (q.mimeType !== "image/png") throw new Error(`png deve restare image/png, ricevuto ${q.mimeType}`)

  console.log(`ok · .heic non convertibile → byte intatti + octet-stream in ${durata}ms; .png intatto`)
} finally {
  await rm(dir, { recursive: true, force: true })
}
process.exit(0)
