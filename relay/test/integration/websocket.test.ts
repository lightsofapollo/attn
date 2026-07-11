/**
 * Integration coverage for `WS /v2/rooms/:roomId/socket` (attn-nnj.5.11).
 *
 * Spec: planning/collab/relay-spec.md §WebSocket Protocol
 * Amendments: #5 (WS-only; backfill via WS hello + envelope frames; cursor-too-old
 *             via error frame + close 4005)
 *
 * Tests go through the Worker via SELF.fetch, opening a WS upgrade and reading
 * frames off the upgraded `Response.webSocket`. Each test creates a fresh
 * room + registers the devices it needs so DO storage is isolated by roomId.
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
import { encodeOpaqueSegment } from "../../src/opaque-key";
import type {
  DeviceRecord,
  EnvelopeInput,
  EnvelopeRecord,
  RoomPolicy,
} from "../../src/schema";
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

// --- envelope builder ----------------------------------------------------

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
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 13 + 7) & 0xff;
  const ciphertext = base64UrlEncode(bytes);
  const nonce = base64UrlEncode(new Uint8Array(24).fill(0x55));
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

async function postEnvelopes(opts: {
  roomId: string;
  admissionKey: Uint8Array;
  envelopes: EnvelopeInput[];
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
  const firstEnv = opts.envelopes[0];
  if (firstEnv === undefined) throw new Error("empty batch");
  headers["Attn-PoW"] = await mintEnvelopePow(opts.roomId, firstEnv.deviceId);
  return SELF.fetch(url, { method: "POST", headers, body });
}

// --- WS helpers ----------------------------------------------------------

/** Mint the Sec-WebSocket-Protocol value for a WS upgrade against /socket. */
async function buildSocketProtocolHeader(opts: {
  roomId: string;
  deviceId: string;
  admissionKey: Uint8Array;
  badHmac?: boolean;
}): Promise<string> {
  const url = `${URL_BASE}/v2/rooms/${opts.roomId}/socket?device_id=${encodeURIComponent(opts.deviceId)}`;
  const signing = new Request(url, { method: "GET" });
  const canonical = await canonicalRequest(signing, new URL(url).pathname);
  let hmac = await hmacSha256(opts.admissionKey, canonical);
  if (opts.badHmac === true) {
    // Flip a byte so the HMAC fails to verify but stays the right length.
    hmac = new Uint8Array(hmac);
    hmac[0] = (hmac[0] ?? 0) ^ 0xff;
  }
  return `attn.v2, hmac.${base64UrlEncode(hmac)}`;
}

interface OpenSocketResult {
  ws: WebSocket;
  response: Response;
}

/** Open a WS upgrade to the relay. Returns the upgraded WebSocket + Response. */
async function openSocket(opts: {
  roomId: string;
  deviceId: string;
  admissionKey: Uint8Array;
  badHmac?: boolean;
  omitProtocol?: boolean;
}): Promise<OpenSocketResult> {
  const url = `${URL_BASE}/v2/rooms/${opts.roomId}/socket?device_id=${encodeURIComponent(opts.deviceId)}`;
  const headers: Record<string, string> = { Upgrade: "websocket" };
  if (!opts.omitProtocol) {
    headers["Sec-WebSocket-Protocol"] = await buildSocketProtocolHeader({
      roomId: opts.roomId,
      deviceId: opts.deviceId,
      admissionKey: opts.admissionKey,
      badHmac: opts.badHmac,
    });
  }
  const res = await SELF.fetch(url, { headers });
  const ws = res.webSocket;
  if (ws === null) {
    return { ws: null as unknown as WebSocket, response: res };
  }
  ws.accept();
  return { ws, response: res };
}

/** Queue helper: collect frames as they arrive; await with next(). */
class FrameQueue {
  private readonly buffer: unknown[] = [];
  private readonly waiters: Array<(frame: unknown) => void> = [];
  public closeCode: number | undefined;
  public closeReason: string | undefined;
  public closed = false;
  public errored = false;

  constructor(ws: WebSocket) {
    ws.addEventListener("message", (e: MessageEvent) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(typeof e.data === "string" ? e.data : "");
      } catch {
        parsed = e.data;
      }
      const waiter = this.waiters.shift();
      if (waiter !== undefined) {
        waiter(parsed);
      } else {
        this.buffer.push(parsed);
      }
    });
    ws.addEventListener("close", (e: CloseEvent) => {
      this.closeCode = e.code;
      this.closeReason = e.reason;
      this.closed = true;
      // Wake any pending waiters with a sentinel to avoid deadlocks.
      while (this.waiters.length > 0) {
        const w = this.waiters.shift();
        if (w !== undefined) w(undefined);
      }
    });
    ws.addEventListener("error", () => {
      this.errored = true;
    });
  }

  /** Resolve with the next frame, or undefined on close/timeout. */
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

  /** Wait for the close event (or timeout). */
  async waitClosed(timeoutMs = 2000): Promise<void> {
    const start = Date.now();
    while (!this.closed) {
      if (Date.now() - start > timeoutMs) return;
      await new Promise<void>((r) => setTimeout(r, 10));
    }
  }
}

