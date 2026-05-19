/**
 * Integration coverage for `POST /v2/rooms/:roomId/blobs` + the Worker-backed
 * `PUT/GET /v2/rooms/:roomId/blobs/:envelopeId` upload/download routes
 * (attn-nnj.5.8).
 *
 * Spec: planning/collab/relay-spec.md §POST /v2/rooms/:roomId/blobs +
 *       §R2 Integration. Amendments: #9 (R2 7-day lifecycle as safety net).
 *
 * Test surface:
 *   1. Happy path: presign + PUT + GET round-trips the bytes.
 *   2. Below 1 MiB → 400 ATTN_BLOB_TOO_SMALL (client must use inline path).
 *   3. Would exceed maxRoomBytes → 507 ATTN_ROOM_STORAGE_FULL.
 *   4. Unregistered device → 400 ATTN_DEVICE_UNREGISTERED.
 *   5. PUT without cap → 401 ATTN_BLOB_CAP_MISSING.
 *   6. PUT with mismatched body length → 400 ATTN_BLOB_LENGTH_MISMATCH.
 *   7. GET on a never-uploaded key → 404 ATTN_BLOB_NOT_FOUND.
 *   8. Room delete (5.10) sweeps the R2 blobs.
 */

import { SELF, env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { base64UrlEncode, canonicalRequest } from "../../src/admission";
import { canonicalize, type CanonicalValue } from "../../src/canonical";
import type { Env } from "../../src/env";
import { presignBlobDownload } from "../../src/r2";
import type { RoomPolicy } from "../../src/schema";
import { FIXED_POW_RAND, mintPowForTests } from "../helpers/pow";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

const URL_BASE = "https://relay.example";

// --- shared builders -----------------------------------------------------

function makeAdmissionKey(seed: number): Uint8Array {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = (seed + i) & 0xff;
  return bytes;
}

function defaultPolicy(overrides: Partial<RoomPolicy> = {}): RoomPolicy {
  return {
    mode: "live",
    maxPeers: 4,
    maxSnapshotBytes: 5_242_880, // 5 MiB
    maxEventBytes: 8_192,
    maxEvents: 100,
    expiresAt: Date.now() + 60 * 60 * 1000,
    idleTimeoutMs: 30 * 60 * 1000,
    longSession: false,
    powBits: 12,
    deleteEventsAfterOwnerAck: false,
    allowBrowser: false,
    allowRemoteAgents: false,
    ...overrides,
  };
}

async function hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data));
}

async function admissionHeaderFor(opts: {
  method: string;
  url: string;
  body?: string;
  admissionKey: Uint8Array;
}): Promise<string> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  const signing = new Request(opts.url, {
    method: opts.method,
    headers,
    body: opts.body,
  });
  const canonical = await canonicalRequest(signing, new URL(opts.url).pathname);
  const hmac = await hmacSha256(opts.admissionKey, canonical);
  return `v2.${base64UrlEncode(hmac)}`;
}

let roomCounter = 0;
function uniqueRoomId(label: string): string {
  roomCounter += 1;
  return `${label}-${Date.now().toString(36)}-${roomCounter}`;
}

