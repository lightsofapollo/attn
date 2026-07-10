/**
 * Integration coverage for `POST /v2/rooms/:roomId/envelopes` (attn-nnj.5.7).
 *
 * Spec: planning/collab/relay-spec.md §POST /v2/rooms/:roomId/envelopes
 * Amendments: #6 (PoW on every write), #7 (batch cap 32, single PoW per batch)
 *
 * Tests go through the Worker via SELF.fetch so they exercise the index.ts
 * router → RoomDO end-to-end. Each test creates a fresh room + registers the
 * device(s) it needs so storage state is isolated by roomId.
 */

import { SELF, env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { base64UrlDecode, base64UrlEncode, canonicalRequest } from "../../src/admission";
import { canonicalize, type CanonicalValue } from "../../src/canonical";
import type { Env } from "../../src/env";
import type { EnvelopeInput, EnvelopeRecord, RoomPolicy } from "../../src/schema";
import { FIXED_POW_RAND, createPowHeader, mintPowForTests } from "../helpers/pow";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

const URL_BASE = "https://relay.example";

function targetIndexPrefix(deviceId: string): string {
  return `env_by_target_v2:${base64UrlEncode(
    new TextEncoder().encode(JSON.stringify(deviceId)),
  )}:`;
}

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
    maxSnapshotBytes: 1_000_000,
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

// Make each test's roomId unique. DO storage is shared across the run (see
// vitest.config.ts isolatedStorage=false note), so collisions must be avoided.
let roomCounter = 0;
function uniqueRoomId(label: string): string {
  roomCounter += 1;
  return `${label}-${Date.now().toString(36)}-${roomCounter}`;
}

async function createRoom(opts: {
  roomId: string;
  policy?: Partial<RoomPolicy>;
  ownerKp: SubtleKeypair;
}): Promise<Uint8Array> {
  const admissionKey = makeAdmissionKey((roomCounter * 7) & 0xff);
  const body = JSON.stringify({
    v: 2,
    policy: defaultPolicy(opts.policy ?? {}),
    ownerSigningKey: base64UrlEncode(opts.ownerKp.publicKeyBytes),
    admissionKey: base64UrlEncode(admissionKey),
  });
  const url = `${URL_BASE}/v2/rooms/${opts.roomId}`;
  // attn-nnj.5.17 (security-review §H1): first-create requires
  // Attn-Owner-Signature self-rooted to the body's ownerSigningKey.
  const ownerSig = await buildOwnerSig({
    method: "POST",
    url,
    body,
    privateKey: opts.ownerKp.privateKey,
  });
  const res = await SELF.fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Attn-Owner-Signature": ownerSig,
      "Attn-PoW": await createPowHeader(opts.roomId, opts.ownerKp.publicKeyBytes),
    },
    body,
  });
  if (res.status !== 201) {
    throw new Error(`room create failed: ${res.status} ${await res.text()}`);
  }
  return admissionKey;
}

async function buildOwnerSig(opts: {
  method: string;
  url: string;
  body?: string;
  privateKey: CryptoKey;
}): Promise<string> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  const signing = new Request(opts.url, {
    method: opts.method,
    headers,
    body: opts.body,
  });
  const canonical = await canonicalRequest(signing, new URL(opts.url).pathname);
  const sig = new Uint8Array(
    await crypto.subtle.sign({ name: "Ed25519" }, opts.privateKey, canonical),
  );
  return base64UrlEncode(sig);
}

// --- device builder (copied minimal subset from devices.test.ts) --------

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
  // Bump per call so each minted PoW token has a unique expiresAt → unique hash →
  // never replay-rejected across tests.
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

async function mintEnvelopePow(roomId: string, deviceId: string): Promise<string> {
  return mintPowForTests({
    roomId,
    deviceId,
    method: "POST",
    path: `/v2/rooms/${roomId}/envelopes`,
    difficulty: 12,
    expiresAt: nextPowExpiresAt(),
    rand: FIXED_POW_RAND,
  });
}

/** Register a device, returning nothing. Throws on non-204. */
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
      kind: opts.kind,
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

/**
 * Publish a target-only device containing `:` directly. The current PoW token
 * wire format is colon-delimited, so such an ID cannot be the PoW-bound author;
 * target routing itself must nevertheless treat it as opaque.
 */
async function injectColonTargetDevice(
  roomId: string,
  participantId: string,
  deviceId: string,
): Promise<void> {
  const stub = env.RELAY_ROOMS.get(env.RELAY_ROOMS.idFromName(roomId));
  await runInDurableObject(stub, async (_inst, state) => {
    await state.storage.put(`device:${participantId}:${deviceId}`, {
      deviceId,
      participantId,
      publicSigningKey: base64UrlEncode(new Uint8Array(32).fill(0x41)),
      publicEncryptionKey: base64UrlEncode(new Uint8Array(32).fill(0x42)),
      client: "attn-browser",
      kind: "reviewer",
      selfSignature: base64UrlEncode(new Uint8Array(64).fill(0x43)),
      registeredAt: Date.now(),
    });
  });
}

// --- envelope builders ---------------------------------------------------

interface BuildEnvelopeInput {
  envelopeId: string;
  authorId: string;
  deviceId: string;
  kind?: "event" | "snapshot_blob" | "signal";
  target?: { deviceId: string } | null;
  ciphertextBytes?: number;
  createdAt?: number;
  expiresAt?: number;
  /** Use this exact ciphertext (base64url) instead of generating zero-bytes. */
  ciphertext?: string;
}

/** Build an envelope with `ciphertextBytes` zero bytes of ciphertext (or use the override). */
function buildEnvelope(input: BuildEnvelopeInput): EnvelopeInput {
  const ciphertextBytes = input.ciphertextBytes ?? 32;
  let ciphertext: string;
  if (input.ciphertext !== undefined) {
    ciphertext = input.ciphertext;
  } else {
    const bytes = new Uint8Array(ciphertextBytes);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 13 + 7) & 0xff;
    ciphertext = base64UrlEncode(bytes);
  }
  const nonce = base64UrlEncode(new Uint8Array(24).fill(0x55));
  return {
    envelopeId: input.envelopeId,
    authorId: input.authorId,
    deviceId: input.deviceId,
    kind: input.kind ?? "event",
    target: input.target === undefined ? null : input.target,
    createdAt: input.createdAt ?? Date.now(),
    expiresAt: input.expiresAt ?? Date.now() + 60 * 60 * 1000,
    nonce,
    ciphertext,
    ciphertextBytes,
  };
}

