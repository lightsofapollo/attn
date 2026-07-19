/**
 * Integration coverage for `POST /v2/rooms/:roomId` (attn-nnj.5.5).
 *
 * Spec: planning/collab/relay-spec.md §POST /v2/rooms/:roomId
 * Amendments: #2 (admission), #8 (TTL clamps), #12 (deleteEventsAfterOwnerAck default)
 * Security: planning/collab/security-review.md §H1 (attn-nnj.5.17 —
 *   require Attn-Owner-Signature on first-create)
 *
 * These tests go through the Worker via SELF.fetch so they exercise the index.ts
 * router + RoomDO end-to-end. DO storage assertions use runInDurableObject
 * against the same DO instance the Worker routed to.
 */

import { SELF, env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { base64UrlEncode, canonicalRequest } from "../../src/admission";
import type { Env } from "../../src/env";
import type { RoomPolicy } from "../../src/schema";
import {
  generateEd25519Keypair,
  ownerSignatureHeader,
  type SubtleEd25519Keypair,
} from "../helpers/owner-sig";
import { createPowHeader } from "../helpers/pow";

// Make the bindings declared in wrangler.toml visible on `env` per the
// vitest-pool-workers ambient-module pattern.
declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

const URL_BASE = "https://relay.example";

/** Default policy that passes schema validation cleanly. */
function defaultPolicy(overrides: Partial<RoomPolicy> = {}): RoomPolicy {
  return {
    mode: "live",
    maxPeers: 4,
    maxSnapshotBytes: 1_000_000,
    maxEventBytes: 8_192,
    maxEvents: 100,
    expiresAt: Date.now() + 60 * 60 * 1000, // +1h
    idleTimeoutMs: 30 * 60 * 1000, // 30m
    longSession: false,
    powBits: 16,
    deleteEventsAfterOwnerAck: false,
    allowBrowser: false,
    allowRemoteAgents: false,
    ...overrides,
  };
}

function makeKeyBytes(seed: number): Uint8Array {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = (seed + i) & 0xff;
  return bytes;
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

interface RoomCreateResponse {
  roomId: string;
  createdAt: number;
  expiresAt: number;
  policy: RoomPolicy;
  ownerSigningKeyId: string;
  serverSeq: number;
}

interface RoomErrorResponse {
  error: { code: string; message: string };
}

/** Counter so each test gets a unique roomId — DO storage persists across tests in the pool. */
let roomCounter = 0;
function uniqueRoomId(label: string): string {
  roomCounter += 1;
  return `${label}-${Date.now().toString(36)}-${roomCounter}`;
}

interface BuildBodyInput {
  policy?: Partial<RoomPolicy>;
  ownerPublicKeyBytes?: Uint8Array;
  admissionKey?: Uint8Array;
  v?: unknown;
}

interface BuiltCreate {
  body: string;
  ownerKp: SubtleEd25519Keypair;
  admissionKeyBytes: Uint8Array;
}

/**
 * Build a valid `POST /v2/rooms/:roomId` body + owner keypair pair. Tests
 * that need to tamper with the body (mismatched key, garbled fields, etc.)
 * can override the body string or use the keypair to sign deliberately
 * incorrect canonical bytes.
 */
async function buildCreate(input: BuildBodyInput = {}): Promise<BuiltCreate> {
  const ownerKp = await generateEd25519Keypair();
  const admissionKeyBytes = input.admissionKey ?? makeKeyBytes(0x20);
  const ownerPublic = input.ownerPublicKeyBytes ?? ownerKp.publicKeyBytes;
  const body = JSON.stringify({
    v: input.v ?? 2,
    policy: defaultPolicy(input.policy ?? {}),
    ownerSigningKey: base64UrlEncode(ownerPublic),
    admissionKey: base64UrlEncode(admissionKeyBytes),
  });
  return { body, ownerKp, admissionKeyBytes };
}

/**
 * Convenience wrapper: build body, build owner-sig header, POST the room.
 * Used by every happy-path test plus a few error-path tests where the
 * intention is to verify behavior AFTER a valid first-create succeeded.
 */
async function postCreate(opts: {
  roomId: string;
  policy?: Partial<RoomPolicy>;
  ownerPublicKeyBytes?: Uint8Array;
  admissionKey?: Uint8Array;
}): Promise<{
  response: Response;
  body: string;
  ownerKp: SubtleEd25519Keypair;
  admissionKeyBytes: Uint8Array;
}> {
  const url = `${URL_BASE}/v2/rooms/${opts.roomId}`;
  const built = await buildCreate({
    policy: opts.policy,
    ownerPublicKeyBytes: opts.ownerPublicKeyBytes,
    admissionKey: opts.admissionKey,
  });
  const ownerSig = await ownerSignatureHeader({
    method: "POST",
    url,
    body: built.body,
    privateKey: built.ownerKp.privateKey,
  });
  const response = await SELF.fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Attn-Owner-Signature": ownerSig,
      "Attn-PoW": await createPowHeader(opts.roomId, built.ownerKp.publicKeyBytes),
    },
    body: built.body,
  });
  return {
    response,
    body: built.body,
    ownerKp: built.ownerKp,
    admissionKeyBytes: built.admissionKeyBytes,
  };
}

