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
 *   { method, roomId, leaseId, envelopeId, expiresAt,
 *     [uploadId], [ciphertextBytes] }
 *
 * HMAC is computed with SHA-256 over the payload bytes using a per-bucket
 * signing key supplied as a deployment secret. Missing production key material
 * fails closed; local tests must opt in explicitly.
 */

import type { Env } from "./env";
import { encodeOpaqueSegment } from "./opaque-key";

const DEFAULT_UPLOAD_TTL_SECONDS = 15 * 60;
const DEFAULT_DOWNLOAD_TTL_SECONDS = 5 * 60;
const TOKEN_PREFIX = "blob-cap:v1:";

/** Worker-to-RoomDO upload path; never routed from the public HTTP surface. */
export const INTERNAL_BLOB_UPLOAD_PATH = "/__attn/internal/blob-upload";
export const INTERNAL_BLOB_LEASE_HEADER = "X-Attn-Blob-Lease";
export const INTERNAL_BLOB_UPLOAD_HEADER = "X-Attn-Blob-Upload";
export const INTERNAL_BLOB_ENVELOPE_HEADER = "X-Attn-Blob-Envelope";
export const INTERNAL_BLOB_OBJECT_KEY_VERSION_HEADER = "X-Attn-Blob-Key-Version";

/** Generation-bound R2 object key. Old caps cannot overwrite a recreated room. */
export function blobObjectKey(
  roomId: string,
  leaseId: string,
  envelopeId: string,
  objectKeyVersion: 1 | 2 = 2,
): string {
  if (objectKeyVersion === 1) {
    return `rooms/${roomId}/generations/${leaseId}/blobs/${envelopeId}`;
  }
  return `rooms_v2/${encodeOpaqueSegment(roomId)}/generations/${encodeOpaqueSegment(leaseId)}/blobs/${encodeOpaqueSegment(envelopeId)}`;
}

/**
 * Durable-share ciphertext lives outside every room/generation prefix. The
 * bucket lifecycle policy can therefore retain `shares_v1/` while continuing
 * to sweep `rooms/` and `rooms_v2/` after seven days. Both path components are
 * encoded, and `artifactId` is minted by ShareDO rather than supplied by the
 * caller, so a share upload cannot select or overwrite another R2 key.
 */
export function shareArtifactPrefix(shareId: string): string {
  return `shares_v1/${encodeOpaqueSegment(shareId)}/artifacts/`;
}

export function shareArtifactObjectKey(shareId: string, artifactId: string): string {
  return `${shareArtifactPrefix(shareId)}${encodeOpaqueSegment(artifactId)}`;
}

/** Delete all durable ciphertext for one share, with bounded pagination. */
export async function deleteShareArtifacts(env: Env, shareId: string): Promise<number> {
  let total = 0;
  let cursor: string | undefined;
  const prefix = shareArtifactPrefix(shareId);
  // A share has at most 64 live artifacts plus bounded superseded cleanup
  // work. Fifty R2 pages is intentionally far above that cap while preventing
  // a corrupted namespace from monopolizing one DO invocation.
  for (let page = 0; page < 50; page += 1) {
    const listed: R2Objects = await env.RELAY_BLOBS.list({
      prefix,
      ...(cursor === undefined ? {} : { cursor }),
    });
    const keys = listed.objects.map(object => object.key);
    if (keys.length > 0) {
      await env.RELAY_BLOBS.delete(keys);
      total += keys.length;
    }
    if (!listed.truncated) return total;
    cursor = listed.cursor;
    if (cursor === undefined) return total;
  }
  throw new Error("share artifact cleanup exceeded pagination bound");
}

export interface PresignedUploadResult {
  uploadUrl: string;
  method: "PUT";
  headers: Record<string, string>;
  expiresAt: number;
  blobKey: string;
  leaseId: string;
}

export interface PresignedDownloadResult {
  downloadUrl: string;
  method: "GET";
  expiresAt: number;
}

export interface BlobCapPayload {
  method: "PUT" | "GET";
  roomId: string;
  leaseId: string;
  envelopeId: string;
  expiresAt: number;
  /** Present only for v3. Omitted for v2 to preserve existing cap bytes. */
  protocolVersion?: 3;
  /** Absent means the legacy raw-key layout; all newly minted caps use 2. */
  objectKeyVersion?: 2;
  /** One-time reservation claim, required only for PUT caps. */
  uploadId?: string;
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
  leaseId: string,
  envelopeId: string,
  uploadId: string,
  ciphertextBytes: number,
  expiresInSeconds?: number,
  objectKeyVersion: 1 | 2 = 2,
  protocolVersion: 2 | 3 = 2,
): Promise<PresignedUploadResult> {
  const ttl = expiresInSeconds ?? DEFAULT_UPLOAD_TTL_SECONDS;
  const expiresAt = Date.now() + ttl * 1000;
  const payload: BlobCapPayload = {
    method: "PUT",
    roomId,
    leaseId,
    envelopeId,
    expiresAt,
    ...(protocolVersion === 3 ? { protocolVersion: 3 as const } : {}),
    ...(objectKeyVersion === 2 ? { objectKeyVersion: 2 as const } : {}),
    uploadId,
    ciphertextBytes,
  };
  const token = await signCap(payload, env);
  const blobKey = blobObjectKey(roomId, leaseId, envelopeId, objectKeyVersion);
  // The path is the spec's `/v2/rooms/:roomId/blobs/:envelopeId`. The client
  // appends the token as a query parameter so the URL is fully self-contained
  // (no extra header coordination needed on the upload PUT).
  const uploadUrl = `/v${protocolVersion}/rooms/${encodeURIComponent(roomId)}/blobs/${encodeURIComponent(envelopeId)}?cap=${encodeURIComponent(token)}`;
  return {
    uploadUrl,
    method: "PUT",
    headers: { "Content-Type": "application/octet-stream" },
    expiresAt,
    blobKey,
    leaseId,
  };
}

