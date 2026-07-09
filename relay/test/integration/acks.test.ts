/**
 * Integration coverage for `POST /v2/rooms/:roomId/acks` (attn-nnj.5.9).
 *
 * Spec: planning/collab/relay-spec.md §POST /v2/rooms/:roomId/acks
 * Amendments: #12 (deleteEventsAfterOwnerAck defaults to false)
 *
 * Test surface (in order):
 *   1. Reviewer ack (no delete header) — 204, envelope retained.
 *   2. Owner ack without owner-sig header (delete-disabled policy) — 204, retained.
 *   3. Owner ack WITH owner-sig but policy.deleteEventsAfterOwnerAck=false — 204,
 *      envelope retained (header ignored, no error).
 *   4. Owner ack WITH owner-sig + policy enabled — envelope deleted, bytes_used
 *      and envelope_count decremented.
 *   5. Non-owner sends a header (reviewer device) — falls through to no-delete,
 *      no 403 (per task pin: ignore non-owner signatures silently).
 *   6. Idempotent: same envelope acked twice — both 204; second is no-op.
 *   7. Missing admission → 401.
 *   8. Missing PoW → 400.
 *   9. Batch ack of 5 envelopes — all per-device slots written.
 *
 * Tests reuse the helper shape established in envelopes.test.ts (room create,
 * device register, envelope post) so the surface stays consistent across the
 * 5.x suite.
 */

import { SELF, env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import {
  base64UrlDecode,
  base64UrlEncode,
  canonicalRequest,
} from "../../src/admission";
import { canonicalize, type CanonicalValue } from "../../src/canonical";
import type { Env } from "../../src/env";
import type { EnvelopeInput, RoomPolicy } from "../../src/schema";
import { FIXED_POW_RAND, createPowHeader, mintPowForTests } from "../helpers/pow";

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
  const admissionKey = makeAdmissionKey((roomCounter * 11) & 0xff);
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

async function mintAcksPow(roomId: string, deviceId: string): Promise<string> {
  return mintPowForTests({
    roomId,
    deviceId,
    method: "POST",
    path: `/v2/rooms/${roomId}/acks`,
    difficulty: 12,
    expiresAt: nextPowExpiresAt(),
    rand: FIXED_POW_RAND,
  });
}

interface RegisteredDevice extends SubtleKeypair {
  deviceId: string;
  participantId: string;
  kind: "owner" | "reviewer" | "agent";
}

/**
 * Register a device, returning the keypair + identifying info.
 *
 * When `kind="owner"`, the caller MUST pass an explicit keypair (the owner's),
 * because the relay enforces publicSigningKey == stored ownerSigningKey for
 * owner-kind registrations. For reviewer/agent we mint a fresh keypair so each
 * call generates an independent identity.
 */
async function registerDevice(opts: {
  roomId: string;
  admissionKey: Uint8Array;
  deviceId: string;
  participantId: string;
  kind?: "owner" | "reviewer" | "agent";
  /** Required when kind="owner" (must match stored ownerSigningKey). */
  keypair?: SubtleKeypair;
}): Promise<RegisteredDevice> {
  const kp = opts.keypair ?? (await generateEd25519Keypair());
  const kind = opts.kind ?? "reviewer";
  const body = await buildSignedDeviceBody(
    {
      deviceId: opts.deviceId,
      participantId: opts.participantId,
      publicSigningKey: base64UrlEncode(kp.publicKeyBytes),
      kind,
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
  return { ...kp, deviceId: opts.deviceId, participantId: opts.participantId, kind };
}

// --- envelope ingest (only the bits we need for ack tests) --------------

interface BuildEnvelopeInput {
  envelopeId: string;
  authorId: string;
  deviceId: string;
  kind?: "event" | "snapshot_blob" | "signal";
  target?: { deviceId: string } | null;
  ciphertextBytes?: number;
}

function buildEnvelope(input: BuildEnvelopeInput): EnvelopeInput {
  const ciphertextBytes = input.ciphertextBytes ?? 32;
  const bytes = new Uint8Array(ciphertextBytes);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 17 + 3) & 0xff;
  const ciphertext = base64UrlEncode(bytes);
  const nonce = base64UrlEncode(new Uint8Array(24).fill(0x33));
  return {
    envelopeId: input.envelopeId,
    authorId: input.authorId,
    deviceId: input.deviceId,
    kind: input.kind ?? "event",
    target: input.target === undefined ? null : input.target,
    createdAt: Date.now(),
    expiresAt: Date.now() + 60 * 60 * 1000,
    nonce,
    ciphertext,
    ciphertextBytes,
  };
}

async function postEnvelope(opts: {
  roomId: string;
  admissionKey: Uint8Array;
  envelope: EnvelopeInput;
}): Promise<void> {
  const url = `${URL_BASE}/v2/rooms/${opts.roomId}/envelopes`;
  const body = JSON.stringify({ envelopes: [opts.envelope] });
  const adm = await admissionHeaderFor({
    method: "POST",
    url,
    body,
    admissionKey: opts.admissionKey,
  });
  const pow = await mintEnvelopePow(opts.roomId, opts.envelope.deviceId);
  const res = await SELF.fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Attn-Admission": adm,
      "Attn-PoW": pow,
    },
    body,
  });
  if (res.status !== 201) {
    throw new Error(`envelope post failed: ${res.status} ${await res.text()}`);
  }
}

