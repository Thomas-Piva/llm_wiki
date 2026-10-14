/**
 * Dove finisce il testo estratto da un documento (pdftotext, MinerU, anydoc,
 * trascrizioni audio, didascalie immagini).
 *
 * Storicamente: `<cartella del file>/.cache/<nome>.txt`, accanto all'originale.
 * Funziona finche' quella cartella e' scrivibile, e sulla VPS di Milena non lo
 * e' piu': le quattro cartelle del suo Dropbox sono montate **in sola lettura**
 * — il suo archivio non si tocca — quindi `mkdir .cache` torna EROFS.
 *
 * Il guasto non e' un errore, e' un silenzio: il ramo Office cattura
 * l'eccezione e **ripiega sulla lettura grezza**, cioe' manda i byte di un
 * .docx al modello. La pagina esce comunque, ed esce sbagliata.
 *
 * Con `LLMWIKI_CACHE_IN_PROJECT=1` la cache va invece sotto
 * `<progetto>/.llm-wiki/cache-estrazione/<percorso relativo>/.cache/<nome>.txt`:
 * sempre scrivibile, e **dentro** il progetto, perche' le guardie dei path
 * delle shim rifiutano qualunque scrittura che ne esca.
 *
 * Il segmento `.cache` resta nel nome anche nello specchio: `source-filter` lo
 * usa per nascondere queste cartelle nell'albero delle fonti, e le cache
 * archiviate dalla vecchia disposizione hanno la stessa forma.
 *
 * Solo matematica sui percorsi, separatori POSIX, nessun `node:*`: questo
 * modulo viene importato anche da `ingest.ts`, che gira nel bundle del browser.
 */

export const CACHE_MIRROR_REL = ".llm-wiki/cache-estrazione"

/** Letto a ogni chiamata, non una volta sola: così i test possono spegnerlo. */
function redirectAttivo(): boolean {
  return typeof process !== "undefined" && process.env?.LLMWIKI_CACHE_IN_PROJECT === "1"
}

function senzaCodaSlash(p: string): string {
  return p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p
}

/** La cartella che contiene la cache di `sourcePath`. Va creata prima di scrivere. */
export function extractionCacheDir(projectPath: string, sourcePath: string): string {
  const dir = sourcePath.substring(0, sourcePath.lastIndexOf("/"))
  if (!redirectAttivo() || !projectPath) return `${dir}/.cache`
  const pp = senzaCodaSlash(projectPath)
  // Una fonte fuori dal progetto non ha un percorso relativo da rispecchiare:
  // torna alla disposizione accanto al file, che e' il comportamento storico.
  if (dir !== pp && !dir.startsWith(`${pp}/`)) return `${dir}/.cache`
  const rel = dir.slice(pp.length).replace(/^\//, "")
  return rel ? `${pp}/${CACHE_MIRROR_REL}/${rel}/.cache` : `${pp}/${CACHE_MIRROR_REL}/.cache`
}

/** Il file `.txt` con il testo estratto da `sourcePath`. */
export function extractionCachePath(projectPath: string, sourcePath: string): string {
  const name = sourcePath.substring(sourcePath.lastIndexOf("/") + 1)
  return `${extractionCacheDir(projectPath, sourcePath)}/${name}.txt`
}
