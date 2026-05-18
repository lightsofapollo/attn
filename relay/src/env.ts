/** Worker environment bindings as configured in wrangler.toml. */

import type { RoomDO } from "./room-do";

declare global {
  /** Optional build SHA injected at deploy time. */
  // eslint-disable-next-line no-var
  var BUILD_SHA: string | undefined;
}

export interface Env {
  // Durable Object namespace bound to the RoomDO class.
  RELAY_ROOMS: DurableObjectNamespace<RoomDO>;

  // R2 bucket for blob spillover (encrypted snapshots > inline cap).
  RELAY_BLOBS: R2Bucket;

  // Hard maxima (string-typed env vars — parse at use site).
  HARD_MAX_PEERS: string;
  HARD_MAX_ROOM_BYTES: string;
  HARD_MAX_EVENT_BYTES: string;
  HARD_MAX_SNAPSHOT_BYTES: string;
  HARD_MAX_EVENTS: string;
  HARD_MAX_BATCH_ENVELOPES: string;
  HARD_MAX_TTL_MS: string;
  HARD_MAX_TTL_LONG_MS: string;
  DEFAULT_IDLE_TIMEOUT_MS: string;

  // PoW difficulty bounds.
  DEFAULT_POW_BITS: string;
  MIN_POW_BITS: string;
  MAX_POW_BITS: string;

  // Browser CORS allowlist (comma-separated origins).
  ALLOWED_BROWSER_ORIGINS: string;
}