// --- ACK request builder -------------------------------------------------

interface AcksRequestInput {
  ackedEnvelopeIds: string[];
  deviceId: string;
}

interface PostAcksOpts {
  roomId: string;
  admissionKey: Uint8Array;
  body: AcksRequestInput;
  /** Optional owner-sig header. If supplied, signs the canonical request bytes
   *  with this Ed25519 private key. */
  ownerSig?: { privateKey: CryptoKey };
  /** Drop Attn-Admission entirely. */
  omitAdmission?: boolean;
  /** Drop Attn-PoW entirely. */
  omitPow?: boolean;
}

async function postAcks(opts: PostAcksOpts): Promise<Response> {
  const url = `${URL_BASE}/v2/rooms/${opts.roomId}/acks`;
  const body = JSON.stringify(opts.body);
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
    headers["Attn-PoW"] = await mintAcksPow(opts.roomId, opts.body.deviceId);
  }
  if (opts.ownerSig !== undefined) {
    // Sign the same canonical bytes used by admission so owner-sig.ts can
    // re-derive them on the relay side.
    const signing = new Request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    const canonical = await canonicalRequest(signing, new URL(url).pathname);
    const sig = new Uint8Array(
      await crypto.subtle.sign({ name: "Ed25519" }, opts.ownerSig.privateKey, canonical),
    );
    headers["Attn-Owner-Signature"] = base64UrlEncode(sig);
  }
  return SELF.fetch(url, { method: "POST", headers, body });
}

// --- helpers to peek into DO storage ------------------------------------

async function getMeta(roomId: string): Promise<{
  envelopeCount: number;
  bytesUsed: number;
  oldestRetainedSeq: number;
}> {
  const id = env.RELAY_ROOMS.idFromName(roomId);
  const stub = env.RELAY_ROOMS.get(id);
  return runInDurableObject(stub, async (_inst, state) => {
    const [c, b, o] = await Promise.all([
      state.storage.get<number>("meta:envelope_count"),
      state.storage.get<number>("meta:bytes_used"),
      state.storage.get<number>("meta:oldest_retained_seq"),
    ]);
    return {
      envelopeCount: c ?? 0,
      bytesUsed: b ?? 0,
      oldestRetainedSeq: o ?? 0,
    };
  });
}

async function hasEnvIdx(roomId: string, envelopeId: string): Promise<boolean> {
  const id = env.RELAY_ROOMS.idFromName(roomId);
  const stub = env.RELAY_ROOMS.get(id);
  return runInDurableObject(stub, async (_inst, state) => {
    const v = await state.storage.get<string>(`env_idx:${envelopeId}`);
    return v !== undefined;
  });
}

async function hasAckSlot(
  roomId: string,
  deviceId: string,
  envelopeId: string,
): Promise<boolean> {
  const id = env.RELAY_ROOMS.idFromName(roomId);
  const stub = env.RELAY_ROOMS.get(id);
  return runInDurableObject(stub, async (_inst, state) => {
    const v = await state.storage.get<number>(`ack:${deviceId}:${envelopeId}`);
    return v !== undefined;
  });
}