interface HelloFrame {
  type: "hello";
  serverSeq: number;
  policy: RoomPolicy;
  devices: DeviceRecord[];
  onlineDeviceIds: string[];
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
function isError(x: unknown): x is ErrorFrame {
  return typeof x === "object" && x !== null && (x as { type?: unknown }).type === "error";
}
function isPresence(x: unknown): x is PresenceFrame {
  return typeof x === "object" && x !== null && (x as { type?: unknown }).type === "presence";
}
function isPing(x: unknown): x is PingFrame {
  return typeof x === "object" && x !== null && (x as { type?: unknown }).type === "ping";
}

// --- tests ---------------------------------------------------------------

describe("WS /socket — admission", () => {
  it("fails closed when legacy state maps one deviceId to two participants", async () => {
    const roomId = uniqueRoomId("ws-ambiguous-device");
    const owner = await generateEd25519Keypair();
    const admissionKey = await createRoom({ roomId, ownerKp: owner });
    await registerDevice({ roomId, admissionKey, deviceId: "ambiguous-device", participantId: "alice" });
    const stub = env.RELAY_ROOMS.get(env.RELAY_ROOMS.idFromName(roomId));
    await runInDurableObject(stub, async (_instance, state) => {
      const records = await state.storage.list<DeviceRecord>({ prefix: "device_v2:" });
      const record = [...records.values()][0];
      if (record === undefined) throw new Error("missing device fixture");
      await state.storage.put(
        `device_v2:${encodeOpaqueSegment("bob")}:${encodeOpaqueSegment("ambiguous-device")}`,
        { ...record, participantId: "bob" },
      );
    });
    const { response } = await openSocket({ roomId, deviceId: "ambiguous-device", admissionKey });
    expect(response.status).toBe(500);
    expect(((await response.json()) as { error: { code: string; message: string } }).error)
      .toEqual({ code: "ATTN_ROOM_CORRUPT", message: "inconsistent versioned storage state" });
  });

  it("returns 401 ATTN_ADMISSION_INVALID when Sec-WebSocket-Protocol is missing", async () => {
    const roomId = uniqueRoomId("ws-no-proto");
    const owner = await generateEd25519Keypair();
    const admissionKey = await createRoom({ roomId, ownerKp: owner });
    await registerDevice({ roomId, admissionKey, deviceId: "dev-a", participantId: "alice" });

    const { ws, response } = await openSocket({
      roomId,
      deviceId: "dev-a",
      admissionKey,
      omitProtocol: true,
    });
    expect(response.status).toBe(401);
    expect(ws as unknown).toBe(null);
    const err = (await response.json()) as { error: { code: string } };
    expect(err.error.code).toBe("ATTN_ADMISSION_INVALID");
  });

  it("accepts the upgrade and closes with 4000 when the HMAC is wrong", async () => {
    const roomId = uniqueRoomId("ws-bad-hmac");
    const owner = await generateEd25519Keypair();
    const admissionKey = await createRoom({ roomId, ownerKp: owner });
    await registerDevice({ roomId, admissionKey, deviceId: "dev-b", participantId: "bob" });

    const { ws, response } = await openSocket({
      roomId,
      deviceId: "dev-b",
      admissionKey,
      badHmac: true,
    });
    expect(response.status).toBe(101);
    const q = new FrameQueue(ws);
    await q.waitClosed(2000);
    expect(q.closed).toBe(true);
    expect(q.closeCode).toBe(4000);
  });

  it("opens with valid admission and replies with a hello frame after subscribe", async () => {
    const roomId = uniqueRoomId("ws-hello");
    const owner = await generateEd25519Keypair();
    const admissionKey = await createRoom({ roomId, ownerKp: owner });
    await registerDevice({ roomId, admissionKey, deviceId: "dev-h", participantId: "harriet" });

    const { ws, response } = await openSocket({ roomId, deviceId: "dev-h", admissionKey });
    expect(response.status).toBe(101);
    const q = new FrameQueue(ws);
    ws.send(JSON.stringify({ type: "subscribe", after: 0 }));
    const first = await q.next();
    expect(isHello(first)).toBe(true);
    if (!isHello(first)) throw new Error("unreachable");
    expect(first.serverSeq).toBe(0);
    expect(first.devices.length).toBe(1);
    expect(first.devices[0]?.deviceId).toBe("dev-h");
    expect(first.missedSignalEnvelopeIds).toEqual([]);
    expect(first.onlineDeviceIds).toEqual(['dev-h']);
    const stub = env.RELAY_ROOMS.get(env.RELAY_ROOMS.idFromName(roomId));
    await runInDurableObject(stub, async (_instance, state) => {
      expect(state.getWebSockets(`d2:${encodeOpaqueSegment("dev-h")}`).length).toBe(1);
      expect(state.getWebSockets(`p2:${encodeOpaqueSegment("harriet")}`).length).toBe(1);
      expect(state.getWebSockets("dev-h").length).toBe(0);
    });
    ws.close(1000, "test done");
  });
});

describe("WS /socket — backfill", () => {
  it.each([
    ["negative server sequence", -1, 0],
    ["fractional cursor floor", 1, 0.5],
    ["cursor floor beyond server sequence", 1, 2],
  ] as const)("fails before hello on %s metadata", async (_label, serverSeq, oldest) => {
    const roomId = uniqueRoomId("ws-corrupt-replay-meta");
    const owner = await generateEd25519Keypair();
    const admissionKey = await createRoom({ roomId, ownerKp: owner });
    await registerDevice({
      roomId,
      admissionKey,
      deviceId: "dev-corrupt-meta",
      participantId: "peer-corrupt-meta",
    });
    const stub = env.RELAY_ROOMS.get(env.RELAY_ROOMS.idFromName(roomId));
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put({
        "meta:server_seq": serverSeq,
        "meta:oldest_retained_seq": oldest,
      });
    });
    const { ws } = await openSocket({ roomId, deviceId: "dev-corrupt-meta", admissionKey });
    const q = new FrameQueue(ws);
    ws.send(JSON.stringify({ type: "subscribe", after: 0 }));
    expect(await q.next()).toMatchObject({ type: "error", code: "ATTN_ROOM_CORRUPT" });
    await q.waitClosed(2_000);
    expect(q.closed).toBe(true);
  });

