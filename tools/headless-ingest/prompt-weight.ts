/**
 * Prova I, parte contabile: quanto pesano davvero le regole in ogni chiamata?
 *
 * L'affermazione da verificare è che l'applicazione rispedisce le stesse
 * convenzioni del vault a ogni documento, perché parla a un'API senza stato.
 * Invece di stimarlo, si costruiscono i due prompt di sistema veri
 * (`buildAnalysisPrompt` e `buildGenerationPrompt`) con gli ingressi reali del
 * vault, e si conta.
 *
 * "Stabile" = ciò che non cambia da un documento all'altro: schema, scopo,
 * indice, panoramica. È la parte che una sessione di agente leggerebbe una
 * volta sola.
 *
 *   bun --preload tools/headless-ingest/preload.ts \
 *     /home/claude/fortezza-kb/bakeoff/prompt_weight.ts <vault>
 */
import { readdirSync, readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { buildAnalysisPrompt, buildGenerationPrompt } from "../../src/lib/ingest"

const vault = process.argv[2] ?? "/home/claude/bakeoff/skill-test"
const read = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : "")

const schema = read(join(vault, "schema.md"))
const purpose = read(join(vault, "purpose.md"))
const index = read(join(vault, "wiki/index.md"))
const overview = read(join(vault, "wiki/overview.md"))

const sourcesDir = join(vault, "_seed")
const docs = readdirSync(sourcesDir)
  .filter((f) => f.endsWith(".md"))
  .map((f) => ({ name: f, text: readFileSync(join(sourcesDir, f), "utf8") }))

// Il costo per documento è: prompt di sistema + fonte, due volte. Il prompt di
// sistema con fonte vuota è la parte che non dipende dal documento — tranne una
// riga, `languageRule(sourceContent)`, che è il motivo per cui oggi il prefisso
// non è riutilizzabile.
const stableAnalysis = buildAnalysisPrompt(purpose, index, "", schema).length
const stableGeneration = buildGenerationPrompt(schema, purpose, index, "X.md", overview, "", undefined).length

let totalSystem = 0
let totalSource = 0
for (const d of docs) {
  totalSystem +=
    buildAnalysisPrompt(purpose, index, d.text, schema).length +
    buildGenerationPrompt(schema, purpose, index, d.name, overview, d.text, undefined).length
  // la fonte viaggia due volte: una per analizzarla, una per riscriverla
  totalSource += d.text.length * 2
}

const stablePerDoc = stableAnalysis + stableGeneration
const agentOnce = schema.length + purpose.length + index.length + overview.length

const fmt = (n: number) => n.toLocaleString("it-IT")
console.log(`vault:                    ${vault}`)
console.log(`documenti nel lotto:      ${docs.length}`)
console.log("")
console.log(`convenzioni sul disco:    ${fmt(agentOnce)} caratteri (schema+scopo+indice+panoramica)`)
console.log(`prompt di sistema, analisi:    ${fmt(stableAnalysis)} caratteri`)
console.log(`prompt di sistema, generazione:${fmt(stableGeneration)} caratteri`)
console.log(`→ parte fissa per documento:   ${fmt(stablePerDoc)} caratteri × 2 chiamate già incluse`)
console.log("")
console.log(`MODO ATTUALE  · sistema totale: ${fmt(totalSystem)} car · fonti: ${fmt(totalSource)} car`)
console.log(`MODO AGENTE   · regole lette una volta: ${fmt(agentOnce)} car · fonti: ${fmt(totalSource / 2)} car (una lettura)`)
console.log("")
const risparmio = totalSystem - agentOnce
console.log(`differenza sulle sole regole: ${fmt(risparmio)} caratteri su ${docs.length} documenti`)
console.log(`fattore di ripetizione:       ${(totalSystem / agentOnce).toFixed(1)}×`)
console.log("")
console.log(`proiezione su 8.800 documenti: ${fmt(Math.round((stablePerDoc * 8800) / 1000))} mila caratteri di sole regole`)