async function hasOwnerAckMarker(roomId: string, envelopeId: string): Promise<boolean> {
  const id = env.RELAY_ROOMS.idFromName(roomId);
  const stub = env.RELAY_ROOMS.get(id);
  return runInDurableObject(stub, async (_inst, state) => {
    const v = await state.storage.get<string>(`ack_owner:${envelopeId}`);
    return v !== undefined;
  });
}

interface ErrorResponse {
  error: { code: string; message: string };
}

// --- tests ---------------------------------------------------------------

describe("POST /v2/rooms/:roomId/acks — reviewer ack without delete flag", () => {
  it("returns 204 and leaves the envelope in place when no owner-sig header is sent", async () => {
    const roomId = uniqueRoomId("ack-reviewer");
    const owner = await generateEd25519Keypair();
    const admissionKey = await createRoom({ roomId, ownerKp: owner });
    const reviewer = await registerDevice({
      roomId,
      admissionKey,
      deviceId: "dev-rev",
      participantId: "rev-a",
    });

    const envelope = buildEnvelope({
      envelopeId: "env-rev-1",
      authorId: "rev-a",
      deviceId: "dev-rev",
      ciphertextBytes: 64,
    });
    await postEnvelope({ roomId, admissionKey, envelope });

    const before = await getMeta(roomId);
    expect(before.envelopeCount).toBe(1);
    expect(before.bytesUsed).toBe(64);

    const res = await postAcks({
      roomId,
      admissionKey,
      body: { ackedEnvelopeIds: ["env-rev-1"], deviceId: reviewer.deviceId },
    });
    expect(res.status).toBe(204);

    // Per-device ack slot present; envelope still present.
    expect(await hasAckSlot(roomId, "dev-rev", "env-rev-1")).toBe(true);
    expect(await hasEnvIdx(roomId, "env-rev-1")).toBe(true);
    const after = await getMeta(roomId);
    expect(after.envelopeCount).toBe(1);
    expect(after.bytesUsed).toBe(64);
  });
});

describe("POST /v2/rooms/:roomId/acks — owner ack with delete-disabled policy", () => {
  it("retains the envelope when owner-sig header is absent (default policy)", async () => {
    const roomId = uniqueRoomId("ack-owner-noheader");
    const ownerKp = await generateEd25519Keypair();
    const admissionKey = await createRoom({ roomId, ownerKp });
    const ownerDev = await registerDevice({
      roomId,
      admissionKey,
      deviceId: "dev-own",
      participantId: "owner",
      kind: "owner",
      keypair: ownerKp,
    });

    const envelope = buildEnvelope({
      envelopeId: "env-own-1",
      authorId: "owner",
      deviceId: "dev-own",
      ciphertextBytes: 48,
    });
    await postEnvelope({ roomId, admissionKey, envelope });

    const res = await postAcks({
      roomId,
      admissionKey,
      body: { ackedEnvelopeIds: ["env-own-1"], deviceId: ownerDev.deviceId },
    });
    expect(res.status).toBe(204);

    // No owner-sig header sent → no delete attempt regardless of caller kind.
    expect(await hasEnvIdx(roomId, "env-own-1")).toBe(true);
    expect(await hasOwnerAckMarker(roomId, "env-own-1")).toBe(false);
    const meta = await getMeta(roomId);
    expect(meta.envelopeCount).toBe(1);
    expect(meta.bytesUsed).toBe(48);
  });

  it("retains the envelope when owner-sig header is sent but policy.deleteEventsAfterOwnerAck=false", async () => {
    const roomId = uniqueRoomId("ack-owner-policyoff");
    const ownerKp = await generateEd25519Keypair();
    // policy is explicit-default (deleteEventsAfterOwnerAck:false).
    const admissionKey = await createRoom({ roomId, ownerKp });
    const ownerDev = await registerDevice({
      roomId,
      admissionKey,
      deviceId: "dev-own",
      participantId: "owner",
      kind: "owner",
      keypair: ownerKp,
    });

    const envelope = buildEnvelope({
      envelopeId: "env-own-2",
      authorId: "owner",
      deviceId: "dev-own",
      ciphertextBytes: 24,
    });
    await postEnvelope({ roomId, admissionKey, envelope });

    const res = await postAcks({
      roomId,
      admissionKey,
      body: { ackedEnvelopeIds: ["env-own-2"], deviceId: ownerDev.deviceId },
      ownerSig: { privateKey: ownerKp.privateKey },
    });
    expect(res.status).toBe(204);

    // Header was correctly signed but policy doesn't allow delete — should
    // be silently ignored, not surface as an error.
    expect(await hasEnvIdx(roomId, "env-own-2")).toBe(true);
    expect(await hasOwnerAckMarker(roomId, "env-own-2")).toBe(false);
    const meta = await getMeta(roomId);
    expect(meta.envelopeCount).toBe(1);
    expect(meta.bytesUsed).toBe(24);
  });
});