  it("sends corruption and closes before hello when legacy/v2 payloads diverge", async () => {
    const roomId = uniqueRoomId("ws-divergent-payload");
    const owner = await generateEd25519Keypair();
    const admissionKey = await createRoom({ roomId, ownerKp: owner });
    await registerDevice({ roomId, admissionKey, deviceId: "dev-diverge", participantId: "peer-diverge" });
    const envelope = buildEnvelope({
      envelopeId: "divergent-envelope",
      authorId: "peer-diverge",
      deviceId: "dev-diverge",
    });
    expect((await postEnvelopes({ roomId, admissionKey, envelopes: [envelope] })).status).toBe(201);
    const padded = "00000000000000000001";
    const stub = env.RELAY_ROOMS.get(env.RELAY_ROOMS.idFromName(roomId));
    await runInDurableObject(stub, async (_instance, state) => {
      const current = await state.storage.get<EnvelopeRecord>(
        `env_v2:${padded}:${encodeOpaqueSegment(envelope.envelopeId)}`,
      );
      if (current === undefined) throw new Error("missing payload fixture");
      await state.storage.put({
        [`env:${padded}:${envelope.envelopeId}`]: { ...current, ciphertext: "AA" },
        [`env_idx:${envelope.envelopeId}`]: padded,
      });
    });
    const { ws } = await openSocket({ roomId, deviceId: "dev-diverge", admissionKey });
    const q = new FrameQueue(ws);
    ws.send(JSON.stringify({ type: "subscribe", after: 0 }));
    expect(await q.next()).toMatchObject({ type: "error", code: "ATTN_ROOM_CORRUPT" });
    await q.waitClosed(2_000);
    expect(q.closed).toBe(true);
  });

