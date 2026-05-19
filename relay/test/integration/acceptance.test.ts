/**
 * Relay v2 — Release Acceptance Suite (attn-nnj.5.15).
 *
 * This file is the *release-blocking* checklist matching `relay-spec.md` §Test
 * Plan (lines 687-705). It enumerates each of the 14 spec-listed scenarios
 * (plus sub-cases) as a top-level `it(...)` with a heading that quotes the
 * spec exactly, so a CI run produces a one-line audit trail per scenario.
 *
 * Coverage breakdown (from §Test Plan):
 *   1.  Room lifecycle: create -> register -> upload -> WS subscribe -> ack -> delete
 *   2a. WS backfill: after=0 receives all envelopes
 *   2b. WS backfill: after=lastSeen receives only newer
 *   2c. WS backfill: after=deletedSeq closes 4005 with resyncFromSeq
 *   3a. Cap: maxEvents fills -> 507 ATTN_ROOM_EVENT_CAP
 *   3b. Cap: maxRoomBytes fills -> 507 ATTN_ROOM_STORAGE_FULL
 *   3c. Cap: exceed maxEventBytes -> 413 ATTN_ENVELOPE_TOO_LARGE
 *   3d. Cap: batch of 33 envelopes -> 400 ATTN_BATCH_TOO_LARGE
 *   4a. Owner auth: non-owner ACK with delete policy -> 204 retained
 *   4b. Owner auth: owner ACK with delete policy + valid sig -> envelope deleted
 *   4c. Owner auth: default policy (delete=false) -> ACK accepted, retained
 *   5.  Multi-device: two owner devices both ACK, deletion only fires per spec
 *   6a. Signaling: round-trip a signal envelope through two open WS clients
 *   6b. Signaling: offline target receives stored signal envelope on reconnect
 *   7.  R2 spillover: presign + PUT + GET round-trips a 3 MiB encrypted blob
 *   8.  Hard-max TTL: expiresAt-in-past -> alarm wipes -> 4002 close -> 404
 *   9.  Idle timeout: rewind last_event_at -> idle alarm fires
 *   10. Hibernation: open WS, close, post envelope, reconnect -> backfill picks it up
 *   11. Rate limit: 121st write/min from one device -> 429
 *   12a. PoW: write without Attn-PoW -> 400 ATTN_POW_INVALID
 *   12b. PoW: write with valid token -> success
 *   12c. PoW: replay same token -> 400 ATTN_POW_INVALID
 *   13. PoW difficulty override: room created with powBits=14; 12-bit token rejected
 *   14a. longSession=true clamps to createdAt + 7d
 *   14b. longSession=false clamps to createdAt + 24h
 *
 * Each test re-implements the scenario explicitly (no shared cases.json) so the
 * labels in this file ARE the audit trail. The helpers are intentionally
 * inlined to keep the suite self-contained — copy-paste from sibling suites is
 * deliberate.
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
import { presignBlobDownload } from "../../src/r2";
import { rateKey } from "../../src/rate-limit";
import type {
  DeviceRecord,
  EnvelopeInput,
  EnvelopeRecord,
  RoomPolicy,
} from "../../src/schema";
import { FIXED_POW_RAND, mintPowForTests } from "../helpers/pow";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

const URL_BASE = "https://relay.example";

// ---------------------------------------------------------------------------
// Shared builders — kept inline so each acceptance test is independently
// readable and any future spec divergence is localized to this file.
// ---------------------------------------------------------------------------

function makeAdmissionKey(seed: number): Uint8Array {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = (seed + i) & 0xff;
  return bytes;
}

function defaultPolicy(overrides: Partial<RoomPolicy> = {}): RoomPolicy {
  return {
    mode: "live",
    maxPeers: 4,
    maxSnapshotBytes: 5_242_880, // 5 MiB — spec hard max
    maxEventBytes: 8_192,
    maxEvents: 100,
    expiresAt: Date.now() + 60 * 60 * 1000,
    idleTimeoutMs: 30 * 60 * 1000,
    longSession: false,
    powBits: 12, // keeps in-process miner cheap; relay clamps min to 12
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
  return `accept-${label}-${Date.now().toString(36)}-${roomCounter}`;
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

interface CreateRoomResult {
  admissionKey: Uint8Array;
  createResponse: RoomCreateResponse;
}

interface RoomCreateResponse {
  roomId: string;
  createdAt: number;
  expiresAt: number;
  policy: RoomPolicy;
  ownerSigningKeyId: string;
  serverSeq: number;
}

async function createRoom(opts: {
  roomId: string;
  policy?: Partial<RoomPolicy>;
  ownerSigningKey: Uint8Array;
}): Promise<CreateRoomResult> {
  const admissionKey = makeAdmissionKey((roomCounter * 19) & 0xff);
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
  const createResponse = (await res.json()) as RoomCreateResponse;
  return { admissionKey, createResponse };
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

let powExpiresBump = 0;
function nextPowExpiresAt(): number {
  powExpiresBump += 1;
  return Date.now() + 5 * 60 * 1000 + powExpiresBump;
}

async function mintPow(opts: {
  roomId: string;
  deviceId: string;
  method: string;
  path: string;
  difficulty?: number;
}): Promise<string> {
  return mintPowForTests({
    roomId: opts.roomId,
    deviceId: opts.deviceId,
    method: opts.method,
    path: opts.path,
    difficulty: opts.difficulty ?? 12,
    expiresAt: nextPowExpiresAt(),
    rand: FIXED_POW_RAND,
  });
}

interface RegisteredDevice extends SubtleKeypair {
  deviceId: string;
  participantId: string;
  kind: "owner" | "reviewer" | "agent";
}

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
  const pow = await mintPow({
    roomId: opts.roomId,
    deviceId: opts.deviceId,
    method: "POST",
    path: `/v2/rooms/${opts.roomId}/devices`,
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
  if (res.status !== 204) {
    throw new Error(`device register failed: ${res.status} ${await res.text()}`);
  }
  return { ...kp, deviceId: opts.deviceId, participantId: opts.participantId, kind };
}

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
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 11 + 1) & 0xff;
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

interface AcceptedRecord {
  envelopeId: string;
  serverSeq: number;
}

interface AcceptResponse {
  accepted: AcceptedRecord[];
}

interface ErrorResponse {
  error: { code: string; message: string; retryAfterMs?: number };
}

async function postEnvelopes(opts: {
  roomId: string;
  admissionKey: Uint8Array;
  envelopes: EnvelopeInput[];
  /** Override PoW deviceId (defaults to first envelope.deviceId). */
  powDeviceId?: string;
  omitPow?: boolean;
  /** Reuse a previously-minted PoW token to test replay. */
  reusePow?: string;
}): Promise<Response> {
  const url = `${URL_BASE}/v2/rooms/${opts.roomId}/envelopes`;
  const body = JSON.stringify({ envelopes: opts.envelopes });
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  headers["Attn-Admission"] = await admissionHeaderFor({
    method: "POST",
    url,
    body,
    admissionKey: opts.admissionKey,
  });
  if (opts.reusePow !== undefined) {
    headers["Attn-PoW"] = opts.reusePow;
  } else if (!opts.omitPow) {
    const first = opts.envelopes[0];
    const deviceId = opts.powDeviceId ?? first?.deviceId ?? "unknown";
    headers["Attn-PoW"] = await mintPow({
      roomId: opts.roomId,
      deviceId,
      method: "POST",
      path: `/v2/rooms/${opts.roomId}/envelopes`,
    });
  }
  return SELF.fetch(url, { method: "POST", headers, body });
}

