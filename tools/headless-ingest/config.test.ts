/**
 * Il tetto sulla dimensione dei file decide cosa entra nel vault e cosa resta
 * in coda per sempre, e il difetto che questi casi bloccano è muto: la mappa
 * per progetto letta come se fosse la configurazione fa cadere OGNI campo su
 * `undefined`, quindi il valore scelto nelle impostazioni viene sostituito dal
 * default senza che niente segnali l'errore — non un'eccezione, non un log.
 *
 * Sul vault della cliente questo teneva 58 documenti (3,28 GB) fermi: le
 * impostazioni dicevano 100 MB, il servizio ne applicava 25, e a ogni giro li
 * saltava lasciandoli `pending`.
 */
import { describe, expect, it } from "vitest"

import { resolveSourceWatchConfig } from "./config"

const PROGETTO = "/opt/llm-wiki/FENICE"
const ID = "26c6c587-7d6d-4d4a-a10f-8354739e4569"

/** La forma vera scritta da `saveSourceWatchConfig`: mappa per progetto. */
const appStateReale = {
  projectRegistry: { [ID]: { id: ID, path: PROGETTO, name: "FENICE" } },
  sourceWatchConfig: {
    [ID]: { enabled: true, maxFileSizeMb: 100 },
    default: { enabled: true, maxFileSizeMb: 40 },
  },
}

describe("resolveSourceWatchConfig", () => {
  it("prende il valore del progetto giusto, non il default", () => {
    expect(resolveSourceWatchConfig(appStateReale, PROGETTO).maxFileSizeMb).toBe(100)
  })

  it("ripiega su `default` quando il progetto non è nel registro", () => {
    expect(resolveSourceWatchConfig(appStateReale, "/altro/vault").maxFileSizeMb).toBe(40)
  })

  it("ignora la barra finale e i separatori Windows", () => {
    expect(resolveSourceWatchConfig(appStateReale, `${PROGETTO}/`).maxFileSizeMb).toBe(100)
    const win = {
      ...appStateReale,
      projectRegistry: { [ID]: { path: "C:\\vault\\FENICE" } },
    }
    expect(resolveSourceWatchConfig(win, "C:/vault/FENICE").maxFileSizeMb).toBe(100)
  })

  it("accetta anche un app-state già piatto", () => {
    const piatto = { sourceWatchConfig: { enabled: true, maxFileSizeMb: 250 } }
    expect(resolveSourceWatchConfig(piatto, PROGETTO).maxFileSizeMb).toBe(250)
  })

  it("senza configurazione torna i valori di fabbrica, non undefined", () => {
    const cfg = resolveSourceWatchConfig({}, PROGETTO)
    expect(typeof cfg.maxFileSizeMb).toBe("number")
    expect(cfg.maxFileSizeMb).toBeGreaterThan(0)
  })

  it("⛔ la regressione: la mappa NON deve essere letta come configurazione", () => {
    // Prima della correzione lo store riceveva `sourceWatchConfig` così com'era:
    // un oggetto le cui chiavi sono id di progetto. `maxFileSizeMb` non esiste
    // su quella forma, quindi valeva `undefined` e il tetto scelto spariva.
    const mappa = appStateReale.sourceWatchConfig as Record<string, unknown>
    expect((mappa as { maxFileSizeMb?: number }).maxFileSizeMb).toBeUndefined()
    expect(resolveSourceWatchConfig(appStateReale, PROGETTO).maxFileSizeMb).toBe(100)
  })
})
