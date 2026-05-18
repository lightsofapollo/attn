/** Hashcash Proof-of-Work verification per relay-spec.md §Proof of Work + crypto-spec.md §Hashcash. */

/**
 * Verify the `Attn-PoW` header token:
 *
 *   attn-pow:v2:<difficulty>:<expiresAt>:<roomId>:<deviceId>:<requestPathHash>:<rand>:<counter>
 *
 * Bound to `(method, path)` via `requestPathHash`. Replay-protected via per-room
 * seen-token set with TTL = token expiry. Difficulty clamped to [MIN_POW_BITS, MAX_POW_BITS].
 *
 * TODO: filled in by attn-nnj.5.4 (parse + difficulty check + replay set + clock skew).
 */
export async function verifyPow(
  _request: Request,
  _roomId: string,
  _requiredBits: number,
): Promise<boolean> {
  return false;
}
