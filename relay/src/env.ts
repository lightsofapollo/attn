/** Worker environment bindings as configured in wrangler.toml. */

import type { RoomDO } from "./room-do";
import type { QuotaDO } from "./quota-do";
import type { ShareDO } from "./share-do";

declare global {
  /** Optional build SHA injected at deploy time. */
  // eslint-disable-next-line no-var
  var BUILD_SHA: string | undefined;
}

export interface Env {
  // Durable Object namespace bound to the RoomDO class.
  RELAY_ROOMS: DurableObjectNamespace<RoomDO>;

  // One account-wide quota coordinator, addressed as idFromName("quota:v1").
  RELAY_QUOTAS: DurableObjectNamespace<QuotaDO>;
  RELAY_SHARES: DurableObjectNamespace<ShareDO>;

  // R2 bucket for blob spillover (encrypted snapshots > inline cap).
  RELAY_BLOBS: R2Bucket;

  // Hard maxima (string-typed env vars — parse at use site).
  HARD_MAX_PEERS: string;
  /** Concurrent anonymous v3 viewer sockets per room. Independent of maxPeers. */
  HARD_MAX_VIEWER_SOCKETS: string;
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

  // Durable first-create quota. All are required in deployed environments.
  QUOTA_MAX_LIVE_ROOMS_PER_SOURCE: string;
  QUOTA_MAX_ALLOCATED_BYTES_PER_SOURCE_24H: string;
  QUOTA_GLOBAL_MAX_LIVE_ROOMS: string;
  QUOTA_GLOBAL_MAX_RESERVED_BYTES: string;

  /** HMAC secret used to pseudonymize canonical CF-Connecting-IP values. */
  QUOTA_IP_HASH_KEY?: string;

  /** Local/test escape hatch. Never enable in a public deployment. */
  QUOTA_ALLOW_UNATTRIBUTED_CREATES?: string;

  /**
   * HMAC key for signing/verifying R2 blob-access caps. Set as a wrangler
   * SECRET in production: `wrangler secret put BLOB_CAP_SIGNING_KEY`. When unset
   * Public deployments fail closed when absent. Tests may explicitly opt in to
   * a deterministic fallback with ALLOW_INSECURE_BLOB_CAP_KEY.
   */
  BLOB_CAP_SIGNING_KEY?: string;

  /** Local/test-only opt-in to the public deterministic blob-cap key. */
  ALLOW_INSECURE_BLOB_CAP_KEY?: string;
}