describe("POST /v2/rooms/:roomId/acks — owner ack with delete-enabled policy", () => {
  it("deletes the envelope, decrements count + bytes_used, and writes ack_owner marker", async () => {
    const roomId = uniqueRoomId("ack-owner-delete");
    const ownerKp = await generateEd25519Keypair();
    const admissionKey = await createRoom({
      roomId,
      ownerKp,
      policy: { deleteEventsAfterOwnerAck: true },
    });
    const ownerDev = await registerDevice({
      roomId,
      admissionKey,
      deviceId: "dev-own",
      participantId: "owner",
      kind: "owner",
      keypair: ownerKp,
    });

    const envelope = buildEnvelope({
      envelopeId: "env-own-del",
      authorId: "owner",
      deviceId: "dev-own",
      ciphertextBytes: 96,
    });
    await postEnvelope({ roomId, admissionKey, envelope });
    const before = await getMeta(roomId);
    expect(before.envelopeCount).toBe(1);
    expect(before.bytesUsed).toBe(96);

    const res = await postAcks({
      roomId,
      admissionKey,
      body: { ackedEnvelopeIds: ["env-own-del"], deviceId: ownerDev.deviceId },
      ownerSig: { privateKey: ownerKp.privateKey },
    });
    expect(res.status).toBe(204);

    // env_idx + payload gone; ack_owner marker present; counts decremented.
    expect(await hasEnvIdx(roomId, "env-own-del")).toBe(false);
    expect(await hasOwnerAckMarker(roomId, "env-own-del")).toBe(true);
    expect(await hasAckSlot(roomId, "dev-own", "env-own-del")).toBe(true);
    const after = await getMeta(roomId);
    expect(after.envelopeCount).toBe(0);
    expect(after.bytesUsed).toBe(0);
  });
});

describe("POST /v2/rooms/:roomId/acks — non-owner with header is silently ignored", () => {
  it("falls through to ack-only (no 403) when a reviewer device sends an owner-sig header", async () => {
    const roomId = uniqueRoomId("ack-rev-with-header");
    const ownerKp = await generateEd25519Keypair();
    const admissionKey = await createRoom({
      roomId,
      ownerKp,
      // Delete enabled — so the only thing blocking deletion is "device is reviewer".
      policy: { deleteEventsAfterOwnerAck: true },
    });
    // Register an owner so the room is well-formed, plus a reviewer that
    // will attempt the ack with a forged-looking header.
    await registerDevice({
      roomId,
      admissionKey,
      deviceId: "dev-own",
      participantId: "owner",
      kind: "owner",
      keypair: ownerKp,
    });
    const reviewer = await registerDevice({
      roomId,
      admissionKey,
      deviceId: "dev-rev",
      participantId: "reviewer",
      kind: "reviewer",
    });

    const envelope = buildEnvelope({
      envelopeId: "env-rev-header",
      authorId: "reviewer",
      deviceId: "dev-rev",
      ciphertextBytes: 32,
    });
    await postEnvelope({ roomId, admissionKey, envelope });

    // Reviewer signs with their own (non-owner) key. Per task pin: handler
    // skips owner-sig verify entirely when acking device is not kind=owner,
    // so this should be 204 + no delete.
    const res = await postAcks({
      roomId,
      admissionKey,
      body: { ackedEnvelopeIds: ["env-rev-header"], deviceId: reviewer.deviceId },
      ownerSig: { privateKey: reviewer.privateKey },
    });
    expect(res.status).toBe(204);
    expect(await hasEnvIdx(roomId, "env-rev-header")).toBe(true);
    expect(await hasOwnerAckMarker(roomId, "env-rev-header")).toBe(false);
    const meta = await getMeta(roomId);
    expect(meta.envelopeCount).toBe(1);
    expect(meta.bytesUsed).toBe(32);
  });
});

