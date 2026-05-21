/**
 * Integration coverage for rate limiting (attn-nnj.5.13).
 *
 * Spec: planning/collab/relay-spec.md §Anti-Abuse + §Caps.
 *
 * The per-device limiter lives inside the RoomDO at `rate:<deviceId>:<min>`;
 * we seed it directly via `runInDurableObject` to avoid minting 120+ PoW
 * tokens just to push past the cap. The per-IP + anti-enum limiters live
 * in the Worker isolate's module-level WorkerEdgeRateLimit, which we
 * exercise by replaying HTTP requests through `SELF.fetch`.
 */

import { SELF, env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { base64UrlEncode, canonicalRequest } from "../../src/admission";
import { canonicalize, type CanonicalValue } from "../../src/canonical";
import type { Env } from "../../src/env";
import { rateKey } from "../../src/rate-limit";
import type { EnvelopeInput, RoomPolicy } from "../../src/schema";
import { FIXED_POW_RAND, createPowHeader, mintPowForTests } from "../helpers/pow";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

const URL_BASE = "https://relay.example";

// --- shared helpers (slim copies of envelopes.test.ts) -----------------

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
    maxEvents: 200,
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
  const signing = new Request(opts.url, { method: opts.method, headers, body: opts.body });
  const canonical = await canonicalRequest(signing, new URL(opts.url).pathname);
  const hmac = await hmacSha256(opts.admissionKey, canonical);
  return `v2.${base64UrlEncode(hmac)}`;
}

let counter = 0;
function uniqueRoomId(label: string): string {
  counter += 1;
  return `${label}-${Date.now().toString(36)}-${counter}`;
}

async function createRoom(opts: {
  roomId: string;
  ownerKp: SubtleKeypair;
  policy?: Partial<RoomPolicy>;
}): Promise<Uint8Array> {
  const admissionKey = makeAdmissionKey((counter * 13) & 0xff);
  const body = JSON.stringify({
    v: 2,
    policy: defaultPolicy(opts.policy ?? {}),
    ownerSigningKey: base64UrlEncode(opts.ownerKp.publicKeyBytes),
    admissionKey: base64UrlEncode(admissionKey),
  });
  const url = `${URL_BASE}/v2/rooms/${opts.roomId}`;
  // attn-nnj.5.17 (security-review §H1): first-create requires
  // Attn-Owner-Signature self-rooted to the body's ownerSigningKey.
  const signing = new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  const canonical = await canonicalRequest(signing, new URL(url).pathname);
  const sig = new Uint8Array(
    await crypto.subtle.sign({ name: "Ed25519" }, opts.ownerKp.privateKey, canonical),
  );
  const res = await SELF.fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Attn-Owner-Signature": base64UrlEncode(sig),
      "Attn-PoW": await createPowHeader(opts.roomId, opts.ownerKp.publicKeyBytes),
    },
    body,
  });
  if (res.status !== 201) {
    throw new Error(`room create failed: ${res.status} ${await res.text()}`);
  }
  return admissionKey;
}

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

let powExpiresBump = 0;
function nextPowExpiresAt(): number {
  powExpiresBump += 1;
  return Date.now() + 5 * 60 * 1000 + powExpiresBump;
}

async function buildSignedDeviceBody(input: {
  deviceId: string;
  participantId: string;
  publicSigningKey: string;
}, privateKey: CryptoKey): Promise<string> {
  const unsigned: Record<string, CanonicalValue> = {
    deviceId: input.deviceId,
    participantId: input.participantId,
    publicSigningKey: input.publicSigningKey,
    publicEncryptionKey: base64UrlEncode(new Uint8Array(32).fill(0xa1)),
    client: "attn-native",
    kind: "reviewer",
  };
  const canonical = new TextEncoder().encode(canonicalize(unsigned));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, privateKey, canonical));
  return JSON.stringify({ ...unsigned, selfSignature: base64UrlEncode(sig) });
}