describe("POST /v2/rooms/:roomId — happy path", () => {
  it("serializes concurrent first-create requests into one create and one rejoin", async () => {
    const roomId = uniqueRoomId("concurrent-create");
    const url = `${URL_BASE}/v2/rooms/${roomId}`;
    const built = await buildCreate();
    const headers = {
      "Content-Type": "application/json",
      "Attn-Owner-Signature": await ownerSignatureHeader({
        method: "POST",
        url,
        body: built.body,
        privateKey: built.ownerKp.privateKey,
      }),
      "Attn-Admission": await admissionHeaderFor({
        method: "POST",
        url,
        body: built.body,
        admissionKey: built.admissionKeyBytes,
      }),
      "Attn-PoW": await createPowHeader(roomId, built.ownerKp.publicKeyBytes),
    };

    const responses = await Promise.all([
      SELF.fetch(url, { method: "POST", headers, body: built.body }),
      SELF.fetch(url, { method: "POST", headers, body: built.body }),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 201]);
  });

  it("creates a room and returns 201 with the clamped policy", async () => {
    const roomId = uniqueRoomId("happy");
    const expiresAt = Date.now() + 60 * 60 * 1000;
    const { response: res, ownerKp } = await postCreate({
      roomId,
      policy: { expiresAt },
    });

    expect(res.status).toBe(201);
    const json = (await res.json()) as RoomCreateResponse;
    expect(json.roomId).toBe(roomId);
    expect(typeof json.createdAt).toBe("number");
    expect(json.createdAt).toBeGreaterThan(0);
    expect(json.expiresAt).toBe(expiresAt); // within bounds, not clamped
    expect(json.serverSeq).toBe(0);
    expect(typeof json.ownerSigningKeyId).toBe("string");
    expect(json.ownerSigningKeyId.length).toBeGreaterThan(0);
    expect(json.policy.mode).toBe("live");
    expect(json.policy.maxPeers).toBe(4);
    expect(json.policy.powBits).toBe(16);
    expect(json.policy.deleteEventsAfterOwnerAck).toBe(false);

    // ownerSigningKeyId is base64url(SHA-256(ownerSigningKey)).
    const expected = base64UrlEncode(
      new Uint8Array(await crypto.subtle.digest("SHA-256", ownerKp.publicKeyBytes)),
    );
    expect(json.ownerSigningKeyId).toBe(expected);
  });
});

describe("POST /v2/rooms/:roomId — body-size guard (abuse hardening)", () => {
  it("rejects an oversized create body with 413 ATTN_BODY_TOO_LARGE before any auth check", async () => {
    const roomId = uniqueRoomId("toobig");
    const url = `${URL_BASE}/v2/rooms/${roomId}`;
    // > ROOM_CREATE_MAX_BODY_BYTES (4096). No Attn-Owner-Signature on purpose:
    // the size guard must fire BEFORE owner-sig verification, so this is 413,
    // not 403.
    const oversized = "x".repeat(5000);
    const res = await SELF.fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: oversized,
    });
    expect(res.status).toBe(413);
    const err = (await res.json()) as RoomErrorResponse;
    expect(err.error.code).toBe("ATTN_BODY_TOO_LARGE");
  });
});

