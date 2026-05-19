/** Owner Ed25519 signature verification per relay-spec.md §Owner Distinction.
 *
 * Wire format:
 *
 *   Attn-Owner-Signature: <base64url(Ed25519(canonicalRequest))>
 *
 * `canonicalRequest` is the same byte string used by admission HMAC
 * (see ./admission.ts). Reusing it keeps the signing surface DRY: clients
 * compute the canonical bytes once per request and feed them to both the
 * admission HMAC and the owner Ed25519 signature.
 *
 * Required for owner-privileged operations:
 *   - POST /v2/rooms/:roomId/acks  when the ack carries a delete-flag and
 *     policy.deleteEventsAfterOwnerAck = true (wired by attn-nnj.5.8 / 5.9)
 *   - DELETE /v2/rooms/:roomId                    (wired by attn-nnj.5.9)
 *
 * The verifier loads `ownerSigningKey` (32-byte Ed25519 public key) from DO
 * storage at `meta:owner_signing_key`. That storage slot is written by the
 * room-create endpoint (attn-nnj.5.5) from the body of `POST /v2/rooms/:roomId`
 * and is immutable for the life of the room.
 */

import { base64UrlDecode, canonicalRequest } from "./admission";

const OWNER_SIG_HEADER = "Attn-Owner-Signature";
const ED25519_SIG_BYTE_LEN = 64;
const ED25519_PUB_BYTE_LEN = 32;

export class OwnerSigError extends Error {
  public readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "OwnerSigError";
    this.code = code;
  }
}

/**
 * Verify `Attn-Owner-Signature` against `ownerSigningKey`.
 *
 * Throws:
 *   - `OwnerSigError("ATTN_OWNER_SIG_REQUIRED")` when the header is absent.
 *   - `OwnerSigError("ATTN_OWNER_SIG_INVALID")` for any other failure: malformed
 *     base64url, wrong signature length, wrong public key length, or
 *     signature/canonical-bytes mismatch.
 */
export async function verifyOwnerSignature(
  request: Request,
  urlPath: string,
  ownerSigningKey: Uint8Array,
): Promise<void> {
  const header = request.headers.get(OWNER_SIG_HEADER);
  if (header === null || header === "") {
    throw new OwnerSigError(
      "ATTN_OWNER_SIG_REQUIRED",
      "missing Attn-Owner-Signature header",
    );
  }

  if (ownerSigningKey.length !== ED25519_PUB_BYTE_LEN) {
    throw new OwnerSigError(
      "ATTN_OWNER_SIG_INVALID",
      `owner signing key must be ${ED25519_PUB_BYTE_LEN} bytes (got ${ownerSigningKey.length})`,
    );
  }

  let signature: Uint8Array;
  try {
    signature = base64UrlDecode(header);
  } catch (err) {
    throw new OwnerSigError(
      "ATTN_OWNER_SIG_INVALID",
      `Attn-Owner-Signature base64url decode failed: ${(err as Error).message}`,
    );
  }
  if (signature.length !== ED25519_SIG_BYTE_LEN) {
    throw new OwnerSigError(
      "ATTN_OWNER_SIG_INVALID",
      `Attn-Owner-Signature must be ${ED25519_SIG_BYTE_LEN} bytes (got ${signature.length})`,
    );
  }

  const canonical = await canonicalRequest(request, urlPath);

  let publicKey: CryptoKey;
  try {
    publicKey = await crypto.subtle.importKey(
      "raw",
      ownerSigningKey,
      { name: "Ed25519" },
      false,
      ["verify"],
    );
  } catch (err) {
    throw new OwnerSigError(
      "ATTN_OWNER_SIG_INVALID",
      `owner signing key import failed: ${(err as Error).message}`,
    );
  }

  const ok = await crypto.subtle.verify(
    { name: "Ed25519" },
    publicKey,
    signature,
    canonical,
  );
  if (!ok) {
    throw new OwnerSigError(
      "ATTN_OWNER_SIG_INVALID",
      "owner signature does not match canonicalRequest",
    );
  }
}

