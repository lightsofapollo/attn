/** Owner Ed25519 signature verification per relay-spec.md §Owner Distinction. */

/**
 * Verify `Attn-Owner-Signature: <base64url(ed25519(canonicalRequest))>` against the
 * `ownerSigningKeyId` stored at room-create time. Required for privileged ops
 * (ACK with delete-flag, room DELETE).
 *
 * TODO: filled in by attn-nnj.5.3 (Ed25519 verify via WebCrypto + canonicalization shared
 * with admission.ts).
 */
export async function verifyOwnerSignature(
  _request: Request,
  _ownerSigningPublicKey: Uint8Array,
): Promise<boolean> {
  return false;
}