interface AcceptedRecord {
  envelopeId: string;
  serverSeq: number;
}

interface AcceptResponse {
  accepted: AcceptedRecord[];
}

interface ErrorResponse {
  error: { code: string; message: string };
}

/** POST an envelope batch with a fresh admission + PoW. Returns the raw Response. */
async function postEnvelopes(opts: {
  roomId: string;
  admissionKey: Uint8Array;
  envelopes: EnvelopeInput[];
  /** Override the deviceId the PoW token binds to (defaults to first envelope's). */
  powDeviceId?: string;
  /** Skip Attn-Admission entirely. */
  omitAdmission?: boolean;
  /** Skip Attn-PoW entirely. */
  omitPow?: boolean;
}): Promise<Response> {
  const url = `${URL_BASE}/v2/rooms/${opts.roomId}/envelopes`;
  const body = JSON.stringify({ envelopes: opts.envelopes });
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
    const firstEnv = opts.envelopes[0];
    const deviceId = opts.powDeviceId ?? firstEnv?.deviceId ?? "unknown";
    headers["Attn-PoW"] = await mintEnvelopePow(opts.roomId, deviceId);
  }
  return SELF.fetch(url, { method: "POST", headers, body });
}

async function getEnvelopeStorageState(roomId: string): Promise<{
  envelopeCount: number;
  bytesUsed: number;
  serverSeq: number;
  oldestRetainedSeq: number;
  payloadCount: number;
  indexCount: number;
}> {
  const stub = env.RELAY_ROOMS.get(env.RELAY_ROOMS.idFromName(roomId));
  return runInDurableObject(stub, async (_inst, state) => {
    const [envelopeCount, bytesUsed, serverSeq, oldestRetainedSeq, payloads, indexes] =
      await Promise.all([
        state.storage.get<number>("meta:envelope_count"),
        state.storage.get<number>("meta:bytes_used"),
        state.storage.get<number>("meta:server_seq"),
        state.storage.get<number>("meta:oldest_retained_seq"),
        state.storage.list({ prefix: "env:" }),
        state.storage.list({ prefix: "env_idx:" }),
      ]);
    return {
      envelopeCount: envelopeCount ?? 0,
      bytesUsed: bytesUsed ?? 0,
      serverSeq: serverSeq ?? 0,
      oldestRetainedSeq: oldestRetainedSeq ?? 0,
      payloadCount: payloads.size,
      indexCount: indexes.size,
    };
  });
}

async function getDeviceRateTotal(roomId: string, deviceId: string): Promise<number> {
  const stub = env.RELAY_ROOMS.get(env.RELAY_ROOMS.idFromName(roomId));
  return runInDurableObject(stub, async (_inst, state) => {
    const entries = await state.storage.list<number>({ prefix: `rate:${deviceId}:` });
    return [...entries.values()].reduce((sum, count) => sum + count, 0);
  });
}

async function getRawEnvelopeAccounting(roomId: string): Promise<{
  envelopeCount: number | undefined;
  bytesUsed: number | undefined;
  bytesUsedR2: number | undefined;
  serverSeq: number | undefined;
  lastEventAt: number | undefined;
  payloadCount: number;
  indexCount: number;
}> {
  const stub = env.RELAY_ROOMS.get(env.RELAY_ROOMS.idFromName(roomId));
  return runInDurableObject(stub, async (_inst, state) => {
    const [envelopeCount, bytesUsed, bytesUsedR2, serverSeq, lastEventAt, payloads, indexes] =
      await Promise.all([
        state.storage.get<number>("meta:envelope_count"),
        state.storage.get<number>("meta:bytes_used"),
        state.storage.get<number>("meta:bytes_used_r2"),
        state.storage.get<number>("meta:server_seq"),
        state.storage.get<number>("meta:last_event_at"),
        state.storage.list({ prefix: "env:" }),
        state.storage.list({ prefix: "env_idx:" }),
      ]);
    return {
      envelopeCount,
      bytesUsed,
      bytesUsedR2,
      serverSeq,
      lastEventAt,
      payloadCount: payloads.size,
      indexCount: indexes.size,
    };
  });
}

async function getRoomStorageSnapshot(roomId: string): Promise<Map<string, unknown>> {
  const stub = env.RELAY_ROOMS.get(env.RELAY_ROOMS.idFromName(roomId));
  return runInDurableObject(stub, async (_inst, state) => {
    return new Map(await state.storage.list<unknown>());
  });
}

async function getEnvelopeContentSnapshot(roomId: string): Promise<Map<string, unknown>> {
  const all = await getRoomStorageSnapshot(roomId);
  const metadata = new Set([
    "meta:envelope_count",
    "meta:bytes_used",
    "meta:bytes_used_r2",
    "meta:server_seq",
    "meta:oldest_retained_seq",
    "meta:last_event_at",
  ]);
  return new Map(
    [...all].filter(([key]) =>
      metadata.has(key) ||
      key.startsWith("env:") ||
      key.startsWith("env_idx:") ||
      key.startsWith("env_by_target_v2:") ||
      key.startsWith("env_by_target:"),
    ),
  );
}

// --- tests ---------------------------------------------------------------

