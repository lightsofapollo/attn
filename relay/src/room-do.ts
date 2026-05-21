/** RoomDO — per-room Durable Object. Holds envelopes, devices, acks, and WS peers.
 *
 * Endpoints land here per planning/collab/relay-spec.md §HTTP API as the
 * 5.5-5.13 issues progress:
 *   - POST /v2/rooms/:roomId             (5.5 — implemented)
 *   - POST /v2/rooms/:roomId/devices, GET (5.6)
 *   - POST /v2/rooms/:roomId/envelopes   (5.7)
 *   - POST /v2/rooms/:roomId/acks        (5.8/5.9)
 *   - DELETE /v2/rooms/:roomId           (5.10 — implemented)
 *   - POST /v2/rooms/:roomId/blobs (R2)  (5.x)
 *   - WebSocket upgrade + frames         (5.11)
 *   - alarms (TTL + idle)                (5.12)
 *   - rate limiting                      (5.13)
 */

import { DurableObject } from "cloudflare:workers";
import { z } from "zod";

import {
  verifyAdmission,
  AdmissionError,
  base64UrlDecode,
  base64UrlEncode,
  canonicalRequest as buildCanonicalRequest,
  constantTimeEquals,
} from "./admission";
import { canonicalize, type CanonicalValue } from "./canonical";
import type { Env } from "./env";
import { OwnerSigError, verifyOwnerSignature } from "./owner-sig";
import { parsePow, POW_MAX_LIFETIME_MS, PowError, verifyPow } from "./pow";
import { presignBlobUpload, type PresignedUploadResult } from "./r2";
import { DurableObjectRateLimit, type RateLimitResult } from "./rate-limit";
import {
  acksRequestSchema,
  blobPresignRequestSchema,
  deviceRegistrationSchema,
  envelopeBatchSchema,
  roomCreationSchema,
  type DeviceRecord,
  type DeviceRegistrationRequest,
  type EnvelopeInput,
  type EnvelopeRecord,
  type RoomPolicy,
} from "./schema";

const ROOM_PATH_RE = /^\/v2\/rooms\/([^/]+)\/?$/;
const ROOM_DEVICES_PATH_RE = /^\/v2\/rooms\/([^/]+)\/devices\/?$/;
const ROOM_ENVELOPES_PATH_RE = /^\/v2\/rooms\/([^/]+)\/envelopes\/?$/;
const ROOM_ACKS_PATH_RE = /^\/v2\/rooms\/([^/]+)\/acks\/?$/;
const ROOM_SOCKET_PATH_RE = /^\/v2\/rooms\/([^/]+)\/socket\/?$/;
const ROOM_BLOBS_PATH_RE = /^\/v2\/rooms\/([^/]+)\/blobs\/?$/;
/** Any path starting with `/v2/rooms/:roomId` (optionally followed by a subroute). */
const ROOM_PATH_LOOSE_RE = /^\/v2\/rooms\/([^/]+)(?:\/.*)?$/;

/**
 * Best-effort extraction of the roomId from any room-scoped path. Used by the
 * OPTIONS preflight handler so a single regex covers `/devices`, `/envelopes`,
 * `/acks`, `/blobs`, `/socket`, and the bare `/v2/rooms/:roomId` route.
 */
function extractRoomIdAnyPath(pathname: string): string | undefined {
  const m = pathname.match(ROOM_PATH_LOOSE_RE);
  return m?.[1];
}

/**
 * Parse `ALLOWED_BROWSER_ORIGINS` (comma-separated env var) into a Set for
 * O(1) membership lookup. Whitespace and empty entries are skipped so a stray
 * trailing comma doesn't allow the empty origin.
 *
 * Duplicated from index.ts so the DO can run its WS-Origin check without
 * round-tripping back to the Worker. Both call sites must stay in sync;
 * relay-spec.md §Browser Considerations is the source of truth.
 */
function parseEnvAllowedOrigins(env: Env): Set<string> {
  const raw = env.ALLOWED_BROWSER_ORIGINS ?? "";
  const out = new Set<string>();
  for (const piece of raw.split(",")) {
    const trimmed = piece.trim();
    if (trimmed !== "") out.add(trimmed);
  }
  return out;
}

/**
 * Build the headers for a 101 WebSocket upgrade response, tagging
 * `X-Attn-Allow-Browser` so the Worker's corsMiddleware can attach CORS
 * headers when the origin is allowed. The 101 path can't be re-tagged in
 * `tagAllowBrowserOnResponse` (the runtime freezes 101 response headers
 * once the webSocket is attached), so we set the header at construction.
 */
function buildSocketUpgradeHeaders(policy: RoomPolicy | undefined): Record<string, string> {
  const headers: Record<string, string> = {
    "Sec-WebSocket-Protocol": "attn.v2",
  };
  if (policy !== undefined) {
    headers["X-Attn-Allow-Browser"] = policy.allowBrowser ? "true" : "false";
  }
  return headers;
}

/** R2 spillover threshold: snapshot_blob envelopes above this go to R2 via
 *  POST /v2/rooms/:roomId/blobs (relay-spec.md §POST /blobs). Anything at or
 *  below uses the inline envelope path, which is more efficient for small
 *  payloads (one HTTP round-trip instead of three).
 */
const BLOB_SPILLOVER_THRESHOLD_BYTES = 1 * 1024 * 1024;

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
  /**
   * Round-trip of the URL-path roomId. The DO has no built-in way to recover
   * the name it was created with, but the alarm() path needs it to walk R2
   * under `rooms/<roomId>/`. We persist it at create time and never mutate.
   */
  roomId: "meta:room_id",
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

/** Storage prefix for the pow-replay set. Walked by the alarm to prune. */
const POW_SEEN_PREFIX = "pow_seen:";

function powSeenKey(hash: string): string {
  return `${POW_SEEN_PREFIX}${hash}`;
}

/**
 * Periodic interval the alarm uses to wake for the pow-prune sweep. The spec
 * pins this at ~5 minutes (relay-spec.md §Alarms). We chose 5min so any token
 * past expiresAt + POW_MAX_LIFETIME_MS (10min) gets cleaned within ~15min.
 */
const POW_PRUNE_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Window before `expires_at` during which a WS connect re-runs the expiry
 * check as a belt-and-braces against alarm slippage. Pinned to 1h per
 * amendments.md #9 (R2 7-day safety net rationale).
 */
const PRE_EXPIRY_CLEANUP_WINDOW_MS = 60 * 60 * 1000;

/**
 * Max bytes accepted on the room-create body (abuse hardening). The create
 * payload is two base64url keys (~44 bytes each) + a small policy object, so a
 * few KB is generous. Create is reachable before admission/PoW, so we bound it
 * tightly to deny a memory-amplification vector.
 */
const ROOM_CREATE_MAX_BODY_BYTES = 4096;

interface ErrorBody {
  error: { code: string; message: string };
}

function errorResponse(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } } satisfies ErrorBody, { status });
}

/**
 * 429 builder for rate-limited DO responses. Mirrors the Worker-edge
 * helper so the wire shape (Retry-After + X-Attn-Retry-After-Ms +
 * error.retryAfterMs in body) is identical regardless of which layer
 * detected the overflow.
 */
function buildRateLimitedResponse(result: RateLimitResult): Response {
  const retryAfterMs = result.retryAfterMs ?? 60_000;
  return new Response(
    JSON.stringify({
      error: {
        code: result.code ?? "ATTN_RATE_LIMITED",
        message: "rate limit exceeded",
        retryAfterMs,
      },
    }),
    {
      status: 429,
      headers: new Headers({
        "Content-Type": "application/json",
        "Retry-After": String(Math.ceil(retryAfterMs / 1000)),
        "X-Attn-Retry-After-Ms": String(retryAfterMs),
      }),
    },
  );
}

