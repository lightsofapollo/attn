/** Worker entry. Routes HTTP requests; delegates per-room state to RoomDO. */

import { RoomDO } from "./room-do";
import type { Env } from "./env";

export { RoomDO };

export default {
  async fetch(request: Request, _env: Env, _ctx: ExecutionContext): Promise<Response> {
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

    // All other routes 404 until filled in by:
    //   attn-nnj.5.5  POST /v2/rooms/:roomId
    //   attn-nnj.5.6  POST /v2/rooms/:roomId/devices, GET .../devices
    //   attn-nnj.5.7  POST /v2/rooms/:roomId/envelopes
    //   attn-nnj.5.8  POST /v2/rooms/:roomId/acks
    //   attn-nnj.5.9  DELETE /v2/rooms/:roomId
    //   attn-nnj.5.10 POST /v2/rooms/:roomId/blobs (R2 presign)
    //   attn-nnj.5.11 WebSocket upgrade + frames
    return new Response("not implemented yet", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