async function createRoom(opts: {
  roomId: string;
  policy?: Partial<RoomPolicy>;
  ownerSigningKey: Uint8Array;
}): Promise<Uint8Array> {
  const admissionKey = makeAdmissionKey((roomCounter * 13) & 0xff);
  const body = JSON.stringify({
    v: 2,
    policy: defaultPolicy(opts.policy ?? {}),
    ownerSigningKey: base64UrlEncode(opts.ownerSigningKey),
    admissionKey: base64UrlEncode(admissionKey),
  });
  const res = await SELF.fetch(`${URL_BASE}/v2/rooms/${opts.roomId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  if (res.status !== 201) {
    throw new Error(`room create failed: ${res.status} ${await res.text()}`);
  }
  return admissionKey;
}

// --- device builder ------------------------------------------------------

interface SubtleKeypair {
  publicKey: CryptoKey;
  privateKey: CryptoKey;
  publicKeyBytes: Uint8Array;
}

async function generateEd25519Keypair(): Promise<SubtleKeypair> {
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

interface DeviceBodyInput {
  deviceId: string;
  participantId: string;
  publicSigningKey: string;
  kind?: "owner" | "reviewer" | "agent";
}

async function buildSignedDeviceBody(
  input: DeviceBodyInput,
  privateKey: CryptoKey,
): Promise<string> {
  const unsigned: Record<string, CanonicalValue> = {
    deviceId: input.deviceId,
    participantId: input.participantId,
    publicSigningKey: input.publicSigningKey,
    publicEncryptionKey: base64UrlEncode(new Uint8Array(32).fill(0xa1)),
    client: "attn-native",
    kind: input.kind ?? "reviewer",
  };
  const canonical = new TextEncoder().encode(canonicalize(unsigned));
  const sig = new Uint8Array(
    await crypto.subtle.sign({ name: "Ed25519" }, privateKey, canonical),
  );
  return JSON.stringify({ ...unsigned, selfSignature: base64UrlEncode(sig) });
}

let powExpiresAtBump = 0;
function nextPowExpiresAt(): number {
  powExpiresAtBump += 1;
  return Date.now() + 5 * 60 * 1000 + powExpiresAtBump;
}

async function mintDevicePow(roomId: string, deviceId: string): Promise<string> {
  return mintPowForTests({
    roomId,
    deviceId,
    method: "POST",
    path: `/v2/rooms/${roomId}/devices`,
    difficulty: 12,
    expiresAt: nextPowExpiresAt(),
    rand: FIXED_POW_RAND,
  });
}

async function mintBlobsPow(roomId: string, deviceId: string): Promise<string> {
  return mintPowForTests({
    roomId,
    deviceId,
    method: "POST",
    path: `/v2/rooms/${roomId}/blobs`,
    difficulty: 12,
    expiresAt: nextPowExpiresAt(),
    rand: FIXED_POW_RAND,
  });
}

async function registerDevice(opts: {
  roomId: string;
  admissionKey: Uint8Array;
  deviceId: string;
  participantId: string;
  kind?: "owner" | "reviewer" | "agent";
}): Promise<SubtleKeypair> {
  const kp = await generateEd25519Keypair();
  const body = await buildSignedDeviceBody(
    {
      deviceId: opts.deviceId,
      participantId: opts.participantId,
      publicSigningKey: base64UrlEncode(kp.publicKeyBytes),
      kind: opts.kind ?? "reviewer",
    },
    kp.privateKey,
  );
  const url = `${URL_BASE}/v2/rooms/${opts.roomId}/devices`;
  const adm = await admissionHeaderFor({
    method: "POST",
    url,
    body,
    admissionKey: opts.admissionKey,
  });
  const pow = await mintDevicePow(opts.roomId, opts.deviceId);
  const res = await SELF.fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Attn-Admission": adm,
      "Attn-PoW": pow,
    },
    body,
  });
  if (res.status !== 204) {
    throw new Error(`device register failed: ${res.status} ${await res.text()}`);
  }
  return kp;
}

// --- POST /blobs builder -------------------------------------------------

interface PresignRequestOpts {
  roomId: string;
  admissionKey: Uint8Array;
  envelopeId: string;
  authorId: string;
  deviceId: string;
  ciphertextBytes: number;
  /** PoW device override (defaults to deviceId). */
  powDeviceId?: string;
  omitAdmission?: boolean;
  omitPow?: boolean;
}

async function postBlobPresign(opts: PresignRequestOpts): Promise<Response> {
  const url = `${URL_BASE}/v2/rooms/${opts.roomId}/blobs`;
  const body = JSON.stringify({
    envelopeId: opts.envelopeId,
    authorId: opts.authorId,
    deviceId: opts.deviceId,
    ciphertextBytes: opts.ciphertextBytes,
  });
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (!opts.omitAdmission) {
    headers["Attn-Admission"] = await admissionHeaderFor({
      method: "POST",
      url,
      body,
      admissionKey: opts.admissionKey,
    });
  }
  if (!opts.omitPow) {
    headers["Attn-PoW"] = await mintBlobsPow(
      opts.roomId,
      opts.powDeviceId ?? opts.deviceId,
    );
  }
  return SELF.fetch(url, { method: "POST", headers, body });
}

interface PresignedUploadResponse {
  uploadUrl: string;
  method: "PUT";
  headers: Record<string, string>;
  expiresAt: number;
  blobKey: string;
}

interface ErrorResponse {
  error: { code: string; message: string };
}

// Above-threshold default size for happy-path tests. 1 MiB + small slop keeps
// the request body small enough that vitest stays fast.
const OVER_THRESHOLD_BYTES = 1 * 1024 * 1024 + 1024; // 1 MiB + 1 KiB

function makeCiphertext(bytes: number, seed: number): Uint8Array {
  const out = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i++) out[i] = (seed + i * 37) & 0xff;
  return out;
}

// --- tests ---------------------------------------------------------------

describe("POST /v2/rooms/:roomId/blobs — happy path", () => {
  it("returns a presigned upload URL for an above-1MiB request", async () => {
    const roomId = uniqueRoomId("blob-presign");
    const owner = await generateEd25519Keypair();
    const admissionKey = await createRoom({ roomId, ownerSigningKey: owner.publicKeyBytes });
    await registerDevice({
      roomId,
      admissionKey,
      deviceId: "dev-a",
      participantId: "alice",
    });

    const res = await postBlobPresign({
      roomId,
      admissionKey,
      envelopeId: "blob-env-1",
      authorId: "alice",
      deviceId: "dev-a",
      ciphertextBytes: OVER_THRESHOLD_BYTES,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as PresignedUploadResponse;
    expect(body.method).toBe("PUT");
    expect(body.blobKey).toBe(`rooms/${roomId}/blobs/blob-env-1`);
    expect(body.uploadUrl).toContain("/v2/rooms/");
    expect(body.uploadUrl).toContain("cap=");
    expect(body.expiresAt).toBeGreaterThan(Date.now());
    expect(body.headers["Content-Type"]).toBe("application/octet-stream");
  });

  it("uploads bytes via PUT and retrieves them via GET (round-trip)", async () => {
    const roomId = uniqueRoomId("blob-rt");
    const owner = await generateEd25519Keypair();
    const admissionKey = await createRoom({ roomId, ownerSigningKey: owner.publicKeyBytes });
    await registerDevice({
      roomId,
      admissionKey,
      deviceId: "dev-rt",
      participantId: "bob",
    });

    const ciphertext = makeCiphertext(OVER_THRESHOLD_BYTES, 0x42);
    const presignRes = await postBlobPresign({
      roomId,
      admissionKey,
      envelopeId: "blob-rt-1",
      authorId: "bob",
      deviceId: "dev-rt",
      ciphertextBytes: ciphertext.byteLength,
    });
    expect(presignRes.status).toBe(200);
    const presigned = (await presignRes.json()) as PresignedUploadResponse;

    // PUT to the cap URL. Worker entry handles it.
    const putRes = await SELF.fetch(`${URL_BASE}${presigned.uploadUrl}`, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body: ciphertext,
    });
    expect(putRes.status).toBe(204);

    // Mint a download cap (in v2 the GET endpoint owning this lives in 5.10/5.x;
    // for now tests mint directly via the r2.ts helper).
    const download = await presignBlobDownload(env, roomId, "blob-rt-1");
    const getRes = await SELF.fetch(`${URL_BASE}${download.downloadUrl}`, { method: "GET" });
    expect(getRes.status).toBe(200);
    const fetched = new Uint8Array(await getRes.arrayBuffer());
    expect(fetched.byteLength).toBe(ciphertext.byteLength);
    // Spot-check a few bytes (deep compare on 1 MiB is slow in vitest).
    expect(fetched[0]).toBe(ciphertext[0]);
    expect(fetched[1024]).toBe(ciphertext[1024]);
    expect(fetched[ciphertext.byteLength - 1]).toBe(ciphertext[ciphertext.byteLength - 1]);
  });
});

describe("POST /v2/rooms/:roomId/blobs — threshold gate", () => {
  it("rejects ciphertextBytes <= 1 MiB with 400 ATTN_BLOB_TOO_SMALL", async () => {
    const roomId = uniqueRoomId("blob-small");
    const owner = await generateEd25519Keypair();
    const admissionKey = await createRoom({ roomId, ownerSigningKey: owner.publicKeyBytes });
    await registerDevice({
      roomId,
      admissionKey,
      deviceId: "dev-small",
      participantId: "carol",
    });

    const res = await postBlobPresign({
      roomId,
      admissionKey,
      envelopeId: "blob-small-1",
      authorId: "carol",
      deviceId: "dev-small",
      ciphertextBytes: 1 * 1024 * 1024, // exactly 1 MiB → still rejected (> threshold required)
    });
    expect(res.status).toBe(400);
    const err = (await res.json()) as ErrorResponse;
    expect(err.error.code).toBe("ATTN_BLOB_TOO_SMALL");
  });
});

describe("POST /v2/rooms/:roomId/blobs — room cap", () => {
  it("rejects when reservation would exceed HARD_MAX_ROOM_BYTES with 507 ATTN_ROOM_STORAGE_FULL", async () => {
    // HARD_MAX_ROOM_BYTES is 25 MiB. We seed meta:bytes_used_r2 close to the
    // cap so a single 2 MiB blob presign trips the overflow check — without
    // having to upload many blobs (which would also need to fit under
    // policy.maxSnapshotBytes individually).
    const roomId = uniqueRoomId("blob-overcap");
    const owner = await generateEd25519Keypair();
    const admissionKey = await createRoom({ roomId, ownerSigningKey: owner.publicKeyBytes });
    await registerDevice({
      roomId,
      admissionKey,
      deviceId: "dev-oc",
      participantId: "dave",
    });

    // Pre-fill the room's accounted R2 bytes to 24 MiB so a 2 MiB ask overflows
    // the 25 MiB HARD_MAX_ROOM_BYTES.
    const id = env.RELAY_ROOMS.idFromName(roomId);
    const stub = env.RELAY_ROOMS.get(id);
    await runInDurableObject(stub, async (_inst, state) => {
      await state.storage.put("meta:bytes_used_r2", 24 * 1024 * 1024);
    });

    const res = await postBlobPresign({
      roomId,
      admissionKey,
      envelopeId: "blob-oc-1",
      authorId: "dave",
      deviceId: "dev-oc",
      ciphertextBytes: 2 * 1024 * 1024, // 2 MiB; below per-snapshot 5 MiB cap but pushes us over the room cap
    });
    expect(res.status).toBe(507);
    const err = (await res.json()) as ErrorResponse;
    expect(err.error.code).toBe("ATTN_ROOM_STORAGE_FULL");
  });
});

describe("POST /v2/rooms/:roomId/blobs — device registration", () => {
  it("rejects when (authorId, deviceId) is not registered with 400 ATTN_DEVICE_UNREGISTERED", async () => {
    const roomId = uniqueRoomId("blob-unreg");
    const owner = await generateEd25519Keypair();
    const admissionKey = await createRoom({ roomId, ownerSigningKey: owner.publicKeyBytes });
    // Register a different device than the one we'll claim authorship from.
    await registerDevice({
      roomId,
      admissionKey,
      deviceId: "dev-known",
      participantId: "eve",
    });

    const res = await postBlobPresign({
      roomId,
      admissionKey,
      envelopeId: "blob-ghost-1",
      authorId: "eve",
      deviceId: "dev-ghost", // not registered
      ciphertextBytes: OVER_THRESHOLD_BYTES,
    });
    expect(res.status).toBe(400);
    const err = (await res.json()) as ErrorResponse;
    expect(err.error.code).toBe("ATTN_DEVICE_UNREGISTERED");
  });
});

describe("PUT /v2/rooms/:roomId/blobs/:envelopeId — cap enforcement", () => {
  it("rejects PUT without a cap query parameter with 401 ATTN_BLOB_CAP_MISSING", async () => {
    const roomId = uniqueRoomId("blob-nocap");
    const url = `${URL_BASE}/v2/rooms/${roomId}/blobs/blob-nocap-1`;
    const res = await SELF.fetch(url, { method: "PUT", body: new Uint8Array(16) });
    expect(res.status).toBe(401);
    const err = (await res.json()) as ErrorResponse;
    expect(err.error.code).toBe("ATTN_BLOB_CAP_MISSING");
  });

  it("rejects PUT whose body length does not match the cap with 400 ATTN_BLOB_LENGTH_MISMATCH", async () => {
    const roomId = uniqueRoomId("blob-lenmis");
    const owner = await generateEd25519Keypair();
    const admissionKey = await createRoom({ roomId, ownerSigningKey: owner.publicKeyBytes });
    await registerDevice({
      roomId,
      admissionKey,
      deviceId: "dev-lm",
      participantId: "frank",
    });

    const presignRes = await postBlobPresign({
      roomId,
      admissionKey,
      envelopeId: "blob-lm-1",
      authorId: "frank",
      deviceId: "dev-lm",
      ciphertextBytes: OVER_THRESHOLD_BYTES,
    });
    expect(presignRes.status).toBe(200);
    const presigned = (await presignRes.json()) as PresignedUploadResponse;

    // PUT a body that's 1 byte short of what we presigned for.
    const wrongBody = new Uint8Array(OVER_THRESHOLD_BYTES - 1);
    const putRes = await SELF.fetch(`${URL_BASE}${presigned.uploadUrl}`, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body: wrongBody,
    });
    expect(putRes.status).toBe(400);
    const err = (await putRes.json()) as ErrorResponse;
    expect(err.error.code).toBe("ATTN_BLOB_LENGTH_MISMATCH");
  });
});

describe("GET /v2/rooms/:roomId/blobs/:envelopeId — missing object", () => {
  it("returns 404 ATTN_BLOB_NOT_FOUND for an envelopeId that was never uploaded", async () => {
    const roomId = uniqueRoomId("blob-missing");
    const download = await presignBlobDownload(env, roomId, "never-uploaded");
    const res = await SELF.fetch(`${URL_BASE}${download.downloadUrl}`, { method: "GET" });
    expect(res.status).toBe(404);
    const err = (await res.json()) as ErrorResponse;
    expect(err.error.code).toBe("ATTN_BLOB_NOT_FOUND");
  });
});

describe("Room delete sweeps blobs (cross-check with 5.10)", () => {
  it("removes a blob uploaded under the room from R2 after DELETE /v2/rooms/:roomId", async () => {
    const roomId = uniqueRoomId("blob-sweep");
    const ownerKp = await generateEd25519Keypair();
    const admissionKey = await createRoom({
      roomId,
      ownerSigningKey: ownerKp.publicKeyBytes,
    });
    // Register the owner device using the room's actual ownerKp (only one
    // signing key matches the stored ownerSigningKey).
    const ownerBody = await buildSignedDeviceBody(
      {
        deviceId: "dev-real-own",
        participantId: "owner",
        publicSigningKey: base64UrlEncode(ownerKp.publicKeyBytes),
        kind: "owner",
      },
      ownerKp.privateKey,
    );
    const ownerUrl = `${URL_BASE}/v2/rooms/${roomId}/devices`;
    const ownerAdm = await admissionHeaderFor({
      method: "POST",
      url: ownerUrl,
      body: ownerBody,
      admissionKey,
    });
    const ownerPow = await mintDevicePow(roomId, "dev-real-own");
    const ownerRegRes = await SELF.fetch(ownerUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Attn-Admission": ownerAdm,
        "Attn-PoW": ownerPow,
      },
      body: ownerBody,
    });
    expect(ownerRegRes.status).toBe(204);

    // Presign + PUT a blob.
    const ciphertext = makeCiphertext(OVER_THRESHOLD_BYTES, 0xab);
    const presignRes = await postBlobPresign({
      roomId,
      admissionKey,
      envelopeId: "blob-sweep-1",
      authorId: "owner",
      deviceId: "dev-real-own",
      ciphertextBytes: ciphertext.byteLength,
    });
    expect(presignRes.status).toBe(200);
    const presigned = (await presignRes.json()) as PresignedUploadResponse;
    const putRes = await SELF.fetch(`${URL_BASE}${presigned.uploadUrl}`, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body: ciphertext,
    });
    expect(putRes.status).toBe(204);

    // Verify the blob is in R2 before deletion.
    const beforeListed = await env.RELAY_BLOBS.list({ prefix: `rooms/${roomId}/` });
    expect(beforeListed.objects.length).toBeGreaterThan(0);

    // DELETE /v2/rooms/:roomId with admission + PoW + owner-sig (5.10 contract).
    const deleteUrl = `${URL_BASE}/v2/rooms/${roomId}`;
    const deleteAdm = await admissionHeaderFor({
      method: "DELETE",
      url: deleteUrl,
      admissionKey,
    });
    const deletePow = await mintPowForTests({
      roomId,
      deviceId: "dev-real-own",
      method: "DELETE",
      path: `/v2/rooms/${roomId}`,
      difficulty: 12,
      expiresAt: nextPowExpiresAt(),
      rand: FIXED_POW_RAND,
    });
    const signingReq = new Request(deleteUrl, { method: "DELETE" });
    const canonical = await canonicalRequest(signingReq, new URL(deleteUrl).pathname);
    const ownerSig = new Uint8Array(
      await crypto.subtle.sign({ name: "Ed25519" }, ownerKp.privateKey, canonical),
    );
    const deleteRes = await SELF.fetch(deleteUrl, {
      method: "DELETE",
      headers: {
        "Attn-Admission": deleteAdm,
        "Attn-PoW": deletePow,
        "Attn-Owner-Signature": base64UrlEncode(ownerSig),
      },
    });
    expect(deleteRes.status).toBe(204);

    // R2 should now be empty under the room prefix.
    const afterListed = await env.RELAY_BLOBS.list({ prefix: `rooms/${roomId}/` });
    expect(afterListed.objects.length).toBe(0);
  });
});
