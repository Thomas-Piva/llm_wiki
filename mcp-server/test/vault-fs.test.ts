/**
 * Le regole del vault sulla strada MCP — la terza, quella dell'agente.
 *
 * `invoke-shim.ts` e `web-invoke.ts` passano da `note-policy.ts`; questa
 * scriveva con un `fs.writeFile` diretto, quindi una nota creata dall'agente
 * nasceva senza `id:`. Il guasto non si vede subito: si vede il giorno in cui
 * qualcuno rinomina o fonde quella pagina e i `[[collegamenti]]` in entrata
 * smettono di risolvere **in silenzio**. Sul vault della cliente il lint ne
 * conta già 5.254 rotti.
 *
 * Il caso che conta di più è il terzo: **una riscrittura non deve cambiare
 * l'identità della pagina**.
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { appendNote, ensureIdentity, frontmatterField, isWikiPage, writeNote } from "../src/vault-fs.js";

const NOTA = `---
title: Prova
tags: [concepts]
---

Corpo della nota.
`;

async function vaultTemporaneo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vault-fs-"));
  await mkdir(join(root, "wiki", "concepts"), { recursive: true });
  return root;
}

test("isWikiPage riconosce solo le pagine dentro wiki/", () => {
  assert.equal(isWikiPage("wiki/concepts/x.md"), true);
  assert.equal(isWikiPage("wiki/a/b/c.md"), true);
  assert.equal(isWikiPage("wiki.md"), false);
  assert.equal(isWikiPage("raw/sources/x.md"), false);
  assert.equal(isWikiPage("wiki/concepts/x.txt"), false);
});

test("una nota nuova nasce con id e visibility", async () => {
  const root = await vaultTemporaneo();
  try {
    await writeNote(root, "wiki/concepts/nuova.md", NOTA, []);
    const scritta = await readFile(join(root, "wiki/concepts/nuova.md"), "utf8");
    assert.match(frontmatterField(scritta, "id") ?? "", /^c-[0-9a-f]{6}$/);
    assert.equal(frontmatterField(scritta, "visibility"), "all");
    assert.match(scritta, /Corpo della nota\./);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("⛔ una riscrittura CONSERVA l'id: l'identità non cambia sotto i collegamenti", async () => {
  const root = await vaultTemporaneo();
  try {
    await writeNote(root, "wiki/concepts/x.md", NOTA, []);
    const primo = frontmatterField(await readFile(join(root, "wiki/concepts/x.md"), "utf8"), "id");

    // L'agente riscrive la pagina senza l'id, come farebbe rigenerandola
    await writeNote(root, "wiki/concepts/x.md", "---\ntitle: Prova\n---\n\nTesto nuovo.\n", []);
    const dopo = await readFile(join(root, "wiki/concepts/x.md"), "utf8");

    assert.equal(frontmatterField(dopo, "id"), primo);
    assert.match(dopo, /Testo nuovo\./);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("un id già presente non viene mai toccato", () => {
  // completa: né id né visibility mancano, quindi il contenuto esce identico
  const completa = "---\nid: c-abc123\nvisibility: all\ntitle: X\n---\n\nCorpo.\n";
  assert.equal(ensureIdentity(completa, null), completa);
  assert.equal(ensureIdentity(completa, "c-999999"), completa);

  // con l'id ma senza visibility: si aggiunge il campo mancante e SOLO quello
  const soloId = "---\nid: c-abc123\ntitle: X\n---\n\nCorpo.\n";
  const arricchita = ensureIdentity(soloId, "c-999999");
  assert.equal(frontmatterField(arricchita, "id"), "c-abc123");
  assert.equal(frontmatterField(arricchita, "visibility"), "all");
});

test("una nota senza frontmatter resta com'è: non se ne inventa uno", () => {
  assert.equal(ensureIdentity("Solo testo, niente frontmatter.\n", null), "Solo testo, niente frontmatter.\n");
});

test("fuori da wiki/ non si aggiunge nulla", async () => {
  const root = await vaultTemporaneo();
  try {
    await mkdir(join(root, "raw"), { recursive: true });
    await writeNote(root, "raw/appunti.md", NOTA, []);
    const scritta = await readFile(join(root, "raw/appunti.md"), "utf8");
    assert.equal(frontmatterField(scritta, "id"), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("appendNote che CREA il file gli dà un'identità; su file esistente non tocca nulla", async () => {
  const root = await vaultTemporaneo();
  try {
    // creazione: è una pagina nuova a tutti gli effetti
    await appendNote(root, "wiki/concepts/creata.md", NOTA, []);
    const creata = await readFile(join(root, "wiki/concepts/creata.md"), "utf8");
    assert.match(frontmatterField(creata, "id") ?? "", /^c-[0-9a-f]{6}$/);

    // aggiunta in coda: il frontmatter esistente non si tocca
    const esistente = join(root, "wiki/concepts/esistente.md");
    await writeFile(esistente, "---\nid: c-fedcba\ntitle: Y\n---\n\nPrima riga.\n");
    await appendNote(root, "wiki/concepts/esistente.md", "Seconda riga.\n", []);
    const dopo = await readFile(esistente, "utf8");
    assert.equal(frontmatterField(dopo, "id"), "c-fedcba");
    assert.match(dopo, /Prima riga\.[\s\S]*Seconda riga\./);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("i prefissi in sola lettura restano invalicabili", async () => {
  const root = await vaultTemporaneo();
  try {
    await assert.rejects(() => writeNote(root, "wiki/concepts/x.md", NOTA, ["wiki/concepts"]), /read-only/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