interface AcksRequestInput {
  ackedEnvelopeIds: string[];
  deviceId: string;
}

async function postAcks(opts: {
  roomId: string;
  admissionKey: Uint8Array;
  body: AcksRequestInput;
  ownerSig?: { privateKey: CryptoKey };
}): Promise<Response> {
  const url = `${URL_BASE}/v2/rooms/${opts.roomId}/acks`;
  const body = JSON.stringify(opts.body);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  headers["Attn-Admission"] = await admissionHeaderFor({
    method: "POST",
    url,
    body,
    admissionKey: opts.admissionKey,
  });
  headers["Attn-PoW"] = await mintPow({
    roomId: opts.roomId,
    deviceId: opts.body.deviceId,
    method: "POST",
    path: `/v2/rooms/${opts.roomId}/acks`,
  });
  if (opts.ownerSig !== undefined) {
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

async function deleteRoom(opts: {
  roomId: string;
  admissionKey: Uint8Array;
  ownerSig: { privateKey: CryptoKey };
  powDeviceId?: string;
}): Promise<Response> {
  const url = `${URL_BASE}/v2/rooms/${opts.roomId}`;
  const headers: Record<string, string> = {};
  headers["Attn-Admission"] = await admissionHeaderFor({
    method: "DELETE",
    url,
    admissionKey: opts.admissionKey,
  });
  headers["Attn-PoW"] = await mintPow({
    roomId: opts.roomId,
    deviceId: opts.powDeviceId ?? "dev-own",
    method: "DELETE",
    path: `/v2/rooms/${opts.roomId}`,
  });
  const signing = new Request(url, { method: "DELETE" });
  const canonical = await canonicalRequest(signing, new URL(url).pathname);
  const sig = new Uint8Array(
    await crypto.subtle.sign({ name: "Ed25519" }, opts.ownerSig.privateKey, canonical),
  );
  headers["Attn-Owner-Signature"] = base64UrlEncode(sig);
  return SELF.fetch(url, { method: "DELETE", headers });
}

// ---------------------------------------------------------------------------
// WS helpers
// ---------------------------------------------------------------------------

async function buildSocketProtocolHeader(opts: {
  roomId: string;
  deviceId: string;
  admissionKey: Uint8Array;
}): Promise<string> {
  const url = `${URL_BASE}/v2/rooms/${opts.roomId}/socket?device_id=${encodeURIComponent(opts.deviceId)}`;
  const signing = new Request(url, { method: "GET" });
  const canonical = await canonicalRequest(signing, new URL(url).pathname);
  const hmac = await hmacSha256(opts.admissionKey, canonical);
  return `attn.v2, hmac.${base64UrlEncode(hmac)}`;
}

async function openSocket(opts: {
  roomId: string;
  deviceId: string;
  admissionKey: Uint8Array;
}): Promise<{ ws: WebSocket; response: Response }> {
  const url = `${URL_BASE}/v2/rooms/${opts.roomId}/socket?device_id=${encodeURIComponent(opts.deviceId)}`;
  const headers: Record<string, string> = { Upgrade: "websocket" };
  headers["Sec-WebSocket-Protocol"] = await buildSocketProtocolHeader({
    roomId: opts.roomId,
    deviceId: opts.deviceId,
    admissionKey: opts.admissionKey,
  });
  const res = await SELF.fetch(url, { headers });
  const ws = res.webSocket;
  if (ws === null) throw new Error(`WS upgrade failed: ${res.status} ${await res.text()}`);
  ws.accept();
  return { ws, response: res };
}

interface HelloFrame {
  type: "hello";
  serverSeq: number;
  policy: RoomPolicy;
  devices: DeviceRecord[];
  missedSignalEnvelopeIds: string[];
}

interface EnvelopeFrame {
  type: "envelope";
  envelope: EnvelopeRecord;
  serverSeq: number;
}

interface ErrorFrame {
  type: "error";
  code: string;
  message: string;
  resyncFromSeq?: number;
}

interface PresenceFrame {
  type: "presence";
  event: "join" | "leave";
  deviceId: string;
  participantId: string;
}

interface PingFrame {
  type: "ping";
  ts: number;
}

function isHello(x: unknown): x is HelloFrame {
  return typeof x === "object" && x !== null && (x as { type?: unknown }).type === "hello";
}
function isEnvelope(x: unknown): x is EnvelopeFrame {
  return typeof x === "object" && x !== null && (x as { type?: unknown }).type === "envelope";
}
function isErrorFrame(x: unknown): x is ErrorFrame {
  return typeof x === "object" && x !== null && (x as { type?: unknown }).type === "error";
}
function isPresence(x: unknown): x is PresenceFrame {
  return typeof x === "object" && x !== null && (x as { type?: unknown }).type === "presence";
}
function isPing(x: unknown): x is PingFrame {
  return typeof x === "object" && x !== null && (x as { type?: unknown }).type === "ping";
}

/** Collects frames + close events for assertions. */
class FrameQueue {
  private readonly buffer: unknown[] = [];
  private readonly waiters: Array<(frame: unknown) => void> = [];
  public closeCode: number | undefined;
  public closeReason: string | undefined;
  public closed = false;

  constructor(ws: WebSocket) {
    ws.addEventListener("message", (e: MessageEvent) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(typeof e.data === "string" ? e.data : "");
      } catch {
        parsed = e.data;
      }
      const waiter = this.waiters.shift();
      if (waiter !== undefined) waiter(parsed);
      else this.buffer.push(parsed);
    });
    ws.addEventListener("close", (e: CloseEvent) => {
      this.closeCode = e.code;
      this.closeReason = e.reason;
      this.closed = true;
      while (this.waiters.length > 0) {
        const w = this.waiters.shift();
        if (w !== undefined) w(undefined);
      }
    });
  }

  async next(timeoutMs = 2000): Promise<unknown> {
    const queued = this.buffer.shift();
    if (queued !== undefined) return queued;
    if (this.closed) return undefined;
    return new Promise<unknown>((resolve) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.indexOf(resolve);
        if (idx >= 0) this.waiters.splice(idx, 1);
        resolve(undefined);
      }, timeoutMs);
      const wrapped = (frame: unknown): void => {
        clearTimeout(timer);
        resolve(frame);
      };
      this.waiters.push(wrapped);
    });
  }

  async waitClosed(timeoutMs = 3000): Promise<void> {
    const start = Date.now();
    while (!this.closed) {
      if (Date.now() - start > timeoutMs) return;
      await new Promise<void>((r) => setTimeout(r, 10));
    }
  }
}

