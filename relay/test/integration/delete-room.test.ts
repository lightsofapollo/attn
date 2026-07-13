/**
 * Integration coverage for `DELETE /v2/rooms/:roomId` (attn-nnj.5.10).
 *
 * Spec: planning/collab/relay-spec.md §DELETE /v2/rooms/:roomId
 *   - Requires admission HMAC + Attn-PoW + Attn-Owner-Signature (every layer).
 *   - Closes live WebSockets with code 4001.
 *   - Wipes all DO storage keys.
 *   - Schedules R2 blob cleanup (best-effort).
 *   - Response: 204 No Content.
 *
 * Test surface:
 *   1. Happy path: owner with valid sig + PoW + admission → 204; subsequent GET
 *      on devices returns 404 (room state is gone).
 *   2. Missing admission → 401 ATTN_ADMISSION_INVALID.
 *   3. Missing PoW → 400 ATTN_POW_INVALID.
 *   4. Missing owner-sig → 403 ATTN_OWNER_SIG_REQUIRED.
 *   5. Wrong owner-sig (signed by a reviewer's key) → 403 ATTN_OWNER_SIG_INVALID.
 *   6. After delete: a live WS client observes close 4001.
 *   7. After delete: a subsequent envelope POST → 404 ATTN_ROOM_NOT_FOUND.
 *   8. After delete: subsequent GET /devices → 404.
 *   9. R2 cleanup: pre-write some blobs under rooms/<roomId>/, delete, verify
 *      every blob is gone from the bucket.
 *  10. Delete on a never-created room → 404 (no owner-sig leak).
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

function roomTestIp(roomId: string): string {
  let hash = 0;
  for (const byte of new TextEncoder().encode(roomId)) hash = (hash * 33 + byte) >>> 0;
  return `198.51.${(hash >>> 8) & 0xff}.${(hash & 0xfe) + 1}`;
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
      "CF-Connecting-IP": roomTestIp(opts.roomId),
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

async function mintDeletePow(roomId: string, deviceId: string): Promise<string> {
  return mintPowForTests({
    roomId,
    deviceId,
    method: "DELETE",
    path: `/v2/rooms/${roomId}`,
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
      "CF-Connecting-IP": roomTestIp(opts.roomId),
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

// --- envelope helper (only the bits we need) -----------------------------

interface BuildEnvelopeInput {
  envelopeId: string;
  authorId: string;
  deviceId: string;
  ciphertextBytes?: number;
}

function buildEnvelope(input: BuildEnvelopeInput): EnvelopeInput {
  const ciphertextBytes = input.ciphertextBytes ?? 32;
  const bytes = new Uint8Array(ciphertextBytes);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7 + 1) & 0xff;
  const ciphertext = base64UrlEncode(bytes);
  const nonce = base64UrlEncode(new Uint8Array(24).fill(0x77));
  return {
    envelopeId: input.envelopeId,
    authorId: input.authorId,
    deviceId: input.deviceId,
    kind: "event",
    target: null,
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
}): Promise<Response> {
  const url = `${URL_BASE}/v2/rooms/${opts.roomId}/envelopes`;
  const body = JSON.stringify({ envelopes: [opts.envelope] });
  const adm = await admissionHeaderFor({
    method: "POST",
    url,
    body,
    admissionKey: opts.admissionKey,
  });
  const pow = await mintEnvelopePow(opts.roomId, opts.envelope.deviceId);
  return SELF.fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Attn-Admission": adm,
      "Attn-PoW": pow,
    },
    body,
  });
}

// --- delete-request builder ----------------------------------------------

interface DeleteRoomOpts {
  roomId: string;
  admissionKey: Uint8Array;
  /** Device whose key signs Attn-Owner-Signature (when ownerSig.privateKey present). */
  ownerSig?: { privateKey: CryptoKey };
  /** DeviceId embedded in the PoW token resource. Defaults to "dev-own". */
  powDeviceId?: string;
  omitAdmission?: boolean;
  omitPow?: boolean;
  omitOwnerSig?: boolean;
  origin?: string;
}

