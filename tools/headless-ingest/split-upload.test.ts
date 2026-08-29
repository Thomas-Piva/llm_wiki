/**
 * Il limite del motore è sui BYTE, e il testo italiano è pieno di caratteri da
 * due byte: contare i caratteri lo supererebbe senza accorgersene. Questo è il
 * controllo che il taglio rispetti davvero il limite dichiarato.
 */
import { splitForUpload, PART_LIMIT_BYTES } from "./r2r-search"

const check = (nome: string, testo: string) => {
  const parti = splitForUpload(testo)
  for (const [i, p] of parti.entries()) {
    const b = Buffer.byteLength(p, "utf8")
    if (b > PART_LIMIT_BYTES) throw new Error(`${nome}: parte ${i} = ${b} byte, oltre il limite`)
  }
  // Niente deve sparire nel taglio: rimesso insieme, il testo torna quello.
  const byteDentro = Buffer.byteLength(testo, "utf8")
  const byteFuori = parti.reduce((n, p) => n + Buffer.byteLength(p, "utf8"), 0)
  // Il taglio su riga toglie il "\n" di giunzione: una parte in meno di a capo.
  const attesi = byteDentro - (parti.length - 1)
  if (byteFuori !== byteDentro && byteFuori !== attesi) {
    throw new Error(`${nome}: ${byteDentro} byte dentro, ${byteFuori} fuori`)
  }
  console.log(`ok · ${nome}: ${Buffer.byteLength(testo, "utf8")} byte → ${parti.length} parti, nessuna riga persa`)
}

check("corto", "una riga sola\ne un'altra")
check("accentato oltre il limite", ("perché società università è più però\n").repeat(40_000))
check("riga singola enorme", "x".repeat(1_500_000))
process.exit(0)
