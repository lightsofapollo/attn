/** Per-device + per-IP rate limiting per relay-spec.md §Anti-Abuse + §Caps.
 *
 * Two limiters live here:
 *
 *   - {@link WorkerEdgeRateLimit} — in-memory, runs at the Worker edge in
 *     `index.ts`. Tracks per-IP request count (default 600/min) and
 *     per-IP "unknown room" count (anti-enumeration, default 30 distinct
 *     unknown roomIds per 5min). State is held in two Maps in Worker
 *     process memory; cold-starts wipe the state (the rate cap is an
 *     order-of-magnitude defense, not a precise quota — spec is explicit
 *     about this in §Anti-Abuse).
 *
 *   - {@link DurableObjectRateLimit} — persisted in DO storage, scoped to
 *     a single room's blast radius. Tracks per-device request count
 *     (default 120/min). The per-(deviceId, minute) counter is stored
 *     at `rate:<deviceId>:<windowStartMin>` per relay-spec.md
 *     §Storage Layout; entries past the current minute fall out of the
 *     sliding window read.
 *
 * Both limiters return a {@link RateLimitResult}. The `code` field
 * distinguishes plain rate-limit overflow from anti-enumeration so
 * clients/operators can tell whether the caller hit the volume cap or
 * the URL-guessing cap.
 *
 * Sliding window strategy: we use a fixed-minute bucketing scheme.
 * Each call (a) computes `windowStartMin = floor(nowMs / 60_000)`,
 * (b) reads the current bucket count, (c) rejects if past the cap,
 * (d) writes the incremented count. We deliberately do not "smear"
 * across two adjacent minutes — the cheap fixed-window has the standard
 * 2× burst risk at the boundary, which is acceptable for the spec's
 * order-of-magnitude framing.
 */

/** Tunables for both limiter classes. */
export interface RateLimitConfig {
  /** Per-device per-minute cap (default 120 per relay-spec.md §Caps). */
  perDevicePerMinute: number;
  /** Per-IP per-minute cap (default 600 per relay-spec.md §Caps). */
  perIpPerMinute: number;
  /**
   * Anti-enumeration cap: distinct unknown roomIds an IP can probe in 5min
   * before getting blocked (default 30 per relay-spec.md §Anti-Abuse).
   */
  antiEnumPerFiveMin: number;
}

/** Default config matching the spec table. */
export const DEFAULT_RATE_LIMIT_CONFIG: RateLimitConfig = {
  perDevicePerMinute: 120,
  perIpPerMinute: 600,
  antiEnumPerFiveMin: 30,
};

export interface RateLimitResult {
  ok: boolean;
  /** Hint to the client for the next viable retry, in milliseconds. */
  retryAfterMs?: number;
  /** Canonical error code (`ATTN_RATE_LIMITED` or `ATTN_ENUM_LIMITED`). */
  code?: string;
}

const MINUTE_MS = 60_000;
const FIVE_MIN_MS = 5 * 60_000;

/** Per-IP bucket — request count over the current 60s window. */
interface IpBucket {
  count: number;
  /** windowStartMs of the bucket (floor(now / 60_000) * 60_000). */
  windowStart: number;
}

/** Per-IP anti-enum bucket — set of unknown roomIds touched in the last 5min. */
interface AntiEnumBucket {
  /** Map of unknownRoomId → first-seen timestamp; entries older than 5min are pruned lazily on read. */
  seen: Map<string, number>;
}

/**
 * Worker-edge limiter. Lives in the Worker process memory because the
 * Worker fans out across thousands of in-flight rooms — putting this
 * behind a DO would introduce a hop on every request. The trade-off is
 * documented in relay-spec.md §Anti-Abuse: per-IP limits are an
 * order-of-magnitude defense, not a precise quota.
 *
 * Reset semantics:
 *   - per-IP buckets advance to a fresh window whenever `windowStart`
 *     lags `now` by ≥ 60s, so the cap acts on a sliding minute.
 *   - anti-enum buckets prune entries past the 5min retention as they
 *     are read; the underlying Map shrinks naturally on idle traffic.
 */
