/** Worker entry. Routes HTTP requests; delegates per-room state to RoomDO. */

import {
  blobObjectKey,
  INTERNAL_BLOB_ENVELOPE_HEADER,
  INTERNAL_BLOB_LEASE_HEADER,
  INTERNAL_BLOB_OBJECT_KEY_VERSION_HEADER,
  INTERNAL_BLOB_UPLOAD_HEADER,
  INTERNAL_BLOB_UPLOAD_PATH,
  verifyBlobCap,
} from "./r2";
import {
  encodeEdgeOriginContext,
  INTERNAL_EDGE_ORIGIN_HEADER,
} from "./browser-origin";
import { WorkerEdgeRateLimit, type RateLimitResult } from "./rate-limit";
import { RoomDO } from "./room-do";
import { ShareDO } from "./share-do";
import { INTERNAL_QUOTA_SOURCE_HEADER, QuotaDO } from "./quota-do";
import type { Env } from "./env";
import {
  ENVELOPE_ID_MAX_CHARS,
  isProtocolId,
  ROOM_ID_MAX_CHARS,
} from "./opaque-key";

export { QuotaDO, RoomDO, ShareDO };

/**
 * Per-Worker-isolate rate limiter. Persists for the lifetime of the
 * isolate so concurrent fetches share the per-IP buckets — Cloudflare
 * recycles isolates on a memory budget so an attacker can't OOM us by
 * fanning out unique IPs forever. State is process-local; cold-starts
 * reset to zero, which is acceptable per the spec (per-IP caps are an
 * order-of-magnitude defense, not a precise quota).
 */
const edgeRateLimit = new WorkerEdgeRateLimit();

/** Common error response for any 429 return path. */
function rateLimitedResponse(result: RateLimitResult): Response {
  const retryAfterMs = result.retryAfterMs ?? 60_000;
  const headers = new Headers({
    "Content-Type": "application/json",
    // RFC 7231 Retry-After takes seconds; round up so the client always
    // waits at least the limiter's hint before retrying.
    "Retry-After": String(Math.ceil(retryAfterMs / 1000)),
    "X-Attn-Retry-After-Ms": String(retryAfterMs),
  });
  return new Response(
    JSON.stringify({
      error: {
        code: result.code ?? "ATTN_RATE_LIMITED",
        message: "rate limit exceeded",
        retryAfterMs,
      },
    }),
    { status: 429, headers },
  );
}

/**
 * Best-effort source IP extractor. CF-Connecting-IP is the canonical
 * header Cloudflare injects on every request; we fall back to a literal
 * "unknown" so the limiter buckets aren't keyed on `null` (which would
 * make every anonymous client share one bucket — much worse than the
 * single-IP false-positive risk).
 */
function clientIp(request: Request): string {
  const ip = request.headers.get("CF-Connecting-IP");
  if (ip !== null && ip !== "") return ip;
  return "unknown";
}

/**
 * Internal handshake header set by RoomDO on every response from a room whose
 * `policy.allowBrowser == true`. The Worker reads (and STRIPS) this header on
 * the response edge to decide whether to attach CORS headers. Stripping is
 * mandatory: this is implementation detail leaked across the DO→Worker boundary
 * and should never be observable by a browser/native client.
 *
 * See relay-spec.md §Browser Considerations.
 */
const INTERNAL_ALLOW_BROWSER_HEADER = "X-Attn-Allow-Browser";

/**
 * Headers a browser client is allowed to send on a CORS request. Mirrors the
 * relay-spec list (Content-Type for JSON bodies, the three Attn-* protocol
 * headers).
 */
const CORS_ALLOWED_HEADERS = "Content-Type, Attn-Admission, Attn-Owner-Signature, Attn-PoW, Attn-Device-Id, Attn-Device-Proof, Attn-Device-Registration, Attn-Share-Bundle";
const CORS_EXPOSED_HEADERS = "Attn-Share-Bundle, Attn-Share-Tier, Attn-Sealed-Bundle, Attn-Snapshot-Id, Attn-Ciphertext-Sha256";

/** Methods the relay exposes to browsers, including durable snapshot uploads. */
const CORS_ALLOWED_METHODS = "GET, POST, PUT, DELETE, OPTIONS";