async function registerDevice(opts: {
  roomId: string;
  admissionKey: Uint8Array;
  deviceId: string;
  participantId: string;
}): Promise<SubtleKeypair> {
  const kp = await generateEd25519Keypair();
  const body = await buildSignedDeviceBody({
    deviceId: opts.deviceId,
    participantId: opts.participantId,
    publicSigningKey: base64UrlEncode(kp.publicKeyBytes),
  }, kp.privateKey);
  const url = `${URL_BASE}/v2/rooms/${opts.roomId}/devices`;
  const adm = await admissionHeaderFor({ method: "POST", url, body, admissionKey: opts.admissionKey });
  const pow = await mintPowForTests({
    roomId: opts.roomId,
    deviceId: opts.deviceId,
    method: "POST",
    path: `/v2/rooms/${opts.roomId}/devices`,
    difficulty: 12,
    expiresAt: nextPowExpiresAt(),
    rand: FIXED_POW_RAND,
  });
  const res = await SELF.fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Attn-Admission": adm, "Attn-PoW": pow },
    body,
  });
  if (res.status !== 204) {
    throw new Error(`device register failed: ${res.status} ${await res.text()}`);
  }
  return kp;
}

function buildEnvelope(input: {
  envelopeId: string;
  authorId: string;
  deviceId: string;
}): EnvelopeInput {
  const ciphertextBytes = 16;
  const bytes = new Uint8Array(ciphertextBytes);
  for (let i = 0; i < ciphertextBytes; i++) bytes[i] = (i * 7) & 0xff;
  return {
    envelopeId: input.envelopeId,
    authorId: input.authorId,
    deviceId: input.deviceId,
    kind: "event",
    target: null,
    createdAt: Date.now(),
    expiresAt: Date.now() + 60 * 60 * 1000,
    nonce: base64UrlEncode(new Uint8Array(24).fill(0x55)),
    ciphertext: base64UrlEncode(bytes),
    ciphertextBytes,
  };
}

async function postOneEnvelope(opts: {
  roomId: string;
  admissionKey: Uint8Array;
  deviceId: string;
  authorId: string;
  envelopeId: string;
}): Promise<Response> {
  const url = `${URL_BASE}/v2/rooms/${opts.roomId}/envelopes`;
  const env = buildEnvelope({
    envelopeId: opts.envelopeId,
    authorId: opts.authorId,
    deviceId: opts.deviceId,
  });
  const body = JSON.stringify({ envelopes: [env] });
  const adm = await admissionHeaderFor({ method: "POST", url, body, admissionKey: opts.admissionKey });
  const pow = await mintPowForTests({
    roomId: opts.roomId,
    deviceId: opts.deviceId,
    method: "POST",
    path: `/v2/rooms/${opts.roomId}/envelopes`,
    difficulty: 12,
    expiresAt: nextPowExpiresAt(),
    rand: FIXED_POW_RAND,
  });
  return SELF.fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Attn-Admission": adm, "Attn-PoW": pow },
    body,
  });
}

// --- per-device cap (DO-side) -------------------------------------------

