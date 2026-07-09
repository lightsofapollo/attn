/**
 * Account-wide room allocation quota.
 *
 * Every RoomDO talks to the same SQLite-backed instance
 * (`RELAY_QUOTAS.idFromName("quota:v1")`). Durable Object serialization plus
 * the explicit storage transactions below make the final capacity slot an
 * atomic decision across every room in the deployment.
 */

import { DurableObject } from "cloudflare:workers";

import type { Env } from "./env";

const ROLLING_WINDOW_MS = 24 * 60 * 60 * 1000;
const GLOBAL_STATE_KEY = "global:v1";
const LEASE_PREFIX = "lease:";
const SOURCE_PREFIX = "source:";
const SOURCE_EXPIRY_PREFIX = "source_expiry:";
const EXPIRY_TIMESTAMP_WIDTH = 16;
/** Bound one alarm transaction's reads/writes even after a large burst. */
const EXPIRY_ALARM_BATCH_SIZE = 128;

/** Private Worker -> RoomDO header. The Worker always strips client input. */
export const INTERNAL_QUOTA_SOURCE_HEADER = "X-Attn-Quota-Source";

interface AcquireRequest {
  roomId: string;
  leaseId: string;
  sourceBucket: string;
  reservedBytes: number;
}

interface ReleaseRequest {
  roomId: string;
  leaseId: string;
}

export interface QuotaLease extends AcquireRequest {
  acquiredAt: number;
}

interface Allocation {
  at: number;
  bytes: number;
}

interface SourceState {
  liveRooms: number;
  allocations: Allocation[];
}

interface GlobalState {
  liveRooms: number;
  reservedBytes: number;
}

interface SourceExpiryRecord {
  sourceBucket: string;
  allocationAt: number;
}

interface QuotaConfig {
  reservedBytesPerRoom: number;
  maxLiveRoomsPerSource: number;
  maxAllocatedBytesPerSource24h: number;
  globalMaxLiveRooms: number;
  globalMaxReservedBytes: number;
}

interface QuotaDecision {
  status: number;
  code?: string;
  message?: string;
  retryAfterSeconds?: number;
}

