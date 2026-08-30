/**
 * La coda di ingest è l'unico posto dove vive lo stato del lavoro: cosa è
 * fatto, cosa manca, cosa è fallito e perché. Perderla non rompe un giro —
 * cancella la memoria di giorni di elaborazione.
 *
 * Il difetto che questi casi bloccano è successo davvero: un `catch { return
 * [] }` in lettura, e un chiamante che riscrive ciò che ha letto, hanno
 * trasformato **una** lettura andata male in una cancellazione totale. 1.087
 * voci ridotte a un file di 3 byte, senza un errore né una riga di log.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { queueBackupPath, queuePath, readQueue, writeQueue, type IngestTask } from "./queue-store"

let project: string

beforeEach(async () => {
  project = await mkdtemp(join(tmpdir(), "coda-"))
})
afterEach(async () => {
  await rm(project, { recursive: true, force: true })
})

const task = (id: string, status: IngestTask["status"] = "pending"): IngestTask => ({
  id,
  projectId: "p",
  sourcePath: `raw/sources/${id}.pdf`,
  folderContext: "",
  status,
  addedAt: 0,
  error: null,
  retryCount: 0,
})

describe("readQueue", () => {
  it("nessun file = coda vuota, che è legittima al primo avvio", async () => {
    expect(await readQueue(project)).toEqual([])
  })

  it("⛔ un file illeggibile NON diventa una coda vuota: si ferma", async () => {
    // Il caso vero: JSON troncato da una scrittura concorrente. Prima tornava
    // `[]`, e la scrittura successiva lo rendeva definitivo.
    await writeQueue(project, [task("a"), task("b")])
    await writeFile(queuePath(project), '[{"id":"a","statu')

    await expect(readQueue(project)).rejects.toThrow(/non si legge|backup/)
  })

  it("prima di arrendersi prova il backup, e lo trova", async () => {
    await writeQueue(project, [task("a"), task("b")]) // nessun .bak ancora
    await writeQueue(project, [task("a"), task("b"), task("c")]) // ora .bak = 2 voci
    await writeFile(queuePath(project), "{ rotto")

    const recuperata = await readQueue(project)
    expect(recuperata.map((t) => t.id)).toEqual(["a", "b"])
  })

  it("un file sparito ma con backup viene recuperato, non ignorato", async () => {
    await writeQueue(project, [task("a")])
    await writeQueue(project, [task("a"), task("b")])
    await rm(queuePath(project))

    expect((await readQueue(project)).map((t) => t.id)).toEqual(["a"])
  })

  it("accetta sia la lista sia la forma { tasks: [...] }", async () => {
    const { mkdir } = await import("node:fs/promises")
    await mkdir(join(project, ".llm-wiki"), { recursive: true })
    await writeFile(queuePath(project), JSON.stringify({ tasks: [task("x")] }))
    expect((await readQueue(project)).map((t) => t.id)).toEqual(["x"])
  })
})

describe("writeQueue", () => {
  it("scrive e rilegge identico", async () => {
    const voci = [task("a", "done"), task("b", "failed")]
    await writeQueue(project, voci)
    expect(await readQueue(project)).toEqual(voci)
  })

  it("conserva la copia precedente come .bak", async () => {
    await writeQueue(project, [task("a")])
    await writeQueue(project, [task("a"), task("b")])

    const bak = JSON.parse(await readFile(queueBackupPath(project), "utf8"))
    expect(bak.map((t: IngestTask) => t.id)).toEqual(["a"])
  })

  it("non lascia file temporanei in giro", async () => {
    await writeQueue(project, [task("a")])
    const { readdir } = await import("node:fs/promises")
    const rimasti = (await readdir(join(project, ".llm-wiki"))).filter((f) => f.includes(".tmp-"))
    expect(rimasti).toEqual([])
  })
})