describe("rate limit — per-device (DO)", () => {
  it("rejects the 121st write in a single minute with 429 ATTN_RATE_LIMITED", async () => {
    const roomId = uniqueRoomId("rate-dev-121");
    const owner = await generateEd25519Keypair();
    const admissionKey = await createRoom({ roomId, ownerKp: owner });
    await registerDevice({
      roomId,
      admissionKey,
      deviceId: "dev-overflow",
      participantId: "alice",
    });

    // Seed the rate counter to 120 directly in DO storage so the next write
    // crosses the cap. Real production code arrives here via 120 prior
    // requests; the storage shape is `rate:<deviceId>:<windowStartMin>` per
    // relay-spec.md §Storage Layout.
    const id = env.RELAY_ROOMS.idFromName(roomId);
    const stub = env.RELAY_ROOMS.get(id);
    await runInDurableObject(stub, async (_inst, ctx) => {
      const windowStartMin = Math.floor(Date.now() / 60_000);
      await ctx.storage.put(rateKey("dev-overflow", windowStartMin), 120);
    });

    const res = await postOneEnvelope({
      roomId,
      admissionKey,
      deviceId: "dev-overflow",
      authorId: "alice",
      envelopeId: "should-be-rate-limited",
    });
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: { code: string; retryAfterMs?: number } };
    expect(body.error.code).toBe("ATTN_RATE_LIMITED");
    expect(body.error.retryAfterMs).toBeGreaterThan(0);
    expect(res.headers.get("Retry-After")).not.toBeNull();
    expect(res.headers.get("X-Attn-Retry-After-Ms")).not.toBeNull();
  });

  it("isolates per-device buckets — a different device in the same room can still write", async () => {
    const roomId = uniqueRoomId("rate-dev-isolation");
    const owner = await generateEd25519Keypair();
    const admissionKey = await createRoom({ roomId, ownerKp: owner });
    await registerDevice({
      roomId,
      admissionKey,
      deviceId: "dev-blocked",
      participantId: "alice",
    });
    await registerDevice({
      roomId,
      admissionKey,
      deviceId: "dev-clear",
      participantId: "bob",
    });

    // Saturate dev-blocked.
    const id = env.RELAY_ROOMS.idFromName(roomId);
    const stub = env.RELAY_ROOMS.get(id);
    await runInDurableObject(stub, async (_inst, ctx) => {
      const windowStartMin = Math.floor(Date.now() / 60_000);
      await ctx.storage.put(rateKey("dev-blocked", windowStartMin), 120);
    });

    // dev-blocked → 429.
    const blocked = await postOneEnvelope({
      roomId,
      admissionKey,
      deviceId: "dev-blocked",
      authorId: "alice",
      envelopeId: "blocked-1",
    });
    expect(blocked.status).toBe(429);

    // dev-clear → 201.
    const ok = await postOneEnvelope({
      roomId,
      admissionKey,
      deviceId: "dev-clear",
      authorId: "bob",
      envelopeId: "clear-1",
    });
    expect(ok.status).toBe(201);
  });

  it("admission failures are NOT rate-limited (admission runs before the cap check)", async () => {
    const roomId = uniqueRoomId("rate-dev-admission-order");
    const owner = await generateEd25519Keypair();
    const admissionKey = await createRoom({ roomId, ownerKp: owner });
    await registerDevice({
      roomId,
      admissionKey,
      deviceId: "dev-bad-adm",
      participantId: "carol",
    });

    // Seed at the cap.
    const id = env.RELAY_ROOMS.idFromName(roomId);
    const stub = env.RELAY_ROOMS.get(id);
    await runInDurableObject(stub, async (_inst, ctx) => {
      const windowStartMin = Math.floor(Date.now() / 60_000);
      await ctx.storage.put(rateKey("dev-bad-adm", windowStartMin), 120);
    });

    // Send a write with a *wrong* admission HMAC. Should 401 (not 429) — the
    // admission verifier runs before the rate check.
    const url = `${URL_BASE}/v2/rooms/${roomId}/envelopes`;
    const envelope = buildEnvelope({
      envelopeId: "wrong-adm",
      authorId: "carol",
      deviceId: "dev-bad-adm",
    });
    const body = JSON.stringify({ envelopes: [envelope] });
    // Sign with a *different* admission key.
    const badKey = new Uint8Array(32).fill(0x99);
    const adm = await admissionHeaderFor({ method: "POST", url, body, admissionKey: badKey });
    const pow = await mintPowForTests({
      roomId,
      deviceId: "dev-bad-adm",
      method: "POST",
      path: `/v2/rooms/${roomId}/envelopes`,
      difficulty: 12,
      expiresAt: nextPowExpiresAt(),
      rand: FIXED_POW_RAND,
    });
    const res = await SELF.fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Attn-Admission": adm, "Attn-PoW": pow },
      body,
    });
    expect(res.status).toBe(401);
  });
});

// --- anti-enumeration (Worker edge) ------------------------------------

// The Worker uses a module-level WorkerEdgeRateLimit shared across all
// requests in this isolate. Tests below use unique IPs per scenario so
// state doesn't leak between cases.