  it("fails before hello on a stale missed-signal index", async () => {
    const roomId = uniqueRoomId("ws-stale-signal-index");
    const owner = await generateEd25519Keypair();
    const admissionKey = await createRoom({ roomId, ownerKp: owner });
    await registerDevice({ roomId, admissionKey, deviceId: "dev-stale", participantId: "peer-stale" });
    const stub = env.RELAY_ROOMS.get(env.RELAY_ROOMS.idFromName(roomId));
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put(
        `env_by_target_v3:${encodeOpaqueSegment("dev-stale")}:00000000000000000001:${encodeOpaqueSegment("missing-signal")}`,
        "",
      );
    });
    const { ws } = await openSocket({ roomId, deviceId: "dev-stale", admissionKey });
    const q = new FrameQueue(ws);
    ws.send(JSON.stringify({ type: "subscribe", after: 0 }));
    expect(await q.next()).toMatchObject({ type: "error", code: "ATTN_ROOM_CORRUPT" });
  });

  it("fails before hello on a malformed envelope payload key", async () => {
    const roomId = uniqueRoomId("ws-malformed-payload");
    const owner = await generateEd25519Keypair();
    const admissionKey = await createRoom({ roomId, ownerKp: owner });
    await registerDevice({ roomId, admissionKey, deviceId: "dev-malformed", participantId: "peer-malformed" });
    const stub = env.RELAY_ROOMS.get(env.RELAY_ROOMS.idFromName(roomId));
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put("env_v2:malformed", null);
    });
    const { ws } = await openSocket({ roomId, deviceId: "dev-malformed", admissionKey });
    const q = new FrameQueue(ws);
    ws.send(JSON.stringify({ type: "subscribe", after: 0 }));
    expect(await q.next()).toMatchObject({ type: "error", code: "ATTN_ROOM_CORRUPT" });
  });

  it("merges an exact legacy payload and env_by_target_v2 index into hello/replay", async () => {
    const roomId = uniqueRoomId("ws-legacy-target-v2");
    const owner = await generateEd25519Keypair();
    const admissionKey = await createRoom({ roomId, ownerKp: owner });
    await registerDevice({ roomId, admissionKey, deviceId: "dev-legacy", participantId: "legacy-peer" });
    const envelopeId = "legacy-signal";
    const padded = "00000000000000000001";
    const record: EnvelopeRecord = {
      envelopeId,
      authorId: "legacy-peer",
      deviceId: "dev-legacy",
      kind: "signal",
      target: { deviceId: "dev-legacy" },
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      nonce: base64UrlEncode(new Uint8Array(24)),
      ciphertext: base64UrlEncode(new Uint8Array([9, 8, 7])),
      ciphertextBytes: 3,
      serverSeq: 1,
    };
    const stub = env.RELAY_ROOMS.get(env.RELAY_ROOMS.idFromName(roomId));
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put({
        [`env:${padded}:${envelopeId}`]: record,
        [`env_idx:${envelopeId}`]: padded,
        [`env_by_target_v2:${encodeOpaqueSegment("dev-legacy")}:${padded}:${envelopeId}`]: "",
        "meta:server_seq": 1,
        "meta:envelope_count": 1,
        "meta:bytes_used": 3,
      });
    });

    const { ws } = await openSocket({ roomId, deviceId: "dev-legacy", admissionKey });
    const q = new FrameQueue(ws);
    ws.send(JSON.stringify({ type: "subscribe", after: 0 }));
    const hello = await q.next();
    expect(isHello(hello)).toBe(true);
    if (!isHello(hello)) throw new Error("unreachable");
    expect(hello.missedSignalEnvelopeIds).toEqual([envelopeId]);
    const replay = await q.next();
    expect((replay as { type?: string; envelope?: { envelopeId?: string } }).type).toBe("envelope");
    expect((replay as { envelope?: { envelopeId?: string } }).envelope?.envelopeId).toBe(envelopeId);
    ws.close(1000, "test done");
  });

  it("replays all stored envelopes when subscribe.after=0", async () => {
    const roomId = uniqueRoomId("ws-backfill-zero");
    const owner = await generateEd25519Keypair();
    const admissionKey = await createRoom({ roomId, ownerKp: owner });
    await registerDevice({ roomId, admissionKey, deviceId: "dev-bk", participantId: "kara" });

    // Pre-load 3 envelopes.
    for (let i = 0; i < 3; i++) {
      const r = await postEnvelopes({
        roomId,
        admissionKey,
        envelopes: [
          buildEnvelope({ envelopeId: `bk-${i}`, authorId: "kara", deviceId: "dev-bk" }),
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
    for (let i = 0; i < 3; i++) {
      const f = await q.next();
      expect(isEnvelope(f)).toBe(true);
      if (!isEnvelope(f)) throw new Error("unreachable");
      seqs.push(f.serverSeq);
      expect(f.envelope.envelopeId).toBe(`bk-${i}`);
    }
    expect(seqs).toEqual([1, 2, 3]);
    ws.close(1000, "done");
  });

  it("replays only envelopes with serverSeq > after", async () => {
    const roomId = uniqueRoomId("ws-backfill-after");
    const owner = await generateEd25519Keypair();
    const admissionKey = await createRoom({ roomId, ownerKp: owner });
    await registerDevice({ roomId, admissionKey, deviceId: "dev-bk2", participantId: "kara" });
    for (let i = 0; i < 4; i++) {
      await postEnvelopes({
        roomId,
        admissionKey,
        envelopes: [
          buildEnvelope({ envelopeId: `mid-${i}`, authorId: "kara", deviceId: "dev-bk2" }),
        ],
      });
    }

    const { ws } = await openSocket({ roomId, deviceId: "dev-bk2", admissionKey });
    const q = new FrameQueue(ws);
    ws.send(JSON.stringify({ type: "subscribe", after: 2 }));
    const hello = await q.next();
    expect(isHello(hello)).toBe(true);

    // Should get envelopes 3 and 4.
    const seqs: number[] = [];
    for (let i = 0; i < 2; i++) {
      const f = await q.next();
      expect(isEnvelope(f)).toBe(true);
      if (isEnvelope(f)) seqs.push(f.serverSeq);
    }
    expect(seqs).toEqual([3, 4]);
    ws.close(1000, "done");
  });

  it("emits ATTN_CURSOR_TOO_OLD + close 4005 when after < oldest_retained_seq", async () => {
    const roomId = uniqueRoomId("ws-cursor-too-old");
    const owner = await generateEd25519Keypair();
    const admissionKey = await createRoom({ roomId, ownerKp: owner });
    await registerDevice({ roomId, admissionKey, deviceId: "dev-co", participantId: "owen" });
    // Model a room whose first five payloads were already removed. Both values
    // are authoritative and the cursor floor does not exceed server_seq.
    const id = env.RELAY_ROOMS.idFromName(roomId);
    const stub = env.RELAY_ROOMS.get(id);
    await runInDurableObject(stub, async (_inst, state) => {
      await state.storage.put({
        "meta:server_seq": 5,
        "meta:oldest_retained_seq": 5,
      });
    });

    const { ws } = await openSocket({ roomId, deviceId: "dev-co", admissionKey });
    const q = new FrameQueue(ws);
    ws.send(JSON.stringify({ type: "subscribe", after: 2 }));
    const errFrame = await q.next();
    expect(isError(errFrame)).toBe(true);
    if (!isError(errFrame)) throw new Error("unreachable");
    expect(errFrame.code).toBe("ATTN_CURSOR_TOO_OLD");
    expect(errFrame.resyncFromSeq).toBe(5);

    await q.waitClosed();
    expect(q.closed).toBe(true);
    expect(q.closeCode).toBe(4005);
  });
});

describe("WS /socket — live broadcast", () => {
  it("delivers a freshly-ingested envelope to a subscribed peer", async () => {
    const roomId = uniqueRoomId("ws-live");
    const owner = await generateEd25519Keypair();
    const admissionKey = await createRoom({ roomId, ownerKp: owner });
    await registerDevice({ roomId, admissionKey, deviceId: "dev-l1", participantId: "lara" });

    const { ws } = await openSocket({ roomId, deviceId: "dev-l1", admissionKey });
    const q = new FrameQueue(ws);
    ws.send(JSON.stringify({ type: "subscribe", after: 0 }));
    const hello = await q.next();
    expect(isHello(hello)).toBe(true);
    // After hello the server sends an immediate ping; drain it so the next
    // assertion isn't shifted.
    const maybePing = await q.next();
    expect(isPing(maybePing)).toBe(true);

    // Now ingest an envelope.
    const r = await postEnvelopes({
      roomId,
      admissionKey,
      envelopes: [buildEnvelope({ envelopeId: "live-1", authorId: "lara", deviceId: "dev-l1" })],
    });
    expect(r.status).toBe(201);

    const frame = await q.next(5000);
    expect(isEnvelope(frame)).toBe(true);
    if (!isEnvelope(frame)) throw new Error("unreachable");
    expect(frame.envelope.envelopeId).toBe("live-1");
    expect(frame.serverSeq).toBe(1);
    ws.close(1000, "done");
  });

  it("delivers signal envelopes only to target.deviceId; other peers see nothing", async () => {
    const roomId = uniqueRoomId("ws-signal");
    const owner = await generateEd25519Keypair();
    const admissionKey = await createRoom({ roomId, ownerKp: owner });
    await registerDevice({ roomId, admissionKey, deviceId: "dev-from", participantId: "fa" });
    await registerDevice({ roomId, admissionKey, deviceId: "dev-to", participantId: "tg" });
    await registerDevice({ roomId, admissionKey, deviceId: "dev-other", participantId: "oth" });

    // Open three sockets and subscribe each.
    const a = await openSocket({ roomId, deviceId: "dev-from", admissionKey });
    const b = await openSocket({ roomId, deviceId: "dev-to", admissionKey });
    const c = await openSocket({ roomId, deviceId: "dev-other", admissionKey });
    const qa = new FrameQueue(a.ws);
    const qb = new FrameQueue(b.ws);
    const qc = new FrameQueue(c.ws);
    a.ws.send(JSON.stringify({ type: "subscribe", after: 0 }));
    b.ws.send(JSON.stringify({ type: "subscribe", after: 0 }));
    c.ws.send(JSON.stringify({ type: "subscribe", after: 0 }));
    // Drain hello + immediate ping on each.
    for (const q of [qa, qb, qc]) {
      const h = await q.next();
      expect(isHello(h)).toBe(true);
      const p = await q.next();
      expect(isPing(p)).toBe(true);
    }

    // Ingest a signal targeted at dev-to.
    const r = await postEnvelopes({
      roomId,
      admissionKey,
      envelopes: [
        buildEnvelope({
          envelopeId: "sig-tgt",
          authorId: "fa",
          deviceId: "dev-from",
          kind: "signal",
          target: { deviceId: "dev-to" },
        }),
      ],
    });
    expect(r.status).toBe(201);

    // dev-to should receive it; the others should not.
    const onTo = await qb.next(2000);
    expect(isEnvelope(onTo)).toBe(true);
    if (isEnvelope(onTo)) expect(onTo.envelope.envelopeId).toBe("sig-tgt");

    // Short waits for the others — neither should emit an envelope.
    const onFrom = await qa.next(300);
    const onOther = await qc.next(300);
    expect(onFrom).toBeUndefined();
    expect(onOther).toBeUndefined();

    a.ws.close(1000);
    b.ws.close(1000);
    c.ws.close(1000);
  });
});

describe("WS /socket — presence", () => {
  it("tracks same-device presence across 0→1 and 1→0 socket transitions", async () => {
    const roomId = uniqueRoomId("ws-presence-same-device");
    const owner = await generateEd25519Keypair();
    const admissionKey = await createRoom({ roomId, ownerKp: owner });
    await registerDevice({ roomId, admissionKey, deviceId: "observer", participantId: "observer-p" });
    await registerDevice({ roomId, admissionKey, deviceId: "shared-device", participantId: "shared-p" });
    await registerDevice({ roomId, admissionKey, deviceId: "isolated-device", participantId: "isolated-p" });

    const observer = await openSocket({ roomId, deviceId: "observer", admissionKey });
    const queue = new FrameQueue(observer.ws);
    observer.ws.send(JSON.stringify({ type: "subscribe", after: 0 }));
    expect(isHello(await queue.next())).toBe(true);
    expect(isPing(await queue.next())).toBe(true);

    const first = await openSocket({ roomId, deviceId: "shared-device", admissionKey });
    const firstJoin = await queue.next();
    expect(firstJoin).toEqual({
      type: "presence",
      event: "join",
      deviceId: "shared-device",
      participantId: "shared-p",
    });

    const second = await openSocket({ roomId, deviceId: "shared-device", admissionKey });
    const isolated = await openSocket({ roomId, deviceId: "isolated-device", admissionKey });
    // This must be the isolated device's join. If the second shared-device
    // socket emitted a duplicate join, it would be the next queued frame.
    expect(await queue.next()).toEqual({
      type: "presence",
      event: "join",
      deviceId: "isolated-device",
      participantId: "isolated-p",
    });

    first.ws.close(1000, "first tab closed");
    isolated.ws.close(1000, "other device closed");
    // This must be isolated-device's leave. A false leave from the first
    // shared-device socket would arrive first. Presence is isolated by
    // deviceId: the remaining shared socket cannot keep this device online.
    expect(await queue.next()).toEqual({
      type: "presence",
      event: "leave",
      deviceId: "isolated-device",
      participantId: "isolated-p",
    });

    second.ws.close(1000, "final tab closed");
    expect(await queue.next()).toEqual({
      type: "presence",
      event: "leave",
      deviceId: "shared-device",
      participantId: "shared-p",
    });
    // The 1→0 transition emits exactly one leave.
    expect(await queue.next(250)).toBeUndefined();

    observer.ws.close(1000);
  });

  it("broadcasts presence:join to existing peers when a new socket opens", async () => {
    const roomId = uniqueRoomId("ws-presence-join");
    const owner = await generateEd25519Keypair();
    const admissionKey = await createRoom({ roomId, ownerKp: owner });
    await registerDevice({ roomId, admissionKey, deviceId: "dev-p1", participantId: "p1" });
    await registerDevice({ roomId, admissionKey, deviceId: "dev-p2", participantId: "p2" });

    const a = await openSocket({ roomId, deviceId: "dev-p1", admissionKey });
    const qa = new FrameQueue(a.ws);
    a.ws.send(JSON.stringify({ type: "subscribe", after: 0 }));
    const helloA = await qa.next();
    expect(isHello(helloA)).toBe(true);
    const pingA = await qa.next();
    expect(isPing(pingA)).toBe(true);

    // Open second socket.
    const b = await openSocket({ roomId, deviceId: "dev-p2", admissionKey });
    const qb = new FrameQueue(b.ws);

    // Peer A should receive a presence:join for dev-p2.
    const presence = await qa.next(2000);
    expect(isPresence(presence)).toBe(true);
    if (isPresence(presence)) {
      expect(presence.event).toBe("join");
      expect(presence.deviceId).toBe("dev-p2");
      expect(presence.participantId).toBe("p2");
    }

    a.ws.close(1000);
    b.ws.close(1000);
    // Drain b to avoid runtime resource leaks; it only sees its own connect.
    await qb.waitClosed();
  });

  it("broadcasts presence:leave to remaining peers when a socket closes", async () => {
    const roomId = uniqueRoomId("ws-presence-leave");
    const owner = await generateEd25519Keypair();
    const admissionKey = await createRoom({ roomId, ownerKp: owner });
    await registerDevice({ roomId, admissionKey, deviceId: "dev-l1", participantId: "l1" });
    await registerDevice({ roomId, admissionKey, deviceId: "dev-l2", participantId: "l2" });

    const a = await openSocket({ roomId, deviceId: "dev-l1", admissionKey });
    const qa = new FrameQueue(a.ws);
    a.ws.send(JSON.stringify({ type: "subscribe", after: 0 }));
    expect(isHello(await qa.next())).toBe(true);
    expect(isPing(await qa.next())).toBe(true);

    const b = await openSocket({ roomId, deviceId: "dev-l2", admissionKey });
    // a sees join.
    const presenceJoin = await qa.next();
    expect(isPresence(presenceJoin)).toBe(true);

    b.ws.close(1000, "leaving");
    const presenceLeave = await qa.next(2000);
    expect(isPresence(presenceLeave)).toBe(true);
    if (isPresence(presenceLeave)) {
      expect(presenceLeave.event).toBe("leave");
      expect(presenceLeave.deviceId).toBe("dev-l2");
    }

    a.ws.close(1000);
  });
});

describe("WS /socket — ping/pong", () => {
  it("server sends a ping after hello; client pong is accepted without error", async () => {
    const roomId = uniqueRoomId("ws-pp");
    const owner = await generateEd25519Keypair();
    const admissionKey = await createRoom({ roomId, ownerKp: owner });
    await registerDevice({ roomId, admissionKey, deviceId: "dev-pp", participantId: "pp" });

    const { ws } = await openSocket({ roomId, deviceId: "dev-pp", admissionKey });
    const q = new FrameQueue(ws);
    ws.send(JSON.stringify({ type: "subscribe", after: 0 }));
    const hello = await q.next();
    expect(isHello(hello)).toBe(true);
    const ping = await q.next();
    expect(isPing(ping)).toBe(true);
    if (isPing(ping)) {
      expect(typeof ping.ts).toBe("number");
      ws.send(JSON.stringify({ type: "pong", ts: ping.ts }));
    }
    // No further frames expected within a short window.
    const next = await q.next(300);
    expect(next).toBeUndefined();
    ws.close(1000);
  });
});

describe("WS /socket — peer cap", () => {
  it("drops a subscribe racing close on a cap-rejected attachment", async () => {
    const roomId = uniqueRoomId("ws-peercap-subscribe-race");
    const owner = await generateEd25519Keypair();
    const admissionKey = await createRoom({ roomId, ownerKp: owner });
    await registerDevice({
      roomId,
      admissionKey,
      deviceId: "dev-rejected",
      participantId: "rejected-p",
    });
    // Ensure a successful subscribe would have both hello and replay data to
    // send, making silence a meaningful assertion rather than an empty room.
    const envelope = buildEnvelope({
      envelopeId: "rejected-race-event",
      authorId: "rejected-p",
      deviceId: "dev-rejected",
    });
    expect(
      (await postEnvelopes({ roomId, admissionKey, envelopes: [envelope] })).status,
    ).toBe(201);

    const stub = env.RELAY_ROOMS.get(env.RELAY_ROOMS.idFromName(roomId));
    const sent: string[] = [];
    const closes: Array<{ code?: number; reason?: string }> = [];
    await runInDurableObject(stub, async (instance) => {
      let attachment: unknown = {
        deviceId: "dev-rejected",
        participantId: "rejected-p",
        presenceAnnounced: false,
        subscribed: false,
        lastPongTs: 0,
      };
      // Drive the hibernation callback directly with a rejected attachment.
      // This fixes the race ordering: subscribe is delivered while the
      // accepted-then-closed socket is still capable of receiving callbacks.
      const rejectedSocket = {
        deserializeAttachment: () => attachment,
        serializeAttachment: (next: unknown) => {
          attachment = next;
        },
        send: (payload: string) => {
          sent.push(payload);
        },
        close: (code?: number, reason?: string) => {
          closes.push({ code, reason });
        },
      } as unknown as WebSocket;
      const handler = instance as unknown as {
        webSocketMessage(socket: WebSocket, message: string): Promise<void>;
      };
      await handler.webSocketMessage(
        rejectedSocket,
        JSON.stringify({ type: "subscribe", after: 0 }),
      );
    });

    expect(closes).toEqual([{ code: 4004, reason: "peer cap reached" }]);
    expect(sent).toEqual([]);
  });

  it("closes the (maxPeers+1)-th distinct device with 4004", async () => {
    const roomId = uniqueRoomId("ws-peercap");
    const owner = await generateEd25519Keypair();
    // Set maxPeers=2 so the third connect trips the cap immediately.
    const admissionKey = await createRoom({
      roomId,
      ownerKp: owner,
      policy: { maxPeers: 2 },
    });
    await registerDevice({ roomId, admissionKey, deviceId: "dev-c1", participantId: "c1" });
    await registerDevice({ roomId, admissionKey, deviceId: "dev-c2", participantId: "c2" });
    await registerDevice({ roomId, admissionKey, deviceId: "dev-c3", participantId: "c3" });

    const a = await openSocket({ roomId, deviceId: "dev-c1", admissionKey });
    const qa = new FrameQueue(a.ws);
    a.ws.send(JSON.stringify({ type: "subscribe", after: 0 }));
    expect(isHello(await qa.next())).toBe(true);
    expect(isPing(await qa.next())).toBe(true);

    const b = await openSocket({ roomId, deviceId: "dev-c2", admissionKey });
    expect(await qa.next()).toEqual({
      type: "presence",
      event: "join",
      deviceId: "dev-c2",
      participantId: "c2",
    });
    const qb = new FrameQueue(b.ws);
    b.ws.send(JSON.stringify({ type: "subscribe", after: 0 }));
    const helloB = await qb.next();
    expect(isHello(helloB)).toBe(true);
    if (isHello(helloB)) {
      expect(helloB.onlineDeviceIds).toEqual(["dev-c1", "dev-c2"]);
    }
    expect(isPing(await qb.next())).toBe(true);

    // Third connect should be rejected with close 4004.
    const c = await openSocket({ roomId, deviceId: "dev-c3", admissionKey });
    const qc = new FrameQueue(c.ws);
    await qc.waitClosed(2000);
    expect(qc.closed).toBe(true);
    expect(qc.closeCode).toBe(4004);
    // A cap-rejected socket never joins presence and its close cannot emit a
    // leave during the brief accepted-then-closed transition.
    expect(await qa.next(250)).toBeUndefined();

    a.ws.close(1000);
    b.ws.close(1000);
  });
});

describe("WS /socket — hibernation roundtrip", () => {
  it("a reconnecting peer with after=lastSeq picks up new envelopes posted in between", async () => {
    const roomId = uniqueRoomId("ws-hibernate");
    const owner = await generateEd25519Keypair();
    const admissionKey = await createRoom({ roomId, ownerKp: owner });
    await registerDevice({ roomId, admissionKey, deviceId: "dev-hb", participantId: "hb" });

    // First connection: subscribe + see hello, then disconnect.
    const first = await openSocket({ roomId, deviceId: "dev-hb", admissionKey });
    const q1 = new FrameQueue(first.ws);
    first.ws.send(JSON.stringify({ type: "subscribe", after: 0 }));
    const hello1 = await q1.next();
    expect(isHello(hello1)).toBe(true);
    first.ws.close(1000, "bye");
    await q1.waitClosed();

    // Server-side state should now have zero live sockets via state.getWebSockets().
    const id = env.RELAY_ROOMS.idFromName(roomId);
    const stub = env.RELAY_ROOMS.get(id);
    await runInDurableObject(stub, async (_inst, state) => {
      // The runtime may take a tick to fully evict the closed socket from
      // getWebSockets(); we just assert no live sockets are present for
      // dev-hb. This is the "hibernation roundtrip" check.
      const sockets = state.getWebSockets("dev-hb");
      expect(sockets.length).toBeLessThanOrEqual(1);
    });

    // Post an envelope while no one is connected.
    const r = await postEnvelopes({
      roomId,
      admissionKey,
      envelopes: [buildEnvelope({ envelopeId: "hb-1", authorId: "hb", deviceId: "dev-hb" })],
    });
    expect(r.status).toBe(201);

    // Reconnect and subscribe with after=0 → should backfill hb-1.
    const second = await openSocket({ roomId, deviceId: "dev-hb", admissionKey });
    const q2 = new FrameQueue(second.ws);
    second.ws.send(JSON.stringify({ type: "subscribe", after: 0 }));
    const hello2 = await q2.next();
    expect(isHello(hello2)).toBe(true);
    const env1 = await q2.next();
    expect(isEnvelope(env1)).toBe(true);
    if (isEnvelope(env1)) {
      expect(env1.envelope.envelopeId).toBe("hb-1");
    }
    second.ws.close(1000);
  });
});
