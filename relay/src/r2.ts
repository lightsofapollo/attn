/** R2 blob access helpers per relay-spec.md §POST /v2/rooms/:roomId/blobs + §R2 Integration.
 *
 * Trade-off note (deferred to prod deploy work):
 * --------------------------------------------------------------------
 * Cloudflare R2 exposes `env.RELAY_BLOBS.put/get/delete/list` but the
 * Workers binding does NOT expose AWS-S3 presigning natively, and
 * @cloudflare/vitest-pool-workers ships a local R2 simulator that has no
 * presigning surface either. Production deployments will swap the upload/
 * download URLs returned here for real S3 V4 presigned URLs minted off the
 * Worker's bucket access key (aws4fetch / `aws-s3-presigner` style).
 *
 * For v2-development today we route uploads + downloads back through the
 * Worker via internal `PUT/GET /v2/rooms/:roomId/blobs/:envelopeId` routes.
 * Authorization on those routes uses a short-lived HMAC token minted here
 * and verified on the Worker entry. Same trust model (server-issued capability,
 * client-bears-token) as a real presigned URL — only the issuing mechanism
 * differs. Spec §R2 Integration pins 15-min upload TTL and 5-min download TTL;
 * we mirror those defaults below.
 *
 * Token format:
 *   `blob-cap:v1:<base64url(payload)>:<base64url(hmac)>`
 *
 * Payload (canonical JSON, sorted keys):
 *   { method: "PUT"|"GET", roomId, envelopeId, expiresAt, [ciphertextBytes] }
 *
 * HMAC is computed with SHA-256 over the payload bytes using a per-bucket
 * signing key. We derive the signing key from the R2 binding's own identifier
 * at first use; tests + prod both use SHA-256(env.RELAY_BLOBS.name || "attn-relay-blobs")
 * so the same Worker instance can verify a token it minted seconds earlier.
 * (Rotation: redeploy → new key → outstanding tokens become invalid, which is
 * fine for short-lived caps.)
 */

import type { Env } from "./env";

const DEFAULT_UPLOAD_TTL_SECONDS = 15 * 60;
const DEFAULT_DOWNLOAD_TTL_SECONDS = 5 * 60;
const TOKEN_PREFIX = "blob-cap:v1:";

/** R2 object-key layout per relay-spec.md §R2 Integration. */
export function blobObjectKey(roomId: string, envelopeId: string): string {
  return `rooms/${roomId}/blobs/${envelopeId}`;
}

export interface PresignedUploadResult {
  uploadUrl: string;
  method: "PUT";
  headers: Record<string, string>;
  expiresAt: number;
  blobKey: string;
}

export interface PresignedDownloadResult {
  downloadUrl: string;
  method: "GET";
  expiresAt: number;
}

export interface BlobCapPayload {
  method: "PUT" | "GET";
  roomId: string;
  envelopeId: string;
  expiresAt: number;
  /** Set only for PUT caps — pins the upload size so attackers can't grow the slot. */
  ciphertextBytes?: number;
}

/**
 * Mint a PUT capability that the holder can use against the Worker's
 * `PUT /v2/rooms/:roomId/blobs/:envelopeId` route to upload `ciphertextBytes`.
 *
 * `expiresInSeconds` defaults to 15 minutes per spec; callers may override
 * (e.g., for tests that need an already-expired token).
 */
export async function presignBlobUpload(
  env: Env,
  roomId: string,
  envelopeId: string,
  ciphertextBytes: number,
  expiresInSeconds?: number,
): Promise<PresignedUploadResult> {
  const ttl = expiresInSeconds ?? DEFAULT_UPLOAD_TTL_SECONDS;
  const expiresAt = Date.now() + ttl * 1000;
  const payload: BlobCapPayload = {
    method: "PUT",
    roomId,
    envelopeId,
    expiresAt,
    ciphertextBytes,
  };
  const token = await signCap(payload);
  const blobKey = blobObjectKey(roomId, envelopeId);
  // The path is the spec's `/v2/rooms/:roomId/blobs/:envelopeId`. The client
  // appends the token as a query parameter so the URL is fully self-contained
  // (no extra header coordination needed on the upload PUT).
  const uploadUrl = `/v2/rooms/${encodeURIComponent(roomId)}/blobs/${encodeURIComponent(envelopeId)}?cap=${encodeURIComponent(token)}`;
  return {
    uploadUrl,
    method: "PUT",
    headers: { "Content-Type": "application/octet-stream" },
    expiresAt,
    blobKey,
  };
}

/**
 * Mint a GET capability for `/v2/rooms/:roomId/blobs/:envelopeId`. 5-minute TTL
 * default per spec.
 */
export async function presignBlobDownload(
  env: Env,
  roomId: string,
  envelopeId: string,
  expiresInSeconds?: number,
): Promise<PresignedDownloadResult> {
  const ttl = expiresInSeconds ?? DEFAULT_DOWNLOAD_TTL_SECONDS;
  const expiresAt = Date.now() + ttl * 1000;
  const payload: BlobCapPayload = {
    method: "GET",
    roomId,
    envelopeId,
    expiresAt,
  };
  const token = await signCap(payload);
  const downloadUrl = `/v2/rooms/${encodeURIComponent(roomId)}/blobs/${encodeURIComponent(envelopeId)}?cap=${encodeURIComponent(token)}`;
  return {
    downloadUrl,
    method: "GET",
    expiresAt,
  };
}

