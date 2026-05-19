/** Worker entry. Routes HTTP requests; delegates per-room state to RoomDO. */

import { blobObjectKey, verifyBlobCap } from "./r2";
import { RoomDO } from "./room-do";
import type { Env } from "./env";

export { RoomDO };

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

    // WebSocket upgrade for /v2/rooms/:roomId/socket. The DO performs admission
    // (HMAC carried via Sec-WebSocket-Protocol per relay-spec.md §WS Protocol)
    // and accepts the socket. We just forward — the DO returns a 101 with the
    // selected subprotocol and the upgraded peer.
    const socketMatch = url.pathname.match(ROOM_SOCKET_RE);
    if (socketMatch && socketMatch[1]) {
      const upgrade = request.headers.get("Upgrade");
      if (upgrade !== "websocket" && upgrade !== "WebSocket") {
        return new Response("expected websocket upgrade", { status: 426 });
      }
      const roomId = socketMatch[1];
      const id = env.RELAY_ROOMS.idFromName(roomId);
      const stub = env.RELAY_ROOMS.get(id);
      return stub.fetch(request);
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
      return stub.fetch(request);
    }

    return new Response("not implemented yet", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

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
