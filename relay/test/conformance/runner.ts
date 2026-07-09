/**
 * Conformance scenario runner — Miniflare/TS side.
 *
 * Interprets `cases.json` against the Worker via `SELF.fetch`. The same JSON
 * is replayed by the Rust client in attn-nnj.6.7; both runners must produce
 * the same outcomes (status, body shape, WS frames) for every scenario.
 *
 * Design notes:
 *
 * - Crypto material (Ed25519 keypairs, HMAC keys, PoW nonces) is materialized
 *   at replay time from deterministic per-scenario seeds. The corpus never
 *   carries opaque hex blobs — that keeps `cases.json` readable and survives
 *   future key-format changes.
 *
 * - Each scenario gets its own room id (suffixed with a counter + timestamp
 *   so DO storage from prior runs never collides) and its own symbol table.
 *   Logical names like `as: "owner"` resolve through the table to the
 *   freshly-minted identifier.
 *
 * - The runner deliberately keeps the action set thin: every action is a
 *   single HTTP request (or a single WS verb). Higher-level conveniences
 *   (helper "register owner + reviewer" macros) belong in test files, not
 *   the corpus.
 */

import { SELF, env, runInDurableObject } from "cloudflare:test";
import { expect } from "vitest";

import { base64UrlEncode, canonicalRequest } from "../../src/admission";
import { canonicalize, type CanonicalValue } from "../../src/canonical";
import type { Env } from "../../src/env";
import { presignBlobDownload } from "../../src/r2";
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

// --- corpus types (mirror cases.json) -----------------------------------

export interface Corpus {
  version: number;
  description?: string;
  scenarios: Scenario[];
}

export interface Scenario {
  id: string;
  name: string;
  spec?: string;
  tags?: string[];
  requires?: string[];
  /** When true, the runner skips execution (replay.test.ts emits `it.skip`). */
  skip?: boolean;
  /** Human-readable rationale surfaced in the skip label. */
  skipReason?: string;
  steps: Step[];
}

export type Step =
  | CreateRoomStep
  | RecreateRoomStep
  | RegisterDeviceStep
  | ListDevicesStep
  | PostEnvelopesStep
  | PostAcksStep
  | DeleteRoomStep
  | OpenSocketStep
  | SendFrameStep
  | ExpectFrameStep
  | ExpectCloseStep
  | CloseSocketStep
  | SleepStep
  | AdvanceMockClockStep
  | SeedR2BlobStep
  | ListR2Step
  | ExpectStorageStateStep
  | BumpStorageStep
  | RewindStorageStep
  | FireAlarmStep
  | PresignBlobStep
  | PutBlobStep
  | GetBlobStep;

interface BaseStep {
  /** Optional human-readable label that the runner echoes on failure. */
  label?: string;
}

interface CreateRoomStep extends BaseStep {
  action: "createRoom";
  /** Logical room handle ("room1", "owner-room", etc). */
  as: string;
  params: {
    policy?: Partial<RoomPolicy>;
    /** Omit the admission header (default behavior for first POST). */
    omitAdmission?: boolean;
    /** Use a freshly-minted admission key instead of the room's stored one. */
    badAdmission?: boolean;
    /** Skip Attn-Owner-Signature entirely (negative path — H1 requirement). */
    omitOwnerSig?: boolean;
    /** Sign canonicalRequest with a non-owner key (negative path). */
    badOwnerSig?: boolean;
  };
  expect: ExpectResponse;
}

interface RecreateRoomStep extends BaseStep {
  action: "recreateRoom";
  in: string;
  params: {
    policy?: Partial<RoomPolicy>;
    omitAdmission?: boolean;
    badAdmission?: boolean;
    /** Whether to attach Attn-Owner-Signature. Rejoin path doesn't require it,
     * so this defaults to true (we still attach for parity with `share`). */
    omitOwnerSig?: boolean;
  };
  expect: ExpectResponse;
}

interface RegisterDeviceStep extends BaseStep {
  action: "registerDevice";
  in: string;
  /** Logical device handle ("owner", "reviewer-1", "agent-cli-1", etc). */
  as: string;
  params: {
    participantId: string;
    kind?: "owner" | "reviewer" | "agent";
    client?: "attn-native" | "attn-browser" | "agent-cli";
    /** Use the room's owner keypair instead of minting a fresh one (required for kind=owner). */
    useOwnerKeypair?: boolean;
    /** Inject a wrong-key selfSignature for the negative path. */
    forgedSelfSig?: boolean;
    /** Use a different PoW difficulty than the policy. */
    powBitsOverride?: number;
    /** Override expiresAt for the PoW token (e.g. -1 for expired). */
    powExpiresAtDelta?: number;
    /** Bind the PoW to a different path than the request. */
    powPathOverride?: string;
    /** Skip Attn-PoW entirely. */
    omitPow?: boolean;
    /** Skip Attn-Admission entirely. */
    omitAdmission?: boolean;
    /** Re-use a previously-minted PoW token (replay attack). */
    replayLastPow?: boolean;
  };
  expect: ExpectResponse;
}

interface ListDevicesStep extends BaseStep {
  action: "listDevices";
  in: string;
  expect: ExpectResponse;
}

interface PostEnvelopesStep extends BaseStep {
  action: "postEnvelopes";
  in: string;
  /** Device the PoW token + admission attach to. */
  from: string;
  params: {
    envelopes: EnvelopeSpec[];
    omitAdmission?: boolean;
    omitPow?: boolean;
  };
  expect: ExpectResponse;
}

export interface EnvelopeSpec {
  envelopeId: string;
  /** Authoring participantId (resolved via the device's registered participantId). */
  authorDevice: string;
  kind?: "event" | "snapshot_blob" | "signal";
  /** Target device handle for signal envelopes. */
  target?: string | null;
  ciphertextBytes?: number;
  /** Use a wrong ciphertext-length declaration. */
  tamperCiphertextLength?: boolean;
}

interface PostAcksStep extends BaseStep {
  action: "postAcks";
  in: string;
  from: string;
  params: {
    envelopeIds: string[];
    /** Use the named device's keypair as owner-sig. */
    ownerSigFrom?: string;
    omitAdmission?: boolean;
    omitPow?: boolean;
  };
  expect: ExpectResponse;
}

interface DeleteRoomStep extends BaseStep {
  action: "deleteRoom";
  in: string;
  params: {
    /** Device whose keypair should sign the owner-sig header. */
    ownerSigFrom?: string;
    omitAdmission?: boolean;
    omitPow?: boolean;
    omitOwnerSig?: boolean;
  };
  expect: ExpectResponse;
}

interface OpenSocketStep extends BaseStep {
  action: "openSocket";
  in: string;
  /** Device handle this socket belongs to. */
  from: string;
  /** Logical socket handle ("sock-a", "sock-reviewer", etc). */
  as: string;
  params?: {
    badHmac?: boolean;
    omitProtocol?: boolean;
  };
  expect?: {
    status?: number;
    errorCode?: string;
  };
}

