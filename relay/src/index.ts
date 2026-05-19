/** Worker entry. Routes HTTP requests; delegates per-room state to RoomDO. */

import { blobObjectKey, verifyBlobCap } from "./r2";
import { WorkerEdgeRateLimit, type RateLimitResult } from "./rate-limit";
import { RoomDO } from "./room-do";
import type { Env } from "./env";

export { RoomDO };

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
  // x-forwarded-for is sometimes set by upstream proxies in dev.
  const xff = request.headers.get("X-Forwarded-For");
  if (xff !== null && xff !== "") return xff.split(",")[0]?.trim() ?? "unknown";
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
const CORS_ALLOWED_HEADERS = "Content-Type, Attn-Admission, Attn-Owner-Signature, Attn-PoW";

/** Methods the relay exposes to browsers — everything in the v2 HTTP surface. */
const CORS_ALLOWED_METHODS = "GET, POST, DELETE, OPTIONS";

/**
 * Parse `ALLOWED_BROWSER_ORIGINS` into a Set for O(1) membership lookup.
 *
 * The env var is a comma-separated allowlist (e.g.
 * `"https://attn.dev,https://staging.attn.dev"`). Empty / whitespace entries
 * are skipped so a stray trailing comma doesn't accidentally allow the empty
 * Origin.
 */
function parseAllowedOrigins(env: Env): Set<string> {
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

  if (allowBrowser) {
    const origin = originIfAllowed(request, env);
    if (origin !== undefined) {
      newHeaders.set("Access-Control-Allow-Origin", origin);
      newHeaders.set("Access-Control-Allow-Headers", CORS_ALLOWED_HEADERS);
      newHeaders.set("Access-Control-Allow-Methods", CORS_ALLOWED_METHODS);
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
const ROOM_ROUTE_RE = /^\/v2\/rooms\/([^/]+)(?:\/.*)?$/;

/** WS upgrade route matcher: `/v2/rooms/:roomId/socket`. */
const ROOM_SOCKET_RE = /^\/v2\/rooms\/([^/]+)\/socket\/?$/;

/**
 * R2 capability-backed blob route: `/v2/rooms/:roomId/blobs/:envelopeId`.
 *
 * This route stands in for a true presigned URL (see r2.ts docstring). The
 * Worker (NOT the DO) handles both PUT (upload) and GET (download) so the
 * R2 binding traffic doesn't have to cross the DO RPC boundary. Authorization
 * is the `?cap=<token>` query parameter — minted by the DO's POST /blobs
 * handler, verified here on every request.
 */
const ROOM_BLOB_OBJECT_RE = /^\/v2\/rooms\/([^/]+)\/blobs\/([^/]+)\/?$/;

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

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

    // WebSocket upgrade for /v2/rooms/:roomId/socket. The DO performs admission
    // (HMAC carried via Sec-WebSocket-Protocol per relay-spec.md §WS Protocol)
    // and accepts the socket. We just forward — the DO returns a 101 with the
    // selected subprotocol and the upgraded peer.
    //
    // Browser-policy Origin check happens inside the DO (where the room policy
    // is loaded). The DO also signals allowBrowser back via the internal
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
      const response = await stub.fetch(request);
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
      const envelopeId = decodeURIComponent(blobObjectMatch[2]);
      // Blob PUT/GET don't pass through the DO, so the Worker fetches policy
      // directly from the DO (via a GET on the room itself) only when we need
      // to emit CORS — for now, blob responses skip CORS entirely since the
      // browser allowBrowser flow uses POST /blobs (which routes to the DO) +
      // a server-mediated upload. PUT/GET cap-bearing routes are native-style.
      // Preflight OPTIONS is still answered (via the DO ROUTE_RE handler below).
      if (request.method === "PUT") {
        return handleBlobPut(request, env, url, roomId, envelopeId);
      }
      if (request.method === "GET") {
        return handleBlobGet(request, env, url, roomId, envelopeId);
      }
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
  const m = pathname.match(/^\/v2\/rooms\/([^/]+)(?:\/.*)?$/);
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
  const verified = await verifyBlobCap(cap, { method: "PUT", roomId, envelopeId });
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

  const key = blobObjectKey(roomId, envelopeId);
  try {
    await env.RELAY_BLOBS.put(key, bodyBytes, {
      httpMetadata: { contentType: "application/octet-stream" },
    });
  } catch (err) {
    return blobErrorResponse(
      500,
      "ATTN_BLOB_UPLOAD_FAILED",
      `R2 put failed: ${(err as Error).message}`,
    );
  }
  return new Response(null, { status: 204 });
}

/**
 * `GET /v2/rooms/:roomId/blobs/:envelopeId?cap=...`
 *
 * Download a previously-uploaded blob. The cap was minted by an explicit
 * (forthcoming) `GET /v2/rooms/:roomId/blobs/:envelopeId` DO endpoint — for
 * now tests mint the cap directly via the r2.ts helper.
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
  const verified = await verifyBlobCap(cap, { method: "GET", roomId, envelopeId });
  if (verified === undefined) {
    return blobErrorResponse(401, "ATTN_BLOB_CAP_INVALID", "invalid or expired blob cap");
  }
  const key = blobObjectKey(roomId, envelopeId);
  const obj = await env.RELAY_BLOBS.get(key);
  if (obj === null) {
    return blobErrorResponse(404, "ATTN_BLOB_NOT_FOUND", `blob ${key} not found`);
  }
  // Stream bytes back. Content-Length comes from the R2 object metadata.
  const headers = new Headers({
    "Content-Type": "application/octet-stream",
    "Content-Length": String(obj.size),
  });
  return new Response(obj.body as unknown as ReadableStream, { status: 200, headers });
}

function blobErrorResponse(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status });
}