export class WorkerEdgeRateLimit {
  private readonly config: RateLimitConfig;
  /**
   * Per-IP request buckets. Keyed by raw IP string (the caller is
   * responsible for choosing a non-spoofable header, typically
   * `CF-Connecting-IP`). Bounded only by traffic — we accept that
   * adversaries can balloon this Map; Worker isolates recycle on a
   * memory budget so an attacker can't OOM the global namespace.
   */
  private readonly ipBuckets: Map<string, IpBucket> = new Map();
  /** Per-IP anti-enum buckets — pruned lazily on each call. */
  private readonly antiEnumBuckets: Map<string, AntiEnumBucket> = new Map();
  /** Allows tests to advance the clock without timer fakes. */
  private readonly nowFn: () => number;

  constructor(config: RateLimitConfig = DEFAULT_RATE_LIMIT_CONFIG, nowFn: () => number = Date.now) {
    this.config = config;
    this.nowFn = nowFn;
  }

  /**
   * Check rate caps for `ip` reaching `roomId`. The caller passes
   * `roomExists` so the limiter can update the anti-enum bucket
   * (unknown rooms count; existing rooms don't).
   *
   * Returns `{ ok: true }` on success, or a `{ ok: false, code,
   * retryAfterMs }` payload the caller maps to a 429 response.
   *
   * Order of evaluation matters: we check anti-enum BEFORE the
   * per-IP cap so a script enumerating unknown rooms surfaces the
   * specific `ATTN_ENUM_LIMITED` code rather than the generic
   * `ATTN_RATE_LIMITED`.
   */
  check(ip: string, roomId: string, roomExists: boolean): RateLimitResult {
    const now = this.nowFn();

    // 1. Anti-enumeration — only counted when the room doesn't exist.
    if (!roomExists) {
      const result = this.trackUnknownRoom(ip, roomId, now);
      if (!result.ok) return result;
    }

    // 2. Per-IP total request rate. Counted whether the room exists or not.
    return this.incrementIpBucket(ip, now);
  }

  /**
   * Update the anti-enum bucket and reject if the IP has now probed
   * more than `config.antiEnumPerFiveMin` distinct unknown roomIds in
   * the last 5min.
   *
   * Pruning runs at read time: any roomId first seen ≥ 5min ago is
   * removed before the size check, so a slow trickle of unknown probes
   * (say 1/min) never crosses the cap.
   */
  private trackUnknownRoom(ip: string, roomId: string, now: number): RateLimitResult {
    let bucket = this.antiEnumBuckets.get(ip);
    if (bucket === undefined) {
      bucket = { seen: new Map() };
      this.antiEnumBuckets.set(ip, bucket);
    }

    // Prune entries past the 5-min retention.
    const cutoff = now - FIVE_MIN_MS;
    for (const [seenRoomId, ts] of bucket.seen) {
      if (ts < cutoff) {
        bucket.seen.delete(seenRoomId);
      }
    }

    // Record this attempt (idempotent — re-probing the same unknown
    // room in the window updates the first-seen timestamp; spec frames
    // the cap as "distinct unknown rooms" so we keep one slot per id).
    if (!bucket.seen.has(roomId)) {
      // Limit BEFORE inserting so we reject at the (cap+1)th distinct id.
      if (bucket.seen.size >= this.config.antiEnumPerFiveMin) {
        // retryAfterMs = time until the oldest entry falls out.
        const oldestTs = oldestTimestamp(bucket.seen);
        const retryAfterMs = oldestTs === undefined ? FIVE_MIN_MS : Math.max(1, oldestTs + FIVE_MIN_MS - now);
        return { ok: false, code: "ATTN_ENUM_LIMITED", retryAfterMs };
      }
      bucket.seen.set(roomId, now);
    } else {
      bucket.seen.set(roomId, now);
    }
    return { ok: true };
  }