interface SendFrameStep extends BaseStep {
  action: "sendFrame";
  socket: string;
  frame: Record<string, unknown>;
}

interface ExpectFrameStep extends BaseStep {
  action: "expectFrame";
  socket: string;
  /** Wait this many ms for the frame. Default 2000. */
  timeoutMs?: number;
  /** Drain through any frame types in this set before matching. */
  ignore?: string[];
  frame: FrameExpectation;
}

interface FrameExpectation {
  type: "hello" | "envelope" | "error" | "presence" | "ping";
  /** Exact-string match for `type=error` codes. */
  code?: string;
  /** Logical envelopeId from the symbol table (resolves to the wire value). */
  envelopeId?: string;
  /** Min seq (so we don't pin exact values across runs). */
  serverSeqAtLeast?: number;
  /** For hello frames: assert serverSeq value. */
  serverSeq?: number;
  /** For presence frames. */
  event?: "join" | "leave";
  deviceId?: string;
  /** For error frames: assert resyncFromSeq presence. */
  hasResyncFromSeq?: boolean;
}

interface ExpectCloseStep extends BaseStep {
  action: "expectClose";
  socket: string;
  code: number;
  /** Wait this many ms for the close. Default 3000. */
  timeoutMs?: number;
}

interface CloseSocketStep extends BaseStep {
  action: "closeSocket";
  socket: string;
  /** Optional client-side close code (default 1000). */
  code?: number;
}

interface SleepStep extends BaseStep {
  action: "sleep";
  ms: number;
}

interface AdvanceMockClockStep extends BaseStep {
  action: "advanceMockClock";
  in: string;
  ms: number;
  /** When true, also force the DO alarm to fire after advancing. */
  fireAlarm?: boolean;
}

interface SeedR2BlobStep extends BaseStep {
  action: "seedR2Blob";
  in: string;
  /** Key suffix under `rooms/<roomId>/`. */
  key: string;
  /** Decoded byte length to fill with deterministic bytes. */
  bytes: number;
}

interface ListR2Step extends BaseStep {
  action: "listR2";
  in: string;
  /** Suffix under `rooms/<roomId>/`. */
  prefix: string;
  expect: {
    keys?: string[];
    countAtLeast?: number;
    countExactly?: number;
  };
}

interface ExpectStorageStateStep extends BaseStep {
  action: "expectStorageState";
  in: string;
  expect: {
    envelopeCountExactly?: number;
    bytesUsedExactly?: number;
    oldestRetainedSeqAtLeast?: number;
    serverSeqAtLeast?: number;
    hasEnvIdx?: string[];
    missingEnvIdx?: string[];
    hasOwnerAckMarker?: string[];
    hasAckSlot?: Array<{ device: string; envelopeId: string }>;
  };
}

interface BumpStorageStep extends BaseStep {
  action: "bumpStorage";
  in: string;
  /** Full DO storage key (e.g. `meta:bytes_used`). */
  key: string;
  /** New value to write — replaces any existing value. */
  value: number;
}

interface RewindStorageStep extends BaseStep {
  action: "rewindStorage";
  in: string;
  /** Full DO storage key (e.g. `meta:hard_max_at`). */
  key: string;
  /** Subtract this many ms from the current value (must already exist). */
  deltaMs: number;
}

interface FireAlarmStep extends BaseStep {
  action: "fireAlarm";
  in: string;
}

interface PresignBlobStep extends BaseStep {
  action: "presignBlob";
  in: string;
  from: string;
  /** Logical handle to bind the presign result to (defaults to envelopeId). */
  as?: string;
  params: {
    envelopeId: string;
    ciphertextBytes: number;
    omitAdmission?: boolean;
    omitPow?: boolean;
  };
  expect: ExpectResponse;
}

interface PutBlobStep extends BaseStep {
  action: "putBlob";
  /** Handle returned by a prior presignBlob step (its envelopeId by default). */
  as: string;
  params: {
    bytes: number;
    /** Send a body shorter/longer than `bytes` for negative paths. */
    bodyBytes?: number;
  };
  expect: ExpectResponse;
}

interface GetBlobStep extends BaseStep {
  action: "getBlob";
  /** Handle bound by a prior presignBlob step. */
  as: string;
  params: {
    /** When set, assert the GET body length matches. */
    expectedBytes?: number;
  };
  expect: ExpectResponse;
}

interface ExpectResponse {
  status: number;
  errorCode?: string;
  bodyShape?: ResponseBodyShape;
}

interface ResponseBodyShape {
  /** Top-level fields and their expected structural shape. */
  serverSeq?: number;
  serverSeqAtLeast?: number;
  expiresAtAtLeast?: number;
  expiresAtAtMost?: number;
  policyMaxPeers?: number;
  policyPowBits?: number;
  policyDeleteEventsAfterOwnerAck?: boolean;
  policyLongSession?: boolean;
  policyIdleTimeoutMsAtLeast?: number;
  policyIdleTimeoutMsAtMost?: number;
  /** For `POST /envelopes` responses. */
  acceptedLength?: number;
  acceptedServerSeqAtLeast?: number;
  acceptedEnvelopeIds?: string[];
  /** For `GET /devices` responses. */
  devicesLength?: number;
  deviceIdsInOrder?: string[];
}

// --- runtime state ------------------------------------------------------

interface Keypair {
  publicKey: CryptoKey;
  privateKey: CryptoKey;
  publicKeyBytes: Uint8Array;
}

interface RoomCtx {
  /** Real wire-level roomId (uniquified). */
  roomId: string;
  admissionKey: Uint8Array;
  ownerKp: Keypair;
  policy: RoomPolicy;
}

interface DeviceCtx {
  roomHandle: string;
  deviceId: string;
  participantId: string;
  kind: "owner" | "reviewer" | "agent";
  kp: Keypair;
}

interface SocketCtx {
  roomHandle: string;
  deviceHandle: string;
  ws: WebSocket;
  response: Response;
  queue: FrameQueue;
}

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

interface BlobCtx {
  roomHandle: string;
  envelopeId: string;
  ciphertextBytes: number;
  leaseId: string;
  /** Worker-side cap URL returned from POST /blobs (relative path). */
  uploadUrl: string;
}

interface ScenarioState {
  rooms: Map<string, RoomCtx>;
  devices: Map<string, DeviceCtx>;
  sockets: Map<string, SocketCtx>;
  /** Presigned upload handles keyed by `as` (defaults to envelopeId). */
  blobs: Map<string, BlobCtx>;
  /** Last-minted PoW token (for replay-attack scenarios). */
  lastPow: string | undefined;
}

// --- crypto helpers -----------------------------------------------------

let roomCounter = 0;

function uniqueRoomId(scenarioId: string, handle: string): string {
  roomCounter += 1;
  return `${scenarioId}-${handle}-${Date.now().toString(36)}-${roomCounter}`;
}