async function deleteRoom(opts: DeleteRoomOpts): Promise<Response> {
  const url = `${URL_BASE}/v2/rooms/${opts.roomId}`;
  const headers: Record<string, string> = {};
  if (!opts.omitAdmission) {
    headers["Attn-Admission"] = await admissionHeaderFor({
      method: "DELETE",
      url,
      admissionKey: opts.admissionKey,
    });
  }
  if (!opts.omitPow) {
    headers["Attn-PoW"] = await mintDeletePow(
      opts.roomId,
      opts.powDeviceId ?? "dev-own",
    );
  }
  if (!opts.omitOwnerSig && opts.ownerSig !== undefined) {
    const signing = new Request(url, { method: "DELETE" });
    const canonical = await canonicalRequest(signing, new URL(url).pathname);
    const sig = new Uint8Array(
      await crypto.subtle.sign(
        { name: "Ed25519" },
        opts.ownerSig.privateKey,
        canonical,
      ),
    );
    headers["Attn-Owner-Signature"] = base64UrlEncode(sig);
  }
  if (opts.origin !== undefined) headers.Origin = opts.origin;
  return SELF.fetch(url, { method: "DELETE", headers });
}

// --- DO storage peek ------------------------------------------------------

async function countStorageKeys(roomId: string): Promise<number> {
  const id = env.RELAY_ROOMS.idFromName(roomId);
  const stub = env.RELAY_ROOMS.get(id);
  return runInDurableObject(stub, async (_inst, state) => {
    const all = await state.storage.list();
    return all.size;
  });
}

async function listR2Keys(prefix: string): Promise<string[]> {
  const listed = await env.RELAY_BLOBS.list({ prefix });
  return listed.objects.map((o) => o.key);
}

interface ErrorResponse {
  error: { code: string; message: string };
}

// --- WS helper for the close-4001 test ----------------------------------

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
  if (ws === null) throw new Error(`WS upgrade failed: ${res.status}`);
  ws.accept();
  return { ws, response: res };
}

/**
 * Collect frames + close events off a WebSocket. Mirrors the helper in
 * websocket.test.ts; copied here so this file stays self-contained.
 */
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

// --- tests ---------------------------------------------------------------

