/**
 * Integration coverage for `POST + GET /v2/rooms/:roomId/devices` (attn-nnj.5.6).
 *
 * Spec: planning/collab/relay-spec.md §POST /v2/rooms/:roomId/devices
 *       planning/collab/crypto-spec.md §Signing-Key Publication
 *
 * Tests go through the Worker via SELF.fetch so they exercise the index.ts
 * router → RoomDO end-to-end, including admission verification, PoW
 * verification, schema validation, selfSignature check, owner-key check, and
 * the upsert/key-mismatch logic.
 */

import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { base64UrlEncode, canonicalRequest } from "../../src/admission";
import { canonicalize, type CanonicalValue } from "../../src/canonical";
import type { Env } from "../../src/env";
import type { DeviceRecord, RoomPolicy } from "../../src/schema";
import { FIXED_POW_RAND, mintPowForTests } from "../helpers/pow";

// Expose env bindings to `env` typing per vitest-pool-workers ambient pattern.
declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

const URL_BASE = "https://relay.example";

// --- small utility builders ---------------------------------------------

function makeAdmissionKey(seed: number): Uint8Array {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = (seed + i) & 0xff;
  return bytes;
}

function defaultPolicy(overrides: Partial<RoomPolicy> = {}): RoomPolicy {
  return {
    mode: "live",
    maxPeers: 4,
    maxSnapshotBytes: 1_000_000,
    maxEventBytes: 8_192,
    maxEvents: 100,
    expiresAt: Date.now() + 60 * 60 * 1000,
    idleTimeoutMs: 30 * 60 * 1000,
    longSession: false,
    // powBits=12 keeps the in-process miner cheap; verifyPow clamps to
    // max(policy, MIN_POW_BITS=12) so we don't need to push higher.
    powBits: 12,
    deleteEventsAfterOwnerAck: false,
    allowBrowser: false,
    allowRemoteAgents: false,
    ...overrides,
  };
}

async function hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, data));
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

/** Counter so each test gets a unique roomId. DO storage is shared per pool. */
let roomCounter = 0;
function uniqueRoomId(label: string): string {
  roomCounter += 1;
  return `${label}-${Date.now().toString(36)}-${roomCounter}`;
}

/** Create a room and return the admissionKey we used (for follow-up requests). */
async function createRoom(opts: {
  roomId: string;
  policy?: Partial<RoomPolicy>;
  ownerSigningKey: Uint8Array;
}): Promise<Uint8Array> {
  const admissionKey = makeAdmissionKey(roomCounter & 0xff);
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

// --- device-registration body builder -----------------------------------

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
  const raw = new Uint8Array(rawKey);
  return {
    publicKey: kp.publicKey,
    privateKey: kp.privateKey,
    publicKeyBytes: raw,
  };
}

interface DeviceBodyInput {
  deviceId: string;
  participantId: string;
  publicSigningKey: string; // base64url
  publicEncryptionKey?: string; // base64url; auto-generated if missing
  client?: "attn-native" | "attn-browser" | "agent-cli";
  kind?: "owner" | "reviewer" | "agent";
}

/** Build a fully-signed device registration body. */
async function buildSignedDeviceBody(
  input: DeviceBodyInput,
  privateKey: CryptoKey,
): Promise<string> {
  const unsigned: Record<string, CanonicalValue> = {
    deviceId: input.deviceId,
    participantId: input.participantId,
    publicSigningKey: input.publicSigningKey,
    publicEncryptionKey:
      input.publicEncryptionKey ?? base64UrlEncode(new Uint8Array(32).fill(0xa1)),
    client: input.client ?? "attn-native",
    kind: input.kind ?? "reviewer",
  };
  const canonical = new TextEncoder().encode(canonicalize(unsigned));
  const sig = new Uint8Array(
    await crypto.subtle.sign({ name: "Ed25519" }, privateKey, canonical),
  );
  return JSON.stringify({ ...unsigned, selfSignature: base64UrlEncode(sig) });
}