/**
 * Mint a GET capability for `/v2/rooms/:roomId/blobs/:envelopeId`. 5-minute TTL
 * default per spec.
 */
export async function presignBlobDownload(
  env: Env,
  roomId: string,
  leaseId: string,
  envelopeId: string,
  expiresInSeconds?: number,
  objectKeyVersion: 1 | 2 = 2,
  protocolVersion: 2 | 3 = 2,
): Promise<PresignedDownloadResult> {
  const ttl = expiresInSeconds ?? DEFAULT_DOWNLOAD_TTL_SECONDS;
  const expiresAt = Date.now() + ttl * 1000;
  const payload: BlobCapPayload = {
    method: "GET",
    roomId,
    leaseId,
    envelopeId,
    expiresAt,
    ...(protocolVersion === 3 ? { protocolVersion: 3 as const } : {}),
    ...(objectKeyVersion === 2 ? { objectKeyVersion: 2 as const } : {}),
  };
  const token = await signCap(payload, env);
  const downloadUrl = `/v${protocolVersion}/rooms/${encodeURIComponent(roomId)}/blobs/${encodeURIComponent(envelopeId)}?cap=${encodeURIComponent(token)}`;
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
  leaseId: string,
  envelopeId: string,
): Promise<void> {
  const key = blobObjectKey(roomId, leaseId, envelopeId, 2);
  await env.RELAY_BLOBS.delete(key);
}

/**
 * List + delete every R2 object under `rooms/<roomId>/`. Returns the number of
 * keys deleted (rough metric; lifecycle rule is the final safety net).
 */
export async function deleteRoomBlobs(env: Env, roomId: string): Promise<number> {
  let total = 0;
  const prefixes = [
    `rooms_v2/${encodeOpaqueSegment(roomId)}/`,
    `rooms/${roomId}/`,
  ];
  for (const prefix of prefixes) {
    let cursor: string | undefined;
    // Bound each layout independently so compatibility cleanup cannot starve
    // either root.
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
      if (!listed.truncated) break;
      cursor = listed.cursor;
      if (cursor === undefined) break;
    }
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
  expect: { method: "PUT" | "GET"; roomId: string; envelopeId: string; protocolVersion?: 2 | 3; now?: number },
  env: Env,
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
  const expectedMac = await hmac(payloadBytes, env);
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
  const expectedProtocolVersion = expect.protocolVersion ?? 2;
  const payloadProtocolVersion = payload.protocolVersion ?? 2;
  if (payloadProtocolVersion !== expectedProtocolVersion) return undefined;
  if (payload.protocolVersion !== undefined && payload.protocolVersion !== 3) return undefined;
  if (typeof payload.leaseId !== "string" || payload.leaseId.length === 0) return undefined;
  if (payload.objectKeyVersion !== undefined && payload.objectKeyVersion !== 2) return undefined;
  if (payload.method === "PUT" && (typeof payload.uploadId !== "string" || payload.uploadId.length === 0)) {
    return undefined;
  }
  const now = expect.now ?? Date.now();
  if (typeof payload.expiresAt !== "number" || payload.expiresAt < now) return undefined;
  return payload;
}

// --- internals -----------------------------------------------------------

/** Cached HMAC key (per isolate; the secret is stable for the isolate's life). */
let cachedSigningKey: CryptoKey | undefined;

async function getSigningKey(env: Env): Promise<CryptoKey> {
  if (cachedSigningKey !== undefined) return cachedSigningKey;
  // Production: a wrangler SECRET (`BLOB_CAP_SIGNING_KEY`). We SHA-256 the
  // secret string into a fixed 32-byte HMAC key so any-length secret works.
  // Public deployments fail closed when the secret is absent. Local tests may
  // opt in explicitly to the deterministic fallback; there is no accidental
  // production downgrade.
  const secret = env.BLOB_CAP_SIGNING_KEY;
  let material: string;
  if (typeof secret === "string" && secret.length >= 32) {
    material = secret;
  } else if (env.ALLOW_INSECURE_BLOB_CAP_KEY === "true") {
    material = "attn-relay-blobs:v1:cap-signing";
  } else {
    throw new Error("BLOB_CAP_SIGNING_KEY must be at least 32 characters");
  }
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(material)));
  cachedSigningKey = await crypto.subtle.importKey(
    "raw",
    digest,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return cachedSigningKey;
}

async function hmac(data: Uint8Array, env: Env): Promise<Uint8Array> {
  const key = await getSigningKey(env);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, data));
}

async function signCap(payload: BlobCapPayload, env: Env): Promise<string> {
  // Canonical JSON: sort keys lexicographically so the HMAC reproduces.
  const canonical = canonicalizePayload(payload);
  const payloadBytes = new TextEncoder().encode(canonical);
  const mac = await hmac(payloadBytes, env);
  return `${TOKEN_PREFIX}${base64UrlEncode(payloadBytes)}:${base64UrlEncode(mac)}`;
}

function canonicalizePayload(p: BlobCapPayload): string {
  // Keep field order stable for HMAC reproduction.
  const ordered: Record<string, unknown> = {
    method: p.method,
    roomId: p.roomId,
    leaseId: p.leaseId,
    envelopeId: p.envelopeId,
    expiresAt: p.expiresAt,
  };
  if (p.protocolVersion === 3) {
    ordered.protocolVersion = 3;
  }
  if (p.objectKeyVersion === 2) {
    ordered.objectKeyVersion = 2;
  }
  if (typeof p.uploadId === "string") {
    ordered.uploadId = p.uploadId;
  }
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