describe("DELETE /v2/rooms/:roomId — happy path", () => {
  it("returns 204 with admission + PoW + owner-sig, then wipes the DO", async () => {
    const roomId = uniqueRoomId("del-happy");
    const ownerKp = await generateEd25519Keypair();
    const admissionKey = await createRoom({
      roomId,
      ownerKp,
      policy: { allowBrowser: true },
    });
    await registerDevice({
      roomId,
      admissionKey,
      deviceId: "dev-own",
      participantId: "owner",
      kind: "owner",
      keypair: ownerKp,
    });

    const before = await countStorageKeys(roomId);
    expect(before).toBeGreaterThan(0);

    const res = await deleteRoom({
      roomId,
      admissionKey,
      ownerSig: { privateKey: ownerKp.privateKey },
      origin: "https://staging.attn.sh",
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://staging.attn.sh");

    // DO storage should be empty.
    const after = await countStorageKeys(roomId);
    expect(after).toBe(0);

    // A subsequent GET /devices should now 404 — the room is gone.
    const getUrl = `${URL_BASE}/v2/rooms/${roomId}/devices`;
    const adm = await admissionHeaderFor({
      method: "GET",
      url: getUrl,
      admissionKey,
    });
    const getRes = await SELF.fetch(getUrl, {
      method: "GET",
      headers: { "Attn-Admission": adm },
    });
    expect(getRes.status).toBe(404);
    const err = (await getRes.json()) as ErrorResponse;
    expect(err.error.code).toBe("ATTN_ROOM_NOT_FOUND");
  });
});

describe("DELETE /v2/rooms/:roomId — admission required", () => {
  it("returns 401 ATTN_ADMISSION_INVALID when Attn-Admission is missing", async () => {
    const roomId = uniqueRoomId("del-no-adm");
    const ownerKp = await generateEd25519Keypair();
    const admissionKey = await createRoom({
      roomId,
      ownerKp,
    });
    await registerDevice({
      roomId,
      admissionKey,
      deviceId: "dev-own",
      participantId: "owner",
      kind: "owner",
      keypair: ownerKp,
    });
    const res = await deleteRoom({
      roomId,
      admissionKey,
      ownerSig: { privateKey: ownerKp.privateKey },
      omitAdmission: true,
    });
    expect(res.status).toBe(401);
    const err = (await res.json()) as ErrorResponse;
    expect(err.error.code).toBe("ATTN_ADMISSION_INVALID");

    // Room must still exist.
    expect(await countStorageKeys(roomId)).toBeGreaterThan(0);
  });
});

describe("DELETE /v2/rooms/:roomId — PoW required", () => {
  it.each([
    ["unsafe", "dev|unsafe", "ATTN_IDENTIFIER_INVALID"],
    ["unknown", "dev-unknown", "ATTN_DEVICE_UNREGISTERED"],
  ] as const)("rejects an %s PoW device before rate/replay mutation", async (_label, powDeviceId, code) => {
    const roomId = uniqueRoomId("del-invalid-device");
    const ownerKp = await generateEd25519Keypair();
    const admissionKey = await createRoom({ roomId, ownerKp });
    await registerDevice({
      roomId,
      admissionKey,
      deviceId: "dev-own",
      participantId: "owner",
      kind: "owner",
      keypair: ownerKp,
    });
    const stub = env.RELAY_ROOMS.get(env.RELAY_ROOMS.idFromName(roomId));
    const before = await runInDurableObject(stub, async (_instance, state) =>
      new Map(await state.storage.list()),
    );
    const response = await deleteRoom({
      roomId,
      admissionKey,
      ownerSig: ownerKp,
      powDeviceId,
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(code);
    expect(await runInDurableObject(stub, async (_instance, state) =>
      new Map(await state.storage.list()),
    )).toEqual(before);
  });

  it("returns 400 ATTN_POW_INVALID when Attn-PoW is missing", async () => {
    const roomId = uniqueRoomId("del-no-pow");
    const ownerKp = await generateEd25519Keypair();
    const admissionKey = await createRoom({
      roomId,
      ownerKp,
    });
    await registerDevice({
      roomId,
      admissionKey,
      deviceId: "dev-own",
      participantId: "owner",
      kind: "owner",
      keypair: ownerKp,
    });

    const res = await deleteRoom({
      roomId,
      admissionKey,
      ownerSig: { privateKey: ownerKp.privateKey },
      omitPow: true,
    });
    expect(res.status).toBe(400);
    const err = (await res.json()) as ErrorResponse;
    expect(err.error.code).toBe("ATTN_POW_INVALID");
    expect(await countStorageKeys(roomId)).toBeGreaterThan(0);
  });
});

describe("DELETE /v2/rooms/:roomId — owner signature required", () => {
  it("returns 403 ATTN_OWNER_SIG_REQUIRED when the header is absent", async () => {
    const roomId = uniqueRoomId("del-no-sig");
    const ownerKp = await generateEd25519Keypair();
    const admissionKey = await createRoom({
      roomId,
      ownerKp,
    });
    await registerDevice({
      roomId,
      admissionKey,
      deviceId: "dev-own",
      participantId: "owner",
      kind: "owner",
      keypair: ownerKp,
    });

    const res = await deleteRoom({
      roomId,
      admissionKey,
      // ownerSig omitted entirely
    });
    expect(res.status).toBe(403);
    const err = (await res.json()) as ErrorResponse;
    expect(err.error.code).toBe("ATTN_OWNER_SIG_REQUIRED");
    expect(await countStorageKeys(roomId)).toBeGreaterThan(0);
  });

  it("returns 403 ATTN_OWNER_SIG_INVALID when the signature is by a non-owner key", async () => {
    const roomId = uniqueRoomId("del-bad-sig");
    const ownerKp = await generateEd25519Keypair();
    const reviewerKp = await generateEd25519Keypair();
    const admissionKey = await createRoom({
      roomId,
      ownerKp,
    });
    await registerDevice({
      roomId,
      admissionKey,
      deviceId: "dev-own",
      participantId: "owner",
      kind: "owner",
      keypair: ownerKp,
    });
    // Sign with reviewer's key — it has a valid Ed25519 sig shape but doesn't
    // match the stored ownerSigningKey.
    const res = await deleteRoom({
      roomId,
      admissionKey,
      ownerSig: { privateKey: reviewerKp.privateKey },
    });
    expect(res.status).toBe(403);
    const err = (await res.json()) as ErrorResponse;
    expect(err.error.code).toBe("ATTN_OWNER_SIG_INVALID");

    // Room must still exist — failed sig leaves storage untouched.
    expect(await countStorageKeys(roomId)).toBeGreaterThan(0);
  });
});

describe("DELETE /v2/rooms/:roomId — closes live WS clients with 4001", () => {
  it("a connected peer receives close code 4001 (room deleted) on DELETE", async () => {
    const roomId = uniqueRoomId("del-ws");
    const ownerKp = await generateEd25519Keypair();
    const admissionKey = await createRoom({
      roomId,
      ownerKp,
    });
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
    void reviewer;

    // Open a live WS as the reviewer; subscribe so we land in the steady-state
    // hibernation path.
    const { ws } = await openSocket({
      roomId,
      deviceId: "dev-rev",
      admissionKey,
    });
    const q = new FrameQueue(ws);
    ws.send(JSON.stringify({ type: "subscribe", after: 0 }));
    const hello = await q.next();
    expect(hello).toBeDefined();
    expect((hello as { type?: string }).type).toBe("hello");

    // Owner deletes the room.
    const del = await deleteRoom({
      roomId,
      admissionKey,
      ownerSig: { privateKey: ownerKp.privateKey },
    });
    expect(del.status).toBe(204);

    // The reviewer's socket should now observe close 4001.
    await q.waitClosed(3000);
    expect(q.closed).toBe(true);
    expect(q.closeCode).toBe(4001);
  });
});

describe("DELETE /v2/rooms/:roomId — post-delete state", () => {
  it("returns 404 ATTN_ROOM_NOT_FOUND on a subsequent envelope POST", async () => {
    const roomId = uniqueRoomId("del-then-post");
    const ownerKp = await generateEd25519Keypair();
    const admissionKey = await createRoom({
      roomId,
      ownerKp,
    });
    const reviewer = await registerDevice({
      roomId,
      admissionKey,
      deviceId: "dev-rev",
      participantId: "reviewer",
      kind: "reviewer",
    });
    await registerDevice({
      roomId,
      admissionKey,
      deviceId: "dev-own",
      participantId: "owner",
      kind: "owner",
      keypair: ownerKp,
    });

    // Post one envelope so we know the path works pre-delete.
    const pre = await postEnvelope({
      roomId,
      admissionKey,
      envelope: buildEnvelope({
        envelopeId: "env-pre",
        authorId: reviewer.participantId,
        deviceId: reviewer.deviceId,
      }),
    });
    expect(pre.status).toBe(201);

    // Delete.
    const del = await deleteRoom({
      roomId,
      admissionKey,
      ownerSig: { privateKey: ownerKp.privateKey },
    });
    expect(del.status).toBe(204);

    // Subsequent envelope ingest → 404; the DO has no admissionKey anymore.
    const post = await postEnvelope({
      roomId,
      admissionKey,
      envelope: buildEnvelope({
        envelopeId: "env-post",
        authorId: reviewer.participantId,
        deviceId: reviewer.deviceId,
      }),
    });
    expect(post.status).toBe(404);
    const err = (await post.json()) as ErrorResponse;
    expect(err.error.code).toBe("ATTN_ROOM_NOT_FOUND");
  });

  it("returns 404 on a DELETE against a never-created room", async () => {
    const roomId = uniqueRoomId("del-never");
    const ownerKp = await generateEd25519Keypair();
    // Build a synthetic admission key (no room exists, so the relay's stored
    // key won't match anything — we still expect 404, not 401, since the
    // existence check runs first).
    const admissionKey = makeAdmissionKey(0x42);

    const res = await deleteRoom({
      roomId,
      admissionKey,
      ownerSig: { privateKey: ownerKp.privateKey },
    });
    expect(res.status).toBe(404);
    const err = (await res.json()) as ErrorResponse;
    expect(err.error.code).toBe("ATTN_ROOM_NOT_FOUND");
  });
});

describe("DELETE /v2/rooms/:roomId — R2 cleanup", () => {
  it("deletes every blob under rooms/<roomId>/ after a successful DELETE", async () => {
    const roomId = uniqueRoomId("del-r2");
    const ownerKp = await generateEd25519Keypair();
    const admissionKey = await createRoom({
      roomId,
      ownerKp,
    });
    await registerDevice({
      roomId,
      admissionKey,
      deviceId: "dev-own",
      participantId: "owner",
      kind: "owner",
      keypair: ownerKp,
    });

    // Pre-write a few R2 blobs under the room's prefix. The 5.x blob endpoint
    // isn't wired here yet — we exercise the cleanup path directly via the
    // bucket binding so the DELETE handler has something to sweep.
    const prefix = `rooms/${roomId}/`;
    const keys = [
      `${prefix}snapshots/blob-a`,
      `${prefix}snapshots/blob-b`,
      `${prefix}blobs/env-1`,
    ];
    for (const k of keys) {
      await env.RELAY_BLOBS.put(k, new Uint8Array([0x11, 0x22, 0x33]));
    }
    // Sanity: every key is listed before the delete.
    const listedBefore = await listR2Keys(prefix);
    expect(listedBefore.sort()).toEqual([...keys].sort());

    // Delete the room.
    const del = await deleteRoom({
      roomId,
      admissionKey,
      ownerSig: { privateKey: ownerKp.privateKey },
    });
    expect(del.status).toBe(204);

    // R2 should now have zero objects under the room's prefix.
    const listedAfter = await listR2Keys(prefix);
    expect(listedAfter).toEqual([]);
  });
});

// Silence unused-import lint — base64UrlDecode is exported by admission.ts and
// imported for parity with sibling integration suites even though this file
// does not decode any inbound bytes directly.
void base64UrlDecode;