/** Mint a PoW token bound to (roomId, deviceId, POST, /v2/rooms/:roomId/devices). */
async function mintDevicePow(roomId: string, deviceId: string): Promise<string> {
  return mintPowForTests({
    roomId,
    deviceId,
    method: "POST",
    path: `/v2/rooms/${roomId}/devices`,
    difficulty: 12,
    expiresAt: Date.now() + 5 * 60 * 1000,
    rand: FIXED_POW_RAND,
  });
}

interface DeviceListResponse {
  devices: DeviceRecord[];
}

interface ErrorResponse {
  error: { code: string; message: string };
}

// --- tests ---------------------------------------------------------------

describe("POST /v2/rooms/:roomId/devices — happy path", () => {
  it("registers a reviewer device and returns 204; GET shows it", async () => {
    const roomId = uniqueRoomId("happy-reviewer");
    const owner = await generateEd25519Keypair();
    const admissionKey = await createRoom({ roomId, ownerSigningKey: owner.publicKeyBytes });

    const reviewer = await generateEd25519Keypair();
    const body = await buildSignedDeviceBody(
      {
        deviceId: "dev-1",
        participantId: "alice",
        publicSigningKey: base64UrlEncode(reviewer.publicKeyBytes),
        kind: "reviewer",
      },
      reviewer.privateKey,
    );

    const url = `${URL_BASE}/v2/rooms/${roomId}/devices`;
    const adm = await admissionHeaderFor({ method: "POST", url, body, admissionKey });
    const pow = await mintDevicePow(roomId, "dev-1");

    const res = await SELF.fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Attn-Admission": adm,
        "Attn-PoW": pow,
      },
      body,
    });
    expect(res.status).toBe(204);

    // GET shows it.
    const getAdm = await admissionHeaderFor({ method: "GET", url, admissionKey });
    const getRes = await SELF.fetch(url, {
      method: "GET",
      headers: { "Attn-Admission": getAdm },
    });
    expect(getRes.status).toBe(200);
    const list = (await getRes.json()) as DeviceListResponse;
    expect(list.devices.length).toBe(1);
    const dev0 = list.devices[0];
    expect(dev0).toBeDefined();
    if (dev0 === undefined) throw new Error("unreachable");
    expect(dev0.deviceId).toBe("dev-1");
    expect(dev0.participantId).toBe("alice");
    expect(dev0.kind).toBe("reviewer");
    expect(typeof dev0.registeredAt).toBe("number");
  });

  it("registers an owner device when publicSigningKey matches stored ownerSigningKey", async () => {
    const roomId = uniqueRoomId("happy-owner");
    const owner = await generateEd25519Keypair();
    const admissionKey = await createRoom({ roomId, ownerSigningKey: owner.publicKeyBytes });

    const body = await buildSignedDeviceBody(
      {
        deviceId: "owner-dev",
        participantId: "owner",
        publicSigningKey: base64UrlEncode(owner.publicKeyBytes),
        kind: "owner",
      },
      owner.privateKey,
    );
    const url = `${URL_BASE}/v2/rooms/${roomId}/devices`;
    const adm = await admissionHeaderFor({ method: "POST", url, body, admissionKey });
    const pow = await mintDevicePow(roomId, "owner-dev");

    const res = await SELF.fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Attn-Admission": adm,
        "Attn-PoW": pow,
      },
      body,
    });
    expect(res.status).toBe(204);
  });
});

describe("POST /v2/rooms/:roomId/devices — owner-key gate", () => {
  it("rejects kind=owner with a mismatched key (403 ATTN_OWNER_KEY_MISMATCH)", async () => {
    const roomId = uniqueRoomId("owner-mismatch");
    const owner = await generateEd25519Keypair();
    const admissionKey = await createRoom({ roomId, ownerSigningKey: owner.publicKeyBytes });

    // Attacker generates a different keypair and tries to claim owner-kind.
    const attacker = await generateEd25519Keypair();
    const body = await buildSignedDeviceBody(
      {
        deviceId: "attacker-dev",
        participantId: "attacker",
        publicSigningKey: base64UrlEncode(attacker.publicKeyBytes),
        kind: "owner",
      },
      attacker.privateKey,
    );
    const url = `${URL_BASE}/v2/rooms/${roomId}/devices`;
    const adm = await admissionHeaderFor({ method: "POST", url, body, admissionKey });
    const pow = await mintDevicePow(roomId, "attacker-dev");

    const res = await SELF.fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Attn-Admission": adm,
        "Attn-PoW": pow,
      },
      body,
    });
    expect(res.status).toBe(403);
    const err = (await res.json()) as ErrorResponse;
    expect(err.error.code).toBe("ATTN_OWNER_KEY_MISMATCH");
  });
});

