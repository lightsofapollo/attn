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

// Drain hello + the immediate post-hello ping the server emits.
async function drainHelloAndPing(q: FrameQueue): Promise<HelloFrame> {
  const hello = await q.next();
  if (!isHello(hello)) throw new Error("expected hello");
  const ping = await q.next();
  if (!isPing(ping)) throw new Error("expected post-hello ping");
  return hello;
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
  // Scenarios are appended in subsequent commits (1..14 + sub-cases).
  it("0. Scaffold guard — env binds and SELF.fetch reaches /health", async () => {
    const res = await SELF.fetch(`${URL_BASE}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; ts: number };
    expect(body.status).toBe("ok");
    expect(typeof body.ts).toBe("number");
  });
});
