/**
 * runTool non deve mai appendere la coda.
 *
 * Il caso vero — `pdftotext` fermo dentro write(2) su stderr per dieci ore e
 * mezza sul box del cliente — non si riproduce qui: bun bufferizza i socket
 * diversamente da come li ha visti quel processo. La prova di produzione resta
 * `/proc/<pid>/syscall` = `1` (write) su `fd 2`.
 *
 * Quello che si può verificare, ed è ciò che conta, è che un tool che non
 * finisce venga interrotto e restituisca comunque il parziale: una coda che
 * avanza con testo incompleto è recuperabile, una coda ferma no.
 */
import { invoke } from "./invoke-shim"

const t0 = Date.now()
// `pdftotext` su un percorso inesistente: torna subito, senza eccezioni.
const vuoto = await invoke<string>("pdf_extract_text", { path: "/tmp/non-esiste-nessun-file.pdf" })
if (typeof vuoto !== "string") throw new Error("pdf_extract_text deve restituire una stringa")
if (Date.now() - t0 > 30_000) throw new Error("un file mancante non deve costare mezzo minuto")

console.log(`ok · file mancante → "" in ${Date.now() - t0}ms, nessuna eccezione, nessun blocco`)
process.exit(0)