function makeAdmissionKey(seed: number): Uint8Array {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = (seed + i) & 0xff;
  return bytes;
}

async function hmacSha256(
  key: Uint8Array,
  data: Uint8Array,
): Promise<Uint8Array> {
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

/** Build `Attn-Owner-Signature` header value (Ed25519 over canonicalRequest,
 * base64url-encoded). Matches `relay/src/owner-sig.ts`. */
async function ownerSignatureHeaderFor(opts: {
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

async function generateEd25519Keypair(): Promise<Keypair> {
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

let powExpiresAtBump = 0;
function nextPowExpiresAt(delta = 0): number {
  powExpiresAtBump += 1;
  return Date.now() + 5 * 60 * 1000 + powExpiresAtBump + delta;
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
    powBits: 12, // 12 keeps the in-process PoW miner cheap; verifyPow clamps to max(policy, MIN_POW_BITS=12)
    deleteEventsAfterOwnerAck: false,
    allowBrowser: false,
    allowRemoteAgents: false,
    ...overrides,
  };
}

// --- response assertion helpers -----------------------------------------

function describeStep(scenarioId: string, idx: number, step: Step): string {
  const label = step.label !== undefined ? ` (${step.label})` : "";
  return `${scenarioId} step #${idx} action=${step.action}${label}`;
}

async function assertResponse(
  res: Response,
  expect_: ExpectResponse,
  label: string,
): Promise<unknown> {
  const status = res.status;
  if (status !== expect_.status) {
    let bodyTxt = "<unreadable>";
    try {
      bodyTxt = await res.clone().text();
    } catch {
      // ignore
    }
    expect.fail(
      `${label}: expected status ${expect_.status}, got ${status}\n  body: ${bodyTxt}`,
    );
  }
  let body: unknown = undefined;
  if (status === 204) {
    return undefined;
  }
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }

  if (expect_.errorCode !== undefined) {
    const code = (body as { error?: { code?: string } })?.error?.code;
    if (code !== expect_.errorCode) {
      expect.fail(
        `${label}: expected error.code ${expect_.errorCode}, got ${String(code)}\n  body: ${JSON.stringify(body)}`,
      );
    }
  }
  if (expect_.bodyShape !== undefined) {
    assertBodyShape(body, expect_.bodyShape, label);
  }
  return body;
}

function assertBodyShape(
  body: unknown,
  shape: ResponseBodyShape,
  label: string,
): void {
  const obj = (body ?? {}) as Record<string, unknown>;
  if (shape.serverSeq !== undefined) {
    expect(obj.serverSeq, label).toBe(shape.serverSeq);
  }
  if (shape.serverSeqAtLeast !== undefined) {
    expect(typeof obj.serverSeq, label).toBe("number");
    expect(obj.serverSeq as number, label).toBeGreaterThanOrEqual(
      shape.serverSeqAtLeast,
    );
  }
  if (shape.expiresAtAtLeast !== undefined) {
    expect(typeof obj.expiresAt, label).toBe("number");
    expect(obj.expiresAt as number, label).toBeGreaterThanOrEqual(
      shape.expiresAtAtLeast,
    );
  }
  if (shape.expiresAtAtMost !== undefined) {
    expect(typeof obj.expiresAt, label).toBe("number");
    expect(obj.expiresAt as number, label).toBeLessThanOrEqual(
      shape.expiresAtAtMost,
    );
  }
  const policy = (obj.policy ?? {}) as Record<string, unknown>;
  if (shape.policyMaxPeers !== undefined) {
    expect(policy.maxPeers, label).toBe(shape.policyMaxPeers);
  }
  if (shape.policyPowBits !== undefined) {
    expect(policy.powBits, label).toBe(shape.policyPowBits);
  }
  if (shape.policyDeleteEventsAfterOwnerAck !== undefined) {
    expect(policy.deleteEventsAfterOwnerAck, label).toBe(
      shape.policyDeleteEventsAfterOwnerAck,
    );
  }
  if (shape.policyLongSession !== undefined) {
    expect(policy.longSession, label).toBe(shape.policyLongSession);
  }
  if (shape.policyIdleTimeoutMsAtLeast !== undefined) {
    expect(typeof policy.idleTimeoutMs, label).toBe("number");
    expect(policy.idleTimeoutMs as number, label).toBeGreaterThanOrEqual(
      shape.policyIdleTimeoutMsAtLeast,
    );
  }
  if (shape.policyIdleTimeoutMsAtMost !== undefined) {
    expect(typeof policy.idleTimeoutMs, label).toBe("number");
    expect(policy.idleTimeoutMs as number, label).toBeLessThanOrEqual(
      shape.policyIdleTimeoutMsAtMost,
    );
  }
  if (shape.acceptedLength !== undefined) {
    const accepted = obj.accepted as Array<{ serverSeq: number; envelopeId: string }>;
    expect(accepted?.length, label).toBe(shape.acceptedLength);
  }
  if (shape.acceptedServerSeqAtLeast !== undefined) {
    const accepted = obj.accepted as Array<{ serverSeq: number }>;
    expect(accepted, label).toBeDefined();
    for (const a of accepted) {
      expect(a.serverSeq, label).toBeGreaterThanOrEqual(
        shape.acceptedServerSeqAtLeast,
      );
    }
  }
  if (shape.acceptedEnvelopeIds !== undefined) {
    const accepted = obj.accepted as Array<{ envelopeId: string }>;
    const got = accepted.map((a) => a.envelopeId);
    expect(got, label).toEqual(shape.acceptedEnvelopeIds);
  }
  if (shape.devicesLength !== undefined) {
    const devices = obj.devices as DeviceRecord[];
    expect(devices?.length, label).toBe(shape.devicesLength);
  }
  if (shape.deviceIdsInOrder !== undefined) {
    const devices = obj.devices as DeviceRecord[];
    const got = devices.map((d) => d.deviceId);
    expect(got, label).toEqual(shape.deviceIdsInOrder);
  }
}

// --- action handlers ----------------------------------------------------

async function actCreateRoom(
  scenarioId: string,
  state: ScenarioState,
  step: CreateRoomStep,
  stepIdx: number,
): Promise<void> {
  const label = describeStep(scenarioId, stepIdx, step);
  const roomId = uniqueRoomId(scenarioId, step.as);
  const ownerKp = await generateEd25519Keypair();
  const admissionKey = makeAdmissionKey((roomCounter * 11) & 0xff);
  const policy = defaultPolicy(step.params.policy);
  const body = JSON.stringify({
    v: 2,
    policy,
    ownerSigningKey: base64UrlEncode(ownerKp.publicKeyBytes),
    admissionKey: base64UrlEncode(admissionKey),
  });
  const url = `${URL_BASE}/v2/rooms/${roomId}`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (!(step.params.omitAdmission ?? true)) {
    const key = step.params.badAdmission ? makeAdmissionKey(0xfe) : admissionKey;
    headers["Attn-Admission"] = await admissionHeaderFor({
      method: "POST",
      url,
      body,
      admissionKey: key,
    });
  }
  // attn-nnj.5.17 (security-review §H1): first-create requires
  // Attn-Owner-Signature. Default behavior attaches a valid sig signed by
  // the room's owner keypair. `omitOwnerSig` and `badOwnerSig` exist for
  // dedicated negative-path scenarios.
  if (!(step.params.omitOwnerSig ?? false)) {
    const signingKey = step.params.badOwnerSig
      ? (await generateEd25519Keypair()).privateKey
      : ownerKp.privateKey;
    headers["Attn-Owner-Signature"] = await ownerSignatureHeaderFor({
      method: "POST",
      url,
      body,
      privateKey: signingKey,
    });
    // First-create also requires a 12-bit Attn-PoW bound to (roomId,
    // ownerSigningKeyId, POST, /v2/rooms/:roomId). Verified AFTER owner-sig,
    // so it's only attached on the success path (alongside the owner sig).
    headers["Attn-PoW"] = await createPowHeader(roomId, ownerKp.publicKeyBytes);
  }
  const res = await SELF.fetch(url, { method: "POST", headers, body });
  const responseBody = await assertResponse(res, step.expect, label);
  if (res.status === 201 || res.status === 200) {
    state.rooms.set(step.as, {
      roomId,
      admissionKey,
      ownerKp,
      policy: ((responseBody as { policy?: RoomPolicy })?.policy ?? policy),
    });
  }
}

async function actRecreateRoom(
  scenarioId: string,
  state: ScenarioState,
  step: RecreateRoomStep,
  stepIdx: number,
): Promise<void> {
  const label = describeStep(scenarioId, stepIdx, step);
  const room = mustRoom(state, step.in, label);
  const policy = defaultPolicy(step.params.policy);
  const body = JSON.stringify({
    v: 2,
    policy,
    ownerSigningKey: base64UrlEncode(room.ownerKp.publicKeyBytes),
    admissionKey: base64UrlEncode(room.admissionKey),
  });
  const url = `${URL_BASE}/v2/rooms/${room.roomId}`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (!(step.params.omitAdmission ?? false)) {
    const key = step.params.badAdmission ? makeAdmissionKey(0xfe) : room.admissionKey;
    headers["Attn-Admission"] = await admissionHeaderFor({
      method: "POST",
      url,
      body,
      admissionKey: key,
    });
  }
  // Attach Attn-Owner-Signature by default. The relay's rejoin path doesn't
  // require it, but a real client (Rust bootstrapper) attaches it unconditionally
  // — mirroring that behavior keeps the corpus aligned.
  if (!(step.params.omitOwnerSig ?? false)) {
    headers["Attn-Owner-Signature"] = await ownerSignatureHeaderFor({
      method: "POST",
      url,
      body,
      privateKey: room.ownerKp.privateKey,
    });
  }
  const res = await SELF.fetch(url, { method: "POST", headers, body });
  await assertResponse(res, step.expect, label);
}

function mustRoom(
  state: ScenarioState,
  handle: string,
  label: string,
): RoomCtx {
  const r = state.rooms.get(handle);
  if (r === undefined) expect.fail(`${label}: unknown room handle '${handle}'`);
  return r;
}

function mustDevice(
  state: ScenarioState,
  handle: string,
  label: string,
): DeviceCtx {
  const d = state.devices.get(handle);
  if (d === undefined) expect.fail(`${label}: unknown device handle '${handle}'`);
  return d;
}

function mustSocket(
  state: ScenarioState,
  handle: string,
  label: string,
): SocketCtx {
  const s = state.sockets.get(handle);
  if (s === undefined) expect.fail(`${label}: unknown socket handle '${handle}'`);
  return s;
}

async function buildSignedDeviceBody(
  input: {
    deviceId: string;
    participantId: string;
    publicSigningKey: string;
    client?: "attn-native" | "attn-browser" | "agent-cli";
    kind?: "owner" | "reviewer" | "agent";
  },
  privateKey: CryptoKey,
): Promise<string> {
  const unsigned: Record<string, CanonicalValue> = {
    deviceId: input.deviceId,
    participantId: input.participantId,
    publicSigningKey: input.publicSigningKey,
    publicEncryptionKey: base64UrlEncode(new Uint8Array(32).fill(0xa1)),
    client: input.client ?? "attn-native",
    kind: input.kind ?? "reviewer",
  };
  const canonical = new TextEncoder().encode(canonicalize(unsigned));
  const sig = new Uint8Array(
    await crypto.subtle.sign({ name: "Ed25519" }, privateKey, canonical),
  );
  return JSON.stringify({ ...unsigned, selfSignature: base64UrlEncode(sig) });
}

async function actRegisterDevice(
  scenarioId: string,
  state: ScenarioState,
  step: RegisterDeviceStep,
  stepIdx: number,
): Promise<void> {
  const label = describeStep(scenarioId, stepIdx, step);
  const room = mustRoom(state, step.in, label);
  const kind = step.params.kind ?? "reviewer";
  const kp =
    step.params.useOwnerKeypair === true ? room.ownerKp : await generateEd25519Keypair();
  // Sign with the wrong key if forgedSelfSig=true: build the body as if it's
  // the right key but sign with a fresh attacker keypair.
  const sigKp = step.params.forgedSelfSig === true ? await generateEd25519Keypair() : kp;
  const deviceId = step.as;

  const body = await buildSignedDeviceBody(
    {
      deviceId,
      participantId: step.params.participantId,
      publicSigningKey: base64UrlEncode(kp.publicKeyBytes),
      client: step.params.client,
      kind,
    },
    sigKp.privateKey,
  );

  const url = `${URL_BASE}/v2/rooms/${room.roomId}/devices`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (!(step.params.omitAdmission === true)) {
    headers["Attn-Admission"] = await admissionHeaderFor({
      method: "POST",
      url,
      body,
      admissionKey: room.admissionKey,
    });
  }
  if (!(step.params.omitPow === true)) {
    let powToken: string;
    if (step.params.replayLastPow === true && state.lastPow !== undefined) {
      powToken = state.lastPow;
    } else {
      const difficulty = step.params.powBitsOverride ?? Math.max(12, room.policy.powBits);
      const powPath = step.params.powPathOverride ?? `/v2/rooms/${room.roomId}/devices`;
      powToken = await mintPowForTests({
        roomId: room.roomId,
        deviceId,
        method: "POST",
        path: powPath,
        difficulty,
        expiresAt: nextPowExpiresAt(step.params.powExpiresAtDelta ?? 0),
        rand: FIXED_POW_RAND,
      });
      state.lastPow = powToken;
    }
    headers["Attn-PoW"] = powToken;
  }
  const res = await SELF.fetch(url, { method: "POST", headers, body });
  await assertResponse(res, step.expect, label);
  if (res.status === 204) {
    state.devices.set(step.as, {
      roomHandle: step.in,
      deviceId,
      participantId: step.params.participantId,
      kind,
      kp,
    });
  }
}

async function actListDevices(
  scenarioId: string,
  state: ScenarioState,
  step: ListDevicesStep,
  stepIdx: number,
): Promise<void> {
  const label = describeStep(scenarioId, stepIdx, step);
  const room = mustRoom(state, step.in, label);
  const url = `${URL_BASE}/v2/rooms/${room.roomId}/devices`;
  const adm = await admissionHeaderFor({
    method: "GET",
    url,
    admissionKey: room.admissionKey,
  });
  const res = await SELF.fetch(url, {
    method: "GET",
    headers: { "Attn-Admission": adm },
  });
  await assertResponse(res, step.expect, label);
}

function buildEnvelopeFromSpec(
  state: ScenarioState,
  room: RoomCtx,
  spec: EnvelopeSpec,
  label: string,
): EnvelopeInput {
  const author = mustDevice(state, spec.authorDevice, label);
  if (author.roomHandle !== "" && state.rooms.get(author.roomHandle) !== room) {
    // tolerate cross-room — but our scenarios never need this; keep tight
  }
  const ciphertextBytes = spec.ciphertextBytes ?? 32;
  const declaredLen = spec.tamperCiphertextLength === true
    ? ciphertextBytes + 16
    : ciphertextBytes;
  const bytes = new Uint8Array(ciphertextBytes);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 17 + 3) & 0xff;
  const ciphertext = base64UrlEncode(bytes);
  const nonce = base64UrlEncode(new Uint8Array(24).fill(0x33));
  let target: { deviceId: string } | null = null;
  if (spec.target !== null && spec.target !== undefined && spec.target !== "") {
    const tgtDev = mustDevice(state, spec.target, label);
    target = { deviceId: tgtDev.deviceId };
  }
  return {
    envelopeId: spec.envelopeId,
    authorId: author.participantId,
    deviceId: author.deviceId,
    kind: spec.kind ?? "event",
    target,
    createdAt: Date.now(),
    expiresAt: Date.now() + 60 * 60 * 1000,
    nonce,
    ciphertext,
    ciphertextBytes: declaredLen,
  };
}

async function actPostEnvelopes(
  scenarioId: string,
  state: ScenarioState,
  step: PostEnvelopesStep,
  stepIdx: number,
): Promise<void> {
  const label = describeStep(scenarioId, stepIdx, step);
  const room = mustRoom(state, step.in, label);
  const from = mustDevice(state, step.from, label);
  const envelopes = step.params.envelopes.map((s) =>
    buildEnvelopeFromSpec(state, room, s, label),
  );
  const url = `${URL_BASE}/v2/rooms/${room.roomId}/envelopes`;
  const body = JSON.stringify({ envelopes });
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (!(step.params.omitAdmission === true)) {
    headers["Attn-Admission"] = await admissionHeaderFor({
      method: "POST",
      url,
      body,
      admissionKey: room.admissionKey,
    });
  }
  if (!(step.params.omitPow === true)) {
    headers["Attn-PoW"] = await mintPowForTests({
      roomId: room.roomId,
      deviceId: from.deviceId,
      method: "POST",
      path: `/v2/rooms/${room.roomId}/envelopes`,
      difficulty: Math.max(12, room.policy.powBits),
      expiresAt: nextPowExpiresAt(),
      rand: FIXED_POW_RAND,
    });
  }
  const res = await SELF.fetch(url, { method: "POST", headers, body });
  await assertResponse(res, step.expect, label);
}

async function actPostAcks(
  scenarioId: string,
  state: ScenarioState,
  step: PostAcksStep,
  stepIdx: number,
): Promise<void> {
  const label = describeStep(scenarioId, stepIdx, step);
  const room = mustRoom(state, step.in, label);
  const from = mustDevice(state, step.from, label);
  const url = `${URL_BASE}/v2/rooms/${room.roomId}/acks`;
  const body = JSON.stringify({
    ackedEnvelopeIds: step.params.envelopeIds,
    deviceId: from.deviceId,
  });
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (!(step.params.omitAdmission === true)) {
    headers["Attn-Admission"] = await admissionHeaderFor({
      method: "POST",
      url,
      body,
      admissionKey: room.admissionKey,
    });
  }
  if (!(step.params.omitPow === true)) {
    headers["Attn-PoW"] = await mintPowForTests({
      roomId: room.roomId,
      deviceId: from.deviceId,
      method: "POST",
      path: `/v2/rooms/${room.roomId}/acks`,
      difficulty: Math.max(12, room.policy.powBits),
      expiresAt: nextPowExpiresAt(),
      rand: FIXED_POW_RAND,
    });
  }
  if (step.params.ownerSigFrom !== undefined) {
    const signer = mustDevice(state, step.params.ownerSigFrom, label);
    const signing = new Request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    const canonical = await canonicalRequest(signing, new URL(url).pathname);
    const sig = new Uint8Array(
      await crypto.subtle.sign({ name: "Ed25519" }, signer.kp.privateKey, canonical),
    );
    headers["Attn-Owner-Signature"] = base64UrlEncode(sig);
  }
  const res = await SELF.fetch(url, { method: "POST", headers, body });
  await assertResponse(res, step.expect, label);
}

async function actDeleteRoom(
  scenarioId: string,
  state: ScenarioState,
  step: DeleteRoomStep,
  stepIdx: number,
): Promise<void> {
  const label = describeStep(scenarioId, stepIdx, step);
  const room = mustRoom(state, step.in, label);
  const url = `${URL_BASE}/v2/rooms/${room.roomId}`;
  const headers: Record<string, string> = {};
  if (!(step.params.omitAdmission === true)) {
    headers["Attn-Admission"] = await admissionHeaderFor({
      method: "DELETE",
      url,
      admissionKey: room.admissionKey,
    });
  }
  if (!(step.params.omitPow === true)) {
    headers["Attn-PoW"] = await mintPowForTests({
      roomId: room.roomId,
      deviceId: "owner-delete", // PoW just needs to bind to *something*; the relay only checks the path
      method: "DELETE",
      path: `/v2/rooms/${room.roomId}`,
      difficulty: Math.max(12, room.policy.powBits),
      expiresAt: nextPowExpiresAt(),
      rand: FIXED_POW_RAND,
    });
  }
  if (!(step.params.omitOwnerSig === true)) {
    const signer =
      step.params.ownerSigFrom !== undefined
        ? mustDevice(state, step.params.ownerSigFrom, label)
        : undefined;
    const privateKey = signer?.kp.privateKey ?? room.ownerKp.privateKey;
    const signing = new Request(url, { method: "DELETE" });
    const canonical = await canonicalRequest(signing, new URL(url).pathname);
    const sig = new Uint8Array(
      await crypto.subtle.sign({ name: "Ed25519" }, privateKey, canonical),
    );
    headers["Attn-Owner-Signature"] = base64UrlEncode(sig);
  }
  const res = await SELF.fetch(url, { method: "DELETE", headers });
  await assertResponse(res, step.expect, label);
}

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
    hmac = new Uint8Array(hmac);
    hmac[0] = (hmac[0] ?? 0) ^ 0xff;
  }
  return `attn.v2, hmac.${base64UrlEncode(hmac)}`;
}

