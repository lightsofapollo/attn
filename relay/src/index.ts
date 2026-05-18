/** Worker entry. Routes HTTP requests; delegates per-room state to RoomDO. */

import { RoomDO } from "./room-do";
import type { Env } from "./env";

export { RoomDO };

export default {
  async fetch(request: Request, _env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

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