/**
 * Parse `ALLOWED_BROWSER_ORIGINS` into a Set for O(1) membership lookup.
 *
 * The env var is a comma-separated allowlist (e.g.
 * `"https://attn.sh,https://staging.attn.sh"`). Empty / whitespace entries
 * are skipped so a stray trailing comma doesn't accidentally allow the empty
 * Origin.
 *
 * Exported so unit tests can exercise the parser without spinning up a Worker.
 */
export function parseAllowedOrigins(env: Env): Set<string> {
  const raw = env.ALLOWED_BROWSER_ORIGINS ?? "";
  const out = new Set<string>();
  for (const piece of raw.split(",")) {
    const trimmed = piece.trim();
    if (trimmed !== "") out.add(trimmed);
  }
  return out;
}

/**
 * Returns the request Origin if (and only if) it is in the configured
 * allowlist. Returning the original-cased value lets us echo it back exactly
 * in `Access-Control-Allow-Origin` per the CORS spec.
 */
function originIfAllowed(request: Request, env: Env): string | undefined {
  const origin = request.headers.get("Origin");
  if (origin === null || origin === "") return undefined;
  const allowed = parseAllowedOrigins(env);
  return allowed.has(origin) ? origin : undefined;
}

/**
 * Attach CORS headers to a response when the DO signaled `allowBrowser=true`
 * (via the internal `X-Attn-Allow-Browser` handshake header) AND the request's
 * Origin is in the configured allowlist.
 *
 * The internal header is ALWAYS stripped before returning to the client —
 * implementation-detail leak protection. The function returns a new Response
 * with a mutable Headers map; callers should discard the original.
 */
function corsMiddleware(request: Request, env: Env, response: Response): Response {
  const allowBrowser = response.headers.get(INTERNAL_ALLOW_BROWSER_HEADER) === "true";
  // Always create a fresh Headers object so we can mutate without aliasing
  // the (often immutable) original. We don't read body to keep streaming intact.
  const newHeaders = new Headers(response.headers);
  newHeaders.delete(INTERNAL_ALLOW_BROWSER_HEADER);
  // Defense in depth: private Worker -> DO request context is never part of
  // the public wire protocol, even if a future DO response accidentally
  // copies it.
  newHeaders.delete(INTERNAL_EDGE_ORIGIN_HEADER);

  if (allowBrowser) {
    const origin = originIfAllowed(request, env);
    if (origin !== undefined) {
      newHeaders.set("Access-Control-Allow-Origin", origin);
      newHeaders.set("Access-Control-Allow-Headers", CORS_ALLOWED_HEADERS);
      newHeaders.set("Access-Control-Allow-Methods", CORS_ALLOWED_METHODS);
      newHeaders.set("Access-Control-Expose-Headers", CORS_EXPOSED_HEADERS);
      // `Vary: Origin` lets caches keep one entry per origin so non-allowlisted
      // hits don't poison the response for a later allowlisted requester.
      const existingVary = newHeaders.get("Vary");
      newHeaders.set("Vary", existingVary === null ? "Origin" : `${existingVary}, Origin`);
    }
  }

  // WebSocket upgrade responses carry the upgraded socket on a non-cloneable
  // field; rebuilding the Response with `new Response(body, init)` preserves
  // status + headers but drops `webSocket`. We special-case 101 by re-using
  // the original response and only patching headers in place where possible.
  if (response.status === 101 && response.webSocket !== null) {
    // For 101 upgrade responses Cloudflare's runtime accepts a fresh response
    // that carries `webSocket` via init. Pass it explicitly.
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: newHeaders,
      webSocket: response.webSocket,
    });
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders,
  });
}

/**
 * Build a synthetic 204 No Content response for OPTIONS preflight requests
 * to non-room routes (e.g. `/health`). Non-room routes never see browsers in
 * a real deployment, but answering OPTIONS politely avoids a 4xx that some
 * CORS-aware HTTP libraries treat as fatal even on routes they don't care
 * about.
 */
function buildPreflightForNonRoomRoute(): Response {
  return new Response(null, { status: 204 });
}

/**
 * Route matcher for any path that targets a single room: matches
 * `/v2/rooms/:roomId` and `/v2/rooms/:roomId/<subroute>`. The first capture
 * is the `roomId` we hand to the DO namespace.
 */
const ROOM_ROUTE_RE = /^\/v(?:2|3)\/rooms\/([^/]+)(?:\/.*)?$/;

/** Bare room path (no subroute) — `POST` here is room creation. */
const ROOM_CREATE_RE = /^\/v(?:2|3)\/rooms\/([^/]+)\/?$/;

