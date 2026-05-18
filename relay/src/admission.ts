/** Admission-HMAC verification per relay-spec.md §Identity, Keys, and Admission. */

/**
 * Verify the `Attn-Admission: v2.<base64url(hmac-sha256(admissionKey, canonicalRequest))>` header.
 *
 * `canonicalRequest` is `METHOD || "\n" || PATH || "\n" || CANONICAL-QUERY || "\n" || SHA256(body)`.
 *
 * TODO: filled in by attn-nnj.5.2 (canonicalization + HMAC verify + constant-time compare).
 */
export async function verifyAdmission(
  _request: Request,
  _admissionKey: Uint8Array,
): Promise<boolean> {
  return false;
}
