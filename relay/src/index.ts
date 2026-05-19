/** Worker entry. Routes HTTP requests; delegates per-room state to RoomDO. */

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
