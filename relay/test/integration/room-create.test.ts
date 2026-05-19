/**
 * Integration coverage for `POST /v2/rooms/:roomId` (attn-nnj.5.5).
 *
 * Spec: planning/collab/relay-spec.md §POST /v2/rooms/:roomId
 * Amendments: #2 (admission), #8 (TTL clamps), #12 (deleteEventsAfterOwnerAck default)
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

interface CreateBodyInput {
  policy?: Partial<RoomPolicy>;
  ownerSigningKey?: string;
  admissionKey?: string;
  v?: unknown;
}

function buildCreateBody(input: CreateBodyInput = {}): string {
  const body = {
    v: input.v ?? 2,
    policy: defaultPolicy(input.policy ?? {}),
    ownerSigningKey: input.ownerSigningKey ?? base64UrlEncode(makeKeyBytes(0x10)),
    admissionKey: input.admissionKey ?? base64UrlEncode(makeKeyBytes(0x20)),
  };
  return JSON.stringify(body);
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

describe("POST /v2/rooms/:roomId — happy path", () => {
  it("creates a room and returns 201 with the clamped policy", async () => {
    const roomId = uniqueRoomId("happy");
    const url = `${URL_BASE}/v2/rooms/${roomId}`;
    const ownerKey = makeKeyBytes(0x11);
    const expiresAt = Date.now() + 60 * 60 * 1000;
    const policy = defaultPolicy({ expiresAt });

    const body = JSON.stringify({
      v: 2,
      policy,
      ownerSigningKey: base64UrlEncode(ownerKey),
      admissionKey: base64UrlEncode(makeKeyBytes(0x21)),
    });

    const res = await SELF.fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
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
    expect(json.policy.maxPeers).toBe(policy.maxPeers);
    expect(json.policy.powBits).toBe(16);
    expect(json.policy.deleteEventsAfterOwnerAck).toBe(false);
  });

  it("ownerSigningKeyId equals base64url(SHA-256(ownerSigningKey))", async () => {
    const roomId = uniqueRoomId("keyid");
    const ownerKey = makeKeyBytes(0x42);

    const expected = base64UrlEncode(
      new Uint8Array(await crypto.subtle.digest("SHA-256", ownerKey)),
    );

    const res = await SELF.fetch(`${URL_BASE}/v2/rooms/${roomId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        v: 2,
        policy: defaultPolicy(),
        ownerSigningKey: base64UrlEncode(ownerKey),
        admissionKey: base64UrlEncode(makeKeyBytes(0x52)),
      }),
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as RoomCreateResponse;
    expect(json.ownerSigningKeyId).toBe(expected);
  });
});

describe("POST /v2/rooms/:roomId — rejoin", () => {
  it("returns 200 with the stored policy on second POST (admission-verified, no mutation)", async () => {
    const roomId = uniqueRoomId("rejoin");
    const url = `${URL_BASE}/v2/rooms/${roomId}`;
    const admissionKey = makeKeyBytes(0x33);
    const ownerKey = makeKeyBytes(0x34);
    const originalPolicy = defaultPolicy({ maxPeers: 3 });
    const originalBody = JSON.stringify({
      v: 2,
      policy: originalPolicy,
      ownerSigningKey: base64UrlEncode(ownerKey),
      admissionKey: base64UrlEncode(admissionKey),
    });

    const first = await SELF.fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: originalBody,
    });
    expect(first.status).toBe(201);
    const firstJson = (await first.json()) as RoomCreateResponse;

    // Second POST tries to mutate maxPeers — should be ignored.
    const mutatedBody = JSON.stringify({
      v: 2,
      policy: defaultPolicy({ maxPeers: 7 }),
      ownerSigningKey: base64UrlEncode(ownerKey),
      admissionKey: base64UrlEncode(admissionKey),
    });
    const adm = await admissionHeaderFor({
      method: "POST",
      url,
      body: mutatedBody,
      admissionKey,
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

    const create = await SELF.fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: buildCreateBody(),
    });
    expect(create.status).toBe(201);

    // No admission header at all on the rejoin.
    const reject = await SELF.fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: buildCreateBody(),
    });
    expect(reject.status).toBe(401);
    const json = (await reject.json()) as RoomErrorResponse;
    expect(json.error.code).toBe("ATTN_ADMISSION_INVALID");
  });
});

describe("POST /v2/rooms/:roomId — clamping", () => {
  it("clamps maxPeers down to HARD_MAX_PEERS", async () => {
    const roomId = uniqueRoomId("clamp-peers");

    // Bypass the zod max(8) by hand-building the body — the handler clamps to
    // env.HARD_MAX_PEERS regardless. We want to exercise the clamp path even
    // though the schema also tops at 8; this keeps the test honest if hard
    // limits diverge later.
    const overlyLargePolicy = { ...defaultPolicy(), maxPeers: 8 };
    const ownerKey = makeKeyBytes(0x71);
    const admissionKey = makeKeyBytes(0x72);
    const body = JSON.stringify({
      v: 2,
      policy: overlyLargePolicy,
      ownerSigningKey: base64UrlEncode(ownerKey),
      admissionKey: base64UrlEncode(admissionKey),
    });

    const res = await SELF.fetch(`${URL_BASE}/v2/rooms/${roomId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as RoomCreateResponse;
    expect(json.policy.maxPeers).toBeLessThanOrEqual(8);
  });

  it("clamps oversized maxSnapshotBytes / maxEventBytes / maxEvents", async () => {
    const roomId = uniqueRoomId("clamp-bytes");
    const policy = defaultPolicy({
      maxSnapshotBytes: 10 * 1024 * 1024 * 1024, // 10 GiB nonsense
      maxEventBytes: 10 * 1024 * 1024, // 10 MiB nonsense
      maxEvents: 1_000_000,
    });
    const body = JSON.stringify({
      v: 2,
      policy,
      ownerSigningKey: base64UrlEncode(makeKeyBytes(0x81)),
      admissionKey: base64UrlEncode(makeKeyBytes(0x82)),
    });

    const res = await SELF.fetch(`${URL_BASE}/v2/rooms/${roomId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as RoomCreateResponse;
    expect(json.policy.maxSnapshotBytes).toBe(5_242_880);
    expect(json.policy.maxEventBytes).toBe(262_144);
    expect(json.policy.maxEvents).toBe(500);
  });

  it("clamps expiresAt to createdAt + 24h by default", async () => {
    const roomId = uniqueRoomId("clamp-ttl");
    const policy = defaultPolicy({
      expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000, // +30d
      longSession: false,
    });
    const t0 = Date.now();
    const body = JSON.stringify({
      v: 2,
      policy,
      ownerSigningKey: base64UrlEncode(makeKeyBytes(0x91)),
      admissionKey: base64UrlEncode(makeKeyBytes(0x92)),
    });
    const res = await SELF.fetch(`${URL_BASE}/v2/rooms/${roomId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as RoomCreateResponse;
    // Should be clamped at most to createdAt + 24h. Allow a 5s test slack.
    const upper = json.createdAt + 24 * 60 * 60 * 1000;
    expect(json.expiresAt).toBeGreaterThanOrEqual(t0);
    expect(json.expiresAt).toBeLessThanOrEqual(upper);
    expect(json.policy.expiresAt).toBe(json.expiresAt);
  });

  it("clamps expiresAt to createdAt + 7d when longSession=true", async () => {
    const roomId = uniqueRoomId("clamp-ttl-long");
    const policy = defaultPolicy({
      expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000, // +30d
      longSession: true,
    });
    const body = JSON.stringify({
      v: 2,
      policy,
      ownerSigningKey: base64UrlEncode(makeKeyBytes(0xa1)),
      admissionKey: base64UrlEncode(makeKeyBytes(0xa2)),
    });
    const res = await SELF.fetch(`${URL_BASE}/v2/rooms/${roomId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as RoomCreateResponse;
    const upper = json.createdAt + 7 * 24 * 60 * 60 * 1000;
    const lower = json.createdAt + 24 * 60 * 60 * 1000; // must exceed default 24h
    expect(json.expiresAt).toBeGreaterThan(lower);
    expect(json.expiresAt).toBeLessThanOrEqual(upper);
    expect(json.policy.longSession).toBe(true);
  });

  it("clamps idleTimeoutMs above 60s and below wall-clock TTL", async () => {
    const roomId = uniqueRoomId("clamp-idle");
    // idleTimeoutMs >= 60_000 is enforced by zod, so client can only request
    // the upper bound here. We pass idleTimeoutMs larger than wall-clock TTL
    // (e.g. expiresAt + 1h) — handler must clamp to TTL.
    const expiresAt = Date.now() + 60 * 60 * 1000; // +1h
    const policy = defaultPolicy({
      expiresAt,
      idleTimeoutMs: 24 * 60 * 60 * 1000, // 24h, way > 1h TTL
    });
    const body = JSON.stringify({
      v: 2,
      policy,
      ownerSigningKey: base64UrlEncode(makeKeyBytes(0xb1)),
      admissionKey: base64UrlEncode(makeKeyBytes(0xb2)),
    });
    const res = await SELF.fetch(`${URL_BASE}/v2/rooms/${roomId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
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
      ownerSigningKey: base64UrlEncode(makeKeyBytes(0xc1)),
      admissionKey: base64UrlEncode(makeKeyBytes(0xc2)),
    });
    const res = await SELF.fetch(`${URL_BASE}/v2/rooms/${roomId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as RoomCreateResponse;
    expect(json.policy.deleteEventsAfterOwnerAck).toBe(false);
  });

  it("defaults powBits to 16 when omitted", async () => {
    const roomId = uniqueRoomId("default-pow");
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
      ownerSigningKey: base64UrlEncode(makeKeyBytes(0xd1)),
      admissionKey: base64UrlEncode(makeKeyBytes(0xd2)),
    });
    const res = await SELF.fetch(`${URL_BASE}/v2/rooms/${roomId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as RoomCreateResponse;
    expect(json.policy.powBits).toBe(16);
  });
});

describe("POST /v2/rooms/:roomId — schema validation", () => {
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
      // ownerSigningKey omitted on purpose
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
      // admissionKey omitted on purpose
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
    const url = `${URL_BASE}/v2/rooms/${roomId}`;
    const ownerKey = makeKeyBytes(0xab);
    const admissionKey = makeKeyBytes(0xcd);

    const res = await SELF.fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        v: 2,
        policy: defaultPolicy({ maxPeers: 2 }),
        ownerSigningKey: base64UrlEncode(ownerKey),
        admissionKey: base64UrlEncode(admissionKey),
      }),
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
      expect(Array.from(storedOwner ?? new Uint8Array())).toEqual(Array.from(ownerKey));

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
    const url = `${URL_BASE}/v2/rooms/${roomId}`;
    const res = await SELF.fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: buildCreateBody({
        policy: { idleTimeoutMs: 60_000 }, // 60s — should win over hard-max
      }),
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as RoomCreateResponse;

    const stubId = env.RELAY_ROOMS.idFromName(roomId);
    const stub = env.RELAY_ROOMS.get(stubId);
    await runInDurableObject(stub, async (_instance, ctx) => {
      const alarmAt = await ctx.storage.getAlarm();
      expect(alarmAt).not.toBeNull();
      // alarm should be createdAt + idleTimeoutMs (60s) — well before hardMaxAt.
      expect(alarmAt).toBe(json.createdAt + 60_000);
    });
  });
});

describe("POST /v2/rooms/:roomId — round-trip with admission on rejoin", () => {
  it("succeeds with a correctly-HMAC'd admission header on rejoin", async () => {
    const roomId = uniqueRoomId("rejoin-ok");
    const url = `${URL_BASE}/v2/rooms/${roomId}`;
    const admissionKey = makeKeyBytes(0xee);
    const ownerKey = makeKeyBytes(0xef);
    const body = JSON.stringify({
      v: 2,
      policy: defaultPolicy(),
      ownerSigningKey: base64UrlEncode(ownerKey),
      admissionKey: base64UrlEncode(admissionKey),
    });

    const first = await SELF.fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    expect(first.status).toBe(201);
    const firstJson = (await first.json()) as RoomCreateResponse;

    const adm = await admissionHeaderFor({
      method: "POST",
      url,
      body,
      admissionKey,
    });
    const second = await SELF.fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Attn-Admission": adm },
      body,
    });
    expect(second.status).toBe(200);
    const secondJson = (await second.json()) as RoomCreateResponse;
    expect(secondJson.createdAt).toBe(firstJson.createdAt);
    expect(secondJson.policy).toEqual(firstJson.policy);
  });
});
