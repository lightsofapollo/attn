/** R2 presigned URL helpers per relay-spec.md §R2 Integration. */

import type { Env } from "./env";

/**
 * Mint a short-lived PUT URL for an encrypted snapshot blob. Object key is
 * `rooms/<roomId>/snapshots/<blobId>`; TTL = 7d enforced by bucket lifecycle.
 *
 * TODO: filled in by attn-nnj.5.10 (R2 presign + content-length + content-type guard).
 */
export async function presignUpload(
  _env: Env,
  _roomId: string,
  _blobId: string,
  _expectedBytes: number,
): Promise<{ url: string; expiresAt: number }> {
  return { url: "", expiresAt: 0 };
}

/**
 * Mint a short-lived GET URL for downloading an encrypted snapshot blob.
 *
 * TODO: filled in by attn-nnj.5.10.
 */
export async function presignDownload(
  _env: Env,
  _roomId: string,
  _blobId: string,
): Promise<{ url: string; expiresAt: number }> {
  return { url: "", expiresAt: 0 };
}