export class QuotaDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST") {
      return quotaError(405, "ATTN_METHOD_NOT_ALLOWED", "quota endpoint requires POST");
    }

    if (url.pathname === "/acquire") return this.acquire(request);
    if (url.pathname === "/release") return this.release(request);
    return quotaError(404, "ATTN_NOT_FOUND", "unknown quota endpoint");
  }

  private async acquire(request: Request): Promise<Response> {
    const body = await parseJson<AcquireRequest>(request);
    if (!isAcquireRequest(body)) {
      return quotaError(400, "ATTN_QUOTA_UNAVAILABLE", "invalid quota acquire request");
    }

    let config: QuotaConfig;
    try {
      config = readQuotaConfig(this.env);
    } catch (error) {
      return quotaError(503, "ATTN_QUOTA_UNAVAILABLE", (error as Error).message, 60);
    }
    if (body.reservedBytes !== config.reservedBytesPerRoom) {
      return quotaError(
        503,
        "ATTN_QUOTA_UNAVAILABLE",
        "room reservation does not match HARD_MAX_ROOM_BYTES",
        60,
      );
    }

    const now = Date.now();
    let decision: QuotaDecision;
    try {
      decision = await this.ctx.storage.transaction(async (txn) => {
        const leaseKey = quotaLeaseKey(body.roomId);
        const existing = await txn.get<QuotaLease>(leaseKey);
        if (existing !== undefined) {
          if (!isStoredLease(existing)) return corruptDecision("invalid stored quota lease");
          if (
            existing.leaseId === body.leaseId &&
            existing.sourceBucket === body.sourceBucket &&
            existing.reservedBytes === body.reservedBytes
          ) {
            // Retrying the same generation after a lost response must not
            // consume either another live slot or another 24h allocation.
            return { status: 200 };
          }
          return {
            status: 409,
            code: "ATTN_QUOTA_LEASE_CONFLICT",
            message: "room already has a different active quota lease",
          };
        }

        const sourceKey = quotaSourceKey(body.sourceBucket);
        const source = (await txn.get<SourceState>(sourceKey)) ?? {
          liveRooms: 0,
          allocations: [],
        };
        const global = (await txn.get<GlobalState>(GLOBAL_STATE_KEY)) ?? {
          liveRooms: 0,
          reservedBytes: 0,
        };
        if (!isSourceState(source) || !isGlobalState(global)) {
          return corruptDecision("invalid quota counter state");
        }

        const activeAllocations = source.allocations.filter(
          (entry) => entry.at > now - ROLLING_WINDOW_MS,
        );
        const allocatedBytes = safeSum(activeAllocations.map((entry) => entry.bytes));
        if (allocatedBytes === undefined) {
          return corruptDecision("source allocation counter overflow");
        }

        const nextSourceLive = safeAdd(source.liveRooms, 1);
        const nextAllocatedBytes = safeAdd(allocatedBytes, body.reservedBytes);
        const nextGlobalLive = safeAdd(global.liveRooms, 1);
        const nextGlobalReserved = safeAdd(global.reservedBytes, body.reservedBytes);
        if (
          nextSourceLive === undefined ||
          nextAllocatedBytes === undefined ||
          nextGlobalLive === undefined ||
          nextGlobalReserved === undefined
        ) {
          return corruptDecision("quota counter overflow");
        }

        if (nextSourceLive > config.maxLiveRoomsPerSource) {
          return {
            status: 429,
            code: "ATTN_SOURCE_ROOM_QUOTA",
            message: "source has reached its live room quota",
            retryAfterSeconds: 60,
          };
        }
        if (nextAllocatedBytes > config.maxAllocatedBytesPerSource24h) {
          const oldest = activeAllocations.reduce(
            (minimum, entry) => Math.min(minimum, entry.at),
            now,
          );
          return {
            status: 429,
            code: "ATTN_SOURCE_BYTE_QUOTA",
            message: "source has reached its rolling 24 hour allocation quota",
            retryAfterSeconds: Math.max(
              1,
              Math.ceil((oldest + ROLLING_WINDOW_MS - now) / 1000),
            ),
          };
        }
        if (
          nextGlobalLive > config.globalMaxLiveRooms ||
          nextGlobalReserved > config.globalMaxReservedBytes
        ) {
          return {
            status: 503,
            code: "ATTN_RELAY_CAPACITY",
            message: "relay reserved capacity is exhausted",
            retryAfterSeconds: 60,
          };
        }

        const nextSource: SourceState = {
          liveRooms: nextSourceLive,
          // Allocations are deliberately non-refundable: release only lowers
          // live/reserved counters and leaves this 24h ingress record intact.
          allocations: [...activeAllocations, { at: now, bytes: body.reservedBytes }],
        };
        const nextGlobal: GlobalState = {
          liveRooms: nextGlobalLive,
          reservedBytes: nextGlobalReserved,
        };
        if (!isSourceState(nextSource) || !isGlobalState(nextGlobal)) {
          return corruptDecision("quota counter overflow");
        }

        await txn.put(sourceKey, nextSource);
        await txn.put(GLOBAL_STATE_KEY, nextGlobal);
        await txn.put<QuotaLease>(leaseKey, { ...body, acquiredAt: now });
        const expiresAt = now + ROLLING_WINDOW_MS;
        await txn.put<SourceExpiryRecord>(
          sourceExpiryKey(expiresAt, body.roomId, body.leaseId),
          { sourceBucket: body.sourceBucket, allocationAt: now },
        );
        // Alarm state participates in the same transaction as the allocation
        // and its expiry index, closing the crash window that would otherwise
        // leave an indexed source with no future cleanup wake-up.
        const currentAlarm = await txn.getAlarm();
        if (currentAlarm === null || expiresAt < currentAlarm) {
          await txn.setAlarm(expiresAt);
        }
        return { status: 201 };
      });
    } catch {
      return quotaError(503, "ATTN_QUOTA_UNAVAILABLE", "quota transaction failed", 60);
    }

    if (decision.status === 200 || decision.status === 201) {
      return Response.json({ ok: true }, { status: decision.status });
    }
    return quotaError(
      decision.status,
      decision.code ?? "ATTN_QUOTA_UNAVAILABLE",
      decision.message ?? "quota decision failed",
      decision.retryAfterSeconds,
    );
  }

  private async release(request: Request): Promise<Response> {
    const body = await parseJson<ReleaseRequest>(request);
    if (!isReleaseRequest(body)) {
      return quotaError(400, "ATTN_QUOTA_UNAVAILABLE", "invalid quota release request");
    }

    let decision: QuotaDecision;
    try {
      decision = await this.ctx.storage.transaction(async (txn) => {
        const leaseKey = quotaLeaseKey(body.roomId);
        const existing = await txn.get<QuotaLease>(leaseKey);
        // Absent and stale-generation releases are both idempotent no-ops.
        // The random leaseId prevents a delayed release from decrementing a
        // newly recreated room that happens to reuse the same roomId.
        if (existing === undefined) {
          return { status: 204 };
        }
        if (!isStoredLease(existing)) return corruptDecision("invalid stored quota lease");
        if (existing.leaseId !== body.leaseId) return { status: 204 };

        const sourceKey = quotaSourceKey(existing.sourceBucket);
        const source = await txn.get<SourceState>(sourceKey);
        const global = await txn.get<GlobalState>(GLOBAL_STATE_KEY);
        if (
          source === undefined ||
          global === undefined ||
          !isSourceState(source) ||
          !isGlobalState(global) ||
          source.liveRooms < 1 ||
          global.liveRooms < 1 ||
          global.reservedBytes < existing.reservedBytes
        ) {
          return corruptDecision("quota counter underflow");
        }

        const nextSourceLive = source.liveRooms - 1;
        if (nextSourceLive === 0 && source.allocations.length === 0) {
          // The alarm may already have aged out every allocation while this
          // lease remained live. Once the last live room releases there is no
          // future expiry index left to wake us, so delete the empty row now.
          await txn.delete(sourceKey);
        } else {
          await txn.put<SourceState>(sourceKey, {
            liveRooms: nextSourceLive,
            allocations: source.allocations,
          });
        }
        await txn.put<GlobalState>(GLOBAL_STATE_KEY, {
          liveRooms: global.liveRooms - 1,
          reservedBytes: global.reservedBytes - existing.reservedBytes,
        });
        await txn.delete(leaseKey);
        return { status: 204 };
      });
    } catch {
      return quotaError(503, "ATTN_QUOTA_UNAVAILABLE", "quota transaction failed", 60);
    }

    if (decision.status === 204) return new Response(null, { status: 204 });
    return quotaError(
      decision.status,
      decision.code ?? "ATTN_QUOTA_UNAVAILABLE",
      decision.message ?? "quota release failed",
      decision.retryAfterSeconds,
    );
  }

  /**
   * Prune rolling-allocation state in bounded, lexicographic expiry batches.
   * A source row is deleted only after it has no live rooms and no allocation
   * still inside the rolling 24h window.
   */
  override async alarm(): Promise<void> {
    const now = Date.now();
    await this.ctx.storage.transaction(async (txn) => {
      const indexed = await txn.list<SourceExpiryRecord>({
        prefix: SOURCE_EXPIRY_PREFIX,
        limit: EXPIRY_ALARM_BATCH_SIZE + 1,
      });

      const processed: Array<[string, SourceExpiryRecord]> = [];
      let nextAlarmAt: number | undefined;
      for (const [key, record] of indexed) {
        const expiresAt = expiryTimestampFromKey(key);
        if (processed.length >= EXPIRY_ALARM_BATCH_SIZE) {
          nextAlarmAt = expiresAt === undefined || expiresAt <= now ? now + 1 : expiresAt;
          break;
        }
        // Invalid index rows cannot be allowed to pin the alarm forever. They
        // carry no trustworthy source reference, so delete them as processed.
        if (expiresAt === undefined) {
          processed.push([key, record]);
          continue;
        }
        if (expiresAt > now) {
          nextAlarmAt = expiresAt;
          break;
        }
        processed.push([key, record]);
      }

      const sourceBuckets = new Set<string>();
      for (const [, record] of processed) {
        if (isSourceExpiryRecord(record)) sourceBuckets.add(record.sourceBucket);
      }
      for (const sourceBucket of sourceBuckets) {
        const key = quotaSourceKey(sourceBucket);
        const source = await txn.get<SourceState>(key);
        if (source === undefined) continue;
        if (!isSourceState(source)) {
          // Preserve fail-closed corrupt state and its index so an operator can
          // diagnose it; aborting rolls back every deletion in this batch.
          throw new Error("invalid quota source state during expiry cleanup");
        }
        const activeAllocations = source.allocations.filter(
          (entry) => entry.at > now - ROLLING_WINDOW_MS,
        );
        if (source.liveRooms === 0 && activeAllocations.length === 0) {
          await txn.delete(key);
        } else if (activeAllocations.length !== source.allocations.length) {
          await txn.put<SourceState>(key, {
            liveRooms: source.liveRooms,
            allocations: activeAllocations,
          });
        }
      }

      if (processed.length > 0) {
        await txn.delete(processed.map(([key]) => key));
      }
      if (nextAlarmAt === undefined) {
        await txn.deleteAlarm();
      } else {
        await txn.setAlarm(Math.max(now + 1, nextAlarmAt));
      }
    });
  }
}