describe("POST /v2/rooms/:roomId/devices — upsert + key-immutability", () => {
  it("re-registering same (participantId, deviceId) with same key succeeds (204)", async () => {
    const roomId = uniqueRoomId("idempotent");
    const owner = await generateEd25519Keypair();
    const admissionKey = await createRoom({ roomId, ownerSigningKey: owner.publicKeyBytes });

    const reviewer = await generateEd25519Keypair();
    const url = `${URL_BASE}/v2/rooms/${roomId}/devices`;

    // Two independent POSTs with fresh PoW tokens but identical body/key.
    for (let i = 0; i < 2; i++) {
      const body = await buildSignedDeviceBody(
        {
          deviceId: "dev-x",
          participantId: "bob",
          publicSigningKey: base64UrlEncode(reviewer.publicKeyBytes),
        },
        reviewer.privateKey,
      );
      const adm = await admissionHeaderFor({ method: "POST", url, body, admissionKey });
      const pow = await mintPowForTests({
        roomId,
        deviceId: "dev-x",
        method: "POST",
        path: `/v2/rooms/${roomId}/devices`,
        difficulty: 12,
        // Bump expiresAt slightly each loop so the SHA changes and replay is avoided.
        expiresAt: Date.now() + 5 * 60 * 1000 + i,
        rand: FIXED_POW_RAND,
      });
      const res = await SELF.fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Attn-Admission": adm,
          "Attn-PoW": pow,
        },
        body,
      });
      expect(res.status).toBe(204);
    }

    // GET still shows exactly one device entry.
    const getAdm = await admissionHeaderFor({ method: "GET", url, admissionKey });
    const list = (await (
      await SELF.fetch(url, { method: "GET", headers: { "Attn-Admission": getAdm } })
    ).json()) as DeviceListResponse;
    expect(list.devices.length).toBe(1);
  });

  it("re-registering same (participantId, deviceId) with a DIFFERENT key returns 409", async () => {
    const roomId = uniqueRoomId("key-changed");
    const owner = await generateEd25519Keypair();
    const admissionKey = await createRoom({ roomId, ownerSigningKey: owner.publicKeyBytes });

    const url = `${URL_BASE}/v2/rooms/${roomId}/devices`;
    const firstKp = await generateEd25519Keypair();
    const firstBody = await buildSignedDeviceBody(
      {
        deviceId: "dev-y",
        participantId: "carol",
        publicSigningKey: base64UrlEncode(firstKp.publicKeyBytes),
      },
      firstKp.privateKey,
    );
    const adm1 = await admissionHeaderFor({ method: "POST", url, body: firstBody, admissionKey });
    const pow1 = await mintDevicePow(roomId, "dev-y");
    const r1 = await SELF.fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Attn-Admission": adm1, "Attn-PoW": pow1 },
      body: firstBody,
    });
    expect(r1.status).toBe(204);

    // Same (participantId, deviceId), fresh keypair — must be rejected.
    const secondKp = await generateEd25519Keypair();
    const secondBody = await buildSignedDeviceBody(
      {
        deviceId: "dev-y",
        participantId: "carol",
        publicSigningKey: base64UrlEncode(secondKp.publicKeyBytes),
      },
      secondKp.privateKey,
    );
    const adm2 = await admissionHeaderFor({ method: "POST", url, body: secondBody, admissionKey });
    const pow2 = await mintPowForTests({
      roomId,
      deviceId: "dev-y",
      method: "POST",
      path: `/v2/rooms/${roomId}/devices`,
      difficulty: 12,
      expiresAt: Date.now() + 5 * 60 * 1000 + 1,
      rand: FIXED_POW_RAND,
    });
    const r2 = await SELF.fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Attn-Admission": adm2, "Attn-PoW": pow2 },
      body: secondBody,
    });
    expect(r2.status).toBe(409);
    const err = (await r2.json()) as ErrorResponse;
    expect(err.error.code).toBe("ATTN_DEVICE_KEY_CHANGED");
  });
});

