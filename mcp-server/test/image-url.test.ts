/**
 * Gli URL firmati delle immagini sono l'unico punto del server raggiungibile
 * **senza autenticazione**: una GET normale, senza header, scarica un file del
 * vault. Regge solo finché la firma regge.
 *
 * Il modulo è stato recuperato dal compilato in produzione — era deployato ma
 * mai committato, quindi il box della cliente ne era l'unica copia. Questi casi
 * fissano il comportamento che quel compilato aveva, così una futura riscrittura
 * non lo allarga per sbaglio.
 *
 * Il caso che conta più di tutti è la firma di lunghezza sbagliata:
 * `timingSafeEqual` **lancia** su buffer di lunghezza diversa, quindi senza il
 * controllo di lunghezza una firma corta non darebbe `false` ma un errore — e a
 * seconda di chi lo cattura, un errore può diventare un permesso.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { buildSignedImageUrl, signImagePath, verifyImageSig } from "../src/image-url.js";

const SEGRETO = "segreto-di-prova";
const PERCORSO = "wiki/media/cartella/foto.png";

test("una firma appena emessa vale", () => {
  const { exp, sig } = signImagePath(PERCORSO, SEGRETO);
  assert.equal(verifyImageSig(PERCORSO, exp, sig, SEGRETO), true);
});

test("⛔ una firma manomessa non passa", () => {
  const { exp, sig } = signImagePath(PERCORSO, SEGRETO);
  const falsa = sig.slice(0, -1) + (sig.endsWith("0") ? "1" : "0");
  assert.equal(verifyImageSig(PERCORSO, exp, falsa, SEGRETO), false);
});

test("⛔ una firma di lunghezza sbagliata torna false, non esplode", () => {
  const { exp } = signImagePath(PERCORSO, SEGRETO);
  assert.equal(verifyImageSig(PERCORSO, exp, "abc", SEGRETO), false);
  assert.equal(verifyImageSig(PERCORSO, exp, "", SEGRETO), false);
});

test("⛔ scaduta non passa", () => {
  const { sig } = signImagePath(PERCORSO, SEGRETO);
  const ieri = Math.floor(Date.now() / 1000) - 86_400;
  assert.equal(verifyImageSig(PERCORSO, ieri, sig, SEGRETO), false);
  assert.equal(verifyImageSig(PERCORSO, Number.NaN, sig, SEGRETO), false);
});

test("⛔ la firma vale per QUEL percorso e per QUELLA chiave, non per altri", () => {
  const { exp, sig } = signImagePath(PERCORSO, SEGRETO);
  assert.equal(verifyImageSig("wiki/media/altra/foto.png", exp, sig, SEGRETO), false);
  assert.equal(verifyImageSig(PERCORSO, exp, sig, "chiave-sbagliata"), false);
});

test("la scadenza è quella richiesta", () => {
  const adesso = Math.floor(Date.now() / 1000);
  const { exp } = signImagePath(PERCORSO, SEGRETO, 60);
  assert.ok(exp > adesso && exp <= adesso + 61, `scadenza fuori intervallo: ${exp - adesso}s`);
});

test("senza segreto o senza hostname non si costruisce nessun URL", () => {
  const { MCP_HTTP_TOKEN: t, MCP_PUBLIC_HOSTNAME: h } = process.env;
  try {
    delete process.env.MCP_HTTP_TOKEN;
    process.env.MCP_PUBLIC_HOSTNAME = "esempio.test";
    assert.equal(buildSignedImageUrl(PERCORSO), undefined);

    process.env.MCP_HTTP_TOKEN = SEGRETO;
    delete process.env.MCP_PUBLIC_HOSTNAME;
    assert.equal(buildSignedImageUrl(PERCORSO), undefined);

    // con entrambi: URL assoluto, e il percorso viaggia codificato
    process.env.MCP_PUBLIC_HOSTNAME = "esempio.test";
    const url = buildSignedImageUrl(PERCORSO);
    assert.ok(url?.startsWith("https://esempio.test/vimg?"), url);
    assert.ok(url?.includes(encodeURIComponent(PERCORSO)), url);
  } finally {
    if (t === undefined) delete process.env.MCP_HTTP_TOKEN;
    else process.env.MCP_HTTP_TOKEN = t;
    if (h === undefined) delete process.env.MCP_PUBLIC_HOSTNAME;
    else process.env.MCP_PUBLIC_HOSTNAME = h;
  }
});
