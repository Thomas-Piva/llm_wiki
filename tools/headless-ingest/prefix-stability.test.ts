/**
 * Quanto prefisso è davvero riutilizzabile?
 *
 * I fornitori scontano il prefisso ripetuto confrontando i prompt carattere per
 * carattere DALL'INIZIO: la prima differenza chiude il discorso. Quindi la
 * misura che conta è una sola — **a quale carattere due prompt per due
 * documenti diversi smettono di essere identici**.
 */
import { buildAnalysisPrompt, buildGenerationPrompt } from "../../src/lib/ingest"

const schema = "## Tipi\n" + "areas outputs concepts entities projects docs\n".repeat(60)
const purpose = "Cervello personale.\n".repeat(30)
const index = "- pagina\n".repeat(200)

const A = { nome: "Primo Documento.pdf", testo: "Testo del primo documento in italiano. ".repeat(50) }
const B = { nome: "Un Altro File.docx", testo: "Contenuto completamente diverso, sempre italiano. ".repeat(80) }

function divergenza(x: string, y: string): number {
  const n = Math.min(x.length, y.length)
  for (let i = 0; i < n; i++) if (x[i] !== y[i]) return i
  return n
}

for (const [nome, fa, fb] of [
  ["analisi",
    buildAnalysisPrompt(purpose, index, A.testo, schema),
    buildAnalysisPrompt(purpose, index, B.testo, schema)],
  ["generazione",
    buildGenerationPrompt(schema, purpose, index, A.nome, "", A.testo, undefined),
    buildGenerationPrompt(schema, purpose, index, B.nome, "", B.testo, undefined)],
] as [string, string, string][]) {
  const d = divergenza(fa, fb)
  const pct = (d / fa.length * 100).toFixed(1)
  console.log(`${nome.padEnd(12)} prefisso identico: ${String(d).padStart(6)} / ${fa.length} caratteri  (${pct}%)`)
}
process.exit(0)
