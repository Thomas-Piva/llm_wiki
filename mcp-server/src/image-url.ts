import { createHmac, timingSafeEqual } from "node:crypto";

// Signs a vault-relative image path so a plain HTTPS GET (no Authorization
// header) can fetch that one image. ChatGPT — and most connectors — render a
// markdown image URL but do NOT display MCP inline image content, so
// vault_read_image also hands back a link to this signed endpoint. The HMAC
// binds the exact path to the server's secret and expires, so the URL is
// unguessable, short-lived, and grants read of that single image only.
//
// The signed string is the path AS THE CALLER PASSED IT (possibly note-style,
// e.g. "dropbox/.../photo.jpg"); the /vimg route resolves it through the same
// readImage() raw/sources fallback, so signature and lookup always agree.
//
// ⚠️ Recovered from the compiled `dist/src/image-url.js` running in production:
// this module had been deployed but never committed, so the box was the only
// copy of it. Verified by recompiling and diffing against that JS.

const SEP = "\n";

export function signImagePath(
  relPath: string,
  secret: string,
  ttlSec = 3600
): { exp: number; sig: string } {
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  const sig = createHmac("sha256", secret).update(relPath + SEP + exp).digest("hex");
  return { exp, sig };
}

export function verifyImageSig(
  relPath: string,
  exp: number,
  sig: string,
  secret: string
): boolean {
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return false;
  const expected = createHmac("sha256", secret).update(relPath + SEP + exp).digest("hex");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  // Length check first: timingSafeEqual throws on mismatched lengths, and a
  // forged signature of the wrong size must be a plain false, not a crash.
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Full signed URL for a vault image, or undefined if the server can't sign
 *  (no secret) or has no public hostname to build an absolute URL from. */
export function buildSignedImageUrl(relPath: string): string | undefined {
  const secret = process.env.MCP_HTTP_TOKEN;
  const host = process.env.MCP_PUBLIC_HOSTNAME;
  if (!secret || !host) return undefined;
  const { exp, sig } = signImagePath(relPath, secret);
  const q = new URLSearchParams({ p: relPath, e: String(exp), s: sig });
  return `https://${host}/vimg?${q.toString()}`;
}