async function actOpenSocket(
  scenarioId: string,
  state: ScenarioState,
  step: OpenSocketStep,
  stepIdx: number,
): Promise<void> {
  const label = describeStep(scenarioId, stepIdx, step);
  const room = mustRoom(state, step.in, label);
  const dev = mustDevice(state, step.from, label);
  const url = `${URL_BASE}/v2/rooms/${room.roomId}/socket?device_id=${encodeURIComponent(dev.deviceId)}`;
  const headers: Record<string, string> = { Upgrade: "websocket" };
  if (!(step.params?.omitProtocol === true)) {
    headers["Sec-WebSocket-Protocol"] = await buildSocketProtocolHeader({
      roomId: room.roomId,
      deviceId: dev.deviceId,
      admissionKey: room.admissionKey,
      badHmac: step.params?.badHmac,
    });
  }
  const res = await SELF.fetch(url, { headers });
  if (step.expect?.status !== undefined) {
    expect(res.status, label).toBe(step.expect.status);
    if (step.expect.errorCode !== undefined) {
      const body = await res.json();
      const code = (body as { error?: { code?: string } })?.error?.code;
      expect(code, label).toBe(step.expect.errorCode);
    }
    return;
  }
  expect(res.status, label).toBe(101);
  const ws = res.webSocket;
  if (ws === null) expect.fail(`${label}: expected upgraded WebSocket, got null`);
  ws.accept();
  const queue = new FrameQueue(ws);
  state.sockets.set(step.as, {
    roomHandle: step.in,
    deviceHandle: step.from,
    ws,
    response: res,
    queue,
  });
}