function readQuotaConfig(env: Env): QuotaConfig {
  const config: QuotaConfig = {
    reservedBytesPerRoom: positiveInt(env.HARD_MAX_ROOM_BYTES, "HARD_MAX_ROOM_BYTES"),
    maxLiveRoomsPerSource: positiveInt(
      env.QUOTA_MAX_LIVE_ROOMS_PER_SOURCE,
      "QUOTA_MAX_LIVE_ROOMS_PER_SOURCE",
    ),
    maxAllocatedBytesPerSource24h: positiveInt(
      env.QUOTA_MAX_ALLOCATED_BYTES_PER_SOURCE_24H,
      "QUOTA_MAX_ALLOCATED_BYTES_PER_SOURCE_24H",
    ),
    globalMaxLiveRooms: positiveInt(
      env.QUOTA_GLOBAL_MAX_LIVE_ROOMS,
      "QUOTA_GLOBAL_MAX_LIVE_ROOMS",
    ),
    globalMaxReservedBytes: positiveInt(
      env.QUOTA_GLOBAL_MAX_RESERVED_BYTES,
      "QUOTA_GLOBAL_MAX_RESERVED_BYTES",
    ),
  };
  if (config.maxAllocatedBytesPerSource24h < config.reservedBytesPerRoom) {
    throw new Error("source byte quota must fit at least one room reservation");
  }
  if (config.globalMaxReservedBytes < config.reservedBytesPerRoom) {
    throw new Error("global byte quota must fit at least one room reservation");
  }
  return config;
}