describe("POST /v2/rooms/:roomId — H1 first-create owner signature", () => {
  it("rejects first-create with no Attn-Owner-Signature (403 ATTN_OWNER_SIG_REQUIRED)", async () => {
    const roomId = uniqueRoomId("h1-missing");
    const url = `${URL_BASE}/v2/rooms/${roomId}`;
    const { body } = await buildCreate();
    const res = await SELF.fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    expect(res.status).toBe(403);
    const err = (await res.json()) as RoomErrorResponse;
    expect(err.error.code).toBe("ATTN_OWNER_SIG_REQUIRED");
  });

  it("rejects first-create when sig is by a different key (403 ATTN_OWNER_SIG_INVALID)", async () => {
    const roomId = uniqueRoomId("h1-wrong-key");
    const url = `${URL_BASE}/v2/rooms/${roomId}`;
    // Body declares ownerKp as the owner, but we sign with attackerKp.
    const ownerKp = await generateEd25519Keypair();
    const attackerKp = await generateEd25519Keypair();
    const built = await buildCreate({ ownerPublicKeyBytes: ownerKp.publicKeyBytes });
    const wrongSig = await ownerSignatureHeader({
      method: "POST",
      url,
      body: built.body,
      privateKey: attackerKp.privateKey,
    });
    const res = await SELF.fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Attn-Owner-Signature": wrongSig,
      },
      body: built.body,
    });
    expect(res.status).toBe(403);
    const err = (await res.json()) as RoomErrorResponse;
    expect(err.error.code).toBe("ATTN_OWNER_SIG_INVALID");
  });

  it("rejects first-create when the body is tampered after signing (403 ATTN_OWNER_SIG_INVALID)", async () => {
    const roomId = uniqueRoomId("h1-tampered");
    const url = `${URL_BASE}/v2/rooms/${roomId}`;
    const ownerKp = await generateEd25519Keypair();
    const originalBody = JSON.stringify({
      v: 2,
      policy: defaultPolicy({ maxPeers: 2 }),
      ownerSigningKey: base64UrlEncode(ownerKp.publicKeyBytes),
      admissionKey: base64UrlEncode(makeKeyBytes(0x44)),
    });
    // Sign the original body...
    const sig = await ownerSignatureHeader({
      method: "POST",
      url,
      body: originalBody,
      privateKey: ownerKp.privateKey,
    });
    // ...but actually POST a tampered body (different policy).
    const tamperedBody = JSON.stringify({
      v: 2,
      policy: defaultPolicy({ maxPeers: 7 }), // attacker raises peer cap
      ownerSigningKey: base64UrlEncode(ownerKp.publicKeyBytes),
      admissionKey: base64UrlEncode(makeKeyBytes(0x44)),
    });
    const res = await SELF.fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Attn-Owner-Signature": sig,
      },
      body: tamperedBody,
    });
    expect(res.status).toBe(403);
    const err = (await res.json()) as RoomErrorResponse;
    expect(err.error.code).toBe("ATTN_OWNER_SIG_INVALID");
  });

  it("rejects first-create when Attn-Owner-Signature is malformed (403 ATTN_OWNER_SIG_INVALID)", async () => {
    const roomId = uniqueRoomId("h1-malformed");
    const url = `${URL_BASE}/v2/rooms/${roomId}`;
    const { body } = await buildCreate();
    const res = await SELF.fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Attn-Owner-Signature": "not-a-real-base64url-sig!!!",
      },
      body,
    });
    expect(res.status).toBe(403);
    const err = (await res.json()) as RoomErrorResponse;
    expect(err.error.code).toBe("ATTN_OWNER_SIG_INVALID");
  });

  it("rejoin does NOT require a new owner signature — admission HMAC alone suffices", async () => {
    const roomId = uniqueRoomId("h1-rejoin-no-sig");
    const url = `${URL_BASE}/v2/rooms/${roomId}`;

    // First-create with a valid owner sig.
    const first = await postCreate({ roomId });
    expect(first.response.status).toBe(201);
    const firstJson = (await first.response.json()) as RoomCreateResponse;

    // Rejoin: build a fresh body (relay ignores it), build admission HMAC,
    // and DELIBERATELY omit Attn-Owner-Signature. Must still succeed.
    const rejoinBody = JSON.stringify({
      v: 2,
      policy: defaultPolicy({ maxPeers: 7 }), // ignored
      ownerSigningKey: base64UrlEncode(first.ownerKp.publicKeyBytes),
      admissionKey: base64UrlEncode(first.admissionKeyBytes),
    });
    const adm = await admissionHeaderFor({
      method: "POST",
      url,
      body: rejoinBody,
      admissionKey: first.admissionKeyBytes,
    });
    const second = await SELF.fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Attn-Admission": adm },
      body: rejoinBody,
    });
    expect(second.status).toBe(200);
    const secondJson = (await second.json()) as RoomCreateResponse;
    expect(secondJson.policy.maxPeers).toBe(firstJson.policy.maxPeers);
    expect(secondJson.createdAt).toBe(firstJson.createdAt);
    expect(secondJson.ownerSigningKeyId).toBe(firstJson.ownerSigningKeyId);
  });
});