async function actSendFrame(
  scenarioId: string,
  state: ScenarioState,
  step: SendFrameStep,
  stepIdx: number,
): Promise<void> {
  const label = describeStep(scenarioId, stepIdx, step);
  const sock = mustSocket(state, step.socket, label);
  sock.ws.send(JSON.stringify(step.frame));
}

async function actExpectFrame(
  scenarioId: string,
  state: ScenarioState,
  step: ExpectFrameStep,
  stepIdx: number,
): Promise<void> {
  const label = describeStep(scenarioId, stepIdx, step);
  const sock = mustSocket(state, step.socket, label);
  const ignore = new Set<string>(step.ignore ?? []);
  let frame: unknown;
  for (let attempts = 0; attempts < 8; attempts++) {
    frame = await sock.queue.next(step.timeoutMs ?? 2000);
    if (frame === undefined) {
      expect.fail(`${label}: timed out waiting for frame ${JSON.stringify(step.frame)}`);
    }
    const typed = (frame as { type?: string }).type;
    if (typed !== undefined && ignore.has(typed)) {
      continue;
    }
    break;
  }
  const fr = frame as Record<string, unknown>;
  expect(fr.type, label).toBe(step.frame.type);
  if (step.frame.code !== undefined) {
    expect(fr.code, label).toBe(step.frame.code);
  }
  if (step.frame.serverSeq !== undefined) {
    expect(fr.serverSeq, label).toBe(step.frame.serverSeq);
  }
  if (step.frame.serverSeqAtLeast !== undefined) {
    expect(typeof fr.serverSeq, label).toBe("number");
    expect(fr.serverSeq as number, label).toBeGreaterThanOrEqual(
      step.frame.serverSeqAtLeast,
    );
  }
  if (step.frame.envelopeId !== undefined) {
    const env = fr.envelope as EnvelopeRecord | undefined;
    expect(env?.envelopeId, label).toBe(step.frame.envelopeId);
  }
  if (step.frame.event !== undefined) {
    expect(fr.event, label).toBe(step.frame.event);
  }
  if (step.frame.deviceId !== undefined) {
    const wireDev = mustDevice(state, step.frame.deviceId, label);
    expect(fr.deviceId, label).toBe(wireDev.deviceId);
  }
  if (step.frame.hasResyncFromSeq === true) {
    expect(typeof fr.resyncFromSeq, label).toBe("number");
  }
}