describe("rate limit — per-IP room-create cap (Worker edge)", () => {
  it("throttles room creation from one IP: the (cap+1)th create in a minute → 429 ATTN_RATE_LIMITED", async () => {
    // Unique IP per run so the shared module-level limiter doesn't leak buckets
    // between cases (singleWorker isolate). CF-Connecting-IP must be a real
    // value — the edge create-cap is skipped for the "unknown" dev/test fallback.
    const createIp = `10.21.${(counter * 13) & 0xff}.7`;
    // The first `perIpCreatePerMinute` (15) creates pass the cap. They 400 on
    // the empty body (schema fail); the point is they are NOT rate-limited.
    for (let i = 0; i < 15; i++) {
      const res = await SELF.fetch(`${URL_BASE}/v2/rooms/createcap-${counter}-${i}`, {
        method: "POST",
        headers: { "CF-Connecting-IP": createIp, "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).not.toBe(429);
    }
    // The 16th create from the same IP within the minute trips the create cap
    // at the edge, BEFORE the DO sees it.
    const blocked = await SELF.fetch(`${URL_BASE}/v2/rooms/createcap-${counter}-over`, {
      method: "POST",
      headers: { "CF-Connecting-IP": createIp, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(blocked.status).toBe(429);
    const j = (await blocked.json()) as { error?: { code?: string } };
    expect(j.error?.code).toBe("ATTN_RATE_LIMITED");
  });
});

// The createRoom-on-first-POST behavior means we can't easily trigger
// "room not found" with POST. Use GET /v2/rooms/:roomId/devices instead
// (5.6) which returns 404 ATTN_ROOM_NOT_FOUND on unknown rooms.

describe("rate limit — anti-enumeration (GET /devices probes)", () => {
  it("31 distinct unknown roomIds from one IP → 31st returns 429 ATTN_ENUM_LIMITED", async () => {
    const enumIp = `10.99.${(counter * 17) & 0xff}.1`;
    const responses: number[] = [];
    const codes: Array<string | undefined> = [];

    // Probe 30 distinct unknown rooms. Each should return 404 ATTN_ROOM_NOT_FOUND.
    for (let i = 0; i < 30; i++) {
      const roomId = `enum-probe-${counter}-${i}`;
      const res = await SELF.fetch(`${URL_BASE}/v2/rooms/${roomId}/devices`, {
        method: "GET",
        headers: { "CF-Connecting-IP": enumIp },
      });
      responses.push(res.status);
      const j = (await res.json()) as { error?: { code?: string } };
      codes.push(j.error?.code);
    }
    // All 30 should be 404 ATTN_ROOM_NOT_FOUND.
    for (let i = 0; i < 30; i++) {
      expect(responses[i]).toBe(404);
      expect(codes[i]).toBe("ATTN_ROOM_NOT_FOUND");
    }

    // 31st probe → 429 ATTN_ENUM_LIMITED.
    const overflowRes = await SELF.fetch(`${URL_BASE}/v2/rooms/enum-probe-${counter}-31/devices`, {
      method: "GET",
      headers: { "CF-Connecting-IP": enumIp },
    });
    expect(overflowRes.status).toBe(429);
    const body = (await overflowRes.json()) as { error: { code: string; retryAfterMs?: number } };
    expect(body.error.code).toBe("ATTN_ENUM_LIMITED");
    expect(body.error.retryAfterMs).toBeGreaterThan(0);
    expect(overflowRes.headers.get("Retry-After")).not.toBeNull();
  });

  it("existing rooms do NOT count against the anti-enum bucket", async () => {
    const ip = `10.77.${(counter * 23) & 0xff}.1`;

    // First create a real room from this IP.
    const roomId = uniqueRoomId("rate-existing");
    const owner = await generateEd25519Keypair();
    const admissionKey = makeAdmissionKey(123);
    const body = JSON.stringify({
      v: 2,
      policy: defaultPolicy(),
      ownerSigningKey: base64UrlEncode(owner.publicKeyBytes),
      admissionKey: base64UrlEncode(admissionKey),
    });
    const createUrl = `${URL_BASE}/v2/rooms/${roomId}`;
    // attn-nnj.5.17: first-create needs Attn-Owner-Signature (H1).
    const createSigning = new Request(createUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    const createCanonical = await canonicalRequest(
      createSigning,
      new URL(createUrl).pathname,
    );
    const createSig = new Uint8Array(
      await crypto.subtle.sign({ name: "Ed25519" }, owner.privateKey, createCanonical),
    );
    const createRes = await SELF.fetch(createUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "CF-Connecting-IP": ip,
        "Attn-Owner-Signature": base64UrlEncode(createSig),
        "Attn-PoW": await createPowHeader(roomId, owner.publicKeyBytes),
      },
      body,
    });
    expect(createRes.status).toBe(201);

    // Hit GET /devices on the *existing* room 50 times — none should count
    // toward the anti-enum bucket.
    for (let i = 0; i < 50; i++) {
      const adm = await admissionHeaderFor({
        method: "GET",
        url: `${URL_BASE}/v2/rooms/${roomId}/devices`,
        admissionKey,
      });
      const res = await SELF.fetch(`${URL_BASE}/v2/rooms/${roomId}/devices`, {
        method: "GET",
        headers: { "CF-Connecting-IP": ip, "Attn-Admission": adm },
      });
      expect(res.status).toBe(200);
    }

    // After 50 hits to a known room, we should still have a full 30-id
    // anti-enum budget. Probe 30 distinct unknown rooms — all should 404
    // (NOT 429).
    for (let i = 0; i < 30; i++) {
      const res = await SELF.fetch(
        `${URL_BASE}/v2/rooms/post-existing-unknown-${counter}-${i}/devices`,
        { method: "GET", headers: { "CF-Connecting-IP": ip } },
      );
      expect(res.status).toBe(404);
    }
  });

  it("probes from a DIFFERENT IP have their own bucket", async () => {
    const ipA = `10.55.${(counter * 31) & 0xff}.1`;
    const ipB = `10.55.${(counter * 31) & 0xff}.2`;

    // Burn IP-A's bucket to the cap.
    for (let i = 0; i < 30; i++) {
      const res = await SELF.fetch(
        `${URL_BASE}/v2/rooms/burn-a-${counter}-${i}/devices`,
        { method: "GET", headers: { "CF-Connecting-IP": ipA } },
      );
      expect(res.status).toBe(404);
    }
    const blockedA = await SELF.fetch(
      `${URL_BASE}/v2/rooms/burn-a-tipover/devices`,
      { method: "GET", headers: { "CF-Connecting-IP": ipA } },
    );
    expect(blockedA.status).toBe(429);

    // IP-B should still have a full budget — probe one unknown room → 404.
    const freshB = await SELF.fetch(
      `${URL_BASE}/v2/rooms/ip-b-fresh/devices`,
      { method: "GET", headers: { "CF-Connecting-IP": ipB } },
    );
    expect(freshB.status).toBe(404);
  });
});

// --- response shape ------------------------------------------------------

describe("rate limit — response shape", () => {
  it("429 ATTN_RATE_LIMITED carries Retry-After + retryAfterMs + canonical code", async () => {
    const roomId = uniqueRoomId("rate-shape");
    const owner = await generateEd25519Keypair();
    const admissionKey = await createRoom({ roomId, ownerKp: owner });
    await registerDevice({
      roomId,
      admissionKey,
      deviceId: "dev-shape",
      participantId: "shape",
    });

    const id = env.RELAY_ROOMS.idFromName(roomId);
    const stub = env.RELAY_ROOMS.get(id);
    await runInDurableObject(stub, async (_inst, ctx) => {
      const windowStartMin = Math.floor(Date.now() / 60_000);
      await ctx.storage.put(rateKey("dev-shape", windowStartMin), 200);
    });

    const res = await postOneEnvelope({
      roomId,
      admissionKey,
      deviceId: "dev-shape",
      authorId: "shape",
      envelopeId: "shape-1",
    });
    expect(res.status).toBe(429);
    expect(res.headers.get("Content-Type")).toMatch(/application\/json/);
    expect(res.headers.get("Retry-After")).not.toBeNull();
    const retryAfterMs = Number(res.headers.get("X-Attn-Retry-After-Ms"));
    expect(retryAfterMs).toBeGreaterThan(0);
    expect(retryAfterMs).toBeLessThanOrEqual(60_000);

    const body = (await res.json()) as { error: { code: string; message?: string; retryAfterMs?: number } };
    expect(body.error.code).toBe("ATTN_RATE_LIMITED");
    expect(body.error.retryAfterMs).toBeGreaterThan(0);
  });
});
