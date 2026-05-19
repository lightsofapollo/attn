/** RoomDO — per-room Durable Object. Holds envelopes, devices, acks, and WS peers.
 *
 * Endpoints land here per planning/collab/relay-spec.md §HTTP API as the
 * 5.5-5.13 issues progress:
 *   - POST /v2/rooms/:roomId             (5.5 — implemented)
 *   - POST /v2/rooms/:roomId/devices, GET (5.6)
 *   - POST /v2/rooms/:roomId/envelopes   (5.7)
 *   - POST /v2/rooms/:roomId/acks        (5.8)
 *   - DELETE /v2/rooms/:roomId           (5.9)
 *   - POST /v2/rooms/:roomId/blobs (R2)  (5.10)
 *   - WebSocket upgrade + frames         (5.11)
 *   - alarms (TTL + idle)                (5.12)
 *   - rate limiting                      (5.13)
 */

import { DurableObject } from "cloudflare:workers";
import { z } from "zod";

import { verifyAdmission, AdmissionError, base64UrlDecode, base64UrlEncode } from "./admission";
import { canonicalize, type CanonicalValue } from "./canonical";
import type { Env } from "./env";
import { PowError, verifyPow } from "./pow";
import {
  deviceRegistrationSchema,
  roomCreationSchema,
  type DeviceRecord,
  type DeviceRegistrationRequest,
  type RoomPolicy,
} from "./schema";

const ROOM_PATH_RE = /^\/v2\/rooms\/([^/]+)\/?$/;
const ROOM_DEVICES_PATH_RE = /^\/v2\/rooms\/([^/]+)\/devices\/?$/;

const ED25519_PUB_BYTE_LEN = 32;
const ED25519_SIG_BYTE_LEN = 64;
const ADMISSION_KEY_BYTE_LEN = 32;

/** Padded width for the registration-order index suffix. ms-epoch fits in 14
 * digits until year 5138; widening this requires re-keying device_order:*. */
const REGISTERED_AT_PAD = 14;
/** Per-room monotonic disambiguator for two devices registered in the same ms. */
const META_DEVICE_SEQ = "meta:device_seq";

/** DO storage keys for room metadata. Kept centralized so 5.6-5.13 reuse the same names. */
const META = {
  policy: "meta:policy",
  ownerSigningKey: "meta:owner_signing_key",
  ownerSigningKeyId: "meta:owner_signing_key_id",
  admissionKey: "meta:admission_key",
  createdAt: "meta:created_at",
  expiresAt: "meta:expires_at",
  hardMaxAt: "meta:hard_max_at",
  lastEventAt: "meta:last_event_at",
  serverSeq: "meta:server_seq",
  bytesUsed: "meta:bytes_used",
  bytesUsedR2: "meta:bytes_used_r2",
  envelopeCount: "meta:envelope_count",
  oldestRetainedSeq: "meta:oldest_retained_seq",
} as const;

interface ErrorBody {
  error: { code: string; message: string };
}

function errorResponse(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } } satisfies ErrorBody, { status });
}

interface HardLimits {
  maxPeers: number;
  maxSnapshotBytes: number;
  maxEventBytes: number;
  maxEvents: number;
  ttlMs: number;
  ttlLongMs: number;
  defaultIdleTimeoutMs: number;
  minPowBits: number;
  maxPowBits: number;
}

function readHardLimits(env: Env): HardLimits {
  return {
    maxPeers: parsePositiveInt(env.HARD_MAX_PEERS, "HARD_MAX_PEERS"),
    maxSnapshotBytes: parsePositiveInt(env.HARD_MAX_SNAPSHOT_BYTES, "HARD_MAX_SNAPSHOT_BYTES"),
    maxEventBytes: parsePositiveInt(env.HARD_MAX_EVENT_BYTES, "HARD_MAX_EVENT_BYTES"),
    maxEvents: parsePositiveInt(env.HARD_MAX_EVENTS, "HARD_MAX_EVENTS"),
    ttlMs: parsePositiveInt(env.HARD_MAX_TTL_MS, "HARD_MAX_TTL_MS"),
    ttlLongMs: parsePositiveInt(env.HARD_MAX_TTL_LONG_MS, "HARD_MAX_TTL_LONG_MS"),
    defaultIdleTimeoutMs: parsePositiveInt(env.DEFAULT_IDLE_TIMEOUT_MS, "DEFAULT_IDLE_TIMEOUT_MS"),
    minPowBits: parsePositiveInt(env.MIN_POW_BITS, "MIN_POW_BITS"),
    maxPowBits: parsePositiveInt(env.MAX_POW_BITS, "MAX_POW_BITS"),
  };
}