describe("POST /v2/rooms/:roomId/acks — idempotency", () => {
  it("returns 204 on re-ack of the same envelope without double-debiting bytes", async () => {
    const roomId = uniqueRoomId("ack-idem");
    const ownerKp = await generateEd25519Keypair();
    const admissionKey = await createRoom({
      roomId,
      ownerKp,
      policy: { deleteEventsAfterOwnerAck: true },
    });
    const ownerDev = await registerDevice({
      roomId,
      admissionKey,
      deviceId: "dev-own",
      participantId: "owner",
      kind: "owner",
      keypair: ownerKp,
    });

    const envelope = buildEnvelope({
      envelopeId: "env-idem",
      authorId: "owner",
      deviceId: "dev-own",
      ciphertextBytes: 40,
    });
    await postEnvelope({ roomId, admissionKey, envelope });

    // First ack with owner-sig → deletes.
    const r1 = await postAcks({
      roomId,
      admissionKey,
      body: { ackedEnvelopeIds: ["env-idem"], deviceId: ownerDev.deviceId },
      ownerSig: { privateKey: ownerKp.privateKey },
    });
    expect(r1.status).toBe(204);
    const mid = await getMeta(roomId);
    expect(mid.envelopeCount).toBe(0);
    expect(mid.bytesUsed).toBe(0);

    // Second ack of the now-deleted envelope → still 204, no double-debit.
    const r2 = await postAcks({
      roomId,
      admissionKey,
      body: { ackedEnvelopeIds: ["env-idem"], deviceId: ownerDev.deviceId },
      ownerSig: { privateKey: ownerKp.privateKey },
    });
    expect(r2.status).toBe(204);
    const after = await getMeta(roomId);
    expect(after.envelopeCount).toBe(0);
    expect(after.bytesUsed).toBe(0);
  });

  it("returns 204 when acking an envelopeId that was never posted", async () => {
    const roomId = uniqueRoomId("ack-unknown");
    const ownerKp = await generateEd25519Keypair();
    const admissionKey = await createRoom({ roomId, ownerKp });
    const reviewer = await registerDevice({
      roomId,
      admissionKey,
      deviceId: "dev-rev",
      participantId: "rev",
    });

    const res = await postAcks({
      roomId,
      admissionKey,
      body: { ackedEnvelopeIds: ["env-never-existed"], deviceId: reviewer.deviceId },
    });
    expect(res.status).toBe(204);
    // Unknown IDs remain a 204 no-op but do not create attacker-controlled
    // durable keys outside the room's bounded envelope set.
    expect(await hasAckSlot(roomId, "dev-rev", "env-never-existed")).toBe(false);
  });
});

describe("POST /v2/rooms/:roomId/acks — protection layers", () => {
  it("rejects POST without Attn-Admission header (401)", async () => {
    const roomId = uniqueRoomId("ack-no-adm");
    const ownerKp = await generateEd25519Keypair();
    const admissionKey = await createRoom({ roomId, ownerKp });
    const reviewer = await registerDevice({
      roomId,
      admissionKey,
      deviceId: "dev-rev",
      participantId: "rev",
    });

    const res = await postAcks({
      roomId,
      admissionKey,
      body: { ackedEnvelopeIds: ["env-anything"], deviceId: reviewer.deviceId },
      omitAdmission: true,
    });
    expect(res.status).toBe(401);
    const err = (await res.json()) as ErrorResponse;
    expect(err.error.code).toBe("ATTN_ADMISSION_INVALID");
  });

  it("rejects POST without Attn-PoW header (400 ATTN_POW_INVALID)", async () => {
    const roomId = uniqueRoomId("ack-no-pow");
    const ownerKp = await generateEd25519Keypair();
    const admissionKey = await createRoom({ roomId, ownerKp });
    const reviewer = await registerDevice({
      roomId,
      admissionKey,
      deviceId: "dev-rev",
      participantId: "rev",
    });

    const res = await postAcks({
      roomId,
      admissionKey,
      body: { ackedEnvelopeIds: ["env-anything"], deviceId: reviewer.deviceId },
      omitPow: true,
    });
    expect(res.status).toBe(400);
    const err = (await res.json()) as ErrorResponse;
    expect(err.error.code).toBe("ATTN_POW_INVALID");
  });
});

