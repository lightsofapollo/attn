// Out-of-band verify-key fingerprint helper (attn-nnj.4.10).
//
// Per planning/collab/crypto-spec.md §400-402 and connection-share.md §6,
// the share dialog exposes a 12-hex-char SHA-256 truncation of the owner's
// signing key so the owner can read it aloud to the reviewer (e.g. over
// Signal) for out-of-band identity verification. The reviewer's UI checks
// the same value. This file is the pure, test-friendly computation.
//
// The input is a string that uniquely identifies the owner's signing key
// material. In production this is the hex/base64 encoding of the Ed25519
// public signing key minted by the daemon — but the function is agnostic
// to the encoding: it just hashes whatever bytes the string carries (UTF-8
// encoded) and returns the first 12 hex chars grouped 4-4-4.
//
// We deliberately do NOT depend on Node `crypto` here so this module can
// be loaded by `tsx` test harnesses AND the webview pipeline. Both expose
// `globalThis.crypto.subtle` (`SubtleCrypto`), so we go through the W3C
// Web Crypto API.

/**
 * Compute the 12-char fingerprint of a signing key, grouped `4-4-4`.
 *
 * Example:
 *
 * ```ts
 * await ownerKeyFingerprint('a'.repeat(64)); // → "535c 110a 9c95"
 * ```
 *
 * @param ownerSigningKey the owner's public signing key (any string encoding —
 *                        the bytes are hashed as UTF-8). Pass an empty string
 *                        to render a placeholder "—— —— ——".
 * @returns the formatted fingerprint or a placeholder when input is empty.
 */
export async function ownerKeyFingerprint(ownerSigningKey: string): Promise<string> {
  if (ownerSigningKey.length === 0) {
    return '—— —— ——';
  }
  const enc = new TextEncoder();
  const data = enc.encode(ownerSigningKey);
  const hash = await crypto.subtle.digest('SHA-256', data);
  const hex = bufferToHex(hash);
  return formatFingerprint(hex.slice(0, 12));
}

/**
 * Pure helper for tests / non-async callers that already hold a hex digest
 * string. Slices to 12 chars and inserts spaces every 4.
 */
export function formatFingerprint(hex12: string): string {
  const lower = hex12.toLowerCase();
  const a = lower.slice(0, 4);
  const b = lower.slice(4, 8);
  const c = lower.slice(8, 12);
  return `${a} ${b} ${c}`;
}

function bufferToHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}