function parsePositiveInt(raw: string, name: string): number {
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new Error(`env.${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return n;
}

export class RoomDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const roomMatch = url.pathname.match(ROOM_PATH_RE);

    if (roomMatch && request.method === "POST") {
      const roomId = roomMatch[1];
      if (roomId === undefined || roomId === "") {
        return errorResponse(400, "ATTN_ROOM_ID_INVALID", "roomId required");
      }
      return this.handleRoomCreate(request, roomId);
    }

    const devicesMatch = url.pathname.match(ROOM_DEVICES_PATH_RE);
    if (devicesMatch) {
      const roomId = devicesMatch[1];
      if (roomId === undefined || roomId === "") {
        return errorResponse(400, "ATTN_ROOM_ID_INVALID", "roomId required");
      }
      // GET on a never-created room → 404. Other endpoints (5.7+) own their own
      // existence checks; we centralize the check here because the spec wants
      // `GET /devices` on an unknown room to return 404 rather than 401.
      if (request.method === "POST") {
        return this.handleDeviceRegister(request, roomId, url.pathname);
      }
      if (request.method === "GET") {
        return this.handleDeviceList(request, roomId, url.pathname);
      }
      return errorResponse(405, "ATTN_METHOD_NOT_ALLOWED", `${request.method} not allowed on /devices`);
    }

    // Other endpoints land in 5.7-5.13.
    return errorResponse(404, "ATTN_NOT_FOUND", `no handler for ${request.method} ${url.pathname}`);
  }

  // -- POST /v2/rooms/:roomId ---------------------------------------------

  /**
   * Idempotent room create/rejoin per relay-spec.md §POST /v2/rooms/:roomId.
   *
   * First-POST trust model (see also schema.ts NOTE on admissionKey):
   *   - We cannot verify the admission HMAC on first create because the room
   *     has no admissionKey stored yet. Per amendments.md #2 the trust
   *     boundary is URL possession; URL holders are by definition admitted.
   *   - The body carries `admissionKey` (32 bytes b64url); we store it at
   *     META.admissionKey and verify every subsequent request against it,
   *     starting with the rejoin path below.
   *
   * Rejoin path:
   *   - admissionKey is loaded from DO storage and verified BEFORE we touch
   *     the body. We deliberately do not re-parse / re-validate the body on
   *     rejoin — the stored policy is authoritative and immutable (spec:
   *     "Do not allow policy mutation after creation; that would let a
   *     stolen URL extend a room's TTL").
   */
  private async handleRoomCreate(request: Request, roomId: string): Promise<Response> {
    const limits = readHardLimits(this.env);

    // Always drain the body to bytes up front. Branches below may short-circuit
    // before parsing JSON (rejoin path, admission failure) — leaving the
    // request stream half-read causes workerd to surface a post-response
    // "Can't read from request stream after response has been sent" error in
    // the DO→Worker boundary. Reading once into a buffer side-steps that.
    let bodyBytes: Uint8Array;
    try {
      bodyBytes = new Uint8Array(await request.arrayBuffer());
    } catch (err) {
      return errorResponse(400, "ATTN_BODY_INVALID", `request body read failed: ${(err as Error).message}`);
    }

    const existingCreatedAt = await this.ctx.storage.get<number>(META.createdAt);
    const isRejoin = typeof existingCreatedAt === "number";

    if (isRejoin) {
      // Verify admission before returning anything — URL holders should still
      // prove they know admissionKey on subsequent calls.
      const storedAdmissionKey = await this.ctx.storage.get<Uint8Array>(META.admissionKey);
      if (storedAdmissionKey === undefined) {
        // Inconsistent state; refuse rather than silently bypass admission.
        return errorResponse(500, "ATTN_ROOM_CORRUPT", `room ${roomId} missing admission key`);
      }
      try {
        // Build a fresh Request from the buffered body so verifyAdmission can
        // re-clone it without us racing the original stream.
        const buffered = new Request(request.url, {
          method: request.method,
          headers: request.headers,
          body: bodyBytes.byteLength === 0 ? null : bodyBytes,
        });
        await verifyAdmission(buffered, new URL(request.url).pathname, {
          roomId,
          admissionKey: storedAdmissionKey,
        });
      } catch (err) {
        if (err instanceof AdmissionError) {
          return errorResponse(401, err.code, err.message);
        }
        throw err;
      }
      return this.buildExistingRoomResponse(roomId);
    }

    // --- First create ----------------------------------------------------

    let parsed: unknown;
    try {
      const text = new TextDecoder().decode(bodyBytes);
      parsed = JSON.parse(text);
    } catch (err) {
      return errorResponse(400, "ATTN_BODY_INVALID", `request body is not valid JSON: ${(err as Error).message}`);
    }

    // Version gate runs before zod so we can return the canonical version error
    // even when other fields are missing/garbage.
    if (typeof parsed === "object" && parsed !== null && "v" in parsed && (parsed as { v: unknown }).v !== 2) {
      return errorResponse(400, "ATTN_VERSION_UNSUPPORTED", `unsupported protocol version: ${String((parsed as { v: unknown }).v)}`);
    }

    const result = roomCreationSchema.safeParse(parsed);
    if (!result.success) {
      return errorResponse(400, "ATTN_BODY_INVALID", formatZodError(result.error));
    }
    const body = result.data;

    // Decode binary key fields; reject if they don't match expected lengths.
    let ownerKeyBytes: Uint8Array;
    let admissionKeyBytes: Uint8Array;
    try {
      ownerKeyBytes = base64UrlDecode(body.ownerSigningKey);
    } catch (err) {
      return errorResponse(400, "ATTN_BODY_INVALID", `ownerSigningKey base64url decode failed: ${(err as Error).message}`);
    }
    if (ownerKeyBytes.length !== ED25519_PUB_BYTE_LEN) {
      return errorResponse(400, "ATTN_BODY_INVALID", `ownerSigningKey must be ${ED25519_PUB_BYTE_LEN} bytes (got ${ownerKeyBytes.length})`);
    }
    try {
      admissionKeyBytes = base64UrlDecode(body.admissionKey);
    } catch (err) {
      return errorResponse(400, "ATTN_BODY_INVALID", `admissionKey base64url decode failed: ${(err as Error).message}`);
    }
    if (admissionKeyBytes.length !== ADMISSION_KEY_BYTE_LEN) {
      return errorResponse(400, "ATTN_BODY_INVALID", `admissionKey must be ${ADMISSION_KEY_BYTE_LEN} bytes (got ${admissionKeyBytes.length})`);
    }

    const createdAt = Date.now();
    const clamped = clampPolicy(body.policy, limits, createdAt);

    const ownerSigningKeyId = await sha256B64Url(ownerKeyBytes);

    // Persist everything in one DO transaction. We use put-many so the writes
    // commit atomically — partial creates are observable as either fully-done
    // or fully-absent.
    await this.ctx.storage.put<unknown>({
      [META.policy]: clamped.policy,
      [META.ownerSigningKey]: ownerKeyBytes,
      [META.ownerSigningKeyId]: ownerSigningKeyId,
      [META.admissionKey]: admissionKeyBytes,
      [META.createdAt]: createdAt,
      [META.expiresAt]: clamped.policy.expiresAt,
      [META.hardMaxAt]: clamped.hardMaxAt,
      [META.lastEventAt]: createdAt,
      [META.serverSeq]: 0,
      [META.bytesUsed]: 0,
      [META.bytesUsedR2]: 0,
      [META.envelopeCount]: 0,
      [META.oldestRetainedSeq]: 0,
    });

    // Schedule the TTL/idle alarm. 5.12 owns the actual alarm() handler; here
    // we just set the wake time to min(hard_max_at, last_event_at + idle).
    const idleAt = createdAt + clamped.idleTimeoutMs;
    const alarmAt = Math.min(clamped.hardMaxAt, idleAt);
    await this.ctx.storage.setAlarm(alarmAt);

    return Response.json(
      {
        roomId,
        createdAt,
        expiresAt: clamped.policy.expiresAt,
        policy: clamped.policy,
        ownerSigningKeyId,
        serverSeq: 0,
      },
      { status: 201 },
    );
  }

  private async buildExistingRoomResponse(roomId: string): Promise<Response> {
    // Load the bag of values we need; missing values surface as a 500 because
    // they'd represent corrupt DO state.
    const [policy, createdAt, expiresAt, ownerSigningKeyId, serverSeq] = await Promise.all([
      this.ctx.storage.get<RoomPolicy>(META.policy),
      this.ctx.storage.get<number>(META.createdAt),
      this.ctx.storage.get<number>(META.expiresAt),
      this.ctx.storage.get<string>(META.ownerSigningKeyId),
      this.ctx.storage.get<number>(META.serverSeq),
    ]);
    if (
      policy === undefined ||
      createdAt === undefined ||
      expiresAt === undefined ||
      ownerSigningKeyId === undefined ||
      serverSeq === undefined
    ) {
      return errorResponse(500, "ATTN_ROOM_CORRUPT", `room ${roomId} has incomplete metadata`);
    }
    return Response.json(
      {
        roomId,
        createdAt,
        expiresAt,
        policy,
        ownerSigningKeyId,
        serverSeq,
      },
      { status: 200 },
    );
  }

  // -- POST /v2/rooms/:roomId/devices -------------------------------------

  /**
   * Publish device public keys per relay-spec.md §POST /v2/rooms/:roomId/devices.
   *
   * Order matters for security: admission first, then PoW, then schema, then
   * cryptographic checks. We don't want to reveal whether a self-signature is
   * valid before the caller proves URL possession + PoW expenditure.
   */
  private async handleDeviceRegister(
    request: Request,
    roomId: string,
    urlPath: string,
  ): Promise<Response> {
    // Bail early if the room was never created — every following check needs
    // the policy + admissionKey + ownerSigningKey loaded from storage.
    const storedAdmissionKey = await this.ctx.storage.get<Uint8Array>(META.admissionKey);
    if (storedAdmissionKey === undefined) {
      return errorResponse(404, "ATTN_ROOM_NOT_FOUND", `room ${roomId} does not exist`);
    }

    // Buffer the body once. Both verifyAdmission and the JSON parser below
    // need to read it; the room-create handler ran into the same workerd
    // "Can't read from request stream after response has been sent" failure
    // when leaving the stream half-consumed.
    let bodyBytes: Uint8Array;
    try {
      bodyBytes = new Uint8Array(await request.arrayBuffer());
    } catch (err) {
      return errorResponse(400, "ATTN_BODY_INVALID", `request body read failed: ${(err as Error).message}`);
    }

    // 1. Admission — URL-as-bearer trust boundary.
    try {
      const buffered = bufferedRequest(request, bodyBytes);
      await verifyAdmission(buffered, urlPath, { roomId, admissionKey: storedAdmissionKey });
    } catch (err) {
      if (err instanceof AdmissionError) {
        return errorResponse(401, err.code, err.message);
      }
      throw err;
    }

    // 2. Schema-validate the body so we have a `deviceId` to bind the PoW to.
    //    Per spec we tie PoW to (roomId, deviceId, method, path) — that needs
    //    the body decoded before verifyPow.
    let parsed: unknown;
    try {
      const text = new TextDecoder().decode(bodyBytes);
      parsed = JSON.parse(text);
    } catch (err) {
      return errorResponse(400, "ATTN_BODY_INVALID", `request body is not valid JSON: ${(err as Error).message}`);
    }
    const result = deviceRegistrationSchema.safeParse(parsed);
    if (!result.success) {
      return errorResponse(400, "ATTN_BODY_INVALID", formatZodError(result.error));
    }
    const body = result.data;

    // 3. PoW — burnt once per request. Header carries the token verbatim.
    const policy = await this.ctx.storage.get<RoomPolicy>(META.policy);
    if (policy === undefined) {
      return errorResponse(500, "ATTN_ROOM_CORRUPT", `room ${roomId} missing policy`);
    }
    const powToken = request.headers.get("Attn-PoW");
    if (powToken === null || powToken === "") {
      return errorResponse(400, "ATTN_POW_INVALID", "missing Attn-PoW header");
    }
    try {
      await verifyPow(powToken, {
        roomId,
        deviceId: body.deviceId,
        method: "POST",
        urlPath,
        policyPowBits: policy.powBits,
        now: Date.now(),
        isReplayed: (hash) => this.isPowSeen(hash),
        markSeen: (hash, expiresAt) => this.markPowSeen(hash, expiresAt),
      });
    } catch (err) {
      if (err instanceof PowError) {
        return errorResponse(400, err.code, err.message);
      }
      throw err;
    }

    // 4. Decode the signing key + verify selfSignature.
    let signingKeyBytes: Uint8Array;
    try {
      signingKeyBytes = base64UrlDecode(body.publicSigningKey);
    } catch (err) {
      return errorResponse(400, "ATTN_BODY_INVALID", `publicSigningKey base64url decode failed: ${(err as Error).message}`);
    }
    if (signingKeyBytes.length !== ED25519_PUB_BYTE_LEN) {
      return errorResponse(400, "ATTN_BODY_INVALID", `publicSigningKey must be ${ED25519_PUB_BYTE_LEN} bytes (got ${signingKeyBytes.length})`);
    }
    let selfSig: Uint8Array;
    try {
      selfSig = base64UrlDecode(body.selfSignature);
    } catch (err) {
      return errorResponse(400, "ATTN_DEVICE_SELF_SIG_INVALID", `selfSignature base64url decode failed: ${(err as Error).message}`);
    }
    if (selfSig.length !== ED25519_SIG_BYTE_LEN) {
      return errorResponse(400, "ATTN_DEVICE_SELF_SIG_INVALID", `selfSignature must be ${ED25519_SIG_BYTE_LEN} bytes (got ${selfSig.length})`);
    }
    const sigOk = await verifySelfSignature(body, signingKeyBytes, selfSig);
    if (!sigOk) {
      return errorResponse(400, "ATTN_DEVICE_SELF_SIG_INVALID", "selfSignature does not match canonical body");
    }

    // 5. kind=owner gate: stored ownerSigningKey wins. Constant-time compare.
    if (body.kind === "owner") {
      const ownerKey = await this.ctx.storage.get<Uint8Array>(META.ownerSigningKey);
      if (ownerKey === undefined) {
        return errorResponse(500, "ATTN_ROOM_CORRUPT", `room ${roomId} missing owner key`);
      }
      if (!constantTimeBytesEqual(ownerKey, signingKeyBytes)) {
        return errorResponse(403, "ATTN_OWNER_KEY_MISMATCH", "publicSigningKey does not match ownerSigningKey stored at room creation");
      }
    }

    // 6. Upsert by (participantId, deviceId). Same key → idempotent; different
    //    key → 409. The (participantId, deviceId) → publicSigningKey binding is
    //    immutable per spec.
    const recordKey = deviceStorageKey(body.participantId, body.deviceId);
    const existing = await this.ctx.storage.get<DeviceRecord>(recordKey);
    if (existing !== undefined && existing.publicSigningKey !== body.publicSigningKey) {
      return errorResponse(
        409,
        "ATTN_DEVICE_KEY_CHANGED",
        `publicSigningKey for (${body.participantId}, ${body.deviceId}) does not match existing registration`,
      );
    }

    // 7. Build the record + write a single put-many so the order index and
    //    payload commit atomically. On re-register we preserve `registeredAt`
    //    so the ordering stays stable.
    let registeredAt: number;
    let orderKey: string;
    if (existing !== undefined) {
      registeredAt = existing.registeredAt;
      orderKey = await this.findExistingOrderKey(body.participantId, body.deviceId);
    } else {
      registeredAt = Date.now();
      const seq = await this.nextDeviceSeq();
      orderKey = deviceOrderKey(registeredAt, seq, body.participantId, body.deviceId);
    }
    const record: DeviceRecord = { ...body, registeredAt };
    await this.ctx.storage.put<unknown>({
      [recordKey]: record,
      [orderKey]: "",
    });

    return new Response(null, { status: 204 });
  }

  // -- GET /v2/rooms/:roomId/devices --------------------------------------

  /** Return devices in registration order. Admission-verified. */
  private async handleDeviceList(
    request: Request,
    roomId: string,
    urlPath: string,
  ): Promise<Response> {
    const storedAdmissionKey = await this.ctx.storage.get<Uint8Array>(META.admissionKey);
    if (storedAdmissionKey === undefined) {
      return errorResponse(404, "ATTN_ROOM_NOT_FOUND", `room ${roomId} does not exist`);
    }
    try {
      // GET bodies are always empty; we can hand the original request straight
      // to verifyAdmission (no double-read concern).
      await verifyAdmission(request, urlPath, { roomId, admissionKey: storedAdmissionKey });
    } catch (err) {
      if (err instanceof AdmissionError) {
        return errorResponse(401, err.code, err.message);
      }
      throw err;
    }

    // Range-scan the order index, then load each payload. We bound the scan
    // by HARD_MAX_PEERS — listing more devices than the policy allows would
    // indicate corrupt storage.
    const orderEntries = await this.ctx.storage.list<string>({
      prefix: DEVICE_ORDER_PREFIX,
    });
    const devices: DeviceRecord[] = [];
    for (const orderKey of orderEntries.keys()) {
      const { participantId, deviceId } = parseDeviceOrderKey(orderKey);
      const record = await this.ctx.storage.get<DeviceRecord>(deviceStorageKey(participantId, deviceId));
      if (record !== undefined) {
        devices.push(record);
      }
    }
    return Response.json({ devices }, { status: 200 });
  }

  // -- helpers for PoW replay + device ordering ---------------------------

  private async isPowSeen(hash: string): Promise<boolean> {
    return (await this.ctx.storage.get<number>(`pow_seen:${hash}`)) !== undefined;
  }

  private async markPowSeen(hash: string, expiresAt: number): Promise<void> {
    // 5.12 owns alarm-driven pruning. For now we just persist the expiresAt
    // so a future alarm can scan + drop expired entries.
    await this.ctx.storage.put<number>(`pow_seen:${hash}`, expiresAt);
  }

  private async nextDeviceSeq(): Promise<number> {
    const current = (await this.ctx.storage.get<number>(META_DEVICE_SEQ)) ?? 0;
    const next = current + 1;
    await this.ctx.storage.put<number>(META_DEVICE_SEQ, next);
    return next;
  }

  /**
   * Find the existing order-index key for a (participantId, deviceId) pair.
   * Needed on idempotent re-register so we re-write the same order key rather
   * than introduce a duplicate at a later position.
   */
  private async findExistingOrderKey(
    participantId: string,
    deviceId: string,
  ): Promise<string> {
    const suffix = `:${participantId}:${deviceId}`;
    const entries = await this.ctx.storage.list<string>({ prefix: DEVICE_ORDER_PREFIX });
    for (const key of entries.keys()) {
      if (key.endsWith(suffix)) return key;
    }
    // Caller already verified existing!==undefined, so the order key must exist;
    // fall back to a fresh ordering only if storage is corrupt.
    const seq = await this.nextDeviceSeq();
    return deviceOrderKey(Date.now(), seq, participantId, deviceId);
  }
}

// --- helpers --------------------------------------------------------------

interface ClampedPolicy {
  policy: RoomPolicy;
  hardMaxAt: number;
  idleTimeoutMs: number;
}

/**
 * Apply the spec's hard maxima to the client-provided policy. Pure (no IO,
 * no Date.now); the handler passes `createdAt` so tests can pin timestamps.
 */
export function clampPolicy(
  input: RoomPolicy,
  limits: HardLimits,
  createdAt: number,
): ClampedPolicy {
  const ttlMs = input.longSession ? limits.ttlLongMs : limits.ttlMs;
  const hardMaxAt = createdAt + ttlMs;

  // expiresAt clamped to [createdAt, hardMaxAt]. If the client requested a
  // value in the past, we treat it as a request for "as long as possible
  // within hard cap" — clamping up to hardMaxAt matches the spec language
  // ("Default if omitted: createdAt + 24h").
  let expiresAt = input.expiresAt;
  if (!Number.isFinite(expiresAt) || expiresAt <= createdAt) {
    expiresAt = hardMaxAt;
  } else if (expiresAt > hardMaxAt) {
    expiresAt = hardMaxAt;
  }

  // idleTimeoutMs clamped to [60s, wall-clock TTL]. Default 1h via env.
  const wallClockTtl = expiresAt - createdAt;
  const requestedIdle = input.idleTimeoutMs ?? limits.defaultIdleTimeoutMs;
  const idleTimeoutMs = Math.max(60_000, Math.min(requestedIdle, wallClockTtl));

  const powBits = clampNumber(input.powBits, limits.minPowBits, limits.maxPowBits);

  const clamped: RoomPolicy = {
    mode: input.mode,
    maxPeers: clampNumber(input.maxPeers, 1, limits.maxPeers),
    maxSnapshotBytes: clampNumber(input.maxSnapshotBytes, 1, limits.maxSnapshotBytes),
    maxEventBytes: clampNumber(input.maxEventBytes, 1, limits.maxEventBytes),
    maxEvents: clampNumber(input.maxEvents, 1, limits.maxEvents),
    expiresAt,
    idleTimeoutMs,
    longSession: input.longSession,
    powBits,
    deleteEventsAfterOwnerAck: input.deleteEventsAfterOwnerAck,
    allowBrowser: input.allowBrowser,
    allowRemoteAgents: input.allowRemoteAgents,
  };

  return { policy: clamped, hardMaxAt, idleTimeoutMs };
}

function clampNumber(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

async function sha256B64Url(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return base64UrlEncode(digest);
}

// --- device-record storage keying ----------------------------------------

const DEVICE_PREFIX = "device:";
const DEVICE_ORDER_PREFIX = "device_order:";

function deviceStorageKey(participantId: string, deviceId: string): string {
  return `${DEVICE_PREFIX}${participantId}:${deviceId}`;
}

/**
 * Order-index key. Padded `registeredAt` keeps lexicographic order aligned with
 * numeric order; `seq` disambiguates within the same ms (DO timer resolution
 * is 1ms, two registrations in the same call site would otherwise collide).
 */
function deviceOrderKey(
  registeredAt: number,
  seq: number,
  participantId: string,
  deviceId: string,
): string {
  const ts = String(registeredAt).padStart(REGISTERED_AT_PAD, "0");
  const s = String(seq).padStart(8, "0");
  return `${DEVICE_ORDER_PREFIX}${ts}:${s}:${participantId}:${deviceId}`;
}

function parseDeviceOrderKey(key: string): { participantId: string; deviceId: string } {
  // Layout: device_order:<ts>:<seq>:<participantId>:<deviceId>. We only need
  // the trailing pair — the timestamp + seq are encoded purely for sort order.
  const rest = key.slice(DEVICE_ORDER_PREFIX.length);
  const parts = rest.split(":");
  if (parts.length < 4) {
    throw new Error(`malformed device_order key: ${key}`);
  }
  // Take the last two segments as (participantId, deviceId). We control the
  // writer side so neither ever contains a colon (max 64 chars, the schema
  // is permissive about content but tests + native client never embed `:`).
  const deviceId = parts[parts.length - 1] ?? "";
  const participantId = parts[parts.length - 2] ?? "";
  return { participantId, deviceId };
}

// --- request body buffering ----------------------------------------------

/**
 * Rebuild a Request from a buffered body so verifyAdmission can `request.clone()`
 * without racing the original stream. Mirrors the pattern in handleRoomCreate.
 */
function bufferedRequest(original: Request, bodyBytes: Uint8Array): Request {
  return new Request(original.url, {
    method: original.method,
    headers: original.headers,
    body: bodyBytes.byteLength === 0 ? null : bodyBytes,
  });
}

// --- self-signature verification ----------------------------------------

/**
 * Verify the Ed25519 selfSignature against the canonical-JSON serialization of
 * the request body with `selfSignature` removed.
 *
 * crypto-spec.md §Canonical JSON drives the wire format — we use the local
 * `canonicalize()` port so a signature produced by the Rust client verifies
 * here byte-for-byte.
 */
async function verifySelfSignature(
  body: DeviceRegistrationRequest,
  publicKeyBytes: Uint8Array,
  signature: Uint8Array,
): Promise<boolean> {
  // Strip selfSignature for the canonical form.
  const signed: Record<string, CanonicalValue> = {
    deviceId: body.deviceId,
    participantId: body.participantId,
    publicSigningKey: body.publicSigningKey,
    publicEncryptionKey: body.publicEncryptionKey,
    client: body.client,
    kind: body.kind,
  };
  const canonical = new TextEncoder().encode(canonicalize(signed));

  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      "raw",
      publicKeyBytes,
      { name: "Ed25519" },
      false,
      ["verify"],
    );
  } catch {
    return false;
  }
  return crypto.subtle.verify({ name: "Ed25519" }, key, signature, canonical);
}

/** Constant-time byte equality. */
function constantTimeBytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}

function formatZodError(err: z.ZodError): string {
  // Compact, single-line. Errors are framed as `path: message`; multiple
  // issues join with `; `. Good enough for client debugging — spec doesn't
  // mandate a per-field shape on the error envelope.
  return err.issues
    .map((issue) => {
      const path = issue.path.length === 0 ? "<root>" : issue.path.join(".");
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}