describe("POST /v2/rooms/:roomId/acks — batch", () => {
  it("marks per-device ack slots for every envelopeId in a batch of 5", async () => {
    const roomId = uniqueRoomId("ack-batch");
    const ownerKp = await generateEd25519Keypair();
    const admissionKey = await createRoom({ roomId, ownerKp });
    const reviewer = await registerDevice({
      roomId,
      admissionKey,
      deviceId: "dev-rev",
      participantId: "rev",
    });

    // Post 5 envelopes from the reviewer.
    const envelopeIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      const id = `env-batch-${i}`;
      envelopeIds.push(id);
      await postEnvelope({
        roomId,
        admissionKey,
        envelope: buildEnvelope({
          envelopeId: id,
          authorId: "rev",
          deviceId: "dev-rev",
          ciphertextBytes: 16,
        }),
      });
    }

    const res = await postAcks({
      roomId,
      admissionKey,
      body: { ackedEnvelopeIds: envelopeIds, deviceId: reviewer.deviceId },
    });
    expect(res.status).toBe(204);

    // All 5 ack slots present; envelopes retained (no delete intent).
    for (const id of envelopeIds) {
      expect(await hasAckSlot(roomId, "dev-rev", id)).toBe(true);
      expect(await hasEnvIdx(roomId, id)).toBe(true);
    }
    const meta = await getMeta(roomId);
    expect(meta.envelopeCount).toBe(5);
    expect(meta.bytesUsed).toBe(5 * 16);
  });
});

describe("POST /v2/rooms/:roomId/acks — owner-sig invalid", () => {
  it("returns 403 when owner-sig header is present + policy + owner-kind but signature is wrong", async () => {
    const roomId = uniqueRoomId("ack-bad-sig");
    const ownerKp = await generateEd25519Keypair();
    const admissionKey = await createRoom({
      roomId,
      ownerKp,
      policy: { deleteEventsAfterOwnerAck: true },
    });
    const ownerDev = await registerDevice({
      roomId,
      admissionKey,
      deviceId: "dev-own",
      participantId: "owner",
      kind: "owner",
      keypair: ownerKp,
    });

    const envelope = buildEnvelope({
      envelopeId: "env-bad-sig",
      authorId: "owner",
      deviceId: "dev-own",
      ciphertextBytes: 20,
    });
    await postEnvelope({ roomId, admissionKey, envelope });

    // Forge owner-sig by signing with a different key. The acking device
    // remains the owner device so we cross the "owner-kind" layer; the
    // signature itself doesn't match the stored owner pubkey → 403.
    const attackerKp = await generateEd25519Keypair();
    const res = await postAcks({
      roomId,
      admissionKey,
      body: { ackedEnvelopeIds: ["env-bad-sig"], deviceId: ownerDev.deviceId },
      ownerSig: { privateKey: attackerKp.privateKey },
    });
    expect(res.status).toBe(403);
    const err = (await res.json()) as ErrorResponse;
    expect(err.error.code).toBe("ATTN_OWNER_SIG_INVALID");

    // Envelope must remain — failed sig leaves storage untouched.
    expect(await hasEnvIdx(roomId, "env-bad-sig")).toBe(true);
    const meta = await getMeta(roomId);
    expect(meta.envelopeCount).toBe(1);
    expect(meta.bytesUsed).toBe(20);
  });
});

// Silence unused-import lint when running without `--no-emit` (base64UrlDecode
// is exported by admission.ts; we import it for parity with the other
// integration suites even though this file doesn't decode any inbound bytes).
void base64UrlDecode;