describe("POST /v2/rooms/:roomId/devices — selfSignature validation", () => {
  it("rejects when selfSignature is from a different keypair (400 ATTN_DEVICE_SELF_SIG_INVALID)", async () => {
    const roomId = uniqueRoomId("wrong-sig-key");
    const owner = await generateEd25519Keypair();
    const admissionKey = await createRoom({ roomId, ownerSigningKey: owner.publicKeyBytes });

    const claimed = await generateEd25519Keypair();
    const attacker = await generateEd25519Keypair();
    // Build the canonical body claiming `claimed`'s public key, but sign with
    // `attacker`'s private key — selfSignature won't verify.
    const unsigned: Record<string, CanonicalValue> = {
      deviceId: "dev-z",
      participantId: "dave",
      publicSigningKey: base64UrlEncode(claimed.publicKeyBytes),
      publicEncryptionKey: base64UrlEncode(new Uint8Array(32).fill(0xa1)),
      client: "attn-native",
      kind: "reviewer",
    };
    const canonical = new TextEncoder().encode(canonicalize(unsigned));
    const sig = new Uint8Array(
      await crypto.subtle.sign({ name: "Ed25519" }, attacker.privateKey, canonical),
    );
    const body = JSON.stringify({ ...unsigned, selfSignature: base64UrlEncode(sig) });

    const url = `${URL_BASE}/v2/rooms/${roomId}/devices`;
    const adm = await admissionHeaderFor({ method: "POST", url, body, admissionKey });
    const pow = await mintDevicePow(roomId, "dev-z");
    const res = await SELF.fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Attn-Admission": adm, "Attn-PoW": pow },
      body,
    });
    expect(res.status).toBe(400);
    const err = (await res.json()) as ErrorResponse;
    expect(err.error.code).toBe("ATTN_DEVICE_SELF_SIG_INVALID");
  });

  it("rejects a tampered body (kind flipped after signing → 400)", async () => {
    const roomId = uniqueRoomId("tampered-body");
    const owner = await generateEd25519Keypair();
    const admissionKey = await createRoom({ roomId, ownerSigningKey: owner.publicKeyBytes });

    const kp = await generateEd25519Keypair();
    // Build & sign with kind=reviewer …
    const reviewerBody = await buildSignedDeviceBody(
      {
        deviceId: "dev-tamper",
        participantId: "eve",
        publicSigningKey: base64UrlEncode(kp.publicKeyBytes),
        kind: "reviewer",
      },
      kp.privateKey,
    );
    // … then tamper to kind=agent so the signature no longer matches the canonical body.
    const tampered = JSON.stringify({
      ...(JSON.parse(reviewerBody) as Record<string, unknown>),
      kind: "agent",
    });

    const url = `${URL_BASE}/v2/rooms/${roomId}/devices`;
    const adm = await admissionHeaderFor({ method: "POST", url, body: tampered, admissionKey });
    const pow = await mintDevicePow(roomId, "dev-tamper");
    const res = await SELF.fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Attn-Admission": adm, "Attn-PoW": pow },
      body: tampered,
    });
    expect(res.status).toBe(400);
    const err = (await res.json()) as ErrorResponse;
    expect(err.error.code).toBe("ATTN_DEVICE_SELF_SIG_INVALID");
  });
});