/** WS upgrade route matcher: `/v2/rooms/:roomId/socket`. */
const ROOM_SOCKET_RE = /^\/v(?:2|3)\/rooms\/([^/]+)\/socket\/?$/;

/**
 * R2 capability-backed blob route: `/v2/rooms/:roomId/blobs/:envelopeId`.
 *
 * This route stands in for a true presigned URL (see r2.ts docstring). The
 * Worker (NOT the DO) handles both PUT (upload) and GET (download) so the
 * R2 binding traffic doesn't have to cross the DO RPC boundary. Authorization
 * is the `?cap=<token>` query parameter — minted by the DO's POST /blobs
 * handler, verified here on every request.
 */
const ROOM_BLOB_OBJECT_RE = /^\/v(?:2|3)\/rooms\/([^/]+)\/blobs\/([^/]+)\/?$/;
const SHARE_ROUTE_RE = /^\/v3\/shares\/([^/]+)(?:\/.*)?$/;
const SHARE_WATCH_RE = /^\/v3\/shares\/([^/]+)\/watch\/?$/;
const SHARE_CREATE_RE = /^\/v3\/shares\/([^/]+)\/?$/;

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    const shareMatch = url.pathname.match(SHARE_ROUTE_RE);
    if (shareMatch?.[1] && !isProtocolId(shareMatch[1], ROOM_ID_MAX_CHARS)) return identifierError();

    // Reject unsafe room identifiers before quota attribution, edge-rate
    // counters, Durable Object name allocation, or any other durable side
    // effect. Protocol-v2 room IDs are base64url tokens, not path text.
    const earlyRoomMatch = url.pathname.match(ROOM_ROUTE_RE);
    if (/^\/v(?:2|3)\/rooms\//.test(url.pathname) && earlyRoomMatch?.[1] === undefined) {
      return identifierError();
    }
    if (earlyRoomMatch?.[1] !== undefined && !isProtocolId(earlyRoomMatch[1], ROOM_ID_MAX_CHARS)) {
      return identifierError();
    }
    // Decode blob object path segments before the edge-rate boundary so a
    // malformed escape is a bounded no-op. Unsafe-but-well-formed IDs continue
    // through the standard edge caps and can proceed only via the exact legacy
    // capability/admission path below.
    const earlyBlobObjectMatch = url.pathname.match(ROOM_BLOB_OBJECT_RE);
    let earlyBlobEnvelopeId: string | undefined;
    if (earlyBlobObjectMatch?.[2] !== undefined) {
      try {
        earlyBlobEnvelopeId = decodeURIComponent(earlyBlobObjectMatch[2]);
      } catch {
        return identifierError();
      }
    }

    // Never trust a client-supplied internal source bucket. Strip it on every
    // route, then overwrite it only for a bare room-create POST using the
    // canonical Cloudflare edge IP (never X-Forwarded-For). If attribution is
    // unavailable we still forward: RoomDO checks existing state first, so a
    // rejoin remains available while a first create fails closed.
    request = await withPrivateQuotaSource(request, env, url.pathname);

    // GET /health is the only unauthenticated route. Every other route below
    // (when filled in by 5.5–5.11) must verify admission via:
    //
    //   import { verifyAdmission, AdmissionError } from "./admission";
    //   try {
    //     await verifyAdmission(request, url.pathname, {
    //       roomId,
    //       admissionKey, // loaded from DO storage at meta:admission_key (5.5)
    //     });
    //   } catch (err) {
    //     if (err instanceof AdmissionError) {
    //       return Response.json({ error: { code: err.code, message: err.message } }, { status: 401 });
    //     }
    //     throw err;
    //   }
    //
    // Owner-privileged routes additionally call verifyOwnerSignature (5.3);
    // writes also call verifyPow (5.4). The owner check composes after
    // admission so we never reveal whether owner-sig was even attempted on
    // a request the URL-bearer wouldn't otherwise be allowed to make:
    //
    //   import { verifyOwnerSignature, OwnerSigError } from "./owner-sig";
    //
    //   // ... inside DELETE /v2/rooms/:roomId or POST /acks (with delete=true):
    //   await verifyAdmission(request, url.pathname, { roomId, admissionKey });
    //   try {
    //     await verifyOwnerSignature(request, url.pathname, ownerSigningKey);
    //   } catch (err) {
    //     if (err instanceof OwnerSigError) {
    //       return Response.json(
    //         { error: { code: err.code, message: err.message } },
    //         { status: 403 },
    //       );
    //     }
    //     throw err;
    //   }
    //
    // Endpoint dispatch is owned by attn-nnj.5.9 (DELETE /v2/rooms/:roomId)
    // and attn-nnj.5.8 (POST /acks). This file currently only stubs the
    // composition pattern so reviewers can see how the verifiers chain.

    if (url.pathname === "/health" && request.method === "GET") {
      return Response.json({
        status: "ok",
        build: globalThis.BUILD_SHA ?? "dev",
        ts: Date.now(),
      });
    }

    // OPTIONS preflight for any non-room route (incl. /health) — answer 204
    // without CORS headers. Browsers only legitimately preflight room routes;
    // a 204 here is just defensive politeness. Room-route OPTIONS is dispatched
    // to the DO below so the response can be conditioned on policy.allowBrowser.
    if (request.method === "OPTIONS" && shareMatch?.[1]) {
      return corsMiddleware(
        request,
        env,
        new Response(null, { status: 204, headers: { "X-Attn-Allow-Browser": "true" } }),
      );
    }
    // First room creation is the one room-route preflight that cannot consult
    // stored policy: the Durable Object has no policy until the POST succeeds.
    // Permit only the exact bare create route and still require the request
    // Origin to be in ALLOWED_BROWSER_ORIGINS. Every later room preflight
    // remains conditioned on the room's stored allowBrowser bit below.
    if (request.method === "OPTIONS" && ROOM_CREATE_RE.test(url.pathname)) {
      return corsMiddleware(
        request,
        env,
        new Response(null, { status: 204, headers: { "X-Attn-Allow-Browser": "true" } }),
      );
    }
    if (request.method === "OPTIONS" && !ROOM_ROUTE_RE.test(url.pathname)) {
      return buildPreflightForNonRoomRoute();
    }

    // Edge per-IP rate limit. Applies to every route below — every request
    // that resolves to a room contributes to the source IP's quota. We pass
    // `roomExists=true` so this initial check ONLY exercises the per-IP cap;
    // anti-enumeration is updated below after the DO has had a chance to
    // tell us whether the room actually existed (404 ATTN_ROOM_NOT_FOUND).
    //
    // /health is intentionally above this check — health probes shouldn't
    // count against an operator's monitoring IP.
    const ip = clientIp(request);
    // Best-effort extract of the roomId for the rate bucket; non-room
    // requests (the 404 fallthrough at the bottom) bucket under a synthetic
    // sentinel so abuse against non-existent routes still hits the cap.
    const rateRoomId = roomIdForRateBucket(url.pathname) ?? "__none__";
    const edgeResult = edgeRateLimit.check(ip, rateRoomId, true);
    if (!edgeResult.ok) {
      return rateLimitedResponse(edgeResult);
    }

    // Tighter per-IP cap for room CREATION (POST on the bare room path). Each
    // create spawns a Durable Object + storage + an alarm, so this is the top
    // R2/DO cost vector — throttle it well below the general per-IP cap before
    // forwarding to the DO (abuse hardening; complements PoW + the WAF rule).
    //
    // Skipped when the source IP is unattributable ("unknown"): Cloudflare
    // always injects CF-Connecting-IP at the edge (a client can't strip it), so
    // in production this is never "unknown". Lumping every anonymous dev/test
    // caller into one create bucket would be a counterproductive false-positive.
    if (
      ip !== "unknown"
      && request.method === "POST"
      && (ROOM_CREATE_RE.test(url.pathname) || SHARE_CREATE_RE.test(url.pathname))
    ) {
      const createResult = edgeRateLimit.checkCreate(ip);
      if (!createResult.ok) {
        return rateLimitedResponse(createResult);
      }
    }

    if (shareMatch?.[1]) {
      let forwardedRequest = request;
      if (SHARE_WATCH_RE.test(url.pathname)) {
        const forwardedHeaders = new Headers(request.headers);
        forwardedHeaders.set(
          INTERNAL_EDGE_ORIGIN_HEADER,
          encodeEdgeOriginContext(request.headers.get("Origin")),
        );
        forwardedRequest = new Request(request, { headers: forwardedHeaders });
      }
      const response = await env.RELAY_SHARES
        .get(env.RELAY_SHARES.idFromName(shareMatch[1]))
        .fetch(forwardedRequest);
      return corsMiddleware(request, env, response);
    }

    // WebSocket upgrade for /v2/rooms/:roomId/socket. The DO performs admission
    // (HMAC carried via Sec-WebSocket-Protocol per relay-spec.md §WS Protocol)
    // and accepts the socket. We just forward — the DO returns a 101 with the
    // selected subprotocol and the upgraded peer.
    //
    // Browser-policy Origin check happens inside the DO (where the room policy
    // is loaded). Cloudflare rewrites the standard Origin header during the
    // Worker -> DO fetch, so snapshot the edge value into a private context
    // header. This SET is unconditional: a client-supplied private header is
    // always overwritten, including for native requests with no Origin.
    // The DO also signals allowBrowser back via the internal
    // X-Attn-Allow-Browser header so corsMiddleware can attach CORS to the
    // 101 response when appropriate.
    const socketMatch = url.pathname.match(ROOM_SOCKET_RE);
    if (socketMatch && socketMatch[1]) {
      const upgrade = request.headers.get("Upgrade");
      if (upgrade !== "websocket" && upgrade !== "WebSocket") {
        return new Response("expected websocket upgrade", { status: 426 });
      }
      const roomId = socketMatch[1];
      const id = env.RELAY_ROOMS.idFromName(roomId);
      const stub = env.RELAY_ROOMS.get(id);
      const forwardedHeaders = new Headers(request.headers);
      forwardedHeaders.set(
        INTERNAL_EDGE_ORIGIN_HEADER,
        encodeEdgeOriginContext(request.headers.get("Origin")),
      );
      const forwardedRequest = new Request(request, { headers: forwardedHeaders });
      const response = await stub.fetch(forwardedRequest);
      return corsMiddleware(request, env, response);
    }

    // R2 blob upload/download — Worker-handled to avoid round-tripping bytes
    // through the DO. The cap token in `?cap=` carries the (method, roomId,
    // envelopeId, expiresAt[, ciphertextBytes]) tuple HMAC-signed by r2.ts.
    // (Note: this MUST be matched before the catch-all ROOM_ROUTE_RE below;
    // otherwise the room dispatcher would forward PUT/GET to the DO and we'd
    // pay an extra RPC hop just to land back here.)
    const blobObjectMatch = url.pathname.match(ROOM_BLOB_OBJECT_RE);
    if (blobObjectMatch && blobObjectMatch[1] && blobObjectMatch[2]) {
      const roomId = blobObjectMatch[1];
      let envelopeId: string;
      try {
        envelopeId = decodeURIComponent(blobObjectMatch[2]);
      } catch {
        return identifierError();
      }
      const isUnsafeLegacyId = !isProtocolId(envelopeId, ENVELOPE_ID_MAX_CHARS);
      if (isUnsafeLegacyId && earlyBlobEnvelopeId !== envelopeId) return identifierError();
      // Blob PUT/GET don't pass through the DO, so cap-bearing responses need
      // an explicit policy probe before the Worker can attach browser CORS.
      // `withBlobObjectCors` asks the room for its allowBrowser bit and then
      // reuses the same exact-origin middleware as every DO-backed route. The
      // short-lived capability remains the data authorization boundary; CORS
      // only controls whether an allowlisted hosted origin may read the result.
      if (request.method === "OPTIONS") {
        return withBlobObjectCors(
          request,
          env,
          roomId,
          new Response(null, { status: 204 }),
        );
      }
      if (request.method === "PUT") {
        return handleBlobPut(request, env, url, roomId, envelopeId);
      }
      if (request.method === "GET") {
        // Cap-bearing GET → serve bytes straight from R2. Cap-less GET →
        // the DO's download-presign endpoint (admission-auth'd), which
        // mints the cap this branch later consumes.
        if (url.searchParams.has("cap")) {
          const response = await handleBlobGet(request, env, url, roomId, envelopeId);
          return withBlobObjectCors(request, env, roomId, response);
        }
        const id = env.RELAY_ROOMS.idFromName(roomId);
        const stub = env.RELAY_ROOMS.get(id);
        const response = await stub.fetch(request);
        if (response.status === 404) {
          const upgraded = await maybeUpgradeUnknownRoomTo429(response, ip, roomId);
          if (upgraded !== undefined) return corsMiddleware(request, env, upgraded);
        }
        return corsMiddleware(request, env, response);
      }
      if (isUnsafeLegacyId) return identifierError();
      return Response.json(
        { error: { code: "ATTN_METHOD_NOT_ALLOWED", message: `${request.method} not allowed on /blobs/:envelopeId` } },
        { status: 405 },
      );
    }

    // Any `/v2/rooms/:roomId[/...]` request is dispatched to the DO for that
    // room. The DO is responsible for the per-method routing inside RoomDO.fetch
    // (see room-do.ts). 5.5 owns POST /v2/rooms/:roomId; 5.6-5.11 wire the
    // rest of the surface there.
    const roomMatch = url.pathname.match(ROOM_ROUTE_RE);
    if (roomMatch && roomMatch[1]) {
      const roomId = roomMatch[1];
      const id = env.RELAY_ROOMS.idFromName(roomId);
      const stub = env.RELAY_ROOMS.get(id);
      const response = await stub.fetch(request);
      // Anti-enumeration: a 404 ATTN_ROOM_NOT_FOUND from the DO confirms
      // the room doesn't exist. Record the unknown probe; if the IP has
      // now passed the anti-enum cap, upgrade the 404 to a 429 ATTN_ENUM_LIMITED.
      //
      // We deliberately only run this check on `not found` responses —
      // a 401/403/400 means the caller hit *some* room, so anti-enum doesn't
      // apply (the per-IP rate cap still does, which already ran above).
      if (response.status === 404) {
        const upgraded = await maybeUpgradeUnknownRoomTo429(response, ip, roomId);
        if (upgraded !== undefined) return corsMiddleware(request, env, upgraded);
      }
      return corsMiddleware(request, env, response);
    }

    return new Response("not implemented yet", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

function identifierError(): Response {
  return Response.json(
    { error: { code: "ATTN_IDENTIFIER_INVALID", message: "invalid protocol identifier" } },
    { status: 400 },
  );
}

async function withPrivateQuotaSource(
  request: Request,
  env: Env,
  pathname: string,
): Promise<Request> {
  const headers = new Headers(request.headers);
  headers.delete(INTERNAL_QUOTA_SOURCE_HEADER);
  // This header is private to the Worker -> RoomDO socket hop. Strip it at
  // the public edge on every route so future DO handlers cannot accidentally
  // trust a client-supplied value; the socket route overwrites it explicitly.
  headers.delete(INTERNAL_EDGE_ORIGIN_HEADER);

  const createMatch = request.method === "POST" ? pathname.match(ROOM_CREATE_RE) : null;
  const roomId = createMatch?.[1];
  if (roomId !== undefined) {
    const sourceBucket = await durableQuotaSourceBucket(request, env, roomId);
    if (sourceBucket !== undefined) headers.set(INTERNAL_QUOTA_SOURCE_HEADER, sourceBucket);
  }
  return new Request(request, { headers });
}

async function durableQuotaSourceBucket(
  request: Request,
  env: Env,
  roomId: string,
): Promise<string | undefined> {
  const canonicalCfIp = canonicalQuotaSourceIp(request.headers.get("CF-Connecting-IP"));
  const key = env.QUOTA_IP_HASH_KEY;
  if (canonicalCfIp !== undefined && key !== undefined && key.length >= 32) {
    try {
      const cryptoKey = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(key),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
      const digest = new Uint8Array(
        await crypto.subtle.sign(
          "HMAC",
          cryptoKey,
          new TextEncoder().encode(`attn-quota-source:v1\0${canonicalCfIp}`),
        ),
      );
      return `ip:v1:${base64Url(digest)}`;
    } catch {
      return undefined;
    }
  }

  if (env.QUOTA_ALLOW_UNATTRIBUTED_CREATES === "true") {
    const digest = new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(`attn-quota-development-room:v1:${roomId}`),
      ),
    );
    return `dev-room:v1:${base64Url(digest)}`;
  }
  return undefined;
}

