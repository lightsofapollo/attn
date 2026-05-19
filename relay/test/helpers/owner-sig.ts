/**
 * Shared test helper for building `Attn-Owner-Signature` headers and matching
 * Ed25519 keypairs. Used by:
 *   - room-create.test.ts (H1 fix coverage, attn-nnj.5.17)
 *   - delete-room.test.ts (DELETE owner-sig)
 *   - acks.test.ts (delete-flag ACKs)
 *
 * Wire format mirrors `relay/src/owner-sig.ts`:
 *
 *   Attn-Owner-Signature: <base64url(Ed25519(canonicalRequest))>
 *
 * where canonicalRequest is the same byte string admission HMAC consumes
 * (`relay/src/admission.ts::canonicalRequest`). Reusing those bytes keeps the
 * test surface aligned with how the relay verifies — drift here would mask
 * real protocol bugs.
 */

import { base64UrlEncode, canonicalRequest } from "../../src/admission";

export interface SubtleEd25519Keypair {
  publicKey: CryptoKey;
  privateKey: CryptoKey;
  publicKeyBytes: Uint8Array;
}

/** Generate a fresh extractable Ed25519 keypair via SubtleCrypto. */
export async function generateEd25519Keypair(): Promise<SubtleEd25519Keypair> {
  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const rawKey = await crypto.subtle.exportKey("raw", kp.publicKey);
  if (!(rawKey instanceof ArrayBuffer)) {
    throw new Error("exportKey('raw') unexpectedly returned a JWK");
  }
  return {
    publicKey: kp.publicKey,
    privateKey: kp.privateKey,
    publicKeyBytes: new Uint8Array(rawKey),
  };
}

/**
 * Build an `Attn-Owner-Signature` header value (just `base64url(sig)` — no
 * version prefix) over canonicalRequest for `(method, url, body)`.
 *
 * Pass `body: undefined` for verb-only requests (DELETE, GET); the canonical
 * request still includes `SHA256("")` so the relay's verifier reproduces the
 * same bytes.
 */
export async function ownerSignatureHeader(opts: {
  method: string;
  url: string;
  body?: string;
  privateKey: CryptoKey;
}): Promise<string> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  const signing = new Request(opts.url, {
    method: opts.method,
    headers,
    body: opts.body,
  });
  const canonical = await canonicalRequest(signing, new URL(opts.url).pathname);
  const sig = new Uint8Array(
    await crypto.subtle.sign({ name: "Ed25519" }, opts.privateKey, canonical),
  );
  return base64UrlEncode(sig);
}