async function actExpectClose(
  scenarioId: string,
  state: ScenarioState,
  step: ExpectCloseStep,
  stepIdx: number,
): Promise<void> {
  const label = describeStep(scenarioId, stepIdx, step);
  const sock = mustSocket(state, step.socket, label);
  await sock.queue.waitClosed(step.timeoutMs ?? 3000);
  expect(sock.queue.closed, label).toBe(true);
  expect(sock.queue.closeCode, label).toBe(step.code);
}

function actCloseSocket(
  scenarioId: string,
  state: ScenarioState,
  step: CloseSocketStep,
  stepIdx: number,
): void {
  const label = describeStep(scenarioId, stepIdx, step);
  const sock = mustSocket(state, step.socket, label);
  sock.ws.close(step.code ?? 1000, "scenario-close");
}

async function actSleep(step: SleepStep): Promise<void> {
  await new Promise<void>((r) => setTimeout(r, step.ms));
}

async function actAdvanceMockClock(
  scenarioId: string,
  state: ScenarioState,
  step: AdvanceMockClockStep,
  stepIdx: number,
): Promise<void> {
  const label = describeStep(scenarioId, stepIdx, step);
  const room = mustRoom(state, step.in, label);
  const id = env.RELAY_ROOMS.idFromName(room.roomId);
  const stub = env.RELAY_ROOMS.get(id);
  await runInDurableObject(stub, async (instance, ctxStorage) => {
    const currentExpires = await ctxStorage.storage.get<number>("meta:expires_at");
    if (currentExpires !== undefined) {
      // Move the wall-clock deadline backwards so the room appears expired now.
      await ctxStorage.storage.put<number>(
        "meta:expires_at",
        currentExpires - step.ms,
      );
    }
    const idleDeadline = await ctxStorage.storage.get<number>("meta:idle_deadline");
    if (idleDeadline !== undefined) {
      await ctxStorage.storage.put<number>(
        "meta:idle_deadline",
        idleDeadline - step.ms,
      );
    }
    if (step.fireAlarm === true) {
      // Fire the alarm immediately. The DO's alarm() handler is responsible
      // for closing sockets / wiping state.
      const inst = instance as unknown as { alarm?: () => Promise<void> };
      if (typeof inst.alarm === "function") {
        await inst.alarm();
      }
    }
  });
}