describe("POST /v2/rooms/:roomId — rejoin", () => {
  it("returns 200 with the stored policy on second POST (admission-verified, no mutation)", async () => {
    const roomId = uniqueRoomId("rejoin");
    const url = `${URL_BASE}/v2/rooms/${roomId}`;

    const first = await postCreate({
      roomId,
      policy: { maxPeers: 3 },
      admissionKey: makeKeyBytes(0x33),
    });
    expect(first.response.status).toBe(201);
    const firstJson = (await first.response.json()) as RoomCreateResponse;

    // Second POST tries to mutate maxPeers — should be ignored. Use the
    // SAME admissionKey so admission HMAC verifies on the relay side.
    const mutatedBody = JSON.stringify({
      v: 2,
      policy: defaultPolicy({ maxPeers: 7 }),
      ownerSigningKey: base64UrlEncode(first.ownerKp.publicKeyBytes),
      admissionKey: base64UrlEncode(first.admissionKeyBytes),
    });
    const adm = await admissionHeaderFor({
      method: "POST",
      url,
      body: mutatedBody,
      admissionKey: first.admissionKeyBytes,
    });
    const second = await SELF.fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Attn-Admission": adm },
      body: mutatedBody,
    });
    expect(second.status).toBe(200);
    const secondJson = (await second.json()) as RoomCreateResponse;
    expect(secondJson.policy.maxPeers).toBe(3); // unchanged
    expect(secondJson.createdAt).toBe(firstJson.createdAt);
    expect(secondJson.ownerSigningKeyId).toBe(firstJson.ownerSigningKeyId);
  });

  it("rejects rejoin with no/invalid admission header (401)", async () => {
    const roomId = uniqueRoomId("rejoin-admission");
    const url = `${URL_BASE}/v2/rooms/${roomId}`;

    const first = await postCreate({ roomId });
    expect(first.response.status).toBe(201);

    // Try to "rejoin" with a fresh body, valid owner-sig, but NO admission
    // header. The relay's rejoin branch fires on existing-room and rejects
    // before even looking at the owner sig.
    const rejoinBody = JSON.stringify({
      v: 2,
      policy: defaultPolicy(),
      ownerSigningKey: base64UrlEncode(first.ownerKp.publicKeyBytes),
      admissionKey: base64UrlEncode(first.admissionKeyBytes),
    });
    const reject = await SELF.fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: rejoinBody,
    });
    expect(reject.status).toBe(401);
    const json = (await reject.json()) as RoomErrorResponse;
    expect(json.error.code).toBe("ATTN_ADMISSION_INVALID");
  });
});

