/**
 * `/vimg` è l'unico punto del server raggiungibile **senza autenticazione**:
 * una GET normale, nessun header, e il file esce. Sta dietro un tunnel
 * Cloudflare, quindi è su internet.
 *
 * Regge su due difese, e i casi qui sotto esercitano entrambe:
 *
 *   1. la FIRMA — l'URL l'ha emesso questo server e non è scaduto;
 *   2. `resolveVaultPath` — il file è dentro il vault.
 *
 * ⛔ Il caso che conta di più è il penultimo: un percorso malevolo **firmato
 * con la chiave giusta**. Se si testa il traversal con una firma finta, il
 * primo cancello lo ferma e il secondo non viene mai eseguito — il test passa
 * verde senza aver provato ciò che dice di provare. Quella è la differenza fra
 * un test e la sua apparenza.
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { signImagePath, verifyImageSig } from "../src/image-url.js";
import { readImage, resolveVaultPath } from "../src/vault-fs.js";

const SEGRETO = "segreto-di-prova";

/** Un PNG 1x1 valido: basta a provare che i byte tornano indietro interi. */
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

async function vaultConUnaImmagine(): Promise<{ root: string; rel: string }> {
  const root = await mkdtemp(join(tmpdir(), "vimg-"));
  await mkdir(join(root, "wiki", "media"), { recursive: true });
  const rel = "wiki/media/prova.png";
  await writeFile(join(root, rel), PNG_1X1);
  return { root, rel };
}

/** Ciò che la route fa, nello stesso ordine: firma, poi percorso. */
async function serviImmagine(
  root: string,
  q: { p: string; e: number; s: string },
): Promise<{ status: number; bytes?: Buffer }> {
  if (!q.p || !verifyImageSig(q.p, q.e, q.s, SEGRETO)) return { status: 403 };
  try {
    const { base64 } = await readImage(root, q.p);
    return { status: 200, bytes: Buffer.from(base64, "base64") };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/escapes the vault|must be relative|not a supported image/i.test(msg)) return { status: 403 };
    return { status: 404 };
  }
}

test("firma valida → 200 e i byte dell'immagine", async () => {
  const { root, rel } = await vaultConUnaImmagine();
  try {
    const { exp, sig } = signImagePath(rel, SEGRETO);
    const r = await serviImmagine(root, { p: rel, e: exp, s: sig });
    assert.equal(r.status, 200);
    assert.ok(r.bytes && r.bytes.length > 0, "nessun byte restituito");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("⛔ firma manomessa → 403", async () => {
  const { root, rel } = await vaultConUnaImmagine();
  try {
    const { exp, sig } = signImagePath(rel, SEGRETO);
    const falsa = sig.slice(0, -1) + (sig.endsWith("0") ? "1" : "0");
    assert.equal((await serviImmagine(root, { p: rel, e: exp, s: falsa })).status, 403);
    assert.equal((await serviImmagine(root, { p: rel, e: exp, s: "" })).status, 403);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("⛔ firma scaduta → 403", async () => {
  const { root, rel } = await vaultConUnaImmagine();
  try {
    const { sig } = signImagePath(rel, SEGRETO);
    const ieri = Math.floor(Date.now() / 1000) - 86_400;
    assert.equal((await serviImmagine(root, { p: rel, e: ieri, s: sig })).status, 403);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("⛔⛔ un percorso FUORI dal vault, firmato con la chiave GIUSTA → 403", async () => {
  // Il caso vero: la firma passa, quindi tutto dipende dal secondo cancello.
  // Se lo si prova con una firma finta si misura solo il primo, e il test
  // sembra superato mentre la difesa che conta non è mai stata toccata.
  const { root } = await vaultConUnaImmagine();
  try {
    for (const cattivo of ["../../etc/passwd", "../../../etc/hosts", "wiki/../../etc/passwd"]) {
      const { exp, sig } = signImagePath(cattivo, SEGRETO);
      assert.equal(verifyImageSig(cattivo, exp, sig, SEGRETO), true, "la firma DEVE essere valida qui");
      const r = await serviImmagine(root, { p: cattivo, e: exp, s: sig });
      assert.equal(r.status, 403, `${cattivo} non è stato bloccato`);
    }
    // e un percorso assoluto, che è l'altro modo di uscire
    assert.throws(() => resolveVaultPath(root, "/etc/passwd"), /must be relative/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("file inesistente ma dentro il vault → 404, non 403", async () => {
  // La distinzione conta: 403 dice "non ti è permesso", 404 dice "non c'è".
  // Confonderli fa credere a un problema di permessi quando manca il file.
  const { root } = await vaultConUnaImmagine();
  try {
    const manca = "wiki/media/mai-esistita.png";
    const { exp, sig } = signImagePath(manca, SEGRETO);
    assert.equal((await serviImmagine(root, { p: manca, e: exp, s: sig })).status, 404);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("⛔ un .md firmato non esce da qui: questa route serve immagini", async () => {
  const { root } = await vaultConUnaImmagine();
  try {
    await writeFile(join(root, "wiki", "segreta.md"), "contenuto riservato");
    const nota = "wiki/segreta.md";
    const { exp, sig } = signImagePath(nota, SEGRETO);
    assert.equal((await serviImmagine(root, { p: nota, e: exp, s: sig })).status, 403);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