  /**
   * Increment the per-IP request bucket for `now`'s minute and reject
   * if the post-increment count exceeds `config.perIpPerMinute`.
   *
   * Window roll-over: any bucket whose `windowStart` lags the current
   * minute is reset before the increment, so the cap operates on the
   * minute the request lands in.
   */
  private incrementIpBucket(ip: string, now: number): RateLimitResult {
    const currentWindow = Math.floor(now / MINUTE_MS) * MINUTE_MS;
    let bucket = this.ipBuckets.get(ip);
    if (bucket === undefined || bucket.windowStart !== currentWindow) {
      bucket = { count: 0, windowStart: currentWindow };
      this.ipBuckets.set(ip, bucket);
    }
    bucket.count += 1;
    if (bucket.count > this.config.perIpPerMinute) {
      const retryAfterMs = Math.max(1, bucket.windowStart + MINUTE_MS - now);
      return { ok: false, code: "ATTN_RATE_LIMITED", retryAfterMs };
    }
    return { ok: true };
  }

  /** Test/diagnostic accessor — count of tracked IPs in the request bucket. */
  trackedIpCount(): number {
    return this.ipBuckets.size;
  }
}

function oldestTimestamp(map: Map<string, number>): number | undefined {
  let oldest: number | undefined;
  for (const ts of map.values()) {
    if (oldest === undefined || ts < oldest) oldest = ts;
  }
  return oldest;
}

/**
 * Per-device limiter persisted in Durable Object storage. Lives inside
 * a RoomDO so the per-device cap is naturally scoped to a single room
 * (the spec is explicit: "the per-device key is `deviceId` from the
 * request body … trusted only within a single room's blast radius").
 *
 * Storage shape: each minute's count for a device is held at
 * `rate:<deviceId>:<windowStartMin>` per relay-spec.md §Storage Layout.
 * Stale entries fall out via the standard DO alarm sweep (5.12) — the
 * limiter itself only operates on the current minute.
 */
export class DurableObjectRateLimit {
  private readonly config: RateLimitConfig;
  private readonly storage: DurableObjectStorage;
  private readonly nowFn: () => number;

  constructor(
    storage: DurableObjectStorage,
    config: RateLimitConfig = DEFAULT_RATE_LIMIT_CONFIG,
    nowFn: () => number = Date.now,
  ) {
    this.storage = storage;
    this.config = config;
    this.nowFn = nowFn;
  }

  /**
   * Check the per-(deviceId, minute) write rate. Returns ok with no
   * side effects when within the cap, or ok=false with
   * `code=ATTN_RATE_LIMITED` plus `retryAfterMs` (time until the
   * next minute boundary) when the cap is exceeded.
   *
   * A successful check writes back the incremented counter so a
   * concurrent caller within the same DO event sees the bump. DO
   * storage is serialized per-object, so we don't race ourselves.
   */
  async check(deviceId: string): Promise<RateLimitResult> {
    const now = this.nowFn();
    const windowStartMin = Math.floor(now / MINUTE_MS);
    const key = rateKey(deviceId, windowStartMin);
    const current = (await this.storage.get<number>(key)) ?? 0;
    const next = current + 1;
    if (next > this.config.perDevicePerMinute) {
      const retryAfterMs = Math.max(1, (windowStartMin + 1) * MINUTE_MS - now);
      return { ok: false, code: "ATTN_RATE_LIMITED", retryAfterMs };
    }
    await this.storage.put(key, next);
    return { ok: true };
  }
}

/** Storage-key builder shared with the alarm sweep so they agree on the prefix. */
export function rateKey(deviceId: string, windowStartMin: number): string {
  return `rate:${deviceId}:${windowStartMin}`;
}

/** Prefix used by the alarm sweep to walk + prune stale rate buckets. */
export const RATE_KEY_PREFIX = "rate:";