async function actSeedR2Blob(
  scenarioId: string,
  state: ScenarioState,
  step: SeedR2BlobStep,
  stepIdx: number,
): Promise<void> {
  const label = describeStep(scenarioId, stepIdx, step);
  const room = mustRoom(state, step.in, label);
  const fullKey = `rooms/${room.roomId}/${step.key}`;
  const bytes = new Uint8Array(step.bytes);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 23 + 5) & 0xff;
  await env.RELAY_BLOBS.put(fullKey, bytes);
}

async function actListR2(
  scenarioId: string,
  state: ScenarioState,
  step: ListR2Step,
  stepIdx: number,
): Promise<void> {
  const label = describeStep(scenarioId, stepIdx, step);
  const room = mustRoom(state, step.in, label);
  const fullPrefix = `rooms/${room.roomId}/${step.prefix}`;
  const keys: string[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await env.RELAY_BLOBS.list({ prefix: fullPrefix, cursor });
    for (const o of page.objects) keys.push(o.key);
    if (!page.truncated) break;
    cursor = page.cursor;
  }
  if (step.expect.countAtLeast !== undefined) {
    expect(keys.length, label).toBeGreaterThanOrEqual(step.expect.countAtLeast);
  }
  if (step.expect.countExactly !== undefined) {
    expect(keys.length, label).toBe(step.expect.countExactly);
  }
  if (step.expect.keys !== undefined) {
    const expected = step.expect.keys.map((k) => `rooms/${room.roomId}/${k}`);
    expect(keys.sort(), label).toEqual(expected.sort());
  }
}

async function actExpectStorageState(
  scenarioId: string,
  state: ScenarioState,
  step: ExpectStorageStateStep,
  stepIdx: number,
): Promise<void> {
  const label = describeStep(scenarioId, stepIdx, step);
  const room = mustRoom(state, step.in, label);
  const id = env.RELAY_ROOMS.idFromName(room.roomId);
  const stub = env.RELAY_ROOMS.get(id);
  await runInDurableObject(stub, async (_inst, ctxStorage) => {
    if (step.expect.envelopeCountExactly !== undefined) {
      const c = (await ctxStorage.storage.get<number>("meta:envelope_count")) ?? 0;
      expect(c, label).toBe(step.expect.envelopeCountExactly);
    }
    if (step.expect.bytesUsedExactly !== undefined) {
      const b = (await ctxStorage.storage.get<number>("meta:bytes_used")) ?? 0;
      expect(b, label).toBe(step.expect.bytesUsedExactly);
    }
    if (step.expect.oldestRetainedSeqAtLeast !== undefined) {
      const o = (await ctxStorage.storage.get<number>("meta:oldest_retained_seq")) ?? 0;
      expect(o, label).toBeGreaterThanOrEqual(step.expect.oldestRetainedSeqAtLeast);
    }
    if (step.expect.serverSeqAtLeast !== undefined) {
      const s = (await ctxStorage.storage.get<number>("meta:server_seq")) ?? 0;
      expect(s, label).toBeGreaterThanOrEqual(step.expect.serverSeqAtLeast);
    }
    for (const envId of step.expect.hasEnvIdx ?? []) {
      const v = await ctxStorage.storage.get<string>(`env_idx:${envId}`);
      expect(v, `${label}: env_idx:${envId} missing`).toBeDefined();
    }
    for (const envId of step.expect.missingEnvIdx ?? []) {
      const v = await ctxStorage.storage.get<string>(`env_idx:${envId}`);
      expect(v, `${label}: env_idx:${envId} unexpectedly present`).toBeUndefined();
    }
    for (const envId of step.expect.hasOwnerAckMarker ?? []) {
      const v = await ctxStorage.storage.get<string>(`ack_owner:${envId}`);
      expect(v, `${label}: ack_owner:${envId} missing`).toBeDefined();
    }
    for (const { device, envelopeId } of step.expect.hasAckSlot ?? []) {
      const dev = mustDevice(state, device, label);
      const v = await ctxStorage.storage.get<number>(
        `ack:${dev.deviceId}:${envelopeId}`,
      );
      expect(
        v,
        `${label}: ack:${dev.deviceId}:${envelopeId} missing`,
      ).toBeDefined();
    }
  });
}

async function actBumpStorage(
  scenarioId: string,
  state: ScenarioState,
  step: BumpStorageStep,
  stepIdx: number,
): Promise<void> {
  const label = describeStep(scenarioId, stepIdx, step);
  const room = mustRoom(state, step.in, label);
  const id = env.RELAY_ROOMS.idFromName(room.roomId);
  const stub = env.RELAY_ROOMS.get(id);
  await runInDurableObject(stub, async (_inst, ctxStorage) => {
    await ctxStorage.storage.put<number>(step.key, step.value);
  });
}

async function actRewindStorage(
  scenarioId: string,
  state: ScenarioState,
  step: RewindStorageStep,
  stepIdx: number,
): Promise<void> {
  const label = describeStep(scenarioId, stepIdx, step);
  const room = mustRoom(state, step.in, label);
  const id = env.RELAY_ROOMS.idFromName(room.roomId);
  const stub = env.RELAY_ROOMS.get(id);
  await runInDurableObject(stub, async (_inst, ctxStorage) => {
    const cur = await ctxStorage.storage.get<number>(step.key);
    if (cur === undefined) {
      expect.fail(`${label}: storage key '${step.key}' missing — cannot rewind`);
    }
    await ctxStorage.storage.put<number>(step.key, (cur as number) - step.deltaMs);
  });
}

async function actFireAlarm(
  scenarioId: string,
  state: ScenarioState,
  step: FireAlarmStep,
  stepIdx: number,
): Promise<void> {
  const label = describeStep(scenarioId, stepIdx, step);
  const room = mustRoom(state, step.in, label);
  const id = env.RELAY_ROOMS.idFromName(room.roomId);
  const stub = env.RELAY_ROOMS.get(id);
  await runInDurableObject(stub, async (inst, _ctxStorage) => {
    type WithAlarm = { alarm?: () => Promise<void> };
    const handler = (inst as unknown as WithAlarm).alarm;
    if (typeof handler !== "function") {
      expect.fail(`${label}: alarm() handler not defined on RoomDO`);
    }
    await (handler as () => Promise<void>).call(inst);
  });
}

interface PresignedUploadResponse {
  uploadUrl: string;
  method: "PUT";
  headers: Record<string, string>;
  expiresAt: number;
  blobKey: string;
  leaseId: string;
}