function positiveInt(raw: string | undefined, name: string): number {
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`env.${name} must be a positive safe integer`);
  }
  return parsed;
}

function quotaLeaseKey(roomId: string): string {
  return `${LEASE_PREFIX}${roomId}`;
}

function quotaSourceKey(sourceBucket: string): string {
  return `${SOURCE_PREFIX}${sourceBucket}`;
}

function sourceExpiryKey(expiresAt: number, roomId: string, leaseId: string): string {
  return `${SOURCE_EXPIRY_PREFIX}${String(expiresAt).padStart(EXPIRY_TIMESTAMP_WIDTH, "0")}:${roomId}:${leaseId}`;
}

function expiryTimestampFromKey(key: string): number | undefined {
  if (!key.startsWith(SOURCE_EXPIRY_PREFIX)) return undefined;
  const raw = key.slice(
    SOURCE_EXPIRY_PREFIX.length,
    SOURCE_EXPIRY_PREFIX.length + EXPIRY_TIMESTAMP_WIDTH,
  );
  if (raw.length !== EXPIRY_TIMESTAMP_WIDTH || !/^\d+$/.test(raw)) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function isAcquireRequest(value: AcquireRequest | undefined): value is AcquireRequest {
  return (
    value !== undefined &&
    nonEmpty(value.roomId) &&
    nonEmpty(value.leaseId) &&
    nonEmpty(value.sourceBucket) &&
    Number.isSafeInteger(value.reservedBytes) &&
    value.reservedBytes > 0
  );
}

function isReleaseRequest(value: ReleaseRequest | undefined): value is ReleaseRequest {
  return value !== undefined && nonEmpty(value.roomId) && nonEmpty(value.leaseId);
}

function isStoredLease(value: QuotaLease): boolean {
  return (
    isAcquireRequest(value) &&
    Number.isSafeInteger(value.acquiredAt) &&
    value.acquiredAt >= 0
  );
}

function isSourceState(value: SourceState): boolean {
  return (
    Number.isSafeInteger(value.liveRooms) &&
    value.liveRooms >= 0 &&
    Array.isArray(value.allocations) &&
    value.allocations.every(
      (entry) =>
        Number.isSafeInteger(entry.at) &&
        entry.at >= 0 &&
        Number.isSafeInteger(entry.bytes) &&
        entry.bytes > 0,
    )
  );
}

function isGlobalState(value: GlobalState): boolean {
  return (
    Number.isSafeInteger(value.liveRooms) &&
    value.liveRooms >= 0 &&
    Number.isSafeInteger(value.reservedBytes) &&
    value.reservedBytes >= 0
  );
}

function isSourceExpiryRecord(value: SourceExpiryRecord): boolean {
  return (
    nonEmpty(value.sourceBucket) &&
    Number.isSafeInteger(value.allocationAt) &&
    value.allocationAt >= 0
  );
}

function safeSum(values: number[]): number | undefined {
  let total = 0;
  for (const value of values) {
    total += value;
    if (!Number.isSafeInteger(total) || total < 0) return undefined;
  }
  return total;
}

function safeAdd(left: number, right: number): number | undefined {
  const total = left + right;
  return Number.isSafeInteger(total) && total >= 0 ? total : undefined;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512;
}

async function parseJson<T>(request: Request): Promise<T | undefined> {
  try {
    return (await request.json()) as T;
  } catch {
    return undefined;
  }
}

function corruptDecision(message: string): QuotaDecision {
  return {
    status: 503,
    code: "ATTN_QUOTA_UNAVAILABLE",
    message,
    retryAfterSeconds: 60,
  };
}

function quotaError(
  status: number,
  code: string,
  message: string,
  retryAfterSeconds?: number,
): Response {
  const headers = new Headers({ "Content-Type": "application/json" });
  const error: { code: string; message: string; retryAfterMs?: number } = {
    code,
    message,
  };
  if (retryAfterSeconds !== undefined) {
    headers.set("Retry-After", String(retryAfterSeconds));
    headers.set("X-Attn-Retry-After-Ms", String(retryAfterSeconds * 1000));
    error.retryAfterMs = retryAfterSeconds * 1000;
  }
  return new Response(JSON.stringify({ error }), {
    status,
    headers,
  });
}