/**
 * Canonical source identity used only as HMAC input. IPv4 is bucketed per
 * address; IPv6 is bucketed per /64 so rotating privacy addresses cannot mint
 * a fresh durable quota inside the same subscriber network. Invalid edge
 * values fail closed instead of becoming attacker-selected storage keys.
 */
export function canonicalQuotaSourceIp(raw: string | null): string | undefined {
  if (raw === null) return undefined;
  const candidate = raw.trim();
  if (candidate === "") return undefined;

  const ipv4 = candidate.split(".");
  if (ipv4.length === 4 && ipv4.every((part) => /^\d{1,3}$/.test(part))) {
    const octets = ipv4.map(Number);
    if (octets.every((octet) => octet >= 0 && octet <= 255)) {
      return `ipv4:${octets.join(".")}/32`;
    }
    return undefined;
  }

  if (!/^[0-9a-f:]+$/i.test(candidate)) return undefined;
  const halves = candidate.toLowerCase().split("::");
  if (halves.length > 2) return undefined;
  const left = halves[0] === "" ? [] : halves[0]?.split(":") ?? [];
  const right = halves.length === 1 || halves[1] === "" ? [] : halves[1]?.split(":") ?? [];
  const validHextet = (part: string): boolean => /^[0-9a-f]{1,4}$/.test(part);
  if (!left.every(validHextet) || !right.every(validHextet)) return undefined;

  const compressed = halves.length === 2;
  const missing = 8 - left.length - right.length;
  if ((compressed && missing < 1) || (!compressed && missing !== 0)) return undefined;
  const expanded = [...left, ...Array.from({ length: missing }, () => "0"), ...right];
  if (expanded.length !== 8) return undefined;
  const prefix = expanded.slice(0, 4).map((part) => part.padStart(4, "0"));
  return `ipv6:${prefix.join(":")}::/64`;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

/**
 * Inspect a 404 DO response and, if the body carries `error.code ==
 * ATTN_ROOM_NOT_FOUND`, record an unknown-room probe in the
 * anti-enum bucket. Returns a 429 response when the cap is exceeded;
 * otherwise returns undefined and the caller forwards the original 404.
 *
 * Reading the body is non-destructive — we clone first, so the
 * original response stream is still available if we return undefined.
 */
async function maybeUpgradeUnknownRoomTo429(
  response: Response,
  ip: string,
  roomId: string,
): Promise<Response | undefined> {
  let bodyText: string;
  try {
    bodyText = await response.clone().text();
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return undefined;
  }
  const code = (parsed as { error?: { code?: string } } | null)?.error?.code;
  if (code !== "ATTN_ROOM_NOT_FOUND") return undefined;

  const result = edgeRateLimit.recordUnknownRoom(ip, roomId);
  if (!result.ok) return rateLimitedResponse(result);
  return undefined;
}

/**
 * Extract the roomId from any `/v2/rooms/:roomId[/...]` path. Returns
 * undefined for non-room routes so the caller knows to fall back to a
 * sentinel bucket.
 */
function roomIdForRateBucket(pathname: string): string | undefined {
  const m = pathname.match(/^\/v(?:2|3)\/rooms\/([^/]+)(?:\/.*)?$/);
  return m?.[1];
}

/**
 * `PUT /v2/rooms/:roomId/blobs/:envelopeId?cap=...`
 *
 * Upload a snapshot_blob ciphertext for which the DO previously minted a cap
 * token. Validations:
 *   - `cap` query parameter present + verifies against (PUT, roomId, envelopeId).
 *   - Request body length matches the cap's `ciphertextBytes` (defends against
 *     a client that holds a small-room cap and tries to upload a larger blob).
 *
 * On success: object lands at `rooms/<roomId>/blobs/<envelopeId>`; 204.
 */
async function handleBlobPut(
  request: Request,
  env: Env,
  url: URL,
  roomId: string,
  envelopeId: string,
): Promise<Response> {
  const cap = url.searchParams.get("cap");
  if (cap === null || cap === "") {
    return blobErrorResponse(401, "ATTN_BLOB_CAP_MISSING", "cap query parameter required");
  }
  let verified;
  try {
    verified = await verifyBlobCap(cap, {
      method: "PUT",
      roomId,
      envelopeId,
      protocolVersion: url.pathname.startsWith("/v3/") ? 3 : 2,
    }, env);
  } catch {
    return blobErrorResponse(503, "ATTN_BLOB_CAP_UNAVAILABLE", "blob capability verifier unavailable");
  }
  if (verified === undefined) {
    return blobErrorResponse(401, "ATTN_BLOB_CAP_INVALID", "invalid or expired blob cap");
  }

  // Read body. We materialize in-memory because the cap has the byte size
  // pinned; bounded by `policy.maxSnapshotBytes` (5 MiB default) so this is safe.
  let bodyBytes: Uint8Array;
  try {
    bodyBytes = new Uint8Array(await request.arrayBuffer());
  } catch (err) {
    return blobErrorResponse(400, "ATTN_BODY_INVALID", `body read failed: ${(err as Error).message}`);
  }
  if (
    typeof verified.ciphertextBytes === "number" &&
    bodyBytes.byteLength !== verified.ciphertextBytes
  ) {
    return blobErrorResponse(
      400,
      "ATTN_BLOB_LENGTH_MISMATCH",
      `body length ${bodyBytes.byteLength} != cap ciphertextBytes ${verified.ciphertextBytes}`,
    );
  }

  try {
    const room = env.RELAY_ROOMS.get(env.RELAY_ROOMS.idFromName(roomId));
    return await room.fetch(`https://room.internal${INTERNAL_BLOB_UPLOAD_PATH}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/octet-stream",
        [INTERNAL_BLOB_LEASE_HEADER]: verified.leaseId,
        [INTERNAL_BLOB_UPLOAD_HEADER]: verified.uploadId ?? "",
        [INTERNAL_BLOB_ENVELOPE_HEADER]: envelopeId,
        [INTERNAL_BLOB_OBJECT_KEY_VERSION_HEADER]: String(verified.objectKeyVersion ?? 1),
      },
      body: bodyBytes,
    });
  } catch {
    return blobErrorResponse(
      500,
      "ATTN_BLOB_UPLOAD_FAILED",
      "room upload failed",
    );
  }
}

/**
 * `GET /v2/rooms/:roomId/blobs/:envelopeId?cap=...`
 *
 * Download a previously-uploaded blob. The cap is minted by the cap-less
 * form of the same route, which the Worker forwards to the DO's
 * admission-auth'd download-presign endpoint (room-do.ts
 * `handleBlobDownloadPresign`).
 */
async function handleBlobGet(
  request: Request,
  env: Env,
  url: URL,
  roomId: string,
  envelopeId: string,
): Promise<Response> {
  const cap = url.searchParams.get("cap");
  if (cap === null || cap === "") {
    return blobErrorResponse(401, "ATTN_BLOB_CAP_MISSING", "cap query parameter required");
  }
  let verified;
  try {
    verified = await verifyBlobCap(cap, {
      method: "GET",
      roomId,
      envelopeId,
      protocolVersion: url.pathname.startsWith("/v3/") ? 3 : 2,
    }, env);
  } catch {
    return blobErrorResponse(503, "ATTN_BLOB_CAP_UNAVAILABLE", "blob capability verifier unavailable");
  }
  if (verified === undefined) {
    return blobErrorResponse(401, "ATTN_BLOB_CAP_INVALID", "invalid or expired blob cap");
  }
  const key = blobObjectKey(roomId, verified.leaseId, envelopeId, verified.objectKeyVersion ?? 1);
  const obj = await env.RELAY_BLOBS.get(key);
  if (obj === null) {
    return blobErrorResponse(404, "ATTN_BLOB_NOT_FOUND", "blob not found");
  }
  // Stream bytes back. Content-Length comes from the R2 object metadata.
  const headers = new Headers({
    "Content-Type": "application/octet-stream",
    "Content-Length": String(obj.size),
  });
  return new Response(obj.body as unknown as ReadableStream, { status: 200, headers });
}

/**
 * Attach policy-gated CORS to a Worker-owned blob-object response.
 *
 * The response bytes cannot be routed through the RoomDO without defeating the
 * R2 fast path, so we make a body-less OPTIONS probe solely to recover the
 * room's `allowBrowser` bit. Any probe failure fails closed (no CORS header),
 * while native clients without an Origin continue to receive the cap-authorized
 * response. Capability URLs and their responses are never cacheable.
 */
async function withBlobObjectCors(
  request: Request,
  env: Env,
  roomId: string,
  response: Response,
): Promise<Response> {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "private, no-store");

  if (request.headers.get("Origin") !== null) {
    try {
      const room = env.RELAY_ROOMS.get(env.RELAY_ROOMS.idFromName(roomId));
      const probe = await room.fetch(`https://room.internal/v2/rooms/${roomId}/blobs`, {
        method: "OPTIONS",
      });
      const allowBrowser = probe.headers.get(INTERNAL_ALLOW_BROWSER_HEADER);
      if (allowBrowser !== null) headers.set(INTERNAL_ALLOW_BROWSER_HEADER, allowBrowser);
    } catch {
      // Fail closed: corsMiddleware sees no allowBrowser handshake header.
    }
  }

  return corsMiddleware(
    request,
    env,
    new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    }),
  );
}

function blobErrorResponse(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status });
}