describe("POST /v2/rooms/:roomId/devices — protection layers", () => {
  it("rejects POST without admission header (401)", async () => {
    const roomId = uniqueRoomId("no-admission");
    const owner = await generateEd25519Keypair();
    await createRoom({ roomId, ownerSigningKey: owner.publicKeyBytes });

    const reviewer = await generateEd25519Keypair();
    const body = await buildSignedDeviceBody(
      {
        deviceId: "dev-no-adm",
        participantId: "frank",
        publicSigningKey: base64UrlEncode(reviewer.publicKeyBytes),
      },
      reviewer.privateKey,
    );
    const url = `${URL_BASE}/v2/rooms/${roomId}/devices`;
    const pow = await mintDevicePow(roomId, "dev-no-adm");
    const res = await SELF.fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Attn-PoW": pow },
      body,
    });
    expect(res.status).toBe(401);
    const err = (await res.json()) as ErrorResponse;
    expect(err.error.code).toBe("ATTN_ADMISSION_INVALID");
  });

  it("rejects POST without PoW header (400 ATTN_POW_INVALID)", async () => {
    const roomId = uniqueRoomId("no-pow");
    const owner = await generateEd25519Keypair();
    const admissionKey = await createRoom({ roomId, ownerSigningKey: owner.publicKeyBytes });

    const reviewer = await generateEd25519Keypair();
    const body = await buildSignedDeviceBody(
      {
        deviceId: "dev-no-pow",
        participantId: "grace",
        publicSigningKey: base64UrlEncode(reviewer.publicKeyBytes),
      },
      reviewer.privateKey,
    );
    const url = `${URL_BASE}/v2/rooms/${roomId}/devices`;
    const adm = await admissionHeaderFor({ method: "POST", url, body, admissionKey });
    const res = await SELF.fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Attn-Admission": adm },
      body,
    });
    expect(res.status).toBe(400);
    const err = (await res.json()) as ErrorResponse;
    expect(err.error.code).toBe("ATTN_POW_INVALID");
  });
});

describe("GET /v2/rooms/:roomId/devices", () => {
  it("returns devices in registration order", async () => {
    const roomId = uniqueRoomId("order");
    const owner = await generateEd25519Keypair();
    const admissionKey = await createRoom({ roomId, ownerSigningKey: owner.publicKeyBytes });
    const url = `${URL_BASE}/v2/rooms/${roomId}/devices`;

    // Register three devices in a known order.
    const labels: Array<{ participantId: string; deviceId: string }> = [
      { participantId: "p-alpha", deviceId: "dev-alpha" },
      { participantId: "p-beta", deviceId: "dev-beta" },
      { participantId: "p-gamma", deviceId: "dev-gamma" },
    ];
    for (let i = 0; i < labels.length; i++) {
      const entry = labels[i];
      if (entry === undefined) throw new Error("unreachable");
      const kp = await generateEd25519Keypair();
      const body = await buildSignedDeviceBody(
        {
          deviceId: entry.deviceId,
          participantId: entry.participantId,
          publicSigningKey: base64UrlEncode(kp.publicKeyBytes),
        },
        kp.privateKey,
      );
      const adm = await admissionHeaderFor({ method: "POST", url, body, admissionKey });
      const pow = await mintPowForTests({
        roomId,
        deviceId: entry.deviceId,
        method: "POST",
        path: `/v2/rooms/${roomId}/devices`,
        difficulty: 12,
        expiresAt: Date.now() + 5 * 60 * 1000 + i,
        rand: FIXED_POW_RAND,
      });
      const res = await SELF.fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Attn-Admission": adm, "Attn-PoW": pow },
        body,
      });
      expect(res.status).toBe(204);
    }

    const getAdm = await admissionHeaderFor({ method: "GET", url, admissionKey });
    const list = (await (
      await SELF.fetch(url, { method: "GET", headers: { "Attn-Admission": getAdm } })
    ).json()) as DeviceListResponse;
    expect(list.devices.length).toBe(labels.length);
    for (let i = 0; i < labels.length; i++) {
      const got = list.devices[i];
      const want = labels[i];
      if (got === undefined || want === undefined) throw new Error("unreachable");
      expect(got.deviceId).toBe(want.deviceId);
      expect(got.participantId).toBe(want.participantId);
    }
  });

  it("returns 404 on an unknown room", async () => {
    // No createRoom call → DO storage has no admissionKey for this id.
    const roomId = uniqueRoomId("unknown");
    const url = `${URL_BASE}/v2/rooms/${roomId}/devices`;
    const res = await SELF.fetch(url, { method: "GET" });
    expect(res.status).toBe(404);
    const err = (await res.json()) as ErrorResponse;
    expect(err.error.code).toBe("ATTN_ROOM_NOT_FOUND");
  });
});