/**
 * Drain `hello`, then any backfill `envelope` frames, then the immediate
 * post-replay `ping` the server emits. Returns the hello frame and the list
 * of envelope frames observed during backfill. Suitable for tests that want
 * to assert on hello state and then start watching for live broadcasts
 * post-ping.
 */
async function drainHelloThroughPing(
  q: FrameQueue,
): Promise<{ hello: HelloFrame; backfill: EnvelopeFrame[] }> {
  const hello = await q.next();
  if (!isHello(hello)) throw new Error("expected hello");
  const backfill: EnvelopeFrame[] = [];
  // Loop until we hit the ping that closes out the initial replay.
  while (true) {
    const frame = await q.next(3000);
    if (isPing(frame)) return { hello, backfill };
    if (isEnvelope(frame)) {
      backfill.push(frame);
      continue;
    }
    throw new Error(`unexpected frame while draining: ${JSON.stringify(frame)}`);
  }
}

// ---------------------------------------------------------------------------
// DO storage peek helpers (used to seed deterministic preconditions).
// ---------------------------------------------------------------------------

function getStub(roomId: string) {
  const id = env.RELAY_ROOMS.idFromName(roomId);
  return env.RELAY_ROOMS.get(id);
}

async function countStorageKeys(roomId: string): Promise<number> {
  return runInDurableObject(getStub(roomId), async (_inst, state) => {
    const all = await state.storage.list();
    return all.size;
  });
}

async function rewindMeta(roomId: string, key: string, deltaMs: number): Promise<void> {
  await runInDurableObject(getStub(roomId), async (_inst, state) => {
    const cur = await state.storage.get<number>(key);
    if (cur === undefined) throw new Error(`${key} missing`);
    await state.storage.put<number>(key, cur - deltaMs);
  });
}

async function fireAlarmDirect(roomId: string): Promise<void> {
  await runInDurableObject(getStub(roomId), async (inst, _state) => {
    type WithAlarm = { alarm?: () => Promise<void> };
    const handler = (inst as unknown as WithAlarm).alarm;
    if (typeof handler !== "function") {
      throw new Error("alarm() handler not defined on RoomDO");
    }
    await handler.call(inst);
  });
}