describe("POST /v2/rooms/:roomId/envelopes — happy path", () => {
  it("accepts a single envelope and returns 201 with serverSeq", async () => {
    const roomId = uniqueRoomId("env-single");
    const owner = await generateEd25519Keypair();
    const admissionKey = await createRoom({ roomId, ownerKp: owner });
    await registerDevice({
      roomId,
      admissionKey,
      deviceId: "dev-a",
      participantId: "alice",
    });

    const envelope = buildEnvelope({
      envelopeId: "env-001",
      authorId: "alice",
      deviceId: "dev-a",
    });
    const res = await postEnvelopes({
      roomId,
      admissionKey,
      envelopes: [envelope],
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as AcceptResponse;
    expect(body.accepted.length).toBe(1);
    const first = body.accepted[0];
    if (first === undefined) throw new Error("unreachable");
    expect(first.envelopeId).toBe("env-001");
    expect(first.serverSeq).toBe(1);
  });

  it("accepts a batch of 5 envelopes and returns 5 monotonically-increasing serverSeqs", async () => {
    const roomId = uniqueRoomId("env-batch5");
    const owner = await generateEd25519Keypair();
    const admissionKey = await createRoom({ roomId, ownerKp: owner });
    await registerDevice({
      roomId,
      admissionKey,
      deviceId: "dev-batch",
      participantId: "bob",
    });

    const envelopes: EnvelopeInput[] = [];
    for (let i = 0; i < 5; i++) {
      envelopes.push(
        buildEnvelope({
          envelopeId: `env-batch-${i}`,
          authorId: "bob",
          deviceId: "dev-batch",
        }),
      );
    }
    const res = await postEnvelopes({ roomId, admissionKey, envelopes });
    expect(res.status).toBe(201);
    const body = (await res.json()) as AcceptResponse;
    expect(body.accepted.length).toBe(5);
    // serverSeq should be 1..5 in order.
    for (let i = 0; i < 5; i++) {
      const entry = body.accepted[i];
      if (entry === undefined) throw new Error("unreachable");
      expect(entry.envelopeId).toBe(`env-batch-${i}`);
      expect(entry.serverSeq).toBe(i + 1);
    }
  });
});

describe("POST /v2/rooms/:roomId/envelopes — idempotency", () => {
  it("re-uploading an envelope returns the prior serverSeq without bumping the counter", async () => {
    const roomId = uniqueRoomId("env-idem");
    const owner = await generateEd25519Keypair();
    const admissionKey = await createRoom({ roomId, ownerKp: owner });
    await registerDevice({
      roomId,
      admissionKey,
      deviceId: "dev-i",
      participantId: "carol",
    });

    const envelope = buildEnvelope({
      envelopeId: "env-dupe",
      authorId: "carol",
      deviceId: "dev-i",
    });
    // First POST gets serverSeq=1.
    const r1 = await postEnvelopes({ roomId, admissionKey, envelopes: [envelope] });
    expect(r1.status).toBe(201);
    const b1 = (await r1.json()) as AcceptResponse;
    expect(b1.accepted[0]?.serverSeq).toBe(1);

    // A different envelope to advance the counter.
    const env2 = buildEnvelope({
      envelopeId: "env-second",
      authorId: "carol",
      deviceId: "dev-i",
    });
    const r2 = await postEnvelopes({ roomId, admissionKey, envelopes: [env2] });
    expect(r2.status).toBe(201);
    expect(((await r2.json()) as AcceptResponse).accepted[0]?.serverSeq).toBe(2);

    // Re-upload env-dupe. Should resolve to serverSeq=1, not bump to 3.
    const r3 = await postEnvelopes({ roomId, admissionKey, envelopes: [envelope] });
    expect(r3.status).toBe(201);
    const b3 = (await r3.json()) as AcceptResponse;
    expect(b3.accepted.length).toBe(1);
    expect(b3.accepted[0]?.envelopeId).toBe("env-dupe");
    expect(b3.accepted[0]?.serverSeq).toBe(1);

    // Now a fresh envelope. Counter should land at 3 (proves the dupe didn't
    // consume a seq).
    const env4 = buildEnvelope({
      envelopeId: "env-third",
      authorId: "carol",
      deviceId: "dev-i",
    });
    const r4 = await postEnvelopes({ roomId, admissionKey, envelopes: [env4] });
    expect(r4.status).toBe(201);
    expect(((await r4.json()) as AcceptResponse).accepted[0]?.serverSeq).toBe(3);
  });

  it("collapses field-identical same-batch duplicates after normalizing omitted target", async () => {
    const roomId = uniqueRoomId("env-same-batch-idem");
    const owner = await generateEd25519Keypair();
    const admissionKey = await createRoom({ roomId, ownerKp: owner });
    await registerDevice({
      roomId,
      admissionKey,
      deviceId: "dev-same-batch",
      participantId: "same-batch",
    });

    const withNullTarget = buildEnvelope({
      envelopeId: "same-batch-id",
      authorId: "same-batch",
      deviceId: "dev-same-batch",
      ciphertextBytes: 19,
    });
    const withoutTarget: EnvelopeInput = { ...withNullTarget };
    delete withoutTarget.target;

    const first = await postEnvelopes({
      roomId,
      admissionKey,
      envelopes: [withoutTarget, withNullTarget],
    });
    expect(first.status).toBe(201);
    expect((await first.json()) as AcceptResponse).toEqual({
      accepted: [{ envelopeId: "same-batch-id", serverSeq: 1 }],
    });
    expect(await getEnvelopeStorageState(roomId)).toEqual({
      envelopeCount: 1,
      bytesUsed: 19,
      serverSeq: 1,
      oldestRetainedSeq: 0,
      payloadCount: 1,
      indexCount: 1,
    });

    const next = await postEnvelopes({
      roomId,
      admissionKey,
      envelopes: [
        buildEnvelope({
          envelopeId: "same-batch-next",
          authorId: "same-batch",
          deviceId: "dev-same-batch",
          ciphertextBytes: 7,
        }),
      ],
    });
    expect(next.status).toBe(201);
    expect(((await next.json()) as AcceptResponse).accepted[0]?.serverSeq).toBe(2);
  });

  it("rejects conflicting same-batch envelopeId reuse without mutating envelope storage", async () => {
    const roomId = uniqueRoomId("env-same-batch-conflict");
    const owner = await generateEd25519Keypair();
    const admissionKey = await createRoom({ roomId, ownerKp: owner });
    await registerDevice({
      roomId,
      admissionKey,
      deviceId: "dev-conflict",
      participantId: "conflict-author",
    });

    const first = buildEnvelope({
      envelopeId: "conflicting-id",
      authorId: "conflict-author",
      deviceId: "dev-conflict",
      kind: "signal",
      target: { deviceId: "target-a" },
      ciphertextBytes: 23,
    });
    const conflict: EnvelopeInput = { ...first, target: { deviceId: "target-b" } };

    const rateBefore = await getDeviceRateTotal(roomId, "dev-conflict");
    const missingPow = await postEnvelopes({
      roomId,
      admissionKey,
      envelopes: [first, conflict],
      omitPow: true,
    });
    expect(missingPow.status).toBe(400);
    expect(((await missingPow.json()) as ErrorResponse).error.code).toBe("ATTN_POW_INVALID");
    expect(await getDeviceRateTotal(roomId, "dev-conflict")).toBe(rateBefore + 1);

    const before = await getEnvelopeStorageState(roomId);

    const response = await postEnvelopes({
      roomId,
      admissionKey,
      envelopes: [first, conflict],
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as ErrorResponse).error.code).toBe(
      "ATTN_ENVELOPE_ID_CONFLICT",
    );
    expect(await getEnvelopeStorageState(roomId)).toEqual(before);
    expect(before).toMatchObject({
      envelopeCount: 0,
      bytesUsed: 0,
      serverSeq: 0,
      payloadCount: 0,
      indexCount: 0,
    });
  });

  it("rejects an unregistered first device before conflict rate or PoW mutation", async () => {
    const roomId = uniqueRoomId("env-conflict-unregistered");
    const owner = await generateEd25519Keypair();
    const admissionKey = await createRoom({ roomId, ownerKp: owner });
    const first = buildEnvelope({
      envelopeId: "unregistered-conflict",
      authorId: "ghost",
      deviceId: "ghost-device",
      kind: "signal",
      target: { deviceId: "target-a" },
    });
    const conflict: EnvelopeInput = { ...first, target: { deviceId: "target-b" } };
    const before = await getRoomStorageSnapshot(roomId);

    const response = await postEnvelopes({
      roomId,
      admissionKey,
      envelopes: [first, conflict],
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as ErrorResponse).error.code).toBe(
      "ATTN_DEVICE_UNREGISTERED",
    );
    expect(await getRoomStorageSnapshot(roomId)).toEqual(before);
  });

  it("charges only the fresh member of a persisted-duplicate plus fresh batch", async () => {
    const roomId = uniqueRoomId("env-persisted-plus-fresh");
    const owner = await generateEd25519Keypair();
    const admissionKey = await createRoom({ roomId, ownerKp: owner });
    await registerDevice({
      roomId,
      admissionKey,
      deviceId: "dev-mixed",
      participantId: "mixed",
    });
    const persisted = buildEnvelope({
      envelopeId: "persisted-id",
      authorId: "mixed",
      deviceId: "dev-mixed",
      ciphertextBytes: 11,
    });
    expect((await postEnvelopes({ roomId, admissionKey, envelopes: [persisted] })).status).toBe(
      201,
    );
    const fresh = buildEnvelope({
      envelopeId: "fresh-id",
      authorId: "mixed",
      deviceId: "dev-mixed",
      ciphertextBytes: 22,
    });

    const response = await postEnvelopes({
      roomId,
      admissionKey,
      envelopes: [persisted, fresh],
    });
    expect(response.status).toBe(201);
    expect((await response.json()) as AcceptResponse).toEqual({
      accepted: [
        { envelopeId: "persisted-id", serverSeq: 1 },
        { envelopeId: "fresh-id", serverSeq: 2 },
      ],
    });
    expect(await getEnvelopeStorageState(roomId)).toEqual({
      envelopeCount: 2,
      bytesUsed: 33,
      serverSeq: 2,
      oldestRetainedSeq: 0,
      payloadCount: 2,
      indexCount: 2,
    });
  });
});

describe("POST /v2/rooms/:roomId/envelopes — batch cap", () => {
  it("rejects a batch of 33 envelopes with 400 ATTN_BATCH_TOO_LARGE", async () => {
    const roomId = uniqueRoomId("env-cap");
    const owner = await generateEd25519Keypair();
    const admissionKey = await createRoom({ roomId, ownerKp: owner });
    await registerDevice({
      roomId,
      admissionKey,
      deviceId: "dev-cap",
      participantId: "dave",
    });

    const envelopes: EnvelopeInput[] = [];
    for (let i = 0; i < 33; i++) {
      envelopes.push(
        buildEnvelope({
          envelopeId: `env-cap-${i}`,
          authorId: "dave",
          deviceId: "dev-cap",
        }),
      );
    }
    const res = await postEnvelopes({ roomId, admissionKey, envelopes });
    expect(res.status).toBe(400);
    const err = (await res.json()) as ErrorResponse;
    expect(err.error.code).toBe("ATTN_BATCH_TOO_LARGE");
  });
});

describe("POST /v2/rooms/:roomId/envelopes — per-envelope validation", () => {
  it("rejects when ciphertextBytes does not equal decoded length (400 ATTN_CIPHERTEXT_LENGTH_MISMATCH)", async () => {
    const roomId = uniqueRoomId("env-mismatch");
    const owner = await generateEd25519Keypair();
    const admissionKey = await createRoom({ roomId, ownerKp: owner });
    await registerDevice({
      roomId,
      admissionKey,
      deviceId: "dev-mis",
      participantId: "eve",
    });

    const env = buildEnvelope({
      envelopeId: "env-mismatch",
      authorId: "eve",
      deviceId: "dev-mis",
      ciphertextBytes: 32,
    });
    // Tamper: claim 32 bytes but supply 16.
    const tampered: EnvelopeInput = { ...env, ciphertext: base64UrlEncode(new Uint8Array(16)) };
    const res = await postEnvelopes({ roomId, admissionKey, envelopes: [tampered] });
    expect(res.status).toBe(400);
    const err = (await res.json()) as ErrorResponse;
    expect(err.error.code).toBe("ATTN_CIPHERTEXT_LENGTH_MISMATCH");
  });

  it("rejects an event envelope exceeding policy.maxEventBytes (413 ATTN_ENVELOPE_TOO_LARGE)", async () => {
    const roomId = uniqueRoomId("env-big-event");
    const owner = await generateEd25519Keypair();
    // maxEventBytes=1024 makes the threshold easy to cross without huge payloads.
    const admissionKey = await createRoom({
      roomId,
      ownerKp: owner,
      policy: { maxEventBytes: 1024 },
    });
    await registerDevice({
      roomId,
      admissionKey,
      deviceId: "dev-be",
      participantId: "frank",
    });

    const big = buildEnvelope({
      envelopeId: "env-too-big",
      authorId: "frank",
      deviceId: "dev-be",
      kind: "event",
      ciphertextBytes: 2048,
    });
    const res = await postEnvelopes({ roomId, admissionKey, envelopes: [big] });
    expect(res.status).toBe(413);
    const err = (await res.json()) as ErrorResponse;
    expect(err.error.code).toBe("ATTN_ENVELOPE_TOO_LARGE");
  });

  it("rejects a snapshot_blob envelope exceeding policy.maxSnapshotBytes (413 ATTN_ENVELOPE_TOO_LARGE)", async () => {
    const roomId = uniqueRoomId("env-big-snap");
    const owner = await generateEd25519Keypair();
    const admissionKey = await createRoom({
      roomId,
      ownerKp: owner,
      policy: { maxSnapshotBytes: 2048, maxEventBytes: 2048 },
    });
    await registerDevice({
      roomId,
      admissionKey,
      deviceId: "dev-bs",
      participantId: "grace",
    });

    const big = buildEnvelope({
      envelopeId: "env-snap-big",
      authorId: "grace",
      deviceId: "dev-bs",
      kind: "snapshot_blob",
      ciphertextBytes: 4096,
    });
    const res = await postEnvelopes({ roomId, admissionKey, envelopes: [big] });
    expect(res.status).toBe(413);
    const err = (await res.json()) as ErrorResponse;
    expect(err.error.code).toBe("ATTN_ENVELOPE_TOO_LARGE");
  });

  it("rejects an envelope whose (authorId, deviceId) is not registered (400 ATTN_DEVICE_UNREGISTERED)", async () => {
    const roomId = uniqueRoomId("env-unreg");
    const owner = await generateEd25519Keypair();
    const admissionKey = await createRoom({ roomId, ownerKp: owner });
    await registerDevice({
      roomId,
      admissionKey,
      deviceId: "dev-known",
      participantId: "harriet",
    });

    const env = buildEnvelope({
      envelopeId: "env-from-ghost",
      authorId: "harriet",
      // PoW is bound to this deviceId, but no device record exists for it.
      deviceId: "dev-ghost",
    });
    const res = await postEnvelopes({ roomId, admissionKey, envelopes: [env] });
    expect(res.status).toBe(400);
    const err = (await res.json()) as ErrorResponse;
    expect(err.error.code).toBe("ATTN_DEVICE_UNREGISTERED");
  });
});

describe("POST /v2/rooms/:roomId/envelopes — room caps", () => {
  it.each(["negative bytes", "missing server seq"] as const)(
    "rejects corrupt ingest metadata (%s) without storing or charging a payload",
    async (corruption) => {
      const roomId = uniqueRoomId(`env-corrupt-${corruption.replaceAll(" ", "-")}`);
      const owner = await generateEd25519Keypair();
      const admissionKey = await createRoom({ roomId, ownerKp: owner });
      await registerDevice({
        roomId,
        admissionKey,
        deviceId: "dev-corrupt",
        participantId: "corrupt",
      });
      const stub = env.RELAY_ROOMS.get(env.RELAY_ROOMS.idFromName(roomId));
      await runInDurableObject(stub, async (_inst, state) => {
        if (corruption === "negative bytes") {
          await state.storage.put("meta:bytes_used", -1);
        } else {
          await state.storage.delete("meta:server_seq");
        }
      });
      const before = await getRawEnvelopeAccounting(roomId);

      const response = await postEnvelopes({
        roomId,
        admissionKey,
        envelopes: [
          buildEnvelope({
            envelopeId: `corrupt-${corruption}`,
            authorId: "corrupt",
            deviceId: "dev-corrupt",
          }),
        ],
      });
      expect(response.status).toBe(500);
      expect(((await response.json()) as ErrorResponse).error.code).toBe("ATTN_ROOM_CORRUPT");
      expect(await getRawEnvelopeAccounting(roomId)).toEqual(before);
    },
  );

  it("rejects the whole batch with 507 ATTN_ROOM_EVENT_CAP when maxEvents would be exceeded", async () => {
    const roomId = uniqueRoomId("env-evcap");
    const owner = await generateEd25519Keypair();
    // Tiny event cap so a single batch trips it.
    const admissionKey = await createRoom({
      roomId,
      ownerKp: owner,
      policy: { maxEvents: 2 },
    });
    await registerDevice({
      roomId,
      admissionKey,
      deviceId: "dev-ec",
      participantId: "ivy",
    });

    // Fill to the cap (2/2).
    const fill: EnvelopeInput[] = [
      buildEnvelope({ envelopeId: "evc-1", authorId: "ivy", deviceId: "dev-ec" }),
      buildEnvelope({ envelopeId: "evc-2", authorId: "ivy", deviceId: "dev-ec" }),
    ];
    const r1 = await postEnvelopes({ roomId, admissionKey, envelopes: fill });
    expect(r1.status).toBe(201);

    // One more → rejected.
    const r2 = await postEnvelopes({
      roomId,
      admissionKey,
      envelopes: [
        buildEnvelope({ envelopeId: "evc-3", authorId: "ivy", deviceId: "dev-ec" }),
      ],
    });
    expect(r2.status).toBe(507);
    const err = (await r2.json()) as ErrorResponse;
    expect(err.error.code).toBe("ATTN_ROOM_EVENT_CAP");
  });

  it("rejects the whole batch with 507 ATTN_ROOM_STORAGE_FULL when room bytes cap is exceeded", async () => {
    // The HARD_MAX_ROOM_BYTES from wrangler.toml is 25 MiB. To trip it without
    // shipping 25 MiB of payload, we mutate the DO storage directly to
    // pre-load meta:bytes_used near the ceiling, then POST a single envelope
    // whose ciphertextBytes pushes us over.
    const roomId = uniqueRoomId("env-bcap");
    const owner = await generateEd25519Keypair();
    const admissionKey = await createRoom({ roomId, ownerKp: owner });
    await registerDevice({
      roomId,
      admissionKey,
      deviceId: "dev-bc",
      participantId: "jack",
    });

    const HARD_MAX_ROOM_BYTES = Number(env.HARD_MAX_ROOM_BYTES);
    expect(HARD_MAX_ROOM_BYTES).toBeGreaterThan(0);

    // Bump meta:bytes_used to one byte under the cap.
    const id = env.RELAY_ROOMS.idFromName(roomId);
    const stub = env.RELAY_ROOMS.get(id);
    await runInDurableObject(stub, async (_inst, state) => {
      await state.storage.put<number>("meta:bytes_used", HARD_MAX_ROOM_BYTES - 1);
    });

    // 2-byte ciphertext → would push us 1 byte over the cap.
    const env2 = buildEnvelope({
      envelopeId: "env-too-fat",
      authorId: "jack",
      deviceId: "dev-bc",
      ciphertextBytes: 2,
    });
    const res = await postEnvelopes({ roomId, admissionKey, envelopes: [env2] });
    expect(res.status).toBe(507);
    const err = (await res.json()) as ErrorResponse;
    expect(err.error.code).toBe("ATTN_ROOM_STORAGE_FULL");
  });

  it("enforces HARD_MAX_ROOM_BYTES across R2 reservations plus inline ciphertext", async () => {
    const roomId = uniqueRoomId("env-combined-cap");
    const owner = await generateEd25519Keypair();
    const admissionKey = await createRoom({ roomId, ownerKp: owner });
    await registerDevice({
      roomId,
      admissionKey,
      deviceId: "dev-combined",
      participantId: "combined",
    });

    const hardMax = Number(env.HARD_MAX_ROOM_BYTES);
    const stub = env.RELAY_ROOMS.get(env.RELAY_ROOMS.idFromName(roomId));
    await runInDurableObject(stub, async (_inst, state) => {
      await state.storage.put("meta:bytes_used_r2", hardMax - 1);
    });

    const response = await postEnvelopes({
      roomId,
      admissionKey,
      envelopes: [
        buildEnvelope({
          envelopeId: "combined-overflow",
          authorId: "combined",
          deviceId: "dev-combined",
          ciphertextBytes: 2,
        }),
      ],
    });
    expect(response.status).toBe(507);
    const error = (await response.json()) as ErrorResponse;
    expect(error.error.code).toBe("ATTN_ROOM_STORAGE_FULL");
  });
});

describe("POST /v2/rooms/:roomId/envelopes — protection layers", () => {
  it("rejects POST without Attn-Admission header (401)", async () => {
    const roomId = uniqueRoomId("env-no-adm");
    const owner = await generateEd25519Keypair();
    const admissionKey = await createRoom({ roomId, ownerKp: owner });
    await registerDevice({
      roomId,
      admissionKey,
      deviceId: "dev-na",
      participantId: "kate",
    });

    const env = buildEnvelope({
      envelopeId: "env-na",
      authorId: "kate",
      deviceId: "dev-na",
    });
    const res = await postEnvelopes({
      roomId,
      admissionKey,
      envelopes: [env],
      omitAdmission: true,
    });
    expect(res.status).toBe(401);
    const err = (await res.json()) as ErrorResponse;
    expect(err.error.code).toBe("ATTN_ADMISSION_INVALID");
  });

  it("rejects POST without Attn-PoW header (400 ATTN_POW_INVALID)", async () => {
    const roomId = uniqueRoomId("env-no-pow");
    const owner = await generateEd25519Keypair();
    const admissionKey = await createRoom({ roomId, ownerKp: owner });
    await registerDevice({
      roomId,
      admissionKey,
      deviceId: "dev-np",
      participantId: "leo",
    });

    const env = buildEnvelope({
      envelopeId: "env-np",
      authorId: "leo",
      deviceId: "dev-np",
    });
    const res = await postEnvelopes({
      roomId,
      admissionKey,
      envelopes: [env],
      omitPow: true,
    });
    expect(res.status).toBe(400);
    const err = (await res.json()) as ErrorResponse;
    expect(err.error.code).toBe("ATTN_POW_INVALID");
  });
});

describe("POST /v2/rooms/:roomId/envelopes — signal routing + sub-cap", () => {
  it("stores a kind=signal envelope under env_by_target:<targetDeviceId>:...", async () => {
    const roomId = uniqueRoomId("env-signal");
    const owner = await generateEd25519Keypair();
    const admissionKey = await createRoom({ roomId, ownerKp: owner });
    await registerDevice({
      roomId,
      admissionKey,
      deviceId: "dev-from",
      participantId: "mona",
    });
    await registerDevice({
      roomId,
      admissionKey,
      deviceId: "dev-to",
      participantId: "owen",
    });

    const sig = buildEnvelope({
      envelopeId: "env-sig-1",
      authorId: "mona",
      deviceId: "dev-from",
      kind: "signal",
      target: { deviceId: "dev-to" },
    });
    const res = await postEnvelopes({ roomId, admissionKey, envelopes: [sig] });
    expect(res.status).toBe(201);

    // Assert: the injective v2 target index has exactly one entry.
    const id = env.RELAY_ROOMS.idFromName(roomId);
    const stub = env.RELAY_ROOMS.get(id);
    await runInDurableObject(stub, async (_inst, state) => {
      const entries = await state.storage.list({ prefix: targetIndexPrefix("dev-to") });
      expect(entries.size).toBe(1);
      // The key should contain the envelopeId at its tail.
      const keys = [...entries.keys()];
      const onlyKey = keys[0];
      if (onlyKey === undefined) throw new Error("unreachable");
      expect(onlyKey.endsWith(":env-sig-1")).toBe(true);
    });
  });

  it("uses injective v2 keys for target/envelope pairs that collide in the legacy format", async () => {
    const roomId = uniqueRoomId("env-signal-key-collision");
    const owner = await generateEd25519Keypair();
    const admissionKey = await createRoom({ roomId, ownerKp: owner });
    await registerDevice({
      roomId,
      admissionKey,
      deviceId: "dev-collision-author",
      participantId: "collision-author",
    });
    const p1 = "00000000000000000001";
    const p2 = "00000000000000000002";
    const firstTarget = "x";
    const firstEnvelopeId = `foo:${p2}:b`;
    const secondTarget = `x:${p1}:foo`;
    const loneSurrogateTarget = "\ud800";
    const replacementTarget = "\ufffd";
    await injectColonTargetDevice(roomId, "target-one", firstTarget);
    await injectColonTargetDevice(roomId, "target-two", secondTarget);
    await injectColonTargetDevice(roomId, "target-three", loneSurrogateTarget);
    await injectColonTargetDevice(roomId, "target-four", replacementTarget);

    const legacyOne = `env_by_target:${firstTarget}:${p1}:${firstEnvelopeId}`;
    const legacyTwo = `env_by_target:${secondTarget}:${p2}:b`;
    expect(legacyOne).toBe(legacyTwo);

    const response = await postEnvelopes({
      roomId,
      admissionKey,
      envelopes: [
        buildEnvelope({
          envelopeId: firstEnvelopeId,
          authorId: "collision-author",
          deviceId: "dev-collision-author",
          kind: "signal",
          target: { deviceId: firstTarget },
        }),
        buildEnvelope({
          envelopeId: "b",
          authorId: "collision-author",
          deviceId: "dev-collision-author",
          kind: "signal",
          target: { deviceId: secondTarget },
        }),
        buildEnvelope({
          envelopeId: "lone-surrogate",
          authorId: "collision-author",
          deviceId: "dev-collision-author",
          kind: "signal",
          target: { deviceId: loneSurrogateTarget },
        }),
        buildEnvelope({
          envelopeId: "replacement-character",
          authorId: "collision-author",
          deviceId: "dev-collision-author",
          kind: "signal",
          target: { deviceId: replacementTarget },
        }),
      ],
    });
    expect(response.status).toBe(201);

    const stub = env.RELAY_ROOMS.get(env.RELAY_ROOMS.idFromName(roomId));
    await runInDurableObject(stub, async (_inst, state) => {
      const firstKeys = await state.storage.list({ prefix: targetIndexPrefix(firstTarget) });
      const secondKeys = await state.storage.list({ prefix: targetIndexPrefix(secondTarget) });
      const loneSurrogateKeys = await state.storage.list({
        prefix: targetIndexPrefix(loneSurrogateTarget),
      });
      const replacementKeys = await state.storage.list({
        prefix: targetIndexPrefix(replacementTarget),
      });
      const allV2 = await state.storage.list({ prefix: "env_by_target_v2:" });
      expect(firstKeys.size).toBe(1);
      expect(secondKeys.size).toBe(1);
      expect(loneSurrogateKeys.size).toBe(1);
      expect(replacementKeys.size).toBe(1);
      expect(allV2.size).toBe(4);
      expect([...firstKeys.keys()][0]).not.toBe([...secondKeys.keys()][0]);
      expect([...loneSurrogateKeys.keys()][0]).not.toBe([...replacementKeys.keys()][0]);
    });
  });

  it("rejects a stale exact target index before mutating fresh signal state", async () => {
    const roomId = uniqueRoomId("env-signal-corrupt-index");
    const owner = await generateEd25519Keypair();
    const admissionKey = await createRoom({ roomId, ownerKp: owner });
    await registerDevice({
      roomId,
      admissionKey,
      deviceId: "dev-signal-author",
      participantId: "signal-author",
    });
    await injectColonTargetDevice(roomId, "signal-target", "target:colon");
    const stub = env.RELAY_ROOMS.get(env.RELAY_ROOMS.idFromName(roomId));
    const corruptKey =
      `${targetIndexPrefix("target:colon")}00000000000000000077:missing:payload`;
    await runInDurableObject(stub, async (_inst, state) => {
      await state.storage.put(corruptKey, "");
    });
    const before = await getRawEnvelopeAccounting(roomId);
    const fullBefore = await getEnvelopeContentSnapshot(roomId);

    const response = await postEnvelopes({
      roomId,
      admissionKey,
      envelopes: [
        buildEnvelope({
          envelopeId: "fresh:signal",
          authorId: "signal-author",
          deviceId: "dev-signal-author",
          kind: "signal",
          target: { deviceId: "target:colon" },
        }),
      ],
    });
    expect(response.status).toBe(500);
    expect(((await response.json()) as ErrorResponse).error.code).toBe("ATTN_ROOM_CORRUPT");
    expect(await getRawEnvelopeAccounting(roomId)).toEqual(before);
    expect(await getEnvelopeContentSnapshot(roomId)).toEqual(fullBefore);
    await runInDurableObject(stub, async (_inst, state) => {
      expect(await state.storage.get(corruptKey)).toBe("");
      expect((await state.storage.list({ prefix: targetIndexPrefix("target:colon") })).size).toBe(1);
    });
  });

  it("FIFO-evicts signals with exact atomic count, byte, index, and cursor accounting", async () => {
    const roomId = uniqueRoomId("env-sigcap");
    const owner = await generateEd25519Keypair();
    // Big maxEvents so we don't trip the event cap first (need at least 65).
    const admissionKey = await createRoom({
      roomId,
      ownerKp: owner,
      policy: { maxEvents: 200 },
    });
    await registerDevice({
      roomId,
      admissionKey,
      deviceId: "dev-sf",
      participantId: "pia",
    });
    await injectColonTargetDevice(roomId, "quinn", "dev:st");

    // Send 64 signals one-per-batch so each gets its own padded seq. (Batching
    // would still increment seqs but I want one envelope per call for clarity
    // and to keep each PoW token small.)
    for (let i = 0; i < 64; i++) {
      const e = buildEnvelope({
        envelopeId: `sig-${String(i).padStart(3, "0")}`,
        authorId: "pia",
        deviceId: "dev-sf",
        kind: "signal",
        target: { deviceId: "dev:st" },
        ciphertextBytes: 16 + i,
      });
      const r = await postEnvelopes({ roomId, admissionKey, envelopes: [e] });
      expect(r.status).toBe(201);
    }

    // Make the would-be FIFO victim corrupt. Planning must reject before the
    // 65th signal, its indexes, accounting, rate key, or PoW replay marker can
    // mutate—proving validation sits on the safe side of the one transaction.
    const id = env.RELAY_ROOMS.idFromName(roomId);
    const stub = env.RELAY_ROOMS.get(id);
    const oldestPayloadKey = "env:00000000000000000001:sig-000";
    let oldestRecord: EnvelopeRecord | undefined;
    await runInDurableObject(stub, async (_inst, state) => {
      oldestRecord = await state.storage.get<EnvelopeRecord>(oldestPayloadKey);
      if (oldestRecord === undefined) throw new Error("missing oldest signal fixture");
      await state.storage.put(oldestPayloadKey, { ...oldestRecord, ciphertextBytes: -1 });
    });
    const corruptSnapshot = await getEnvelopeContentSnapshot(roomId);
    const sixtyFifth = buildEnvelope({
      envelopeId: "sig-064",
      authorId: "pia",
      deviceId: "dev-sf",
      kind: "signal",
      target: { deviceId: "dev:st" },
      ciphertextBytes: 80,
    });
    const corruptResponse = await postEnvelopes({
      roomId,
      admissionKey,
      envelopes: [sixtyFifth],
    });
    expect(corruptResponse.status).toBe(500);
    expect(((await corruptResponse.json()) as ErrorResponse).error.code).toBe(
      "ATTN_ROOM_CORRUPT",
    );
    expect(await getEnvelopeContentSnapshot(roomId)).toEqual(corruptSnapshot);

    await runInDurableObject(stub, async (_inst, state) => {
      if (oldestRecord === undefined) throw new Error("missing oldest signal fixture");
      await state.storage.put(oldestPayloadKey, oldestRecord);
    });
    expect(
      (await postEnvelopes({ roomId, admissionKey, envelopes: [sixtyFifth] })).status,
    ).toBe(201);

    // After 65 inserts, the bucket holds seq 2..65. Payload/index deletion and
    // the exact count/byte/cursor debit must have landed together; env_idx for
    // the evicted id intentionally remains as its idempotency tombstone.
    await runInDurableObject(stub, async (_inst, state) => {
      const [entries, payloads, indexes, count, bytes, serverSeq, oldest] = await Promise.all([
        state.storage.list({ prefix: targetIndexPrefix("dev:st") }),
        state.storage.list({ prefix: "env:" }),
        state.storage.list({ prefix: "env_idx:" }),
        state.storage.get<number>("meta:envelope_count"),
        state.storage.get<number>("meta:bytes_used"),
        state.storage.get<number>("meta:server_seq"),
        state.storage.get<number>("meta:oldest_retained_seq"),
      ]);
      expect(entries.size).toBe(64);
      expect(payloads.size).toBe(64);
      expect(indexes.size).toBe(65);
      expect(count).toBe(64);
      expect(bytes).toBe(Array.from({ length: 64 }, (_, i) => 17 + i).reduce((a, b) => a + b, 0));
      expect(serverSeq).toBe(65);
      expect(oldest).toBe(2);
      expect(await state.storage.get("env:00000000000000000001:sig-000")).toBeUndefined();
      expect(await state.storage.get("env_idx:sig-000")).toBe("00000000000000000001");
      // The evicted envelope id is `sig-000`; assert no remaining key ends with that.
      for (const key of entries.keys()) {
        expect(key.endsWith(":sig-000")).toBe(false);
      }
    });

    const beforeRetry = await getEnvelopeStorageState(roomId);
    const retry = await postEnvelopes({
      roomId,
      admissionKey,
      envelopes: [
        buildEnvelope({
          envelopeId: "sig-000",
          authorId: "pia",
          deviceId: "dev-sf",
          kind: "signal",
          target: { deviceId: "dev:st" },
          ciphertextBytes: 16,
        }),
      ],
    });
    expect(retry.status).toBe(201);
    expect((await retry.json()) as AcceptResponse).toEqual({
      accepted: [{ envelopeId: "sig-000", serverSeq: 1 }],
    });
    expect(await getEnvelopeStorageState(roomId)).toEqual(beforeRetry);

    // One request can force multiple varying-size FIFO evictions. After adding
    // seq 66..68, retained payloads correspond to i=4..67 exactly.
    const extra = Array.from({ length: 3 }, (_, offset) => {
      const i = 65 + offset;
      return buildEnvelope({
        envelopeId: `sig-${String(i).padStart(3, "0")}`,
        authorId: "pia",
        deviceId: "dev-sf",
        kind: "signal",
        target: { deviceId: "dev:st" },
        ciphertextBytes: 16 + i,
      });
    });
    const extraResponse = await postEnvelopes({ roomId, admissionKey, envelopes: extra });
    expect(extraResponse.status).toBe(201);
    const finalState = await getEnvelopeStorageState(roomId);
    expect(finalState).toEqual({
      envelopeCount: 64,
      bytesUsed: Array.from({ length: 64 }, (_, i) => 20 + i).reduce((a, b) => a + b, 0),
      serverSeq: 68,
      oldestRetainedSeq: 5,
      payloadCount: 64,
      indexCount: 68,
    });
  });
});
