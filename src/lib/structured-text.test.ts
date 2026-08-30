/**
 * json/xml/yaml/html erano accettati come sorgenti ma non parsati: finivano
 * nell'indice con la loro sintassi. Per un JSON piccolo si sopravvive; per una
 * pagina HTML significa indicizzare `<div class="wrapper">` invece di quello che
 * la pagina dice, e ognuno di quei token compete con il testo vero al momento
 * della ricerca.
 *
 * Il caso che conta di più è l'ultimo: **un file malformato non deve sparire**.
 * Prima di questo modulo veniva comunque letto grezzo, quindi il peggio
 * accettabile è tornare a quel comportamento — mai perdere il documento.
 */
import { describe, expect, it } from "vitest"

import {
  decodeEntities,
  isStructuredText,
  markupToText,
  structuredToText,
  treeToText,
} from "./structured-text"

describe("isStructuredText", () => {
  it("riconosce i formati strutturati, con o senza punto", () => {
    for (const e of ["json", ".json", "XML", "yaml", "yml", "html", "htm", "svg"]) {
      expect(isStructuredText(e)).toBe(true)
    }
    for (const e of ["pdf", "md", "txt", "docx", "mp3"]) {
      expect(isStructuredText(e)).toBe(false)
    }
  })
})

describe("markupToText", () => {
  it("⛔ butta via script e style: sono codice, non contenuto", () => {
    const html = `<html><head><style>.a{color:red}</style>
      <script>var x = 1; function f(){return "testo finto"}</script></head>
      <body><h1>Titolo vero</h1><p>Prosa vera.</p></body></html>`
    const testo = markupToText(html)
    expect(testo).toContain("Titolo vero")
    expect(testo).toContain("Prosa vera.")
    expect(testo).not.toContain("color:red")
    expect(testo).not.toContain("testo finto")
  })

  it("i tag di blocco diventano a-capo: le frasi non si fondono", () => {
    // due paragrafi restano due paragrafi (riga vuota in mezzo, come in markdown);
    // ciò che conta è che "Prima" e "Seconda" non diventino "PrimaSeconda"
    expect(markupToText("<p>Prima</p><p>Seconda</p>")).toBe("Prima\n\nSeconda")
    expect(markupToText("<li>Uno</li><li>Due</li>")).toBe("Uno\n\nDue")
    expect(markupToText("<span>Attac</span><span>cate</span>")).toBe("Attac cate")
  })

  it("niente markup nel risultato", () => {
    const testo = markupToText('<div class="wrapper"><span id="x">Contenuto</span></div>')
    expect(testo).toBe("Contenuto")
    expect(testo).not.toMatch(/[<>]/)
  })

  it("decodifica le entità, comprese le accentate italiane", () => {
    expect(decodeEntities("perch&eacute; &egrave; cos&igrave;")).toBe("perché è così")
    expect(decodeEntities("&#233;&#x2014;&amp;")).toBe("é—&")
    expect(decodeEntities("&nonesiste;")).toBe("&nonesiste;")
  })

  it("i commenti spariscono", () => {
    expect(markupToText("<!-- nota privata -->Testo")).toBe("Testo")
  })
})

describe("treeToText", () => {
  it("chiavi e valori diventano righe leggibili", () => {
    const testo = treeToText({ cliente: "Rossi SRL", importo: 1250.5, pagato: false })
    expect(testo).toContain("cliente: Rossi SRL")
    expect(testo).toContain("importo: 1250.5")
    expect(testo).toContain("pagato: false")
  })

  it("⛔ le chiavi di sola impalcatura non entrano nell'indice", () => {
    const testo = treeToText({ _id: "abc123", uuid: "x-y-z", etag: "W/123", titolo: "Vero" })
    expect(testo).toContain("titolo: Vero")
    expect(testo).not.toContain("abc123")
    expect(testo).not.toContain("x-y-z")
  })

  it("scende dentro liste e annidamenti", () => {
    const testo = treeToText({ voci: [{ nome: "A" }, { nome: "B" }] })
    expect(testo).toContain("nome: A")
    expect(testo).toContain("nome: B")
  })

  it("i valori vuoti non lasciano righe fantasma", () => {
    expect(treeToText({ a: "", b: null, c: undefined })).toBe("")
  })
})

describe("structuredToText", () => {
  it("json → chiave: valore", () => {
    expect(structuredToText('{"titolo":"Fattura","importo":90}', "json")).toContain("titolo: Fattura")
  })

  it("yaml → chiave: valore", () => {
    expect(structuredToText("titolo: Nota\ntags:\n  - uno\n  - due\n", "yml")).toContain("titolo: Nota")
  })

  it("xml e svg perdono i tag e tengono le parole", () => {
    expect(structuredToText("<root><nome>Marco</nome></root>", "xml")).toBe("Marco")
    expect(structuredToText("<svg><title>Diagramma</title></svg>", "svg")).toBe("Diagramma")
  })

  it("⛔ un file malformato torna grezzo, non sparisce", () => {
    const jsonRotto = '{"a": 1, "b": '
    expect(structuredToText(jsonRotto, "json")).toBe(jsonRotto)

    const yamlRotto = "a:\n  - x\n b: storto"
    expect(structuredToText(yamlRotto, "yaml")).toBe(yamlRotto)
  })

  it("un formato non strutturato passa intatto", () => {
    const md = "# Titolo\n\nCorpo."
    expect(structuredToText(md, "md")).toBe(md)
  })

  it("un json che si riduce a nulla torna grezzo invece di svuotare il documento", () => {
    // solo chiavi di impalcatura: il risultato sarebbe vuoto, e una pagina vuota
    // vale meno del grezzo
    expect(structuredToText('{"uuid":"a","etag":"b"}', "json")).toBe('{"uuid":"a","etag":"b"}')
  })
})
