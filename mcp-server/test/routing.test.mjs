// Un LLM sceglie il tool leggendo la descrizione. Se due tool fanno lo stesso
// verbo e nessuno dei due dice quando cedere il passo all'altro, la scelta e'
// un sorteggio — ed e' esattamente il guasto che Thomas vedeva ("sbaglia tool").
// Questo controllo non giudica la prosa: verifica che ogni coppia che si
// sovrappone si nomini a vicenda, e che ogni descrizione dica QUANDO usarla.
import { readFileSync } from "node:fs"

const src = readFileSync(new URL("./src/tool-server.ts", import.meta.url), "utf8")
  + readFileSync(new URL("./src/vault-tools.ts", import.meta.url), "utf8")

const desc = new Map()
for (const m of src.matchAll(/name:\s*"((?:vault|llm_wiki)_[a-z_]+)",?\s*\n?\s*description:\s*\n?\s*"((?:[^"\\]|\\.)*)"/g)) {
  desc.set(m[1], m[2])
}

const coppie = [
  ["llm_wiki_search", "vault_search_notes"],
  ["llm_wiki_files", "vault_list_notes"],
  ["llm_wiki_read_file", "vault_read_note"],
  ["llm_wiki_graph", "vault_graph"],
  ["vault_write_note", "vault_create_missing_page"],
]

let errori = 0
console.log(`tool con descrizione: ${desc.size}`)
for (const [a, b] of coppie) {
  for (const [x, y] of [[a, b], [b, a]]) {
    const d = desc.get(x)
    if (!d) { console.log(`  ✗ ${x}: descrizione non trovata`); errori++; continue }
    if (!d.includes(y)) { console.log(`  ✗ ${x} non nomina ${y}`); errori++ }
  }
  console.log(`  ok  ${a} ⇄ ${b}`)
}

// Ogni descrizione deve contenere una guida d'uso, non solo cosa fa.
const segnali = /\b(use (this|it|them)|Use |PREFER|prefer|only when|whenever|Rarely needed|This is the tool|This is what you call|call this|Call this|do not|Do NOT|instead|WRONG tool|FIRST|default way)\b/;
for (const [nome, d] of desc) {
  if (!segnali.test(d)) { console.log(`  ✗ ${nome}: nessuna indicazione su QUANDO usarlo`); errori++ }
}

console.log(errori === 0 ? "\nok · ogni coppia sovrapposta si rimanda a vicenda, ogni tool dice quando usarlo"
                         : `\n${errori} problemi`)
process.exit(errori === 0 ? 0 : 1)