async function actPresignBlob(
  scenarioId: string,
  state: ScenarioState,
  step: PresignBlobStep,
  stepIdx: number,
): Promise<void> {
  const label = describeStep(scenarioId, stepIdx, step);
  const room = mustRoom(state, step.in, label);
  const from = mustDevice(state, step.from, label);
  const url = `${URL_BASE}/v2/rooms/${room.roomId}/blobs`;
  const body = JSON.stringify({
    envelopeId: step.params.envelopeId,
    authorId: from.participantId,
    deviceId: from.deviceId,
    ciphertextBytes: step.params.ciphertextBytes,
  });
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (!(step.params.omitAdmission === true)) {
    headers["Attn-Admission"] = await admissionHeaderFor({
      method: "POST",
      url,
      body,
      admissionKey: room.admissionKey,
    });
  }
  if (!(step.params.omitPow === true)) {
    headers["Attn-PoW"] = await mintPowForTests({
      roomId: room.roomId,
      deviceId: from.deviceId,
      method: "POST",
      path: `/v2/rooms/${room.roomId}/blobs`,
      difficulty: Math.max(12, room.policy.powBits),
      expiresAt: nextPowExpiresAt(),
      rand: FIXED_POW_RAND,
    });
  }
  const res = await SELF.fetch(url, { method: "POST", headers, body });
  const responseBody = await assertResponse(res, step.expect, label);
  if (res.status === 200) {
    const presigned = responseBody as PresignedUploadResponse;
    const handle = step.as ?? step.params.envelopeId;
    state.blobs.set(handle, {
      roomHandle: step.in,
      envelopeId: step.params.envelopeId,
      ciphertextBytes: step.params.ciphertextBytes,
      uploadUrl: presigned.uploadUrl,
      leaseId: presigned.leaseId,
    });
  }
}

function makeBlobBytes(byteLen: number, seed: number): Uint8Array {
  const out = new Uint8Array(byteLen);
  for (let i = 0; i < byteLen; i++) out[i] = (seed + i * 37) & 0xff;
  return out;
}

async function actPutBlob(
  scenarioId: string,
  state: ScenarioState,
  step: PutBlobStep,
  stepIdx: number,
): Promise<void> {
  const label = describeStep(scenarioId, stepIdx, step);
  const blob = state.blobs.get(step.as);
  if (blob === undefined) {
    expect.fail(`${label}: unknown blob handle '${step.as}' — call presignBlob first`);
  }
  const payloadLen = step.params.bodyBytes ?? step.params.bytes;
  const payload = makeBlobBytes(payloadLen, 0x42);
  const res = await SELF.fetch(`${URL_BASE}${blob.uploadUrl}`, {
    method: "PUT",
    headers: { "Content-Type": "application/octet-stream" },
    body: payload,
  });
  await assertResponse(res, step.expect, label);
}

async function actGetBlob(
  scenarioId: string,
  state: ScenarioState,
  step: GetBlobStep,
  stepIdx: number,
): Promise<void> {
  const label = describeStep(scenarioId, stepIdx, step);
  const blob = state.blobs.get(step.as);
  if (blob === undefined) {
    expect.fail(`${label}: unknown blob handle '${step.as}' — call presignBlob first`);
  }
  const room = mustRoom(state, blob.roomHandle, label);
  const download = await presignBlobDownload(env, room.roomId, blob.leaseId, blob.envelopeId);
  const res = await SELF.fetch(`${URL_BASE}${download.downloadUrl}`, { method: "GET" });
  // The blob GET response is binary; call assertResponse-equivalent checks
  // inline so we can consume the body once via arrayBuffer().
  if (res.status !== step.expect.status) {
    let bodyTxt = "<binary>";
    try {
      bodyTxt = await res.clone().text();
    } catch {
      // ignore
    }
    expect.fail(
      `${label}: expected status ${step.expect.status}, got ${res.status}\n  body: ${bodyTxt}`,
    );
  }
  if (step.expect.errorCode !== undefined) {
    const errBody = (await res.json()) as { error?: { code?: string } };
    expect(errBody?.error?.code, label).toBe(step.expect.errorCode);
    return;
  }
  if (res.status === 200 && step.params.expectedBytes !== undefined) {
    const got = new Uint8Array(await res.arrayBuffer());
    if (got.byteLength !== step.params.expectedBytes) {
      expect.fail(
        `${label}: expected ${step.params.expectedBytes} bytes, got ${got.byteLength}`,
      );
    }
  }
}

// --- top-level dispatcher -----------------------------------------------

export async function runScenario(scenario: Scenario): Promise<void> {
  const state: ScenarioState = {
    rooms: new Map(),
    devices: new Map(),
    sockets: new Map(),
    blobs: new Map(),
    lastPow: undefined,
  };

  try {
    for (let i = 0; i < scenario.steps.length; i++) {
      const step = scenario.steps[i];
      if (step === undefined) continue;
      switch (step.action) {
        case "createRoom":
          await actCreateRoom(scenario.id, state, step, i);
          break;
        case "recreateRoom":
          await actRecreateRoom(scenario.id, state, step, i);
          break;
        case "registerDevice":
          await actRegisterDevice(scenario.id, state, step, i);
          break;
        case "listDevices":
          await actListDevices(scenario.id, state, step, i);
          break;
        case "postEnvelopes":
          await actPostEnvelopes(scenario.id, state, step, i);
          break;
        case "postAcks":
          await actPostAcks(scenario.id, state, step, i);
          break;
        case "deleteRoom":
          await actDeleteRoom(scenario.id, state, step, i);
          break;
        case "openSocket":
          await actOpenSocket(scenario.id, state, step, i);
          break;
        case "sendFrame":
          await actSendFrame(scenario.id, state, step, i);
          break;
        case "expectFrame":
          await actExpectFrame(scenario.id, state, step, i);
          break;
        case "expectClose":
          await actExpectClose(scenario.id, state, step, i);
          break;
        case "closeSocket":
          actCloseSocket(scenario.id, state, step, i);
          break;
        case "sleep":
          await actSleep(step);
          break;
        case "advanceMockClock":
          await actAdvanceMockClock(scenario.id, state, step, i);
          break;
        case "seedR2Blob":
          await actSeedR2Blob(scenario.id, state, step, i);
          break;
        case "listR2":
          await actListR2(scenario.id, state, step, i);
          break;
        case "expectStorageState":
          await actExpectStorageState(scenario.id, state, step, i);
          break;
        case "bumpStorage":
          await actBumpStorage(scenario.id, state, step, i);
          break;
        case "rewindStorage":
          await actRewindStorage(scenario.id, state, step, i);
          break;
        case "fireAlarm":
          await actFireAlarm(scenario.id, state, step, i);
          break;
        case "presignBlob":
          await actPresignBlob(scenario.id, state, step, i);
          break;
        case "putBlob":
          await actPutBlob(scenario.id, state, step, i);
          break;
        case "getBlob":
          await actGetBlob(scenario.id, state, step, i);
          break;
        default: {
          const _exhaustive: never = step;
          throw new Error(`unhandled step ${String((step as { action: string }).action)} : ${String(_exhaustive)}`);
        }
      }
    }
  } finally {
    // Clean up any sockets the scenario left open so vitest doesn't leak them.
    for (const sock of state.sockets.values()) {
      if (!sock.queue.closed) {
        try {
          sock.ws.close(1000, "scenario-cleanup");
        } catch {
          // ignore
        }
      }
    }
  }
}