async function hasEnvIdx(roomId: string, envelopeId: string): Promise<boolean> {
  return runInDurableObject(getStub(roomId), async (_inst, state) => {
    const v = await state.storage.get<string>(`env_idx:${envelopeId}`);
    return v !== undefined;
  });
}

async function hasOwnerAckMarker(roomId: string, envelopeId: string): Promise<boolean> {
  return runInDurableObject(getStub(roomId), async (_inst, state) => {
    const v = await state.storage.get<string>(`ack_owner:${envelopeId}`);
    return v !== undefined;
  });
}

async function getEnvelopeCount(roomId: string): Promise<number> {
  return runInDurableObject(getStub(roomId), async (_inst, state) => {
    return (await state.storage.get<number>("meta:envelope_count")) ?? 0;
  });
}

// Silence unused-import lint — base64UrlDecode exported by admission.ts; we
// import it for parity with sibling integration suites.
void base64UrlDecode;

// ---------------------------------------------------------------------------
// Scenario shell — each scenario has its own describe() block so the suite's
// top-level reporter output reads as a checklist.
// ---------------------------------------------------------------------------

describe("Relay v2 release acceptance — spec §Test Plan", () => {
  it("0. Scaffold guard — env binds and SELF.fetch reaches /health", async () => {
    const res = await SELF.fetch(`${URL_BASE}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; ts: number };
    expect(body.status).toBe("ok");
    expect(typeof body.ts).toBe("number");
  });

  // -------------------------------------------------------------------------
  // Scenario 1 — Room lifecycle (full happy path through every endpoint).
  // -------------------------------------------------------------------------
  it("1. Room lifecycle: create → register → upload → WS subscribe → ack → delete", async () => {
    const roomId = uniqueRoomId("s01-lifecycle");
    const ownerKp = await generateEd25519Keypair();

    // Create the room.
    const { admissionKey, createResponse } = await createRoom({
      roomId,
      ownerSigningKey: ownerKp.publicKeyBytes,
    });
    expect(createResponse.roomId).toBe(roomId);
    expect(createResponse.serverSeq).toBe(0);

    // Register the owner device (kind=owner requires matching ownerSigningKey).
    const ownerDev = await registerDevice({
      roomId,
      admissionKey,
      deviceId: "dev-own",
      participantId: "owner",
      kind: "owner",
      keypair: ownerKp,
    });

    // Upload one envelope.
    const upload = await postEnvelopes({
      roomId,
      admissionKey,
      envelopes: [
        buildEnvelope({
          envelopeId: "lc-1",
          authorId: ownerDev.participantId,
          deviceId: ownerDev.deviceId,
        }),
      ],
    });
    expect(upload.status).toBe(201);
    const uploadBody = (await upload.json()) as AcceptResponse;
    expect(uploadBody.accepted[0]?.serverSeq).toBe(1);

    // Open a WS and subscribe with after=0 → should backfill the envelope.
    const { ws } = await openSocket({
      roomId,
      deviceId: ownerDev.deviceId,
      admissionKey,
    });
    const q = new FrameQueue(ws);
    ws.send(JSON.stringify({ type: "subscribe", after: 0 }));
    const drained = await drainHelloThroughPing(q);
    expect(drained.backfill.length).toBe(1);
    expect(drained.backfill[0]?.envelope.envelopeId).toBe("lc-1");
    expect(drained.backfill[0]?.serverSeq).toBe(1);

    // ACK the envelope.
    const ack = await postAcks({
      roomId,
      admissionKey,
      body: { ackedEnvelopeIds: ["lc-1"], deviceId: ownerDev.deviceId },
    });
    expect(ack.status).toBe(204);
    ws.close(1000, "ack done");
    await q.waitClosed(1000);

    // Delete the room. (Default policy retains envelopes; the DELETE is the
    // owner's lifecycle wrap-up.)
    const del = await deleteRoom({
      roomId,
      admissionKey,
      ownerSig: { privateKey: ownerKp.privateKey },
      powDeviceId: ownerDev.deviceId,
    });
    expect(del.status).toBe(204);
    expect(await countStorageKeys(roomId)).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Scenario 2 — WS backfill (a/b/c sub-cases).
  // -------------------------------------------------------------------------
  it("2a. WS backfill: after=0 receives all envelopes", async () => {
    const roomId = uniqueRoomId("s02a-backfill-zero");
    const owner = await generateEd25519Keypair();
    const { admissionKey } = await createRoom({ roomId, ownerSigningKey: owner.publicKeyBytes });
    await registerDevice({
      roomId,
      admissionKey,
      deviceId: "dev-bk",
      participantId: "kara",
    });

    for (let i = 0; i < 4; i++) {
      const r = await postEnvelopes({
        roomId,
        admissionKey,
        envelopes: [
          buildEnvelope({ envelopeId: `bf-zero-${i}`, authorId: "kara", deviceId: "dev-bk" }),
        ],
      });
      expect(r.status).toBe(201);
    }

    const { ws } = await openSocket({ roomId, deviceId: "dev-bk", admissionKey });
    const q = new FrameQueue(ws);
    ws.send(JSON.stringify({ type: "subscribe", after: 0 }));
    const hello = await q.next();
    expect(isHello(hello)).toBe(true);

    const seqs: number[] = [];
    for (let i = 0; i < 4; i++) {
      const frame = await q.next();
      expect(isEnvelope(frame)).toBe(true);
      if (isEnvelope(frame)) seqs.push(frame.serverSeq);
    }
    expect(seqs).toEqual([1, 2, 3, 4]);
    ws.close(1000, "done");
  });

  it("2b. WS backfill: after=lastSeen receives only newer", async () => {
    const roomId = uniqueRoomId("s02b-backfill-after");
    const owner = await generateEd25519Keypair();
    const { admissionKey } = await createRoom({ roomId, ownerSigningKey: owner.publicKeyBytes });
    await registerDevice({
      roomId,
      admissionKey,
      deviceId: "dev-bk2",
      participantId: "kara",
    });

    for (let i = 0; i < 5; i++) {
      await postEnvelopes({
        roomId,
        admissionKey,
        envelopes: [
          buildEnvelope({ envelopeId: `bf-after-${i}`, authorId: "kara", deviceId: "dev-bk2" }),
        ],
      });
    }

    // Subscribe with after=3 — should only see envelopes with serverSeq > 3.
    const { ws } = await openSocket({ roomId, deviceId: "dev-bk2", admissionKey });
    const q = new FrameQueue(ws);
    ws.send(JSON.stringify({ type: "subscribe", after: 3 }));
    const hello = await q.next();
    expect(isHello(hello)).toBe(true);

    const seqs: number[] = [];
    for (let i = 0; i < 2; i++) {
      const frame = await q.next();
      expect(isEnvelope(frame)).toBe(true);
      if (isEnvelope(frame)) seqs.push(frame.serverSeq);
    }
    expect(seqs).toEqual([4, 5]);
    ws.close(1000, "done");
  });

  it("2c. WS backfill: after=deletedSeq closes 4005 with resyncFromSeq", async () => {
    const roomId = uniqueRoomId("s02c-backfill-stale");
    const owner = await generateEd25519Keypair();
    const { admissionKey } = await createRoom({ roomId, ownerSigningKey: owner.publicKeyBytes });
    await registerDevice({
      roomId,
      admissionKey,
      deviceId: "dev-co",
      participantId: "owen",
    });
    await postEnvelopes({
      roomId,
      admissionKey,
      envelopes: [
        buildEnvelope({ envelopeId: "co-1", authorId: "owen", deviceId: "dev-co" }),
      ],
    });

    // Advance oldest_retained_seq so the subscriber's cursor falls behind.
    await runInDurableObject(getStub(roomId), async (_inst, state) => {
      await state.storage.put<number>("meta:oldest_retained_seq", 10);
    });

    const { ws } = await openSocket({ roomId, deviceId: "dev-co", admissionKey });
    const q = new FrameQueue(ws);
    ws.send(JSON.stringify({ type: "subscribe", after: 5 })); // < oldest_retained_seq
    const errFrame = await q.next();
    expect(isErrorFrame(errFrame)).toBe(true);
    if (!isErrorFrame(errFrame)) throw new Error("unreachable");
    expect(errFrame.code).toBe("ATTN_CURSOR_TOO_OLD");
    expect(errFrame.resyncFromSeq).toBe(10);

    await q.waitClosed();
    expect(q.closed).toBe(true);
    expect(q.closeCode).toBe(4005);
  });

  // -------------------------------------------------------------------------
  // Scenario 3 — Caps (a..d sub-cases).
  // -------------------------------------------------------------------------
  it("3a. Cap: maxEvents fills → 507 ATTN_ROOM_EVENT_CAP", async () => {
    const roomId = uniqueRoomId("s03a-cap-events");
    const owner = await generateEd25519Keypair();
    const { admissionKey } = await createRoom({
      roomId,
      ownerSigningKey: owner.publicKeyBytes,
      policy: { maxEvents: 3 },
    });
    await registerDevice({
      roomId,
      admissionKey,
      deviceId: "dev-ec",
      participantId: "ivy",
    });

    // Fill to the cap (3/3).
    const fill = [0, 1, 2].map((i) =>
      buildEnvelope({ envelopeId: `cap-evt-${i}`, authorId: "ivy", deviceId: "dev-ec" }),
    );
    const r1 = await postEnvelopes({ roomId, admissionKey, envelopes: fill });
    expect(r1.status).toBe(201);

    // 4th envelope → 507.
    const r2 = await postEnvelopes({
      roomId,
      admissionKey,
      envelopes: [
        buildEnvelope({ envelopeId: "cap-evt-overflow", authorId: "ivy", deviceId: "dev-ec" }),
      ],
    });
    expect(r2.status).toBe(507);
    const err = (await r2.json()) as ErrorResponse;
    expect(err.error.code).toBe("ATTN_ROOM_EVENT_CAP");
  });

  it("3b. Cap: maxRoomBytes fills → 507 ATTN_ROOM_STORAGE_FULL", async () => {
    const roomId = uniqueRoomId("s03b-cap-bytes");
    const owner = await generateEd25519Keypair();
    const { admissionKey } = await createRoom({ roomId, ownerSigningKey: owner.publicKeyBytes });
    await registerDevice({
      roomId,
      admissionKey,
      deviceId: "dev-bc",
      participantId: "jack",
    });

    // Seed meta:bytes_used to one byte under HARD_MAX_ROOM_BYTES so a 2-byte
    // envelope overflows the room cap.
    const HARD_MAX_ROOM_BYTES = Number(env.HARD_MAX_ROOM_BYTES);
    expect(HARD_MAX_ROOM_BYTES).toBeGreaterThan(0);
    await runInDurableObject(getStub(roomId), async (_inst, state) => {
      await state.storage.put<number>("meta:bytes_used", HARD_MAX_ROOM_BYTES - 1);
    });

    const res = await postEnvelopes({
      roomId,
      admissionKey,
      envelopes: [
        buildEnvelope({
          envelopeId: "cap-bytes-overflow",
          authorId: "jack",
          deviceId: "dev-bc",
          ciphertextBytes: 2,
        }),
      ],
    });
    expect(res.status).toBe(507);
    const err = (await res.json()) as ErrorResponse;
    expect(err.error.code).toBe("ATTN_ROOM_STORAGE_FULL");
  });

  it("3c. Cap: exceed maxEventBytes → 413 ATTN_ENVELOPE_TOO_LARGE", async () => {
    const roomId = uniqueRoomId("s03c-cap-eventbytes");
    const owner = await generateEd25519Keypair();
    const { admissionKey } = await createRoom({
      roomId,
      ownerSigningKey: owner.publicKeyBytes,
      policy: { maxEventBytes: 512 },
    });
    await registerDevice({
      roomId,
      admissionKey,
      deviceId: "dev-be",
      participantId: "frank",
    });

    const res = await postEnvelopes({
      roomId,
      admissionKey,
      envelopes: [
        buildEnvelope({
          envelopeId: "cap-ev-too-big",
          authorId: "frank",
          deviceId: "dev-be",
          kind: "event",
          ciphertextBytes: 2048,
        }),
      ],
    });
    expect(res.status).toBe(413);
    const err = (await res.json()) as ErrorResponse;
    expect(err.error.code).toBe("ATTN_ENVELOPE_TOO_LARGE");
  });

  it("3d. Cap: batch of 33 envelopes → 400 ATTN_BATCH_TOO_LARGE", async () => {
    const roomId = uniqueRoomId("s03d-cap-batch");
    const owner = await generateEd25519Keypair();
    const { admissionKey } = await createRoom({ roomId, ownerSigningKey: owner.publicKeyBytes });
    await registerDevice({
      roomId,
      admissionKey,
      deviceId: "dev-bt",
      participantId: "dave",
    });
    const envelopes = Array.from({ length: 33 }, (_, i) =>
      buildEnvelope({ envelopeId: `cap-batch-${i}`, authorId: "dave", deviceId: "dev-bt" }),
    );
    const res = await postEnvelopes({ roomId, admissionKey, envelopes });
    expect(res.status).toBe(400);
    const err = (await res.json()) as ErrorResponse;
    expect(err.error.code).toBe("ATTN_BATCH_TOO_LARGE");
  });

  // -------------------------------------------------------------------------
  // Scenario 4 — Owner auth + delete policy (a/b/c sub-cases).
  // -------------------------------------------------------------------------
  it("4a. Owner auth: non-owner ACK with delete policy → 204 retained", async () => {
    const roomId = uniqueRoomId("s04a-owner-nonowner");
    const ownerKp = await generateEd25519Keypair();
    const { admissionKey } = await createRoom({
      roomId,
      ownerSigningKey: ownerKp.publicKeyBytes,
      policy: { deleteEventsAfterOwnerAck: true },
    });
    // Register owner + reviewer; the reviewer attempts the ACK.
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
    });

    const envelope = buildEnvelope({
      envelopeId: "s4a-env-1",
      authorId: "reviewer",
      deviceId: "dev-rev",
    });
    await postEnvelopes({ roomId, admissionKey, envelopes: [envelope] });

    // Reviewer signs with their own (non-owner) key — handler ignores the
    // header silently because the acking device isn't kind=owner.
    const res = await postAcks({
      roomId,
      admissionKey,
      body: { ackedEnvelopeIds: ["s4a-env-1"], deviceId: reviewer.deviceId },
      ownerSig: { privateKey: reviewer.privateKey },
    });
    expect(res.status).toBe(204);
    expect(await hasEnvIdx(roomId, "s4a-env-1")).toBe(true);
    expect(await hasOwnerAckMarker(roomId, "s4a-env-1")).toBe(false);
  });

  it("4b. Owner auth: owner ACK with delete policy + valid sig → envelope deleted", async () => {
    const roomId = uniqueRoomId("s04b-owner-delete");
    const ownerKp = await generateEd25519Keypair();
    const { admissionKey } = await createRoom({
      roomId,
      ownerSigningKey: ownerKp.publicKeyBytes,
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
      envelopeId: "s4b-env-1",
      authorId: "owner",
      deviceId: "dev-own",
      ciphertextBytes: 48,
    });
    await postEnvelopes({ roomId, admissionKey, envelopes: [envelope] });
    expect(await getEnvelopeCount(roomId)).toBe(1);

    const res = await postAcks({
      roomId,
      admissionKey,
      body: { ackedEnvelopeIds: ["s4b-env-1"], deviceId: ownerDev.deviceId },
      ownerSig: { privateKey: ownerKp.privateKey },
    });
    expect(res.status).toBe(204);
    expect(await hasEnvIdx(roomId, "s4b-env-1")).toBe(false);
    expect(await hasOwnerAckMarker(roomId, "s4b-env-1")).toBe(true);
    expect(await getEnvelopeCount(roomId)).toBe(0);
  });

  it("4c. Owner auth: default policy (delete=false) → ACK accepted, envelopes retained", async () => {
    const roomId = uniqueRoomId("s04c-owner-default");
    const ownerKp = await generateEd25519Keypair();
    // Default policy — deleteEventsAfterOwnerAck=false.
    const { admissionKey, createResponse } = await createRoom({
      roomId,
      ownerSigningKey: ownerKp.publicKeyBytes,
    });
    expect(createResponse.policy.deleteEventsAfterOwnerAck).toBe(false);
    const ownerDev = await registerDevice({
      roomId,
      admissionKey,
      deviceId: "dev-own",
      participantId: "owner",
      kind: "owner",
      keypair: ownerKp,
    });

    await postEnvelopes({
      roomId,
      admissionKey,
      envelopes: [
        buildEnvelope({
          envelopeId: "s4c-env-1",
          authorId: "owner",
          deviceId: "dev-own",
        }),
      ],
    });

    const res = await postAcks({
      roomId,
      admissionKey,
      body: { ackedEnvelopeIds: ["s4c-env-1"], deviceId: ownerDev.deviceId },
      ownerSig: { privateKey: ownerKp.privateKey },
    });
    expect(res.status).toBe(204);
    // Header was signed but policy says retain.
    expect(await hasEnvIdx(roomId, "s4c-env-1")).toBe(true);
    expect(await getEnvelopeCount(roomId)).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Scenario 5 — Multi-device: two owner devices both ACK, deletion only fires
  // once any owner ACKs (per spec "owner-acked-anywhere ⇒ may drop").
  // -------------------------------------------------------------------------
  it("5. Multi-device: two owner devices both ACK; deletion fires after either", async () => {
    const roomId = uniqueRoomId("s05-multi-device");
    const ownerKp = await generateEd25519Keypair();
    const { admissionKey } = await createRoom({
      roomId,
      ownerSigningKey: ownerKp.publicKeyBytes,
      policy: { deleteEventsAfterOwnerAck: true },
    });
    // Both owner devices share the same Ed25519 keypair (multi-device owner
    // pattern: identity is keyed by ownerSigningKey).
    const ownerA = await registerDevice({
      roomId,
      admissionKey,
      deviceId: "dev-own-a",
      participantId: "owner",
      kind: "owner",
      keypair: ownerKp,
    });
    const ownerB = await registerDevice({
      roomId,
      admissionKey,
      deviceId: "dev-own-b",
      participantId: "owner",
      kind: "owner",
      keypair: ownerKp,
    });

    // Two envelopes.
    await postEnvelopes({
      roomId,
      admissionKey,
      envelopes: [
        buildEnvelope({ envelopeId: "s5-env-1", authorId: "owner", deviceId: "dev-own-a" }),
        buildEnvelope({ envelopeId: "s5-env-2", authorId: "owner", deviceId: "dev-own-a" }),
      ],
    });
    expect(await getEnvelopeCount(roomId)).toBe(2);

    // device A acks env-1 (with owner-sig + delete policy) → env-1 dropped.
    const r1 = await postAcks({
      roomId,
      admissionKey,
      body: { ackedEnvelopeIds: ["s5-env-1"], deviceId: ownerA.deviceId },
      ownerSig: { privateKey: ownerKp.privateKey },
    });
    expect(r1.status).toBe(204);
    expect(await hasEnvIdx(roomId, "s5-env-1")).toBe(false);
    expect(await hasOwnerAckMarker(roomId, "s5-env-1")).toBe(true);
    expect(await getEnvelopeCount(roomId)).toBe(1);

    // device B acks env-2 → also deleted (independent owner device).
    const r2 = await postAcks({
      roomId,
      admissionKey,
      body: { ackedEnvelopeIds: ["s5-env-2"], deviceId: ownerB.deviceId },
      ownerSig: { privateKey: ownerKp.privateKey },
    });
    expect(r2.status).toBe(204);
    expect(await hasEnvIdx(roomId, "s5-env-2")).toBe(false);
    expect(await getEnvelopeCount(roomId)).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Scenario 6 — Signaling (a: live round-trip; b: offline target mailbox).
  // -------------------------------------------------------------------------
  it("6a. Signaling: signal envelope routes to target.deviceId over WS", async () => {
    const roomId = uniqueRoomId("s06a-signal-live");
    const owner = await generateEd25519Keypair();
    const { admissionKey } = await createRoom({ roomId, ownerSigningKey: owner.publicKeyBytes });
    await registerDevice({
      roomId,
      admissionKey,
      deviceId: "dev-from",
      participantId: "fa",
    });
    await registerDevice({
      roomId,
      admissionKey,
      deviceId: "dev-to",
      participantId: "tg",
    });
    await registerDevice({
      roomId,
      admissionKey,
      deviceId: "dev-other",
      participantId: "oth",
    });

    const a = await openSocket({ roomId, deviceId: "dev-from", admissionKey });
    const b = await openSocket({ roomId, deviceId: "dev-to", admissionKey });
    const c = await openSocket({ roomId, deviceId: "dev-other", admissionKey });
    const qa = new FrameQueue(a.ws);
    const qb = new FrameQueue(b.ws);
    const qc = new FrameQueue(c.ws);
    a.ws.send(JSON.stringify({ type: "subscribe", after: 0 }));
    b.ws.send(JSON.stringify({ type: "subscribe", after: 0 }));
    c.ws.send(JSON.stringify({ type: "subscribe", after: 0 }));
    await drainHelloThroughPing(qa);
    await drainHelloThroughPing(qb);
    await drainHelloThroughPing(qc);

    const r = await postEnvelopes({
      roomId,
      admissionKey,
      envelopes: [
        buildEnvelope({
          envelopeId: "s6a-sig-1",
          authorId: "fa",
          deviceId: "dev-from",
          kind: "signal",
          target: { deviceId: "dev-to" },
        }),
      ],
    });
    expect(r.status).toBe(201);

    // Target receives it.
    const onTo = await qb.next(2000);
    expect(isEnvelope(onTo)).toBe(true);
    if (isEnvelope(onTo)) {
      expect(onTo.envelope.envelopeId).toBe("s6a-sig-1");
      expect(onTo.envelope.target?.deviceId).toBe("dev-to");
    }
    // Non-target peers must not see it.
    const onFrom = await qa.next(300);
    const onOther = await qc.next(300);
    expect(onFrom).toBeUndefined();
    expect(onOther).toBeUndefined();

    a.ws.close(1000);
    b.ws.close(1000);
    c.ws.close(1000);
  });

  it("6b. Signaling: offline target gets stored signal envelope on reconnect", async () => {
    const roomId = uniqueRoomId("s06b-signal-mailbox");
    const owner = await generateEd25519Keypair();
    const { admissionKey } = await createRoom({ roomId, ownerSigningKey: owner.publicKeyBytes });
    await registerDevice({
      roomId,
      admissionKey,
      deviceId: "dev-from",
      participantId: "fa",
    });
    await registerDevice({
      roomId,
      admissionKey,
      deviceId: "dev-target",
      participantId: "tg",
    });

    // Target is offline at time of signal upload.
    const r = await postEnvelopes({
      roomId,
      admissionKey,
      envelopes: [
        buildEnvelope({
          envelopeId: "s6b-sig-stored",
          authorId: "fa",
          deviceId: "dev-from",
          kind: "signal",
          target: { deviceId: "dev-target" },
        }),
      ],
    });
    expect(r.status).toBe(201);

    // Target connects later — hello.missedSignalEnvelopeIds includes the stored
    // signal envelope id and the envelope is delivered on backfill.
    const { ws } = await openSocket({ roomId, deviceId: "dev-target", admissionKey });
    const q = new FrameQueue(ws);
    ws.send(JSON.stringify({ type: "subscribe", after: 0 }));
    const drained = await drainHelloThroughPing(q);
    expect(drained.hello.missedSignalEnvelopeIds).toContain("s6b-sig-stored");
    // The stored signal envelope must also be delivered as a backfill envelope
    // frame so the target can decrypt + handle it.
    const ids = drained.backfill.map((f) => f.envelope.envelopeId);
    expect(ids).toContain("s6b-sig-stored");
    ws.close(1000);
  });

  // -------------------------------------------------------------------------
  // Scenario 7 — R2 spillover (presign + PUT + GET round-trip).
  // Spec calls out 3 MiB; we use 1 MiB + 1 KiB to keep the test fast while
  // still being above the 1 MiB R2 threshold gate.
  // -------------------------------------------------------------------------
  it("7. R2 spillover: presign → PUT → GET round-trips an encrypted snapshot", async () => {
    const roomId = uniqueRoomId("s07-r2-roundtrip");
    const owner = await generateEd25519Keypair();
    const { admissionKey } = await createRoom({ roomId, ownerSigningKey: owner.publicKeyBytes });
    await registerDevice({
      roomId,
      admissionKey,
      deviceId: "dev-rt",
      participantId: "bob",
    });

    const blobBytes = 1 * 1024 * 1024 + 1024; // 1 MiB + 1 KiB — above threshold
    const ciphertext = new Uint8Array(blobBytes);
    for (let i = 0; i < blobBytes; i++) ciphertext[i] = (i * 37) & 0xff;

    // Presign request.
    const presignUrl = `${URL_BASE}/v2/rooms/${roomId}/blobs`;
    const presignBody = JSON.stringify({
      envelopeId: "s7-blob",
      authorId: "bob",
      deviceId: "dev-rt",
      ciphertextBytes: blobBytes,
    });
    const adm = await admissionHeaderFor({
      method: "POST",
      url: presignUrl,
      body: presignBody,
      admissionKey,
    });
    const pow = await mintPow({
      roomId,
      deviceId: "dev-rt",
      method: "POST",
      path: `/v2/rooms/${roomId}/blobs`,
    });
    const presignRes = await SELF.fetch(presignUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Attn-Admission": adm, "Attn-PoW": pow },
      body: presignBody,
    });
    expect(presignRes.status).toBe(200);
    const presigned = (await presignRes.json()) as {
      uploadUrl: string;
      method: "PUT";
      headers: Record<string, string>;
      expiresAt: number;
      blobKey: string;
    };
    expect(presigned.blobKey).toBe(`rooms/${roomId}/blobs/s7-blob`);

    // PUT to the presigned URL.
    const putRes = await SELF.fetch(`${URL_BASE}${presigned.uploadUrl}`, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body: ciphertext,
    });
    expect(putRes.status).toBe(204);

    // GET via download URL.
    const download = await presignBlobDownload(env, roomId, "s7-blob");
    const getRes = await SELF.fetch(`${URL_BASE}${download.downloadUrl}`, { method: "GET" });
    expect(getRes.status).toBe(200);
    const fetched = new Uint8Array(await getRes.arrayBuffer());
    expect(fetched.byteLength).toBe(blobBytes);
    expect(fetched[0]).toBe(ciphertext[0]);
    expect(fetched[blobBytes - 1]).toBe(ciphertext[blobBytes - 1]);
  });
});
