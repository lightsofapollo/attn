/** Per-device + per-IP rate limiting per relay-spec.md §Anti-Abuse. */

/**
 * Token-bucket limiters keyed by `(roomId, deviceId)` and by source IP. Default
 * cap: 120 writes/min/device; over-cap returns `429` with `retryAfterMs`.
 *
 * TODO: filled in by attn-nnj.5.13 (in-DO sliding window + IP bucket in env).
 */
export async function checkRateLimit(
  _roomId: string,
  _deviceId: string,
  _request: Request,
): Promise<{ ok: true } | { ok: false; retryAfterMs: number }> {
  return { ok: true };
}