describe("POST /v2/rooms/:roomId — clamping", () => {
  it("clamps maxPeers down to HARD_MAX_PEERS", async () => {
    const roomId = uniqueRoomId("clamp-peers");
    const { response: res } = await postCreate({
      roomId,
      policy: { maxPeers: 8 },
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as RoomCreateResponse;
    expect(json.policy.maxPeers).toBeLessThanOrEqual(8);
  });

  it("clamps oversized maxSnapshotBytes / maxEventBytes / maxEvents", async () => {
    const roomId = uniqueRoomId("clamp-bytes");
    const { response: res } = await postCreate({
      roomId,
      policy: {
        maxSnapshotBytes: 10 * 1024 * 1024 * 1024, // 10 GiB nonsense
        maxEventBytes: 10 * 1024 * 1024, // 10 MiB nonsense
        maxEvents: 1_000_000,
      },
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as RoomCreateResponse;
    expect(json.policy.maxSnapshotBytes).toBe(5_242_880);
    expect(json.policy.maxEventBytes).toBe(262_144);
    expect(json.policy.maxEvents).toBe(2_000);
  });

  it("clamps expiresAt to createdAt + 24h by default", async () => {
    const roomId = uniqueRoomId("clamp-ttl");
    const t0 = Date.now();
    const { response: res } = await postCreate({
      roomId,
      policy: {
        expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000, // +30d
        longSession: false,
      },
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as RoomCreateResponse;
    const upper = json.createdAt + 24 * 60 * 60 * 1000;
    expect(json.expiresAt).toBeGreaterThanOrEqual(t0);
    expect(json.expiresAt).toBeLessThanOrEqual(upper);
    expect(json.policy.expiresAt).toBe(json.expiresAt);
  });

  it("clamps expiresAt to createdAt + 7d when longSession=true", async () => {
    const roomId = uniqueRoomId("clamp-ttl-long");
    const { response: res } = await postCreate({
      roomId,
      policy: {
        expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000, // +30d
        longSession: true,
      },
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as RoomCreateResponse;
    const upper = json.createdAt + 7 * 24 * 60 * 60 * 1000;
    const lower = json.createdAt + 24 * 60 * 60 * 1000;
    expect(json.expiresAt).toBeGreaterThan(lower);
    expect(json.expiresAt).toBeLessThanOrEqual(upper);
    expect(json.policy.longSession).toBe(true);
  });

  it("clamps idleTimeoutMs above 60s and below wall-clock TTL", async () => {
    const roomId = uniqueRoomId("clamp-idle");
    const expiresAt = Date.now() + 60 * 60 * 1000; // +1h
    const { response: res } = await postCreate({
      roomId,
      policy: {
        expiresAt,
        idleTimeoutMs: 24 * 60 * 60 * 1000, // way > 1h TTL
      },
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as RoomCreateResponse;
    const ttl = json.expiresAt - json.createdAt;
    expect(json.policy.idleTimeoutMs).toBeLessThanOrEqual(ttl);
    expect(json.policy.idleTimeoutMs).toBeGreaterThanOrEqual(60_000);
  });
});

describe("POST /v2/rooms/:roomId — defaults", () => {
  it("defaults deleteEventsAfterOwnerAck to false (amendments #12)", async () => {
    const roomId = uniqueRoomId("default-delete");
    const url = `${URL_BASE}/v2/rooms/${roomId}`;
    const ownerKp = await generateEd25519Keypair();
    // Build the body manually to omit the field entirely.
    const body = JSON.stringify({
      v: 2,
      policy: {
        mode: "live",
        maxPeers: 4,
        maxSnapshotBytes: 1_000_000,
        maxEventBytes: 8_192,
        maxEvents: 100,
        expiresAt: Date.now() + 60 * 60 * 1000,
      },
      ownerSigningKey: base64UrlEncode(ownerKp.publicKeyBytes),
      admissionKey: base64UrlEncode(makeKeyBytes(0xc2)),
    });
    const ownerSig = await ownerSignatureHeader({
      method: "POST",
      url,
      body,
      privateKey: ownerKp.privateKey,
    });
    const res = await SELF.fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Attn-Owner-Signature": ownerSig,
        "Attn-PoW": await createPowHeader(roomId, ownerKp.publicKeyBytes),
      },
      body,
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as RoomCreateResponse;
    expect(json.policy.deleteEventsAfterOwnerAck).toBe(false);
  });

  it("defaults powBits to 16 when omitted", async () => {
    const roomId = uniqueRoomId("default-pow");
    const url = `${URL_BASE}/v2/rooms/${roomId}`;
    const ownerKp = await generateEd25519Keypair();
    const body = JSON.stringify({
      v: 2,
      policy: {
        mode: "async",
        maxPeers: 2,
        maxSnapshotBytes: 50_000,
        maxEventBytes: 4_096,
        maxEvents: 50,
        expiresAt: Date.now() + 60 * 60 * 1000,
      },
      ownerSigningKey: base64UrlEncode(ownerKp.publicKeyBytes),
      admissionKey: base64UrlEncode(makeKeyBytes(0xd2)),
    });
    const ownerSig = await ownerSignatureHeader({
      method: "POST",
      url,
      body,
      privateKey: ownerKp.privateKey,
    });
    const res = await SELF.fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Attn-Owner-Signature": ownerSig,
        "Attn-PoW": await createPowHeader(roomId, ownerKp.publicKeyBytes),
      },
      body,
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as RoomCreateResponse;
    expect(json.policy.powBits).toBe(16);
  });
});

describe("POST /v2/rooms/:roomId — schema validation", () => {
  // For these tests we don't bother with a valid owner-sig: the version /
  // body-validation gates run before the owner-sig check in the handler
  // when the body is unparseable. The wrong-key length and wrong-mode tests
  // attach a valid sig over the offending body so we exercise the path
  // where the body decodes but ownerSigningKey itself is malformed.

  it("rejects v=1 with ATTN_VERSION_UNSUPPORTED (400)", async () => {
    const roomId = uniqueRoomId("v1");
    const body = JSON.stringify({
      v: 1,
      policy: defaultPolicy(),
      ownerSigningKey: base64UrlEncode(makeKeyBytes(0xe1)),
      admissionKey: base64UrlEncode(makeKeyBytes(0xe2)),
    });
    const res = await SELF.fetch(`${URL_BASE}/v2/rooms/${roomId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    expect(res.status).toBe(400);
    const err = (await res.json()) as RoomErrorResponse;
    expect(err.error.code).toBe("ATTN_VERSION_UNSUPPORTED");
  });

  it("rejects malformed JSON with 400 ATTN_BODY_INVALID", async () => {
    const roomId = uniqueRoomId("badjson");
    const res = await SELF.fetch(`${URL_BASE}/v2/rooms/${roomId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not-json",
    });
    expect(res.status).toBe(400);
    const err = (await res.json()) as RoomErrorResponse;
    expect(err.error.code).toBe("ATTN_BODY_INVALID");
  });

  it("rejects body missing ownerSigningKey with 400", async () => {
    const roomId = uniqueRoomId("missing-owner");
    const body = JSON.stringify({
      v: 2,
      policy: defaultPolicy(),
      admissionKey: base64UrlEncode(makeKeyBytes(0xf2)),
    });
    const res = await SELF.fetch(`${URL_BASE}/v2/rooms/${roomId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    expect(res.status).toBe(400);
    const err = (await res.json()) as RoomErrorResponse;
    expect(err.error.code).toBe("ATTN_BODY_INVALID");
    expect(err.error.message).toMatch(/ownerSigningKey/);
  });

  it("rejects body missing admissionKey with 400", async () => {
    const roomId = uniqueRoomId("missing-admission");
    const body = JSON.stringify({
      v: 2,
      policy: defaultPolicy(),
      ownerSigningKey: base64UrlEncode(makeKeyBytes(0x12)),
    });
    const res = await SELF.fetch(`${URL_BASE}/v2/rooms/${roomId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    expect(res.status).toBe(400);
    const err = (await res.json()) as RoomErrorResponse;
    expect(err.error.code).toBe("ATTN_BODY_INVALID");
    expect(err.error.message).toMatch(/admissionKey/);
  });

  it("rejects ownerSigningKey of wrong byte length (400)", async () => {
    const roomId = uniqueRoomId("bad-owner-len");
    const body = JSON.stringify({
      v: 2,
      policy: defaultPolicy(),
      ownerSigningKey: base64UrlEncode(new Uint8Array(16)), // not 32
      admissionKey: base64UrlEncode(makeKeyBytes(0x13)),
    });
    const res = await SELF.fetch(`${URL_BASE}/v2/rooms/${roomId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    expect(res.status).toBe(400);
    const err = (await res.json()) as RoomErrorResponse;
    expect(err.error.code).toBe("ATTN_BODY_INVALID");
  });

  it("rejects mode outside of live/async/hybrid (400)", async () => {
    const roomId = uniqueRoomId("bad-mode");
    const body = JSON.stringify({
      v: 2,
      policy: { ...defaultPolicy(), mode: "speedrun" },
      ownerSigningKey: base64UrlEncode(makeKeyBytes(0x14)),
      admissionKey: base64UrlEncode(makeKeyBytes(0x15)),
    });
    const res = await SELF.fetch(`${URL_BASE}/v2/rooms/${roomId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    expect(res.status).toBe(400);
    const err = (await res.json()) as RoomErrorResponse;
    expect(err.error.code).toBe("ATTN_BODY_INVALID");
  });
});

describe("POST /v2/rooms/:roomId — DO storage state", () => {
  it("persists the clamped policy and metadata to DO storage", async () => {
    const roomId = uniqueRoomId("storage");
    const admissionKey = makeKeyBytes(0xcd);
    const { response: res, ownerKp } = await postCreate({
      roomId,
      policy: { maxPeers: 2 },
      admissionKey,
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as RoomCreateResponse;

    const stubId = env.RELAY_ROOMS.idFromName(roomId);
    const stub = env.RELAY_ROOMS.get(stubId);
    await runInDurableObject(stub, async (_instance, ctx) => {
      const storedPolicy = await ctx.storage.get<RoomPolicy>("meta:policy");
      expect(storedPolicy).toBeDefined();
      expect(storedPolicy?.maxPeers).toBe(2);

      const storedAdmission = await ctx.storage.get<Uint8Array>("meta:admission_key");
      expect(storedAdmission).toBeDefined();
      expect(Array.from(storedAdmission ?? new Uint8Array())).toEqual(Array.from(admissionKey));

      const storedOwner = await ctx.storage.get<Uint8Array>("meta:owner_signing_key");
      expect(Array.from(storedOwner ?? new Uint8Array())).toEqual(
        Array.from(ownerKp.publicKeyBytes),
      );

      const ownerKeyId = await ctx.storage.get<string>("meta:owner_signing_key_id");
      expect(ownerKeyId).toBe(json.ownerSigningKeyId);

      expect(await ctx.storage.get<number>("meta:created_at")).toBe(json.createdAt);
      expect(await ctx.storage.get<number>("meta:expires_at")).toBe(json.expiresAt);
      expect(await ctx.storage.get<number>("meta:server_seq")).toBe(0);
      expect(await ctx.storage.get<number>("meta:bytes_used")).toBe(0);
      expect(await ctx.storage.get<number>("meta:envelope_count")).toBe(0);
      expect(await ctx.storage.get<number>("meta:oldest_retained_seq")).toBe(0);
    });
  });

  it("schedules an alarm bounded by hard-max-at and idle deadline", async () => {
    const roomId = uniqueRoomId("alarm");
    const { response: res } = await postCreate({
      roomId,
      policy: { idleTimeoutMs: 60_000 }, // 60s — should win over hard-max
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as RoomCreateResponse;

    const stubId = env.RELAY_ROOMS.idFromName(roomId);
    const stub = env.RELAY_ROOMS.get(stubId);
    await runInDurableObject(stub, async (_instance, ctx) => {
      const alarmAt = await ctx.storage.getAlarm();
      expect(alarmAt).not.toBeNull();
      expect(alarmAt).toBe(json.createdAt + 60_000);
    });
  });

  it("does NOT persist any meta when the owner sig is missing (storage stays empty)", async () => {
    // Regression: ensure the H1 gate runs BEFORE storage writes, so a failed
    // first-create can't half-create a room (or worse, store the attacker's
    // body keys).
    const roomId = uniqueRoomId("h1-no-write");
    const url = `${URL_BASE}/v2/rooms/${roomId}`;
    const { body } = await buildCreate();
    const res = await SELF.fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    expect(res.status).toBe(403);

    const stubId = env.RELAY_ROOMS.idFromName(roomId);
    const stub = env.RELAY_ROOMS.get(stubId);
    await runInDurableObject(stub, async (_inst, ctx) => {
      const all = await ctx.storage.list();
      expect(all.size).toBe(0);
    });
  });
});

describe("POST /v2/rooms/:roomId — round-trip with admission on rejoin", () => {
  it("succeeds with a correctly-HMAC'd admission header on rejoin", async () => {
    const roomId = uniqueRoomId("rejoin-ok");
    const url = `${URL_BASE}/v2/rooms/${roomId}`;

    const first = await postCreate({ roomId });
    expect(first.response.status).toBe(201);
    const firstJson = (await first.response.json()) as RoomCreateResponse;

    const rejoinBody = JSON.stringify({
      v: 2,
      policy: defaultPolicy(),
      ownerSigningKey: base64UrlEncode(first.ownerKp.publicKeyBytes),
      admissionKey: base64UrlEncode(first.admissionKeyBytes),
    });
    const adm = await admissionHeaderFor({
      method: "POST",
      url,
      body: rejoinBody,
      admissionKey: first.admissionKeyBytes,
    });
    const second = await SELF.fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Attn-Admission": adm },
      body: rejoinBody,
    });
    expect(second.status).toBe(200);
    const secondJson = (await second.json()) as RoomCreateResponse;
    expect(secondJson.createdAt).toBe(firstJson.createdAt);
    expect(secondJson.policy).toEqual(firstJson.policy);
  });
});
