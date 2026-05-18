/** RoomDO — per-room Durable Object. Holds envelopes, devices, acks, and WS peers. */

import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";

export class RoomDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  override async fetch(_request: Request): Promise<Response> {
    // TODO: handle WS upgrade + HTTP routes; filled in by attn-nnj.5.5..5.13
    //   - room create/rejoin     (5.5)
    //   - device register/list   (5.6)
    //   - envelope batch write   (5.7)
    //   - ack + owner delete     (5.8)
    //   - room delete            (5.9)
    //   - R2 blob presign        (5.10)
    //   - WebSocket subscribe    (5.11)
    //   - alarms (TTL + idle)    (5.12)
    //   - rate limiting          (5.13)
    return new Response("DO not implemented", { status: 501 });
  }
}