interface HardLimits {
  maxPeers: number;
  maxSnapshotBytes: number;
  maxEventBytes: number;
  maxEvents: number;
  maxRoomBytes: number;
  maxBatchEnvelopes: number;
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
    maxRoomBytes: parsePositiveInt(env.HARD_MAX_ROOM_BYTES, "HARD_MAX_ROOM_BYTES"),
    maxBatchEnvelopes: parsePositiveInt(env.HARD_MAX_BATCH_ENVELOPES, "HARD_MAX_BATCH_ENVELOPES"),
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
    const response = await this.dispatch(request);
    // CORS handshake (attn-nnj.9.5): every response from this DO is tagged with
    // an `X-Attn-Allow-Browser` header reflecting the room's `policy.allowBrowser`
    // setting. The Worker reads + strips this header on the response edge to
    // decide whether to attach CORS headers. We tag at the DO boundary so the
    // Worker doesn't need its own policy fetch round-trip on every request.
    return this.tagAllowBrowserOnResponse(request, response);
  }

  private async dispatch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const roomMatch = url.pathname.match(ROOM_PATH_RE);

    // CORS preflight (attn-nnj.9.5). Browser clients hit OPTIONS before any
    // cross-origin POST/DELETE/GET; we answer 204 with no body. The Worker
    // attaches CORS headers based on `X-Attn-Allow-Browser`. We accept OPTIONS
    // on any room-scoped path so the same handler covers /devices, /envelopes,
    // /acks, /blobs, /socket.
    if (request.method === "OPTIONS") {
      // The DO is addressed by roomId — pull it from whichever room-scoped
      // path matched. Use the broadest matcher (ROOM_PATH_RE matches only
      // `/v2/rooms/:roomId`); for sub-paths we extract via a lenient regex.
      const roomId = roomMatch?.[1] ?? extractRoomIdAnyPath(url.pathname);
      if (roomId === undefined || roomId === "") {
        return errorResponse(400, "ATTN_ROOM_ID_INVALID", "roomId required");
      }
      return this.handleOptionsPreflight(roomId);
    }

    if (roomMatch && request.method === "POST") {
      const roomId = roomMatch[1];
      if (roomId === undefined || roomId === "") {
        return errorResponse(400, "ATTN_ROOM_ID_INVALID", "roomId required");
      }
      return this.handleRoomCreate(request, roomId);
    }

    if (roomMatch && request.method === "DELETE") {
      const roomId = roomMatch[1];
      if (roomId === undefined || roomId === "") {
        return errorResponse(400, "ATTN_ROOM_ID_INVALID", "roomId required");
      }
      return this.handleRoomDelete(request, roomId, url.pathname);
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

    const envelopesMatch = url.pathname.match(ROOM_ENVELOPES_PATH_RE);
    if (envelopesMatch) {
      const roomId = envelopesMatch[1];
      if (roomId === undefined || roomId === "") {
        return errorResponse(400, "ATTN_ROOM_ID_INVALID", "roomId required");
      }
      if (request.method === "POST") {
        return this.handleEnvelopesIngest(request, roomId, url.pathname);
      }
      return errorResponse(405, "ATTN_METHOD_NOT_ALLOWED", `${request.method} not allowed on /envelopes`);
    }

    const acksMatch = url.pathname.match(ROOM_ACKS_PATH_RE);
    if (acksMatch) {
      const roomId = acksMatch[1];
      if (roomId === undefined || roomId === "") {
        return errorResponse(400, "ATTN_ROOM_ID_INVALID", "roomId required");
      }
      if (request.method === "POST") {
        return this.handleAcks(request, roomId, url.pathname);
      }
      return errorResponse(405, "ATTN_METHOD_NOT_ALLOWED", `${request.method} not allowed on /acks`);
    }

    const blobsMatch = url.pathname.match(ROOM_BLOBS_PATH_RE);
    if (blobsMatch) {
      const roomId = blobsMatch[1];
      if (roomId === undefined || roomId === "") {
        return errorResponse(400, "ATTN_ROOM_ID_INVALID", "roomId required");
      }
      if (request.method === "POST") {
        return this.handleBlobPresign(request, roomId, url.pathname);
      }
      return errorResponse(405, "ATTN_METHOD_NOT_ALLOWED", `${request.method} not allowed on /blobs`);
    }

    const socketMatch = url.pathname.match(ROOM_SOCKET_PATH_RE);
    if (socketMatch) {
      const roomId = socketMatch[1];
      if (roomId === undefined || roomId === "") {
        return errorResponse(400, "ATTN_ROOM_ID_INVALID", "roomId required");
      }
      return this.handleSocketUpgrade(request, roomId, url);
    }

    // Other endpoints land in 5.8-5.13.
    return errorResponse(404, "ATTN_NOT_FOUND", `no handler for ${request.method} ${url.pathname}`);
  }

  /**
   * CORS preflight. Returns 204 unconditionally — the Worker decides whether
   * to attach actual CORS headers based on the `X-Attn-Allow-Browser` header
   * that `tagAllowBrowserOnResponse` adds.
   *
   * We deliberately respond 204 even when the room has `allowBrowser=false` so
   * the response doesn't leak existence: a 404 here would let an attacker
   * enumerate rooms by sending OPTIONS preflights and watching for the
   * difference between 204 (room exists, browser disallowed) and 404 (room
   * doesn't exist). The CORS-header-absence on the Worker side is the only
   * signal a non-browser-allowed room gives.
   */
  private async handleOptionsPreflight(_roomId: string): Promise<Response> {
    return new Response(null, { status: 204 });
  }

  /**
   * Post-process every response leaving the DO and tag it with
   * `X-Attn-Allow-Browser: true|false` based on the room's stored
   * `policy.allowBrowser`. The Worker strips this header before returning
   * to the client — see `corsMiddleware` in index.ts.
   *
   * For rooms that don't exist (no stored policy), we omit the header
   * entirely. This avoids leaking room existence on routes that return
   * 404 (the absence of the header on a `/socket` 404 is indistinguishable
   * from the room being native-only).
   *
   * On a 101 WebSocket upgrade response, the runtime won't let us mutate
   * headers post-construction; the DO already builds the 101 response with
   * the right header via `withAllowBrowserHeader` so this branch is a no-op.
   */
  private async tagAllowBrowserOnResponse(
    request: Request,
    response: Response,
  ): Promise<Response> {
    // Don't touch 101 — the runtime treats the response headers as frozen
    // once the webSocket field is attached. handleSocketUpgrade is
    // responsible for setting the header at construction time.
    if (response.status === 101) return response;

    let policy: RoomPolicy | undefined;
    try {
      policy = await this.ctx.storage.get<RoomPolicy>(META.policy);
    } catch {
      policy = undefined;
    }
    if (policy === undefined) return response;

    // Rebuild the response so we can mutate headers (the original headers may
    // be immutable depending on how the inner handler constructed it).
    const newHeaders = new Headers(response.headers);
    newHeaders.set("X-Attn-Allow-Browser", policy.allowBrowser ? "true" : "false");
    void request; // silenced — kept in signature for future per-method tagging
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: newHeaders,
    });
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
   *   - Additionally, per security-review.md §H1, we require an
   *     `Attn-Owner-Signature` Ed25519 signature over canonicalRequest,
   *     verified against the `ownerSigningKey` in the body. This proves the
   *     requester actually owns the private half of the key they're about to
   *     register, so a leaked URL alone cannot register a forged owner.
   *
   * Rejoin path:
   *   - admissionKey is loaded from DO storage and verified BEFORE we touch
   *     the body. We deliberately do not re-parse / re-validate the body on
   *     rejoin — the stored policy is authoritative and immutable (spec:
   *     "Do not allow policy mutation after creation; that would let a
   *     stolen URL extend a room's TTL"). No new owner-signature is required
   *     on rejoin: the room's owner identity was bound at first-create and
   *     can't be replaced; subsequent owner-privileged ops verify against the
   *     stored `ownerSigningKey` directly.
   */
  private async handleRoomCreate(request: Request, roomId: string): Promise<Response> {
    const limits = readHardLimits(this.env);

    // Body-size guard (abuse hardening). The create body is tiny — two keys +
    // a small policy object — so anything over a few KB is junk/abuse. Reject
    // on a declared Content-Length BEFORE buffering: create is one of the few
    // routes reachable before admission/PoW, so an unbounded read here is a
    // cheap memory-amplification vector.
    const declaredLen = Number(request.headers.get("Content-Length") ?? "");
    if (Number.isFinite(declaredLen) && declaredLen > ROOM_CREATE_MAX_BODY_BYTES) {
      return errorResponse(413, "ATTN_BODY_TOO_LARGE", `create body exceeds ${ROOM_CREATE_MAX_BODY_BYTES} bytes`);
    }

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
    // Belt-and-braces: Content-Length may be absent (chunked) or lie. Reject
    // the actual buffered size too.
    if (bodyBytes.byteLength > ROOM_CREATE_MAX_BODY_BYTES) {
      return errorResponse(413, "ATTN_BODY_TOO_LARGE", `create body exceeds ${ROOM_CREATE_MAX_BODY_BYTES} bytes`);
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

    // H1 defense (planning/collab/security-review.md §H1): require
    // `Attn-Owner-Signature` on first-create so the requester proves possession
    // of the private half of `ownerSigningKey`. URL leakage alone is no longer
    // sufficient to claim ownership — the attacker would also need the owner's
    // Ed25519 private key, which never leaves the legitimate owner's device.
    //
    // Self-rooting: we verify the signature against the public key in the body
    // (which we just decoded above), not against a stored key. This is exactly
    // the trust assumption we want for the first POST.
    //
    // We rebuild a `Request` from the buffered bytes so verifyOwnerSignature
    // can re-clone the body without racing the original (already-drained) stream.
    try {
      const buffered = new Request(request.url, {
        method: request.method,
        headers: request.headers,
        body: bodyBytes.byteLength === 0 ? null : bodyBytes,
      });
      await verifyOwnerSignature(buffered, new URL(request.url).pathname, ownerKeyBytes);
    } catch (err) {
      if (err instanceof OwnerSigError) {
        return errorResponse(403, err.code, err.message);
      }
      throw err;
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
      [META.roomId]: roomId,
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

    // Schedule the TTL/idle alarm. The alarm() handler owns the actual
    // expire/prune logic; `rescheduleAlarm()` picks the earliest of
    // (hard_max_at, last_event_at + idleTimeoutMs, next_pow_prune_at).
    await this.rescheduleAlarm({
      now: createdAt,
      hardMaxAt: clamped.hardMaxAt,
      lastEventAt: createdAt,
      idleTimeoutMs: clamped.idleTimeoutMs,
    });

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

    // 3. Per-device rate limit (attn-nnj.5.13). Sits between admission and
    //    PoW so admitted-but-noisy clients see a 429 immediately rather
    //    than burning PoW cycles only to be rate-rejected.
    const rateRejection = await this.enforceDeviceRateLimit(body.deviceId);
    if (rateRejection !== undefined) return rateRejection;

    // 4. PoW — burnt once per request. Header carries the token verbatim.
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

    // 5. Decode the signing key + verify selfSignature.
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

  // -- POST /v2/rooms/:roomId/envelopes -----------------------------------

  /**
   * Batched envelope ingest per relay-spec.md §POST /v2/rooms/:roomId/envelopes
   * and amendments.md #6 (PoW on every write) + #7 (batch cap 32).
   *
   * Flow:
   *   1. Admission (HMAC) — single token for the whole batch.
   *   2. PoW            — single token bound to (roomId, deviceId-of-first-envelope,
   *                       POST, /v2/rooms/:roomId/envelopes). The spec requires
   *                       one PoW per HTTP request; we tie it to the first
   *                       envelope's deviceId so the spec's "deviceId" binding
   *                       still maps onto a concrete value.
   *   3. Batch cap      — > 32 envelopes → 400 ATTN_BATCH_TOO_LARGE.
   *   4. Per-envelope:
   *        - decoded ciphertext length == ciphertextBytes (400 LENGTH_MISMATCH)
   *        - kind size cap (413 ENVELOPE_TOO_LARGE)
   *        - (authorId, deviceId) registered (400 DEVICE_UNREGISTERED)
   *   5. Running totals against policy.maxEvents + HARD_MAX_ROOM_BYTES
   *      (whole batch rejected on overflow — 507 ROOM_EVENT_CAP / ROOM_STORAGE_FULL).
   *   6. Atomic put-many: every accepted envelope writes
   *        env:<seq>:<id>, env_idx:<id>, and (signal-only) env_by_target:<targetDeviceId>:<seq>:<id>
   *      plus meta updates (server_seq, envelope_count, bytes_used, last_event_at).
   *      Idempotency: env_idx:<id> hit → reuse prior serverSeq, skip storage write.
   *   7. Signal sub-cap: per (authorId, target.deviceId), evict oldest entries
   *      past maxSignalEnvelopes=64 (FIFO).
   *   8. Alarm reschedule on accept.
   *
   * WS broadcast (5.11) is out of scope here — accepted envelopes are buffered
   * by storage and re-delivered to subscribers on hibernation resume.
   */
  private async handleEnvelopesIngest(
    request: Request,
    roomId: string,
    urlPath: string,
  ): Promise<Response> {
    const limits = readHardLimits(this.env);
    const storedAdmissionKey = await this.ctx.storage.get<Uint8Array>(META.admissionKey);
    if (storedAdmissionKey === undefined) {
      return errorResponse(404, "ATTN_ROOM_NOT_FOUND", `room ${roomId} does not exist`);
    }

    // Buffer the body up front — verifyAdmission, JSON.parse, and the bulk
    // decode all need a non-streamed copy.
    let bodyBytes: Uint8Array;
    try {
      bodyBytes = new Uint8Array(await request.arrayBuffer());
    } catch (err) {
      return errorResponse(400, "ATTN_BODY_INVALID", `request body read failed: ${(err as Error).message}`);
    }

    // 1. Admission.
    try {
      const buffered = bufferedRequest(request, bodyBytes);
      await verifyAdmission(buffered, urlPath, { roomId, admissionKey: storedAdmissionKey });
    } catch (err) {
      if (err instanceof AdmissionError) {
        return errorResponse(401, err.code, err.message);
      }
      throw err;
    }

    // Parse + schema-validate so we have a deviceId for the PoW binding and the
    // batch size for the cap check.
    let parsed: unknown;
    try {
      const text = new TextDecoder().decode(bodyBytes);
      parsed = JSON.parse(text);
    } catch (err) {
      return errorResponse(400, "ATTN_BODY_INVALID", `request body is not valid JSON: ${(err as Error).message}`);
    }

    // 3. Batch cap — checked BEFORE zod so we surface the spec error code
    //    even when the body shape would also fail other checks.
    if (typeof parsed === "object" && parsed !== null && "envelopes" in parsed) {
      const envs = (parsed as { envelopes: unknown }).envelopes;
      if (Array.isArray(envs) && envs.length > limits.maxBatchEnvelopes) {
        return errorResponse(
          400,
          "ATTN_BATCH_TOO_LARGE",
          `batch contains ${envs.length} envelopes, max ${limits.maxBatchEnvelopes}`,
        );
      }
    }

    const result = envelopeBatchSchema.safeParse(parsed);
    if (!result.success) {
      return errorResponse(400, "ATTN_BODY_INVALID", formatZodError(result.error));
    }
    const batch = result.data;
    // Re-check cap post-zod (zod already enforces .max(32) but a future bump
    // should still surface the canonical error code).
    if (batch.envelopes.length > limits.maxBatchEnvelopes) {
      return errorResponse(
        400,
        "ATTN_BATCH_TOO_LARGE",
        `batch contains ${batch.envelopes.length} envelopes, max ${limits.maxBatchEnvelopes}`,
      );
    }

    // 2. PoW — bound to (roomId, first envelope's deviceId, POST, urlPath).
    //    Every envelope in a batch should share the author/device per the
    //    crypto-spec usage pattern; we don't enforce that here (the spec is
    //    silent on cross-device batching), we just pin PoW to the first
    //    envelope so a single token works.
    const policy = await this.ctx.storage.get<RoomPolicy>(META.policy);
    if (policy === undefined) {
      return errorResponse(500, "ATTN_ROOM_CORRUPT", `room ${roomId} missing policy`);
    }
    const powToken = request.headers.get("Attn-PoW");
    if (powToken === null || powToken === "") {
      return errorResponse(400, "ATTN_POW_INVALID", "missing Attn-PoW header");
    }
    const first = batch.envelopes[0];
    if (first === undefined) {
      // zod's .min(1) makes this unreachable, but the type narrows for TS.
      return errorResponse(400, "ATTN_BODY_INVALID", "empty envelope batch");
    }

    // 2a. Per-device rate limit (attn-nnj.5.13). Per relay-spec.md §Anti-Abuse,
    //     all POST /envelopes traffic counts toward the per-device cap.
    //     A batch is a single HTTP request so it bumps the counter once, not
    //     N times; this matches the spec's "120/min/device" framing where
    //     the unit is "request", not "envelope".
    const rateRejection = await this.enforceDeviceRateLimit(first.deviceId);
    if (rateRejection !== undefined) return rateRejection;

    try {
      await verifyPow(powToken, {
        roomId,
        deviceId: first.deviceId,
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

    // 4. Per-envelope validation. We collect everything first and bail on the
    //    first error so the whole batch is rejected atomically (spec wording
    //    says "reject the *whole batch*" for cap overflow; per-envelope shape
    //    errors mirror that for symmetry — partial accepts are footguns).
    const decodedLengths = new Map<string, number>();
    for (const env of batch.envelopes) {
      let decodedLen: number;
      try {
        // We only need the length, not the bytes themselves.
        decodedLen = base64UrlDecode(env.ciphertext).length;
      } catch (err) {
        return errorResponse(
          400,
          "ATTN_BODY_INVALID",
          `envelope ${env.envelopeId} ciphertext base64url decode failed: ${(err as Error).message}`,
        );
      }
      if (decodedLen !== env.ciphertextBytes) {
        return errorResponse(
          400,
          "ATTN_CIPHERTEXT_LENGTH_MISMATCH",
          `envelope ${env.envelopeId} ciphertextBytes=${env.ciphertextBytes} != decoded=${decodedLen}`,
        );
      }
      decodedLengths.set(env.envelopeId, decodedLen);

      const sizeCap =
        env.kind === "snapshot_blob" ? policy.maxSnapshotBytes : policy.maxEventBytes;
      if (env.ciphertextBytes > sizeCap) {
        return errorResponse(
          413,
          "ATTN_ENVELOPE_TOO_LARGE",
          `envelope ${env.envelopeId} kind=${env.kind} ciphertextBytes=${env.ciphertextBytes} > cap ${sizeCap}`,
        );
      }

      // Device registration check. We look up by (authorId/participantId,
      // deviceId) — `authorId` is the participantId on the wire per the spec.
      const deviceKey = deviceStorageKey(env.authorId, env.deviceId);
      const deviceRecord = await this.ctx.storage.get<DeviceRecord>(deviceKey);
      if (deviceRecord === undefined) {
        return errorResponse(
          400,
          "ATTN_DEVICE_UNREGISTERED",
          `envelope ${env.envelopeId} (authorId=${env.authorId}, deviceId=${env.deviceId}) not registered`,
        );
      }
    }

    // 5. Idempotency + running-totals.
    //    Split the batch into (a) duplicates (already in env_idx) and (b)
    //    fresh envelopes that need a new serverSeq + storage write.
    const accepted: Array<{ envelopeId: string; serverSeq: number }> = [];
    const fresh: EnvelopeInput[] = [];

    for (const env of batch.envelopes) {
      const idx = await this.ctx.storage.get<string>(envIndexKey(env.envelopeId));
      if (idx !== undefined) {
        // `idx` is the padded serverSeq string. Parse to surface in the response.
        const prevSeq = Number(idx);
        if (!Number.isSafeInteger(prevSeq) || prevSeq <= 0) {
          return errorResponse(
            500,
            "ATTN_ROOM_CORRUPT",
            `env_idx for ${env.envelopeId} not a valid serverSeq: ${idx}`,
          );
        }
        accepted.push({ envelopeId: env.envelopeId, serverSeq: prevSeq });
      } else {
        fresh.push(env);
      }
    }

    // Cap checks operate on the fresh subset (duplicates don't change totals).
    const [curCount, curBytes, curServerSeq] = await Promise.all([
      this.ctx.storage.get<number>(META.envelopeCount),
      this.ctx.storage.get<number>(META.bytesUsed),
      this.ctx.storage.get<number>(META.serverSeq),
    ]);
    const runningCount = curCount ?? 0;
    const runningBytes = curBytes ?? 0;
    const runningSeq = curServerSeq ?? 0;

    const addedCount = fresh.length;
    let addedBytes = 0;
    for (const env of fresh) addedBytes += env.ciphertextBytes;

    if (runningCount + addedCount > policy.maxEvents) {
      return errorResponse(
        507,
        "ATTN_ROOM_EVENT_CAP",
        `room ${roomId} event cap reached (have ${runningCount}, +${addedCount} > ${policy.maxEvents})`,
      );
    }
    if (runningBytes + addedBytes > limits.maxRoomBytes) {
      return errorResponse(
        507,
        "ATTN_ROOM_STORAGE_FULL",
        `room ${roomId} storage cap reached (have ${runningBytes}, +${addedBytes} > ${limits.maxRoomBytes})`,
      );
    }

    // 6. Build the atomic write map. We compute the next serverSeq locally,
    //    insert env: + env_idx: + (signal-only) env_by_target: keys, then commit
    //    in a single put-many call. DO storage commits put-many atomically
    //    within one event (see relay-spec.md §serverSeq Allocation).
    const now = Date.now();
    const writeMap: Record<string, unknown> = {};
    let nextSeq = runningSeq;

    // Signal evictions are computed up-front so the put-many includes the
    // delete-equivalent (we'll handle deletes in a follow-up storage call;
    // DO put-many doesn't support a `delete` set, so we batch the puts and
    // then issue a delete-many for evicted keys).
    interface PlannedSignal {
      authorId: string;
      targetDeviceId: string;
      paddedSeq: string;
      envelopeId: string;
    }
    const newSignals: PlannedSignal[] = [];

    for (const env of fresh) {
      nextSeq += 1;
      const paddedSeq = padServerSeq(nextSeq);
      const record: EnvelopeRecord = {
        ...env,
        target: env.target ?? null,
        serverSeq: nextSeq,
      };
      writeMap[envStorageKey(paddedSeq, env.envelopeId)] = record;
      writeMap[envIndexKey(env.envelopeId)] = paddedSeq;
      if (env.kind === "signal" && env.target?.deviceId !== undefined) {
        writeMap[envByTargetKey(env.target.deviceId, paddedSeq, env.envelopeId)] = "";
        newSignals.push({
          authorId: env.authorId,
          targetDeviceId: env.target.deviceId,
          paddedSeq,
          envelopeId: env.envelopeId,
        });
      }
      accepted.push({ envelopeId: env.envelopeId, serverSeq: nextSeq });
    }

    // Meta updates — only re-write the keys that actually changed when there
    // are fresh envelopes. For an all-duplicates batch the response goes out
    // without touching meta so caps remain authoritative.
    if (fresh.length > 0) {
      writeMap[META.serverSeq] = nextSeq;
      writeMap[META.envelopeCount] = runningCount + addedCount;
      writeMap[META.bytesUsed] = runningBytes + addedBytes;
      writeMap[META.lastEventAt] = now;
    }

    if (Object.keys(writeMap).length > 0) {
      await this.ctx.storage.put<unknown>(writeMap);
    }

    // 7. Signal sub-cap — per (authorId, targetDeviceId) pair, FIFO-evict
    //    anything past maxSignalEnvelopes=64. We do this AFTER the atomic put
    //    so the cap operates on the post-insert state. Evictions delete both
    //    the env: payload and the env_by_target: index entry; we leave
    //    env_idx: in place so idempotent retries still resolve (the prior
    //    serverSeq is still useful to clients even if the payload is gone).
    if (newSignals.length > 0) {
      // Group by (authorId, targetDeviceId) so we only scan each bucket once.
      const buckets = new Map<string, PlannedSignal[]>();
      for (const s of newSignals) {
        const bucketKey = `${s.authorId} ${s.targetDeviceId}`;
        const arr = buckets.get(bucketKey) ?? [];
        arr.push(s);
        buckets.set(bucketKey, arr);
      }
      for (const bucketKey of buckets.keys()) {
        const [authorId, targetDeviceId] = bucketKey.split(" ") as [string, string];
        await this.evictExcessSignals(authorId, targetDeviceId, MAX_SIGNAL_ENVELOPES_PER_PAIR);
      }
    }

    // 8. Reschedule alarm if anything was accepted (idle window advances).
    if (fresh.length > 0) {
      const hardMaxAt = await this.ctx.storage.get<number>(META.hardMaxAt);
      if (hardMaxAt !== undefined) {
        await this.rescheduleAlarm({
          now,
          hardMaxAt,
          lastEventAt: now,
          idleTimeoutMs: policy.idleTimeoutMs ?? limits.defaultIdleTimeoutMs,
        });
      }
    }

    // WS broadcast (5.11). Push each freshly-accepted envelope to live WS
    // peers. Sub-cap eviction above may have removed a freshly-stored signal
    // before we get here; we still broadcast (subscribers heard the offer in
    // real time even though replay-after-reconnect skips it). Per-target
    // filtering: kind=signal envelopes only deliver to target.deviceId.
    if (fresh.length > 0) {
      this.broadcastFreshEnvelopes(fresh, nextSeq);
    }

    // Sort accepted by serverSeq so clients see a stable order matching
    // request order for fresh envelopes (duplicates land at their prior seq,
    // which may be lower; that's expected per the spec's idempotency note).
    accepted.sort((a, b) => a.serverSeq - b.serverSeq);

    return Response.json({ accepted }, { status: 201 });
  }

  /**
   * Walk the `env_by_target:<targetDeviceId>:` index, find entries whose
   * payload was authored by `authorId`, and FIFO-evict anything past `cap`.
   *
   * The env_by_target index doesn't carry authorId, so we have to load each
   * payload to filter. For a 64-entry sub-cap this is bounded — at most ~65
   * reads per insert that triggers eviction. Bigger sub-caps would need a
   * dedicated `env_signal_by_pair:<authorId>:<targetDeviceId>:<seq>` index;
   * we don't need that for v2.
   */
  private async evictExcessSignals(
    authorId: string,
    targetDeviceId: string,
    cap: number,
  ): Promise<void> {
    const prefix = envByTargetPrefix(targetDeviceId);
    const entries = await this.ctx.storage.list<string>({ prefix });
    interface Found {
      paddedSeq: string;
      envelopeId: string;
      byTargetKey: string;
    }
    const matches: Found[] = [];
    for (const orderKey of entries.keys()) {
      const parsed = parseEnvByTargetKey(orderKey);
      if (parsed === undefined) continue;
      // We need the payload to filter on authorId. The payload key contains
      // the seq + envelopeId so we can reconstruct it directly.
      const payloadKey = envStorageKey(parsed.paddedSeq, parsed.envelopeId);
      const record = await this.ctx.storage.get<EnvelopeRecord>(payloadKey);
      if (record === undefined || record.authorId !== authorId) continue;
      matches.push({
        paddedSeq: parsed.paddedSeq,
        envelopeId: parsed.envelopeId,
        byTargetKey: orderKey,
      });
    }
    if (matches.length <= cap) return;
    // entries.keys() iteration order is lex over the padded seq, which is
    // chronological. Evict the oldest (lowest seq) entries first.
    matches.sort((a, b) => (a.paddedSeq < b.paddedSeq ? -1 : a.paddedSeq > b.paddedSeq ? 1 : 0));
    const toEvict = matches.slice(0, matches.length - cap);
    const keysToDelete: string[] = [];
    for (const ev of toEvict) {
      keysToDelete.push(envStorageKey(ev.paddedSeq, ev.envelopeId));
      keysToDelete.push(ev.byTargetKey);
      // Leave env_idx alone so an idempotent re-upload still resolves to the
      // (now-deleted) serverSeq. Clients can detect via list-style fetches if
      // they care; for signal envelopes they normally don't re-fetch.
    }
    if (keysToDelete.length > 0) {
      await this.ctx.storage.delete(keysToDelete);
    }
  }

  // -- POST /v2/rooms/:roomId/acks ----------------------------------------

  /**
   * Acknowledge envelopes per relay-spec.md §POST /v2/rooms/:roomId/acks and
   * amendments.md #12 (deleteEventsAfterOwnerAck defaults to false).
   *
   * Per spec the request shape is `{ackedEnvelopeIds, deviceId}` plus headers:
   *   - `Attn-Admission` always required.
   *   - `Attn-PoW` always required (write endpoint).
   *   - `Attn-Owner-Signature` required IF AND ONLY IF the caller wants
   *     deletion AND `policy.deleteEventsAfterOwnerAck == true`. The presence
   *     of the header is the caller's signal of delete-intent; without it, we
   *     just record the ACK and keep the envelope until TTL.
   *
   * Deletion gating (defensive layering):
   *   1. Owner-sig header present? If not → no-delete branch.
   *   2. policy.deleteEventsAfterOwnerAck == true? If not → header is ignored
   *      (no error). Lets clients always send the header without coordinating
   *      on policy state.
   *   3. The acking device's stored record has kind == "owner"? If not →
   *      header ignored (per task pin: "ignore non-owner signatures silently
   *      and don't delete — be conservative"). Reviewers can't unlock the
   *      delete path even if they somehow produce a valid-looking header.
   *   4. verifyOwnerSignature passes? If not → 403. (At this point the caller
   *      claimed owner-intent on an owner device against a delete-enabled
   *      policy; a signature mismatch is an attempted forgery.)
   *
   * Idempotency:
   *   - Acking an envelope that no longer exists (already deleted) is 204.
   *   - Re-acking an envelope only re-writes its `ack:<deviceId>:<envelopeId>`
   *     slot with the current timestamp; counts/bytes aren't double-decremented
   *     because deletion is gated on env_idx existence.
   *   - Acking an unknown envelopeId is 204 (per spec: "Acking a non-existent
   *     or already-deleted envelope is `204`").
   *
   * Response: 204 No Content.
   */
  private async handleAcks(
    request: Request,
    roomId: string,
    urlPath: string,
  ): Promise<Response> {
    const storedAdmissionKey = await this.ctx.storage.get<Uint8Array>(META.admissionKey);
    if (storedAdmissionKey === undefined) {
      return errorResponse(404, "ATTN_ROOM_NOT_FOUND", `room ${roomId} does not exist`);
    }

    // Buffer body so admission/owner-sig + JSON.parse can both read it.
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

    // 2. Parse body (need deviceId to bind PoW).
    let parsed: unknown;
    try {
      const text = new TextDecoder().decode(bodyBytes);
      parsed = JSON.parse(text);
    } catch (err) {
      return errorResponse(400, "ATTN_BODY_INVALID", `request body is not valid JSON: ${(err as Error).message}`);
    }
    const result = acksRequestSchema.safeParse(parsed);
    if (!result.success) {
      return errorResponse(400, "ATTN_BODY_INVALID", formatZodError(result.error));
    }
    const body = result.data;

    // 3. Per-device rate limit (attn-nnj.5.13).
    const rateRejection = await this.enforceDeviceRateLimit(body.deviceId);
    if (rateRejection !== undefined) return rateRejection;

    // 4. PoW — bound to (roomId, body.deviceId, POST, urlPath).
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

    // 5. Deletion gating — see method docstring for layering rationale.
    //    `deleteIntent` is the caller asking for deletion (owner-sig header
    //    present). `mayDelete` only flips true if every layer below also
    //    holds (policy enabled, acking device is owner-kind, signature ok).
    const ownerSigHeader = request.headers.get("Attn-Owner-Signature");
    const deleteIntent = ownerSigHeader !== null && ownerSigHeader !== "";

    // Look up the acking device's record. Used both for kind-gating the
    // owner branch and for surfacing a clear 4xx if the device isn't known.
    const ackingDevice = await this.findDeviceByDeviceId(body.deviceId);

    let mayDelete = false;
    if (
      deleteIntent &&
      policy.deleteEventsAfterOwnerAck === true &&
      ackingDevice !== undefined &&
      ackingDevice.kind === "owner"
    ) {
      // Layer 4: verify the signature. A failure here is an attempted forgery
      // (caller signaled owner-intent against an owner device + delete-enabled
      // policy) so we surface 403 rather than silently downgrading to ack-only.
      const ownerKey = await this.ctx.storage.get<Uint8Array>(META.ownerSigningKey);
      if (ownerKey === undefined) {
        return errorResponse(500, "ATTN_ROOM_CORRUPT", `room ${roomId} missing owner key`);
      }
      try {
        // Owner-sig consumes the body via request.clone() inside canonicalRequest;
        // wrap a fresh buffered Request so the body bytes stay readable.
        const buffered = bufferedRequest(request, bodyBytes);
        await verifyOwnerSignature(buffered, urlPath, ownerKey);
        mayDelete = true;
      } catch (err) {
        if (err instanceof OwnerSigError) {
          return errorResponse(403, err.code, err.message);
        }
        throw err;
      }
    }

    // 5. Per-envelope: mark per-device ACK, optionally delete.
    //    We collect writes and deletes and commit at the end so partial failures
    //    leave the storage atomically advanced.
    const writes: Record<string, unknown> = {};
    const keysToDelete: string[] = [];
    let bytesDelta = 0;
    let countDelta = 0;
    const ackedAt = Date.now();
    // Track the lowest paddedSeq we deleted so we can advance
    // meta:oldest_retained_seq when a leading run drops away.
    let minDeletedPaddedSeq: string | undefined;

    for (const envelopeId of body.ackedEnvelopeIds) {
      // Per-device ACK slot. Always re-written with the latest timestamp so a
      // re-ack noticeably updates the slot; idempotent in the count/bytes
      // sense (we only debit storage when we actually delete the envelope).
      writes[ackKey(body.deviceId, envelopeId)] = ackedAt;

      if (!mayDelete) continue;

      // Lookup the env_idx to find the padded seq of this envelope's payload.
      // Missing entry = already deleted (or never existed) → idempotent no-op.
      const paddedSeq = await this.ctx.storage.get<string>(envIndexKey(envelopeId));
      if (paddedSeq === undefined) continue;
      const payloadKey = envStorageKey(paddedSeq, envelopeId);
      const record = await this.ctx.storage.get<EnvelopeRecord>(payloadKey);
      if (record === undefined) {
        // env_idx present but payload missing — corrupt state; drop the idx
        // entry too so a retry doesn't re-trip this branch.
        keysToDelete.push(envIndexKey(envelopeId));
        continue;
      }

      // Track ack_owner so future scans (e.g., GET /envelopes filters) can
      // tell that an owner ack happened even after the payload is gone.
      writes[ackOwnerKey(envelopeId)] = "";

      // Stage the storage deletes. We hold env_idx around for retries to keep
      // landing as no-ops; deleting the payload + env_by_target entries is
      // enough to free the bytes.
      keysToDelete.push(payloadKey);
      keysToDelete.push(envIndexKey(envelopeId));
      if (record.kind === "signal" && record.target?.deviceId !== undefined) {
        keysToDelete.push(envByTargetKey(record.target.deviceId, paddedSeq, envelopeId));
      }
      bytesDelta -= record.ciphertextBytes;
      countDelta -= 1;

      if (minDeletedPaddedSeq === undefined || paddedSeq < minDeletedPaddedSeq) {
        minDeletedPaddedSeq = paddedSeq;
      }
    }

    // 6. Meta updates on actual deletion. We re-read the current counters
    //    inside the same DO event so the writes commit on a consistent base.
    if (mayDelete && (countDelta !== 0 || bytesDelta !== 0)) {
      const [curCount, curBytes, curOldestRetained] = await Promise.all([
        this.ctx.storage.get<number>(META.envelopeCount),
        this.ctx.storage.get<number>(META.bytesUsed),
        this.ctx.storage.get<number>(META.oldestRetainedSeq),
      ]);
      const newCount = Math.max(0, (curCount ?? 0) + countDelta);
      const newBytes = Math.max(0, (curBytes ?? 0) + bytesDelta);
      writes[META.envelopeCount] = newCount;
      writes[META.bytesUsed] = newBytes;

      // Advance oldest_retained_seq if the lowest envelope still alive is
      // beyond the previous mark. Scan env_idx forward from the prior mark to
      // find the new floor; bounded by the number of deleted envelopes in this
      // batch (worst case: 100).
      if (minDeletedPaddedSeq !== undefined) {
        const prevOldest = curOldestRetained ?? 0;
        const newOldest = await this.findOldestRetainedSeq(prevOldest);
        if (newOldest > prevOldest) {
          writes[META.oldestRetainedSeq] = newOldest;
        }
      }
    }

    if (Object.keys(writes).length > 0) {
      await this.ctx.storage.put<unknown>(writes);
    }
    if (keysToDelete.length > 0) {
      await this.ctx.storage.delete(keysToDelete);
    }

    return new Response(null, { status: 204 });
  }

  // -- POST /v2/rooms/:roomId/blobs ---------------------------------------

  /**
   * R2 spillover presign endpoint per relay-spec.md §POST /v2/rooms/:roomId/blobs.
   *
   * Returns a short-lived upload capability the client uses to PUT the raw
   * ciphertext directly to R2 (via the Worker's internal route — see r2.ts
   * docstring for the trade-off vs. real S3 presigning).
   *
   * Layered checks (mirror the other write endpoints):
   *   1. Room exists (admissionKey loaded from DO storage; 404 otherwise).
   *   2. Admission HMAC.
   *   3. Schema-validate body so we have a deviceId for the PoW binding + the
   *      ciphertextBytes value for the spillover threshold + cap checks.
   *   4. PoW — bound to (roomId, body.deviceId, POST, urlPath).
   *   5. Threshold gate: `ciphertextBytes > 1 MiB`. Below that → 400, the
   *      client should use the inline envelope path.
   *   6. Hard cap: `policy.maxSnapshotBytes` upper bound (no point reserving
   *      a slot the eventual POST /envelopes would reject).
   *   7. Room-bytes cap: `(meta:bytes_used + meta:bytes_used_r2 + ciphertextBytes)
   *      <= HARD_MAX_ROOM_BYTES`. Reserve up-front so two concurrent presigns
   *      cannot double-spend the remaining budget.
   *   8. Device registration check — (authorId, deviceId) must be registered.
   *   9. Persist a reservation record at `blob_resv:<envelopeId>` carrying the
   *      reserved byte count + token expiry. The PUT route consumes the
   *      reservation; the GET route is independent and only checks R2 directly.
   *  10. Mint upload capability + return.
   *
   * Reservation lifecycle:
   *   - Created here, debits `meta:bytes_used_r2` immediately.
   *   - Cleared by the eventual POST /envelopes for the same envelopeId, or
   *     when the underlying R2 object lands and the client confirms.
   *   - Falls out via the bucket's 7-day lifecycle rule + DO alarm wipe if
   *     the client never follows through. Acceptable: each room is capped at
   *     25 MiB total so a runaway client can't pin large reservations indefinitely.
   */
  private async handleBlobPresign(
    request: Request,
    roomId: string,
    urlPath: string,
  ): Promise<Response> {
    const limits = readHardLimits(this.env);
    const storedAdmissionKey = await this.ctx.storage.get<Uint8Array>(META.admissionKey);
    if (storedAdmissionKey === undefined) {
      return errorResponse(404, "ATTN_ROOM_NOT_FOUND", `room ${roomId} does not exist`);
    }

    // Buffer body once — admission + JSON.parse both need it.
    let bodyBytes: Uint8Array;
    try {
      bodyBytes = new Uint8Array(await request.arrayBuffer());
    } catch (err) {
      return errorResponse(400, "ATTN_BODY_INVALID", `request body read failed: ${(err as Error).message}`);
    }

    // 1. Admission.
    try {
      const buffered = bufferedRequest(request, bodyBytes);
      await verifyAdmission(buffered, urlPath, { roomId, admissionKey: storedAdmissionKey });
    } catch (err) {
      if (err instanceof AdmissionError) {
        return errorResponse(401, err.code, err.message);
      }
      throw err;
    }

    // 2. Schema-validate so we have a deviceId for the PoW binding.
    let parsed: unknown;
    try {
      const text = new TextDecoder().decode(bodyBytes);
      parsed = JSON.parse(text);
    } catch (err) {
      return errorResponse(400, "ATTN_BODY_INVALID", `request body is not valid JSON: ${(err as Error).message}`);
    }
    const result = blobPresignRequestSchema.safeParse(parsed);
    if (!result.success) {
      return errorResponse(400, "ATTN_BODY_INVALID", formatZodError(result.error));
    }
    const body = result.data;

    // 3. Per-device rate limit (attn-nnj.5.13).
    const rateRejection = await this.enforceDeviceRateLimit(body.deviceId);
    if (rateRejection !== undefined) return rateRejection;

    // 4. PoW — bound to (roomId, body.deviceId, POST, urlPath).
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

    // 5. Threshold gate: payload must exceed 1 MiB. Below → use inline envelope path.
    if (body.ciphertextBytes <= BLOB_SPILLOVER_THRESHOLD_BYTES) {
      return errorResponse(
        400,
        "ATTN_BLOB_TOO_SMALL",
        `ciphertextBytes=${body.ciphertextBytes} <= ${BLOB_SPILLOVER_THRESHOLD_BYTES}; use inline envelope path`,
      );
    }

    // 5. Per-snapshot cap.
    if (body.ciphertextBytes > policy.maxSnapshotBytes) {
      return errorResponse(
        413,
        "ATTN_ENVELOPE_TOO_LARGE",
        `ciphertextBytes=${body.ciphertextBytes} > policy.maxSnapshotBytes=${policy.maxSnapshotBytes}`,
      );
    }

    // 6. Device registration check.
    const deviceKey = deviceStorageKey(body.authorId, body.deviceId);
    const deviceRecord = await this.ctx.storage.get<DeviceRecord>(deviceKey);
    if (deviceRecord === undefined) {
      return errorResponse(
        400,
        "ATTN_DEVICE_UNREGISTERED",
        `(authorId=${body.authorId}, deviceId=${body.deviceId}) not registered`,
      );
    }

    // 7. Room-bytes cap. Sum DO bytes + R2 bytes + outstanding reservations
    //    + this request's ask. Reservations are tracked in meta:bytes_used_r2
    //    so concurrent presigns cannot double-spend the budget.
    const resvKey = blobReservationKey(body.envelopeId);
    const existing = await this.ctx.storage.get<BlobReservation>(resvKey);
    const [curBytes, curBytesR2] = await Promise.all([
      this.ctx.storage.get<number>(META.bytesUsed),
      this.ctx.storage.get<number>(META.bytesUsedR2),
    ]);
    const runningBytes = curBytes ?? 0;
    const runningBytesR2 = curBytesR2 ?? 0;

    // Idempotent re-presign for the same envelopeId. We return a fresh token
    // but do NOT debit again — the prior reservation already counted toward
    // running_r2_bytes. This means a stuck client can re-issue presigns
    // without inflating accounting.
    let addedR2 = body.ciphertextBytes;
    if (existing !== undefined) {
      if (existing.ciphertextBytes !== body.ciphertextBytes) {
        return errorResponse(
          409,
          "ATTN_BLOB_RESERVATION_MISMATCH",
          `envelopeId ${body.envelopeId} already reserved at ${existing.ciphertextBytes} bytes`,
        );
      }
      addedR2 = 0;
    }
    if (runningBytes + runningBytesR2 + addedR2 > limits.maxRoomBytes) {
      return errorResponse(
        507,
        "ATTN_ROOM_STORAGE_FULL",
        `room ${roomId} storage cap reached (have ${runningBytes + runningBytesR2}, +${addedR2} > ${limits.maxRoomBytes})`,
      );
    }

    // 8. Mint upload cap. Default 15-min TTL per spec.
    let presigned: PresignedUploadResult;
    try {
      presigned = await presignBlobUpload(this.env, roomId, body.envelopeId, body.ciphertextBytes);
    } catch (err) {
      return errorResponse(500, "ATTN_BLOB_PRESIGN_FAILED", `presign failed: ${(err as Error).message}`);
    }

    // 9. Persist the reservation + update meta:bytes_used_r2 atomically.
    const reservation: BlobReservation = {
      envelopeId: body.envelopeId,
      authorId: body.authorId,
      deviceId: body.deviceId,
      ciphertextBytes: body.ciphertextBytes,
      reservedAt: Date.now(),
      uploadExpiresAt: presigned.expiresAt,
    };
    const writes: Record<string, unknown> = {
      [resvKey]: reservation,
    };
    if (addedR2 > 0) {
      writes[META.bytesUsedR2] = runningBytesR2 + addedR2;
    }
    await this.ctx.storage.put<unknown>(writes);

    return Response.json(presigned, { status: 200 });
  }

  // -- DELETE /v2/rooms/:roomId -------------------------------------------

  /**
   * Wipe a room per relay-spec.md §DELETE /v2/rooms/:roomId.
   *
   * Layered checks (every layer required — owner-only privileged op):
   *   1. Room exists (admissionKey loaded from DO storage; 404 otherwise).
   *   2. Admission HMAC (`Attn-Admission`) — URL-as-bearer.
   *   3. PoW (`Attn-PoW`) — write-cost gate. We parse the token to extract its
   *      embedded deviceId, then pass that deviceId to `verifyPow` so the
   *      `resource` check (roomId + deviceId + requestPathHash) re-validates the
   *      same value bound into the hash. (Unlike POST endpoints, DELETE has no
   *      body to carry deviceId, and the spec doesn't define a header for it —
   *      the PoW token itself is the binding.)
   *   4. Owner signature (`Attn-Owner-Signature`) — Ed25519 over canonicalRequest
   *      against the stored ownerSigningKey. The only path to this endpoint.
   *
   * On success:
   *   a. Close every live WebSocket with close code 4001 (room deleted). Hibernated
   *      sockets re-surface via state.getWebSockets() so closes reach replay too.
   *   b. Wipe ALL DO storage keys via state.storage.deleteAll() — meta, devices,
   *      envelopes, acks, pow_seen, the lot. Cancel any scheduled alarm so we
   *      don't re-trip the 4002 (expired) close on a now-empty DO.
   *   c. Schedule R2 cleanup: list objects under `rooms/<roomId>/` and delete each.
   *      Best-effort within this request. Anything that lags or fails falls back
   *      to the bucket's 7-day lifecycle rule (relay-spec.md §R2 Integration).
   *
   * Subsequent requests targeting this roomId observe an empty DO — every other
   * handler short-circuits to `404 ATTN_ROOM_NOT_FOUND` when meta:admission_key
   * is missing.
   *
   * Response: 204 No Content.
   */
  private async handleRoomDelete(
    request: Request,
    roomId: string,
    urlPath: string,
  ): Promise<Response> {
    // DELETE has no body per the spec, but we still drain the request stream
    // up front so workerd doesn't surface the "Can't read from request stream
    // after response has been sent" warning on the early-404 path below. The
    // bytes get reused by admission + owner-sig verifiers (each needs to
    // re-clone the request to compute its own canonical SHA).
    let bodyBytes: Uint8Array;
    try {
      bodyBytes = new Uint8Array(await request.arrayBuffer());
    } catch (err) {
      return errorResponse(400, "ATTN_BODY_INVALID", `request body read failed: ${(err as Error).message}`);
    }

    // 1. Existence check — without admissionKey we couldn't verify admission
    //    anyway, and every other endpoint surfaces unknown rooms as 404.
    const storedAdmissionKey = await this.ctx.storage.get<Uint8Array>(META.admissionKey);
    if (storedAdmissionKey === undefined) {
      return errorResponse(404, "ATTN_ROOM_NOT_FOUND", `room ${roomId} does not exist`);
    }

    // 2. Admission — URL-as-bearer trust boundary.
    try {
      const buffered = bufferedRequest(request, bodyBytes);
      await verifyAdmission(buffered, urlPath, { roomId, admissionKey: storedAdmissionKey });
    } catch (err) {
      if (err instanceof AdmissionError) {
        return errorResponse(401, err.code, err.message);
      }
      throw err;
    }

    // 3. PoW. DELETE has no body to carry deviceId; the token itself binds it.
    //    We parse first to extract the deviceId, then hand it to verifyPow which
    //    re-validates the same value via the resource check + leading-zero count.
    const policy = await this.ctx.storage.get<RoomPolicy>(META.policy);
    if (policy === undefined) {
      return errorResponse(500, "ATTN_ROOM_CORRUPT", `room ${roomId} missing policy`);
    }
    const powToken = request.headers.get("Attn-PoW");
    if (powToken === null || powToken === "") {
      return errorResponse(400, "ATTN_POW_INVALID", "missing Attn-PoW header");
    }
    let powDeviceId: string;
    try {
      powDeviceId = parsePow(powToken).deviceId;
    } catch (err) {
      if (err instanceof PowError) {
        return errorResponse(400, err.code, err.message);
      }
      throw err;
    }

    // 3a. Per-device rate limit (attn-nnj.5.13). Uses the deviceId
    //     extracted from the PoW token since DELETE has no body.
    const rateRejection = await this.enforceDeviceRateLimit(powDeviceId);
    if (rateRejection !== undefined) return rateRejection;

    try {
      await verifyPow(powToken, {
        roomId,
        deviceId: powDeviceId,
        method: "DELETE",
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

    // 4. Owner signature — the only path that authorizes wipe. We check this
    //    AFTER admission + PoW so a non-URL-holder never learns whether owner
    //    sig was even attempted (same layering rationale as the rest of the
    //    privileged routes).
    const ownerKey = await this.ctx.storage.get<Uint8Array>(META.ownerSigningKey);
    if (ownerKey === undefined) {
      return errorResponse(500, "ATTN_ROOM_CORRUPT", `room ${roomId} missing owner key`);
    }
    try {
      const buffered = bufferedRequest(request, bodyBytes);
      await verifyOwnerSignature(buffered, urlPath, ownerKey);
    } catch (err) {
      if (err instanceof OwnerSigError) {
        return errorResponse(403, err.code, err.message);
      }
      throw err;
    }

    // ---- Authorized: actually wipe ----------------------------------------

    // a. Close every live WS with 4001 (room deleted). We don't broadcast a
    //    presence:leave first — the room is gone, leave frames would race the
    //    close on the wire and confuse clients. Use a try/swallow loop so one
    //    dead socket doesn't block the others.
    for (const sock of this.ctx.getWebSockets()) {
      try {
        sock.close(CLOSE_ROOM_DELETED, "room deleted");
      } catch {
        // socket likely already closed; runtime will clean up
      }
    }

    // b. Wipe every DO storage key in a single transaction. deleteAll() also
    //    drops pow_seen:*, the alarm map, etc. After this the DO is observably
    //    indistinguishable from a never-created room.
    await this.ctx.storage.deleteAll();
    // Cancel any pending alarm too — without this the next alarm fire would
    // try to broadcast 4002 to a now-empty DO and re-run idle cleanup.
    try {
      await this.ctx.storage.deleteAlarm();
    } catch {
      // deleteAlarm is a no-op when no alarm is set, but the API surface
      // varies across workerd versions; swallow any "no alarm" error.
    }

    // c. Schedule R2 cleanup. Best-effort: anything we can't get to falls back
    //    to the bucket's 7-day lifecycle rule (relay-spec.md §R2 Integration).
    //    We loop in pages of 1000 (R2 list cap) and delete each page in batches.
    await this.cleanupRoomBlobs(roomId);

    return new Response(null, { status: 204 });
  }

  /**
   * List + delete every R2 object under `rooms/<roomId>/`. Iterates the list
   * cursor until truncated=false. Errors are swallowed (best-effort per spec);
   * the bucket lifecycle rule is the safety net.
   */
  private async cleanupRoomBlobs(roomId: string): Promise<void> {
    const prefix = `rooms/${roomId}/`;
    const bucket = this.env.RELAY_BLOBS;
    if (bucket === undefined) return;
    try {
      let cursor: string | undefined;
      // Bound the loop so a runaway list can't pin the DO event loop. In
      // practice a single room never produces more than ~25 MiB / 5 MiB blobs,
      // so 50 pages of 1000 is comfortable headroom.
      for (let page = 0; page < 50; page++) {
        const listed: R2Objects = await bucket.list({
          prefix,
          ...(cursor !== undefined ? { cursor } : {}),
        });
        const keys = listed.objects.map((obj) => obj.key);
        if (keys.length > 0) {
          // R2.delete accepts an array of keys in a single round-trip.
          await bucket.delete(keys);
        }
        if (!listed.truncated) return;
        cursor = listed.truncated ? listed.cursor : undefined;
        if (cursor === undefined) return;
      }
    } catch {
      // Best-effort: lifecycle rule (7d) catches anything we leave behind.
    }
  }

  /**
   * Scan env:* forward from `prevOldest` (exclusive) and return the smallest
   * remaining serverSeq. If no envelopes remain, returns the room's current
   * meta:server_seq (so future replays still gate `after < oldest` correctly).
   */
  private async findOldestRetainedSeq(prevOldest: number): Promise<number> {
    const entries = await this.ctx.storage.list<EnvelopeRecord>({
      prefix: ENV_PREFIX,
      limit: 1,
    });
    for (const record of entries.values()) {
      return record.serverSeq;
    }
    // No envelopes left — pin to the highest seq we've ever issued so any
    // subscriber with after=N (N <= max) still satisfies after >= oldest.
    const serverSeq = await this.ctx.storage.get<number>(META.serverSeq);
    return Math.max(prevOldest, serverSeq ?? 0);
  }

  // -- WebSocket /v2/rooms/:roomId/socket --------------------------------

  /**
   * Upgrade handshake for the live socket. Per relay-spec.md §WebSocket
   * Protocol the URL is `wss://relay/v2/rooms/:roomId/socket?device_id=...`
   * and admission HMAC piggybacks on `Sec-WebSocket-Protocol`:
   *
   *   Sec-WebSocket-Protocol: attn.v2, hmac.<base64url HMAC>
   *
   * The HMAC's canonicalRequest covers `GET <path> <canonicalQuery> SHA256("")`
   * — same scheme as the HTTP endpoints, only the body is the empty string.
   *
   * Failure modes:
   *   - non-GET method               → 405
   *   - missing/wrong upgrade header → 426
   *   - room doesn't exist           → 404
   *   - missing Sec-WebSocket-Protocol → 401 (no peer to close-frame yet)
   *   - admission HMAC fails         → 101 + close(4000) so the spec's
   *     close-code surface is observable. Browsers can't read response
   *     status after a failed upgrade reliably; close 4000 is the canonical
   *     signal per relay-spec.md §Close Codes.
   *   - peer cap reached             → 101 + accept + close(4004)
   */
  private async handleSocketUpgrade(
    request: Request,
    roomId: string,
    url: URL,
  ): Promise<Response> {
    if (request.method !== "GET") {
      return errorResponse(405, "ATTN_METHOD_NOT_ALLOWED", `${request.method} not allowed on /socket`);
    }
    const upgrade = request.headers.get("Upgrade");
    if (upgrade !== "websocket" && upgrade !== "WebSocket") {
      return new Response("expected websocket upgrade", { status: 426 });
    }

    // Existence check before parsing the subprotocol so unknown rooms surface
    // as 404 rather than 401 (matches the device list precedent).
    const storedAdmissionKey = await this.ctx.storage.get<Uint8Array>(META.admissionKey);
    if (storedAdmissionKey === undefined) {
      return errorResponse(404, "ATTN_ROOM_NOT_FOUND", `room ${roomId} does not exist`);
    }

    // Browser-policy Origin allowlist check (attn-nnj.9.5, relay-spec.md
    // §Browser Considerations). A WebSocket upgrade with an `Origin` header
    // signals a browser client; enforce the room's allow-browser policy +
    // the ALLOWED_BROWSER_ORIGINS env var allowlist. Native clients omit
    // the Origin header and pass straight through.
    const origin = request.headers.get("Origin");
    if (origin !== null && origin !== "") {
      const policyForOrigin = await this.ctx.storage.get<RoomPolicy>(META.policy);
      if (policyForOrigin === undefined) {
        return errorResponse(500, "ATTN_ROOM_CORRUPT", `room ${roomId} missing policy`);
      }
      if (!policyForOrigin.allowBrowser) {
        return errorResponse(
          403,
          "ATTN_BROWSER_DISALLOWED",
          `room ${roomId} does not allow browser clients`,
        );
      }
      const allowed = parseEnvAllowedOrigins(this.env);
      if (!allowed.has(origin)) {
        return errorResponse(
          403,
          "ATTN_ORIGIN_FORBIDDEN",
          `origin ${origin} not in ALLOWED_BROWSER_ORIGINS`,
        );
      }
    }

    // Pre-expiry cleanup check (amendments.md #9): if the room is within 1h of
    // `meta:expires_at`, run alarm() immediately to belt-and-braces against
    // alarm slippage near TTL. If the alarm wipes the room, the very next
    // storage.get below returns undefined and we surface 404 — matching the
    // post-expiry observable behaviour.
    const cleanupRan = await this.maybeRunPreExpiryCleanup();
    if (cleanupRan) {
      const stillThere = await this.ctx.storage.get<Uint8Array>(META.admissionKey);
      if (stillThere === undefined) {
        return errorResponse(404, "ATTN_ROOM_NOT_FOUND", `room ${roomId} does not exist`);
      }
    }

    // Parse Sec-WebSocket-Protocol → ["attn.v2", "hmac.<b64url>"].
    const protocolHeader = request.headers.get("Sec-WebSocket-Protocol");
    const parsedProtocol = parseAttnProtocol(protocolHeader);
    if (parsedProtocol === undefined) {
      // Without a parseable subprotocol we can't even negotiate `attn.v2`, so
      // we refuse the upgrade outright. This is the only admission-failure
      // path that does NOT return 101+close — the upgrade can't proceed if
      // the server can't pick a subprotocol to respond with.
      return errorResponse(
        401,
        "ATTN_ADMISSION_INVALID",
        "Sec-WebSocket-Protocol must be 'attn.v2, hmac.<base64url>'",
      );
    }

    // Verify admission. The canonical body is empty (GET).
    const hmacOk = await verifyAdmissionHmac({
      method: "GET",
      url,
      providedHmac: parsedProtocol.hmac,
      admissionKey: storedAdmissionKey,
    });
    if (!hmacOk) {
      // Per spec: accept the upgrade so the client observes close 4000.
      const pair = new WebSocketPair();
      const [c, s] = [pair[0], pair[1]];
      s.accept();
      try {
        s.close(CLOSE_ADMISSION_INVALID, "admission HMAC invalid");
      } catch {
        // swallow
      }
      const policyForTag = await this.ctx.storage.get<RoomPolicy>(META.policy);
      return new Response(null, {
        status: 101,
        webSocket: c,
        headers: buildSocketUpgradeHeaders(policyForTag),
      });
    }

    // device_id query parameter is required so we can tag the socket.
    const deviceId = url.searchParams.get("device_id");
    if (deviceId === null || deviceId === "") {
      return errorResponse(400, "ATTN_BODY_INVALID", "missing device_id query parameter");
    }

    // Look up the device's participantId. Per spec the WS open is for an
    // already-registered device; unknown deviceId → 404 so the client knows to
    // POST /devices first.
    const deviceRecord = await this.findDeviceByDeviceId(deviceId);
    if (deviceRecord === undefined) {
      return errorResponse(
        404,
        "ATTN_DEVICE_UNREGISTERED",
        `device ${deviceId} not registered in room ${roomId}`,
      );
    }
    const participantId = deviceRecord.participantId;

    // Peer cap: count distinct deviceIds currently connected.
    const policy = await this.ctx.storage.get<RoomPolicy>(META.policy);
    if (policy === undefined) {
      return errorResponse(500, "ATTN_ROOM_CORRUPT", `room ${roomId} missing policy`);
    }
    const connectedDevices = new Set<string>();
    for (const existing of this.ctx.getWebSockets()) {
      const attached = readAttachment(existing);
      if (attached !== undefined) connectedDevices.add(attached.deviceId);
    }
    // If THIS deviceId is already connected we let it in (the prior socket
    // will be replaced — the spec doesn't speak to multi-tab per device, so we
    // treat it as the same peer). New deviceId beyond cap → close 4004.
    const wouldBeOver =
      !connectedDevices.has(deviceId) && connectedDevices.size >= policy.maxPeers;

    // Build the upgrade response.
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    // Tag the server end with [deviceId, participantId] per the spec.
    // acceptWebSocket switches the runtime into hibernation mode.
    this.ctx.acceptWebSocket(server, [deviceId, participantId]);
    writeAttachment(server, {
      deviceId,
      participantId,
      subscribed: false,
      lastPongTs: 0,
    });

    if (wouldBeOver) {
      // Close immediately so the client observes 4004 over the WS protocol.
      try {
        server.close(CLOSE_PEER_CAP, "peer cap reached");
      } catch {
        // swallow — close is best-effort
      }
      return new Response(null, {
        status: 101,
        webSocket: client,
        headers: buildSocketUpgradeHeaders(policy),
      });
    }

    // Broadcast presence:join to every OTHER connected peer.
    this.broadcastPresence({ event: "join", deviceId, participantId }, server);

    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: buildSocketUpgradeHeaders(policy),
    });
  }

  /**
   * Hibernation entry-point: fires when a peer sends a frame. We re-load the
   * per-socket state from the attachment so the handler can survive a DO
   * eviction between frames.
   */
  override async webSocketMessage(ws: WebSocket, msg: string | ArrayBuffer): Promise<void> {
    if (typeof msg !== "string") {
      sendError(ws, "ATTN_FRAME_INVALID", "binary frames are reserved");
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(msg);
    } catch (err) {
      sendError(ws, "ATTN_FRAME_INVALID", `frame is not valid JSON: ${(err as Error).message}`);
      return;
    }
    const frame = clientFrameSchema.safeParse(parsed);
    if (!frame.success) {
      sendError(ws, "ATTN_FRAME_INVALID", formatZodError(frame.error));
      return;
    }
    const att = readAttachment(ws);
    if (att === undefined) {
      // Attachment shouldn't be missing — defensively close.
      try {
        ws.close(CLOSE_NORMAL, "missing attachment");
      } catch {
        // ignore
      }
      return;
    }
    const body = frame.data;
    if (body.type === "subscribe") {
      await this.handleSubscribe(ws, att, body.after);
      return;
    }
    if (body.type === "pong") {
      writeAttachment(ws, { ...att, lastPongTs: Date.now() });
      return;
    }
  }

  /** Hibernation entry-point on close. Broadcast presence:leave. */
  override async webSocketClose(
    ws: WebSocket,
    _code: number,
    _reason: string,
    _wasClean: boolean,
  ): Promise<void> {
    const att = readAttachment(ws);
    if (att !== undefined) {
      this.broadcastPresence(
        { event: "leave", deviceId: att.deviceId, participantId: att.participantId },
        ws,
      );
    }
    // No need to call ws.close — the runtime already did. We just clean up
    // any state we owned (the attachment lives on the socket itself, which
    // is GC'd with the connection).
  }

  /** Hibernation entry-point on socket-level error. Same handling as close. */
  override async webSocketError(ws: WebSocket, _err: unknown): Promise<void> {
    const att = readAttachment(ws);
    if (att !== undefined) {
      this.broadcastPresence(
        { event: "leave", deviceId: att.deviceId, participantId: att.participantId },
        ws,
      );
    }
  }

  /**
   * Handle the client's `subscribe { after }` frame. Sends `hello` plus a
   * replay of every envelope with serverSeq > after, in order. If `after` is
   * behind the room's oldest retained seq we send an `error` frame + close
   * 4005 per amendments.md #5.
   */
  private async handleSubscribe(ws: WebSocket, att: WSAttachment, after: number): Promise<void> {
    // Idempotent: a second `subscribe` is allowed but only the first replay is
    // sent. Subsequent subscribes are no-ops; the spec doesn't require
    // re-replay and clients shouldn't be issuing them anyway.
    if (att.subscribed) {
      return;
    }
    const [policy, serverSeq, oldestRetainedSeq] = await Promise.all([
      this.ctx.storage.get<RoomPolicy>(META.policy),
      this.ctx.storage.get<number>(META.serverSeq),
      this.ctx.storage.get<number>(META.oldestRetainedSeq),
    ]);
    if (policy === undefined || serverSeq === undefined) {
      sendError(ws, "ATTN_ROOM_CORRUPT", "room metadata missing");
      try {
        ws.close(CLOSE_NORMAL, "corrupt");
      } catch {
        // ignore
      }
      return;
    }
    const oldest = oldestRetainedSeq ?? 0;
    // Per spec: `after < oldest_retained_seq` → cursor too old. `after == 0`
    // (first connect, no prior cursor) is always valid even if oldest > 0
    // because the client is asking for "everything available".
    if (after > 0 && after < oldest) {
      sendError(ws, "ATTN_CURSOR_TOO_OLD", `cursor ${after} < oldest_retained_seq ${oldest}`, {
        resyncFromSeq: oldest,
      });
      try {
        ws.close(CLOSE_CURSOR_TOO_OLD, "cursor too old");
      } catch {
        // ignore
      }
      return;
    }

    // Build the hello frame.
    const devices = await this.listDevicesInOrder();
    const missedSignalEnvelopeIds = await this.collectMissedSignalIds(att.deviceId, after);
    const hello: ServerFrame = {
      type: "hello",
      serverSeq,
      policy,
      devices,
      missedSignalEnvelopeIds,
    };
    sendJson(ws, hello);

    // Replay env:* > after, in lex (== serverSeq) order. Per-target filtering
    // for signal envelopes — only deliver to the addressed deviceId.
    const envEntries = await this.ctx.storage.list<EnvelopeRecord>({ prefix: ENV_PREFIX });
    for (const record of envEntries.values()) {
      if (record.serverSeq <= after) continue;
      if (!deliverableTo(record, att.deviceId)) continue;
      const frame: ServerFrame = { type: "envelope", envelope: record, serverSeq: record.serverSeq };
      sendJson(ws, frame);
    }

    writeAttachment(ws, { ...att, subscribed: true });

    // Emit an immediate ping so clients can observe the ping/pong contract.
    // Periodic 30s pings are owned by the 5.12 alarm; this single ping is
    // enough to satisfy the spec's "server sends ping" guarantee on connect
    // and gives tests a deterministic frame to assert against.
    sendJson(ws, { type: "ping", ts: Date.now() } satisfies ServerFrame);
  }

  /**
   * Broadcast a freshly-accepted envelope batch to every connected WS that
   * should receive it. Called from handleEnvelopesIngest after the atomic
   * put-many commits.
   *
   * Signal envelopes are delivered only to `target.deviceId`. Other kinds
   * broadcast to all peers (including the author, so multi-device peers see
   * their own writes echoed for read-after-write consistency).
   */
  private broadcastFreshEnvelopes(fresh: EnvelopeInput[], lastSeq: number): void {
    if (fresh.length === 0) return;
    // We need each envelope's serverSeq. We allocated them sequentially in the
    // same order as `fresh` ending at `lastSeq`.
    const startSeq = lastSeq - fresh.length + 1;
    const sockets = this.ctx.getWebSockets();
    if (sockets.length === 0) return;
    for (let i = 0; i < fresh.length; i++) {
      const env = fresh[i];
      if (env === undefined) continue;
      const seq = startSeq + i;
      const record: EnvelopeRecord = {
        ...env,
        target: env.target ?? null,
        serverSeq: seq,
      };
      const frame: ServerFrame = { type: "envelope", envelope: record, serverSeq: seq };
      const json = JSON.stringify(frame);
      for (const sock of sockets) {
        const att = readAttachment(sock);
        if (att === undefined) continue;
        if (!att.subscribed) continue;
        if (!deliverableTo(record, att.deviceId)) continue;
        sendRaw(sock, json);
      }
    }
  }

  /**
   * Broadcast a presence frame to every connected peer except `originator`.
   * Called from connect (join) and close (leave).
   */
  private broadcastPresence(
    event: { event: "join" | "leave"; deviceId: string; participantId: string },
    originator: WebSocket,
  ): void {
    const frame: ServerFrame = {
      type: "presence",
      event: event.event,
      deviceId: event.deviceId,
      participantId: event.participantId,
    };
    const json = JSON.stringify(frame);
    for (const sock of this.ctx.getWebSockets()) {
      if (sock === originator) continue;
      const att = readAttachment(sock);
      if (att === undefined) continue;
      sendRaw(sock, json);
    }
  }

  /**
   * Lookup a device record by deviceId alone. The device storage key requires
   * participantId; we walk the order index since callers (the WS upgrade)
   * don't have the participantId yet. Bounded by HARD_MAX_PEERS (8) in steady
   * state.
   */
  private async findDeviceByDeviceId(deviceId: string): Promise<DeviceRecord | undefined> {
    const orderEntries = await this.ctx.storage.list<string>({ prefix: DEVICE_ORDER_PREFIX });
    const suffix = `:${deviceId}`;
    for (const key of orderEntries.keys()) {
      if (!key.endsWith(suffix)) continue;
      const { participantId, deviceId: parsedDeviceId } = parseDeviceOrderKey(key);
      if (parsedDeviceId !== deviceId) continue;
      const record = await this.ctx.storage.get<DeviceRecord>(deviceStorageKey(participantId, deviceId));
      if (record !== undefined) return record;
    }
    return undefined;
  }

  /** Return device records in registration order. Used in `hello`. */
  private async listDevicesInOrder(): Promise<DeviceRecord[]> {
    const orderEntries = await this.ctx.storage.list<string>({ prefix: DEVICE_ORDER_PREFIX });
    const records: DeviceRecord[] = [];
    for (const orderKey of orderEntries.keys()) {
      const { participantId, deviceId } = parseDeviceOrderKey(orderKey);
      const record = await this.ctx.storage.get<DeviceRecord>(deviceStorageKey(participantId, deviceId));
      if (record !== undefined) records.push(record);
    }
    return records;
  }

  /**
   * Collect envelopeIds of signal envelopes targeted at `myDeviceId` whose
   * serverSeq > `after`. The peer learns the IDs in `hello` so it can decide
   * whether to re-fetch the payloads via the replay stream that follows.
   * (In practice the replay below already includes them; we still surface the
   * id list per the spec's `hello` shape.)
   */
  private async collectMissedSignalIds(myDeviceId: string, after: number): Promise<string[]> {
    const prefix = envByTargetPrefix(myDeviceId);
    const entries = await this.ctx.storage.list<string>({ prefix });
    const ids: string[] = [];
    for (const orderKey of entries.keys()) {
      const parsed = parseEnvByTargetKey(orderKey);
      if (parsed === undefined) continue;
      const seqNum = Number(parsed.paddedSeq);
      if (!Number.isSafeInteger(seqNum)) continue;
      if (seqNum <= after) continue;
      ids.push(parsed.envelopeId);
    }
    return ids;
  }

  // -- helpers for PoW replay + device ordering ---------------------------

  /**
   * Per-device rate limit check (attn-nnj.5.13). Lives inside the DO so the
   * per-(deviceId, minute) counter persists across requests and shares
   * storage with the room. Returns undefined when the caller is under
   * the cap; returns a 429 Response when the cap is exceeded.
   *
   * Call from every write handler AFTER admission verification — admission
   * is the trust boundary that ties a caller to a known URL, so we don't
   * want unauthenticated traffic charging against a known device's quota.
   */
  private async enforceDeviceRateLimit(deviceId: string): Promise<Response | undefined> {
    const limiter = new DurableObjectRateLimit(this.ctx.storage);
    const result = await limiter.check(deviceId);
    if (result.ok) return undefined;
    return buildRateLimitedResponse(result);
  }

  private async isPowSeen(hash: string): Promise<boolean> {
    return (await this.ctx.storage.get<number>(powSeenKey(hash))) !== undefined;
  }

  private async markPowSeen(hash: string, expiresAt: number): Promise<void> {
    // Stored value is the token's expiresAt so the periodic pow-prune alarm
    // can walk `pow_seen:*` and drop anything past expiresAt + 10min.
    await this.ctx.storage.put<number>(powSeenKey(hash), expiresAt);
  }

  // -- Alarms (TTL + Idle + PoW-prune) ------------------------------------

  /**
   * Cloudflare DO alarm handler per relay-spec.md §Alarms.
   *
   * Three logical alarms collapsed into one wake time (CF only supports one):
   *   1. Hard-max     — fires at `meta:hard_max_at` (createdAt + 24h/7d).
   *   2. Idle         — fires at `meta:last_event_at + policy.idleTimeoutMs`.
   *   3. PoW-prune    — periodic (~5min), removes pow_seen entries whose
   *                     stored expiresAt + 10min < now.
   *
   * On hard-max or idle expiry:
   *   - Close every WS with 4002 (room expired).
   *   - Schedule R2 deletion under `rooms/<roomId>/`.
   *   - state.storage.deleteAll() — DO is observably gone.
   *   - Do NOT re-schedule (DO is dormant).
   *
   * Otherwise the alarm just woke for the pow-prune sweep — prune expired
   * entries and re-schedule for `min(hard_max_at, last_event_at + idle,
   * next_pow_prune_at)`.
   */
  override async alarm(): Promise<void> {
    const now = Date.now();
    const [hardMaxAt, lastEventAt, policy] = await Promise.all([
      this.ctx.storage.get<number>(META.hardMaxAt),
      this.ctx.storage.get<number>(META.lastEventAt),
      this.ctx.storage.get<RoomPolicy>(META.policy),
    ]);

    // Room state already wiped (e.g., raced with DELETE). Nothing to do.
    if (hardMaxAt === undefined || lastEventAt === undefined || policy === undefined) {
      return;
    }

    const limits = readHardLimits(this.env);
    const idleTimeoutMs = policy.idleTimeoutMs ?? limits.defaultIdleTimeoutMs;
    const idleDeadline = lastEventAt + idleTimeoutMs;

    // Expiry check first — hard-max OR idle past due → wipe the room.
    if (now >= hardMaxAt || now >= idleDeadline) {
      await this.expireRoom();
      return;
    }

    // Periodic pow-prune sweep.
    await this.prunePowSeen(now);

    // Re-schedule to the next earliest wake time.
    await this.rescheduleAlarm({
      now,
      hardMaxAt,
      lastEventAt,
      idleTimeoutMs,
    });
  }

  /**
   * Shared helper to compute and set the next alarm wake time as
   * `min(hard_max_at, last_event_at + idleTimeoutMs, now + POW_PRUNE_INTERVAL_MS)`.
   * Called from handleRoomCreate, handleEnvelopesIngest, and alarm() itself.
   */
  private async rescheduleAlarm(opts: {
    now: number;
    hardMaxAt: number;
    lastEventAt: number;
    idleTimeoutMs: number;
  }): Promise<void> {
    const idleAt = opts.lastEventAt + opts.idleTimeoutMs;
    const powPruneAt = opts.now + POW_PRUNE_INTERVAL_MS;
    const alarmAt = Math.min(opts.hardMaxAt, idleAt, powPruneAt);
    await this.ctx.storage.setAlarm(alarmAt);
  }

  /**
   * Expire-and-wipe path for the hard-max/idle alarm. Mirrors handleRoomDelete
   * structure (close 4002, deleteAll, schedule R2 cleanup) but does NOT require
   * any of the admission/PoW/owner-sig layers — the alarm is server-internal.
   */
  private async expireRoom(): Promise<void> {
    // Close every live WS with 4002 (room expired). Wrapped per-socket so one
    // dead socket can't block the others.
    for (const sock of this.ctx.getWebSockets()) {
      try {
        sock.close(CLOSE_ROOM_EXPIRED, "room expired");
      } catch {
        // socket likely already closed; runtime will clean up
      }
    }

    // Schedule R2 cleanup. We do this BEFORE deleteAll() so we still have the
    // room context available; the bucket lifecycle rule is the safety net.
    // Derive the roomId by inspecting the env_by_target / device_order keys is
    // overkill — we just walk the R2 prefix directly using the DO's own id.
    // The DO has no direct handle on its roomId; we rely on the env_by_target
    // prefix-walk pattern used by cleanupRoomBlobs by passing the roomId
    // resolved from a stored helper key. For now we encode roomId implicitly
    // by relying on the env_by_target index path being scoped per-DO.
    // Simpler: persist the roomId at create time and read it here.
    const roomId = await this.ctx.storage.get<string>(META.roomId);
    if (roomId !== undefined) {
      await this.cleanupRoomBlobs(roomId);
    }

    // Wipe every DO storage key + cancel any other alarm we might have set
    // mid-flight. deleteAll also drops pow_seen:*, env:*, device:*, etc.
    await this.ctx.storage.deleteAll();
    try {
      await this.ctx.storage.deleteAlarm();
    } catch {
      // deleteAlarm varies across workerd versions; swallow.
    }
  }

  /**
   * Belt-and-braces cleanup gate run from WS connect.
   *
   * If the room is within `PRE_EXPIRY_CLEANUP_WINDOW_MS` (1h) of its
   * `meta:expires_at`, re-run the alarm logic synchronously so a slipped
   * alarm can't keep an expired room limping along. Returns true if alarm()
   * ran (caller re-checks META.admissionKey to decide whether to 404).
   *
   * Amendments.md #9: motivated by R2's 7-day lifecycle rule landing before
   * the DO's TTL alarm in a worst-case slippage scenario.
   */
  private async maybeRunPreExpiryCleanup(): Promise<boolean> {
    const expiresAt = await this.ctx.storage.get<number>(META.expiresAt);
    if (expiresAt === undefined) return false;
    const now = Date.now();
    if (now <= expiresAt - PRE_EXPIRY_CLEANUP_WINDOW_MS) return false;
    await this.alarm();
    return true;
  }

  /**
   * Walk `pow_seen:*` and delete entries whose stored expiresAt + 10min < now.
   * The 10min skew matches POW_MAX_LIFETIME_MS so a freshly-minted token
   * cannot be erroneously pruned mid-flight.
   *
   * Bounded by the volume of in-flight PoW tokens (default 16 bits → ~1 token
   * per write, capped by per-room rate limit at 120/min). Worst case ~1200
   * entries; the list+delete is cheap.
   */
  private async prunePowSeen(now: number): Promise<void> {
    const entries = await this.ctx.storage.list<number>({ prefix: POW_SEEN_PREFIX });
    const stale: string[] = [];
    for (const [key, expiresAt] of entries.entries()) {
      if (typeof expiresAt !== "number") continue;
      if (expiresAt + POW_MAX_LIFETIME_MS < now) {
        stale.push(key);
      }
    }
    if (stale.length > 0) {
      await this.ctx.storage.delete(stale);
    }
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

// --- envelope storage keying ---------------------------------------------

/** Padded width for serverSeq in lex keys. 20 digits matches the spec example
 *  (`paddedServerSeq = serverSeq.toString().padStart(20, '0')`). */
const SERVER_SEQ_PAD = 20;

/** Per-(authorId, targetDeviceId) signal sub-cap from relay-spec.md §Caps. */
const MAX_SIGNAL_ENVELOPES_PER_PAIR = 64;

const ENV_PREFIX = "env:";
const ENV_IDX_PREFIX = "env_idx:";
const ENV_BY_TARGET_PREFIX = "env_by_target:";
const ACK_PREFIX = "ack:";
const ACK_OWNER_PREFIX = "ack_owner:";

function padServerSeq(n: number): string {
  return String(n).padStart(SERVER_SEQ_PAD, "0");
}

function envStorageKey(paddedSeq: string, envelopeId: string): string {
  return `${ENV_PREFIX}${paddedSeq}:${envelopeId}`;
}

function envIndexKey(envelopeId: string): string {
  return `${ENV_IDX_PREFIX}${envelopeId}`;
}

function envByTargetKey(
  targetDeviceId: string,
  paddedSeq: string,
  envelopeId: string,
): string {
  return `${ENV_BY_TARGET_PREFIX}${targetDeviceId}:${paddedSeq}:${envelopeId}`;
}

function envByTargetPrefix(targetDeviceId: string): string {
  return `${ENV_BY_TARGET_PREFIX}${targetDeviceId}:`;
}

/** Per-device ACK slot: `ack:<deviceId>:<envelopeId>` → ms-epoch ack time. */
function ackKey(deviceId: string, envelopeId: string): string {
  return `${ACK_PREFIX}${deviceId}:${envelopeId}`;
}

/** Owner-ack marker: `ack_owner:<envelopeId>` → "" (presence-only). */
function ackOwnerKey(envelopeId: string): string {
  return `${ACK_OWNER_PREFIX}${envelopeId}`;
}

// --- blob reservation keying ---------------------------------------------

const BLOB_RESV_PREFIX = "blob_resv:";

/**
 * R2 reservation record stored at `blob_resv:<envelopeId>` while a client holds
 * an outstanding presigned upload URL. Counted against `meta:bytes_used_r2`
 * so two concurrent presigns can't double-spend the room's byte budget.
 */
interface BlobReservation {
  envelopeId: string;
  authorId: string;
  deviceId: string;
  ciphertextBytes: number;
  reservedAt: number;
  uploadExpiresAt: number;
}

function blobReservationKey(envelopeId: string): string {
  return `${BLOB_RESV_PREFIX}${envelopeId}`;
}

/**
 * Parse `env_by_target:<targetDeviceId>:<paddedSeq>:<envelopeId>`.
 * Returns undefined if the key shape doesn't match (defensive — should never
 * happen in production, but keeps the iterator robust to garbage).
 */
function parseEnvByTargetKey(
  key: string,
): { targetDeviceId: string; paddedSeq: string; envelopeId: string } | undefined {
  if (!key.startsWith(ENV_BY_TARGET_PREFIX)) return undefined;
  const rest = key.slice(ENV_BY_TARGET_PREFIX.length);
  // targetDeviceId is the segment before the first colon; paddedSeq is the
  // SERVER_SEQ_PAD-wide block after that; envelopeId is everything after the
  // second colon (envelopeIds may contain colons, so we don't split-3).
  const firstColon = rest.indexOf(":");
  if (firstColon < 0) return undefined;
  const targetDeviceId = rest.slice(0, firstColon);
  const afterTarget = rest.slice(firstColon + 1);
  if (afterTarget.length < SERVER_SEQ_PAD + 1) return undefined;
  const paddedSeq = afterTarget.slice(0, SERVER_SEQ_PAD);
  if (afterTarget.charCodeAt(SERVER_SEQ_PAD) !== ":".charCodeAt(0)) return undefined;
  const envelopeId = afterTarget.slice(SERVER_SEQ_PAD + 1);
  if (envelopeId.length === 0) return undefined;
  return { targetDeviceId, paddedSeq, envelopeId };
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

// --- WebSocket constants + types -----------------------------------------

/** WS close codes per relay-spec.md §WebSocket Protocol. */
const CLOSE_NORMAL = 1000;
const CLOSE_ADMISSION_INVALID = 4000;
const CLOSE_ROOM_DELETED = 4001;
const CLOSE_ROOM_EXPIRED = 4002;
const CLOSE_RATE_LIMIT = 4003;
const CLOSE_PEER_CAP = 4004;
const CLOSE_CURSOR_TOO_OLD = 4005;

// Exported so 5.9/5.12/5.13 can reuse the codes when they wire up their
// flows. Underscore-prefixed in close handlers is also fine — these stay
// canonical names rather than magic numbers.
export const WS_CLOSE_CODES = {
  normal: CLOSE_NORMAL,
  admissionInvalid: CLOSE_ADMISSION_INVALID,
  roomDeleted: CLOSE_ROOM_DELETED,
  roomExpired: CLOSE_ROOM_EXPIRED,
  rateLimit: CLOSE_RATE_LIMIT,
  peerCap: CLOSE_PEER_CAP,
  cursorTooOld: CLOSE_CURSOR_TOO_OLD,
} as const;

/** Persisted per-socket state. Survives hibernation via serializeAttachment. */
interface WSAttachment {
  deviceId: string;
  participantId: string;
  /** True once the socket has received a successful `subscribe` reply. */
  subscribed: boolean;
  /** Last seen pong timestamp (ms). 0 until the first pong. */
  lastPongTs: number;
}

/**
 * Server-emitted frames per relay-spec.md §WebSocket Protocol.
 * `MailboxEnvelope` is `EnvelopeRecord` on the server (the wire envelope plus
 * server-stamped `serverSeq`).
 */
type ServerFrame =
  | {
      type: "hello";
      serverSeq: number;
      policy: RoomPolicy;
      devices: DeviceRecord[];
      missedSignalEnvelopeIds: string[];
    }
  | {
      type: "envelope";
      envelope: EnvelopeRecord;
      serverSeq: number;
    }
  | {
      type: "presence";
      event: "join" | "leave";
      deviceId: string;
      participantId: string;
    }
  | {
      type: "policy_changed";
      policy: RoomPolicy;
    }
  | {
      type: "ping";
      ts: number;
    }
  | {
      type: "error";
      code: string;
      message: string;
      resyncFromSeq?: number;
    };

/** Client-sent frame schema. Validated with zod so unknown shapes surface
 *  consistently with the HTTP request schemas. */
const clientFrameSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("subscribe"),
    after: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("pong"),
    ts: z.number().int().nonnegative(),
  }),
]);

// --- WebSocket helpers ---------------------------------------------------

/**
 * Parse Sec-WebSocket-Protocol expected as `attn.v2, hmac.<base64url>`.
 * Returns undefined on any shape mismatch — the caller surfaces as 401.
 */
function parseAttnProtocol(header: string | null): { hmac: Uint8Array } | undefined {
  if (header === null || header === "") return undefined;
  // Cloudflare's runtime exposes the *comma-joined* original header. We split
  // on `,` and trim each token, matching how browsers serialize the list.
  const tokens = header.split(",").map((t) => t.trim()).filter((t) => t.length > 0);
  if (tokens.length < 2) return undefined;
  // Require the canonical subprotocol up front; reject mixed orderings so the
  // canonical request stays deterministic on the client side.
  if (tokens[0] !== "attn.v2") return undefined;
  let hmacToken: string | undefined;
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (t !== undefined && t.startsWith("hmac.")) {
      hmacToken = t;
      break;
    }
  }
  if (hmacToken === undefined) return undefined;
  const encoded = hmacToken.slice("hmac.".length);
  if (encoded === "") return undefined;
  let bytes: Uint8Array;
  try {
    bytes = base64UrlDecode(encoded);
  } catch {
    return undefined;
  }
  if (bytes.length !== 32) return undefined;
  return { hmac: bytes };
}

/**
 * Verify an admission HMAC supplied via subprotocol. The canonical request
 * mirrors the HTTP path: METHOD || "\n" || URL_PATH || "\n" || CANONICAL_QUERY
 * || "\n" || SHA256(""). We construct a dummy Request with an empty body so
 * the existing canonicalRequest builder produces byte-identical output.
 */
async function verifyAdmissionHmac(opts: {
  method: string;
  url: URL;
  providedHmac: Uint8Array;
  admissionKey: Uint8Array;
}): Promise<boolean> {
  const dummy = new Request(opts.url.toString(), { method: opts.method });
  const canonical = await buildCanonicalRequest(dummy, opts.url.pathname);
  const key = await crypto.subtle.importKey(
    "raw",
    opts.admissionKey,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const expected = new Uint8Array(await crypto.subtle.sign("HMAC", key, canonical));
  return constantTimeEquals(expected, opts.providedHmac);
}

/** Read the per-socket attachment, returning undefined if missing/garbage. */
function readAttachment(ws: WebSocket): WSAttachment | undefined {
  const raw = ws.deserializeAttachment() as unknown;
  if (raw === null || typeof raw !== "object") return undefined;
  const r = raw as Partial<WSAttachment>;
  if (typeof r.deviceId !== "string" || typeof r.participantId !== "string") return undefined;
  return {
    deviceId: r.deviceId,
    participantId: r.participantId,
    subscribed: r.subscribed === true,
    lastPongTs: typeof r.lastPongTs === "number" ? r.lastPongTs : 0,
  };
}

/** Persist the per-socket attachment so it survives DO hibernation. */
function writeAttachment(ws: WebSocket, att: WSAttachment): void {
  ws.serializeAttachment(att);
}

/** Send a JSON-encoded server frame to a single socket. */
function sendJson(ws: WebSocket, frame: ServerFrame): void {
  sendRaw(ws, JSON.stringify(frame));
}

/** Send a pre-stringified frame to a single socket. */
function sendRaw(ws: WebSocket, payload: string): void {
  try {
    ws.send(payload);
  } catch {
    // Socket likely closed mid-broadcast; runtime will surface via
    // webSocketClose. Swallow so one dead peer can't poison the loop.
  }
}

/**
 * Send an error frame. `resyncFromSeq` is included for ATTN_CURSOR_TOO_OLD;
 * other error codes leave it undefined.
 */
function sendError(
  ws: WebSocket,
  code: string,
  message: string,
  extras?: { resyncFromSeq?: number },
): void {
  const frame: ServerFrame = {
    type: "error",
    code,
    message,
    ...(extras?.resyncFromSeq !== undefined ? { resyncFromSeq: extras.resyncFromSeq } : {}),
  };
  sendJson(ws, frame);
}

/**
 * Per-target deliverability check. Signal envelopes deliver only to their
 * target.deviceId; all other kinds broadcast to every connected peer.
 */
function deliverableTo(record: EnvelopeRecord, deviceId: string): boolean {
  if (record.kind === "signal") {
    // Targeted signal (WebRTC SDP/ICE) → only the addressed device.
    // Broadcast signal (target=null, e.g. live co-typing steps) → every
    // peer. The author also receives its own broadcast back; consumers drop
    // self-echoes via the payload's `from` field.
    if (record.target?.deviceId == null) return true;
    return record.target.deviceId === deviceId;
  }
  return true;
}