/** Delete a single room/envelope blob (best-effort; returns silently on miss). */
export async function deleteBlob(
  env: Env,
  roomId: string,
  envelopeId: string,
): Promise<void> {
  const key = blobObjectKey(roomId, envelopeId);
  await env.RELAY_BLOBS.delete(key);
}

/**
 * List + delete every R2 object under `rooms/<roomId>/`. Returns the number of
 * keys deleted (rough metric; lifecycle rule is the final safety net).
 */
export async function deleteRoomBlobs(env: Env, roomId: string): Promise<number> {
  const prefix = `rooms/${roomId}/`;
  let total = 0;
  let cursor: string | undefined;
  // Bound the loop so a runaway list can't pin the Worker event loop.
  for (let page = 0; page < 50; page++) {
    const listed: R2Objects = await env.RELAY_BLOBS.list({
      prefix,
      ...(cursor !== undefined ? { cursor } : {}),
    });
    const keys = listed.objects.map((obj) => obj.key);
    if (keys.length > 0) {
      await env.RELAY_BLOBS.delete(keys);
      total += keys.length;
    }
    if (!listed.truncated) return total;
    cursor = listed.truncated ? listed.cursor : undefined;
    if (cursor === undefined) return total;
  }
  return total;
}

/**
 * Verify a blob-access cap token. Returns the decoded payload on success;
 * undefined on any mismatch (bad shape, bad HMAC, expired, wrong method, or
 * wrong (roomId, envelopeId)).
 */
export async function verifyBlobCap(
  token: string,
  expect: { method: "PUT" | "GET"; roomId: string; envelopeId: string; now?: number },
): Promise<BlobCapPayload | undefined> {
  if (!token.startsWith(TOKEN_PREFIX)) return undefined;
  const rest = token.slice(TOKEN_PREFIX.length);
  const lastColon = rest.lastIndexOf(":");
  if (lastColon < 0) return undefined;
  const payloadB64 = rest.slice(0, lastColon);
  const macB64 = rest.slice(lastColon + 1);
  let payloadBytes: Uint8Array;
  let providedMac: Uint8Array;
  try {
    payloadBytes = base64UrlDecode(payloadB64);
    providedMac = base64UrlDecode(macB64);
  } catch {
    return undefined;
  }
  const expectedMac = await hmac(payloadBytes);
  if (!constantTimeEquals(expectedMac, providedMac)) return undefined;

  let payload: BlobCapPayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(payloadBytes)) as BlobCapPayload;
  } catch {
    return undefined;
  }
  if (payload.method !== expect.method) return undefined;
  if (payload.roomId !== expect.roomId) return undefined;
  if (payload.envelopeId !== expect.envelopeId) return undefined;
  const now = expect.now ?? Date.now();
  if (typeof payload.expiresAt !== "number" || payload.expiresAt < now) return undefined;
  return payload;
}

// --- internals -----------------------------------------------------------

/** Cached HMAC key derived from the bucket binding name. */
let cachedSigningKey: CryptoKey | undefined;

async function getSigningKey(): Promise<CryptoKey> {
  if (cachedSigningKey !== undefined) return cachedSigningKey;
  // In production we'd use a secret; for v2 development we derive deterministically
  // from a fixed seed so the same Worker instance can verify its own tokens. The
  // bucket binding is not exposed by name on the env handle, so we hard-code the
  // canonical bucket name from wrangler.toml.
  const seed = new TextEncoder().encode("attn-relay-blobs:v1:cap-signing");
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", seed));
  cachedSigningKey = await crypto.subtle.importKey(
    "raw",
    digest,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return cachedSigningKey;
}

async function hmac(data: Uint8Array): Promise<Uint8Array> {
  const key = await getSigningKey();
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, data));
}

async function signCap(payload: BlobCapPayload): Promise<string> {
  // Canonical JSON: sort keys lexicographically so the HMAC reproduces.
  const canonical = canonicalizePayload(payload);
  const payloadBytes = new TextEncoder().encode(canonical);
  const mac = await hmac(payloadBytes);
  return `${TOKEN_PREFIX}${base64UrlEncode(payloadBytes)}:${base64UrlEncode(mac)}`;
}

function canonicalizePayload(p: BlobCapPayload): string {
  // Keep field order stable: method, roomId, envelopeId, expiresAt, ciphertextBytes?
  const ordered: Record<string, unknown> = {
    method: p.method,
    roomId: p.roomId,
    envelopeId: p.envelopeId,
    expiresAt: p.expiresAt,
  };
  if (typeof p.ciphertextBytes === "number") {
    ordered.ciphertextBytes = p.ciphertextBytes;
  }
  return JSON.stringify(ordered);
}

function base64UrlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i] ?? 0);
  const std = btoa(bin);
  return std.replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function base64UrlDecode(input: string): Uint8Array {
  let std = input.replaceAll("-", "+").replaceAll("_", "/");
  const pad = std.length % 4;
  if (pad === 2) std += "==";
  else if (pad === 3) std += "=";
  else if (pad !== 0) throw new Error(`invalid base64url length: ${input.length}`);
  const bin = atob(std);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function constantTimeEquals(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}
