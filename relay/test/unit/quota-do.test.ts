/** Atomic quota coordinator coverage. Each test uses a distinct QuotaDO id. */

import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { Env } from "../../src/env";
import { encodeOpaqueSegment } from "../../src/opaque-key";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

const RESERVED = 25 * 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;
let counter = 0;

function quotaStub(label: string): DurableObjectStub {
  counter += 1;
  const id = env.RELAY_QUOTAS.idFromName(`${label}-${Date.now()}-${counter}`);
  return env.RELAY_QUOTAS.get(id);
}

async function acquire(
  stub: DurableObjectStub,
  roomId: string,
  leaseId: string,
  sourceBucket: string,
): Promise<Response> {
  return stub.fetch("https://quota.internal/acquire", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ roomId, leaseId, sourceBucket, reservedBytes: RESERVED }),
  });
}

async function release(
  stub: DurableObjectStub,
  roomId: string,
  leaseId: string,
): Promise<Response> {
  return stub.fetch("https://quota.internal/release", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ roomId, leaseId }),
  });
}

async function code(response: Response): Promise<string | undefined> {
  const body = (await response.clone().json()) as { error?: { code?: string } };
  return body.error?.code;
}

async function ageSourceAllocationAndIndex(
  stub: DurableObjectStub,
  sourceBucket: string,
): Promise<void> {
  await runInDurableObject(stub, async (_instance, state) => {
    const agedAt = Date.now() - DAY_MS - 10;
    const sourceKey = `source:${sourceBucket}`;
    const source = await state.storage.get<{
      liveRooms: number;
      allocations: Array<{ at: number; bytes: number }>;
    }>(sourceKey);
    if (source === undefined) throw new Error("source record missing");
    await state.storage.put(sourceKey, {
      liveRooms: source.liveRooms,
      allocations: source.allocations.map((entry) => ({ ...entry, at: agedAt })),
    });

    const indexes = await state.storage.list<{
      sourceBucket: string;
      allocationAt: number;
    }>({ prefix: "source_expiry_v2:" });
    let sequence = 0;
    for (const [key, record] of indexes) {
      if (record.sourceBucket !== sourceBucket) continue;
      await state.storage.delete(key);
      const expiredAt = Date.now() - 1;
      const replacement = `source_expiry_v2:${String(expiredAt).padStart(16, "0")}:${encodeOpaqueSegment("aged")}:${encodeOpaqueSegment(String(sequence++))}`;
      await state.storage.put(replacement, { ...record, allocationAt: agedAt });
    }
    await state.storage.setAlarm(Date.now() - 1);
  });
}

async function fireQuotaAlarm(stub: DurableObjectStub): Promise<void> {
  await runInDurableObject(stub, async (instance) => {
    const alarm = (instance as unknown as { alarm?: () => Promise<void> }).alarm;
    if (alarm === undefined) throw new Error("QuotaDO alarm handler missing");
    await alarm.call(instance);
  });
}

describe("QuotaDO", () => {
  it("enforces the source live boundary and makes acquire/release idempotent", async () => {
    const stub = quotaStub("boundary");
    const source = "ip:v1:source-boundary";

    expect((await acquire(stub, "room-1", "lease-1", source)).status).toBe(201);
    expect((await acquire(stub, "room-1", "lease-1", source)).status).toBe(200);
    const conflict = await acquire(stub, "room-1", "lease-other", source);
    expect(conflict.status).toBe(409);
    expect(await code(conflict)).toBe("ATTN_QUOTA_LEASE_CONFLICT");
    expect((await acquire(stub, "room-2", "lease-2", source)).status).toBe(201);

    const over = await acquire(stub, "room-3", "lease-3", source);
    expect(over.status).toBe(429);
    expect(await code(over)).toBe("ATTN_SOURCE_ROOM_QUOTA");
    expect(over.headers.get("Retry-After")).toBe("60");
    expect(over.headers.get("X-Attn-Retry-After-Ms")).toBe("60000");
    const overBody = (await over.json()) as {
      error: { retryAfterMs?: number };
    };
    expect(overBody.error.retryAfterMs).toBe(60_000);

    expect((await release(stub, "room-1", "lease-1")).status).toBe(204);
    expect((await release(stub, "room-1", "lease-1")).status).toBe(204);
    const counters = await runInDurableObject(stub, async (_instance, state) => ({
      source: await state.storage.get<{ liveRooms: number }>(`source:${source}`),
      global: await state.storage.get<{ liveRooms: number; reservedBytes: number }>(
        "global:v1",
      ),
    }));
    expect(counters.source?.liveRooms).toBe(1);
    expect(counters.global).toEqual({ liveRooms: 1, reservedBytes: RESERVED });
  });

  it("keeps released allocation bytes in the rolling window, then prunes expired entries", async () => {
    const stub = quotaStub("rolling");
    const source = "ip:v1:source-rolling";
    await acquire(stub, "room-1", "lease-1", source);
    await acquire(stub, "room-2", "lease-2", source);
    await release(stub, "room-1", "lease-1");
    await release(stub, "room-2", "lease-2");

    // Test binding permits 60 MiB/24h. Two 25 MiB allocations were released,
    // but a third still exceeds that non-refundable rolling budget.
    const blocked = await acquire(stub, "room-3", "lease-3", source);
    expect(blocked.status).toBe(429);
    expect(await code(blocked)).toBe("ATTN_SOURCE_BYTE_QUOTA");

    await runInDurableObject(stub, async (_instance, state) => {
      const key = `source:${source}`;
      const stored = await state.storage.get<{
        liveRooms: number;
        allocations: Array<{ at: number; bytes: number }>;
      }>(key);
      expect(stored?.allocations).toHaveLength(2);
      await state.storage.put(key, {
        liveRooms: stored?.liveRooms ?? 0,
        allocations: (stored?.allocations ?? []).map((entry) => ({
          ...entry,
          at: Date.now() - DAY_MS - 1,
        })),
      });
    });

    expect((await acquire(stub, "room-3", "lease-3", source)).status).toBe(201);
  });

  it("allows exactly one concurrent claimant for the final source slot", async () => {
    const stub = quotaStub("concurrent");
    const source = "ip:v1:source-concurrent";
    expect((await acquire(stub, "room-1", "lease-1", source)).status).toBe(201);

    const results = await Promise.all([
      acquire(stub, "room-2", "lease-2", source),
      acquire(stub, "room-3", "lease-3", source),
    ]);
    expect(results.map((response) => response.status).sort()).toEqual([201, 429]);
    const denied = results.find((response) => response.status === 429);
    expect(denied).toBeDefined();
    expect(await code(denied as Response)).toBe("ATTN_SOURCE_ROOM_QUOTA");
  });

  it("returns global exhaustion as 503 ATTN_RELAY_CAPACITY", async () => {
    const stub = quotaStub("global");
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put("global:v1", {
        liveRooms: Number(env.QUOTA_GLOBAL_MAX_LIVE_ROOMS),
        reservedBytes: 0,
      });
    });

    const response = await acquire(stub, "room-global", "lease-global", "ip:v1:global");
    expect(response.status).toBe(503);
    expect(await code(response)).toBe("ATTN_RELAY_CAPACITY");
  });

  it("allows exactly one concurrent claimant for the final global slot", async () => {
    const stub = quotaStub("global-concurrent");
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put("global:v1", {
        liveRooms: Number(env.QUOTA_GLOBAL_MAX_LIVE_ROOMS) - 1,
        reservedBytes: 0,
      });
    });

    const results = await Promise.all([
      acquire(stub, "room-global-a", "lease-global-a", "ip:v1:global-a"),
      acquire(stub, "room-global-b", "lease-global-b", "ip:v1:global-b"),
    ]);
    expect(results.map((response) => response.status).sort()).toEqual([201, 503]);
    const denied = results.find((response) => response.status === 503);
    expect(await code(denied as Response)).toBe("ATTN_RELAY_CAPACITY");
  });

  it("ignores a stale release after the same roomId is recreated", async () => {
    const stub = quotaStub("generation");
    await acquire(stub, "room-same", "lease-old", "ip:v1:generation-old");
    await release(stub, "room-same", "lease-old");
    expect(
      (await acquire(stub, "room-same", "lease-new", "ip:v1:generation-new")).status,
    ).toBe(201);

    expect((await release(stub, "room-same", "lease-old")).status).toBe(204);
    const state = await runInDurableObject(stub, async (_instance, durableState) => ({
      lease: await durableState.storage.get<{ leaseId: string }>(
        `lease_v2:${encodeOpaqueSegment("room-same")}`,
      ),
      global: await durableState.storage.get<{ liveRooms: number }>("global:v1"),
    }));
    expect(state.lease?.leaseId).toBe("lease-new");
    expect(state.global?.liveRooms).toBe(1);
  });

  it("dual-reads and atomically migrates an exact legacy singleton lease", async () => {
    const stub = quotaStub("legacy-lease");
    const roomId = "room-legacy";
    const leaseId = "lease-legacy";
    const sourceBucket = "ip:v1:legacy";
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put(`lease:${roomId}`, {
        roomId,
        leaseId,
        sourceBucket,
        reservedBytes: RESERVED,
        acquiredAt: 123,
      });
    });
    expect((await acquire(stub, roomId, leaseId, sourceBucket)).status).toBe(200);
    const state = await runInDurableObject(stub, async (_instance, durableState) => ({
      versioned: await durableState.storage.get(
        `lease_v2:${encodeOpaqueSegment(roomId)}`,
      ),
      legacy: await durableState.storage.get(`lease:${roomId}`),
    }));
    expect(state.versioned).toBeDefined();
    expect(state.legacy).toBeUndefined();
  });

  it("fails closed on mismatched reservation configuration", async () => {
    const stub = quotaStub("config");
    const response = await stub.fetch("https://quota.internal/acquire", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        roomId: "room-config",
        leaseId: "lease-config",
        sourceBucket: "ip:v1:config",
        reservedBytes: 1,
      }),
    });
    expect(response.status).toBe(503);
    expect(await code(response)).toBe("ATTN_QUOTA_UNAVAILABLE");
  });

  it("alarm removes an inactive source after its rolling allocations age out", async () => {
    const stub = quotaStub("expiry-inactive");
    const source = "ip:v1:expiry-inactive";
    await acquire(stub, "room-expired", "lease-expired", source);
    await release(stub, "room-expired", "lease-expired");
    await ageSourceAllocationAndIndex(stub, source);

    await fireQuotaAlarm(stub);

    const stored = await runInDurableObject(stub, async (_instance, state) => ({
      source: await state.storage.get(`source:${source}`),
      indexes: await state.storage.list({ prefix: "source_expiry_v2:" }),
      alarm: await state.storage.getAlarm(),
    }));
    expect(stored.source).toBeUndefined();
    expect(stored.indexes.size).toBe(0);
    expect(stored.alarm).toBeNull();
  });

  it("alarm prunes aged allocations but preserves an active source", async () => {
    const stub = quotaStub("expiry-active");
    const source = "ip:v1:expiry-active";
    await acquire(stub, "room-live", "lease-live", source);
    await ageSourceAllocationAndIndex(stub, source);

    await fireQuotaAlarm(stub);

    const stored = await runInDurableObject(stub, async (_instance, state) => ({
      source: await state.storage.get<{
        liveRooms: number;
        allocations: Array<{ at: number; bytes: number }>;
      }>(`source:${source}`),
      lease: await state.storage.get(`lease_v2:${encodeOpaqueSegment("room-live")}`),
      indexes: await state.storage.list({ prefix: "source_expiry_v2:" }),
    }));
    expect(stored.source).toEqual({ liveRooms: 1, allocations: [] });
    expect(stored.lease).toBeDefined();
    expect(stored.indexes.size).toBe(0);

    // Once the preserved active lease releases, no expiry index remains to
    // wake the alarm; release must remove the now-empty source immediately.
    expect((await release(stub, "room-live", "lease-live")).status).toBe(204);
    const afterRelease = await runInDurableObject(stub, async (_instance, state) =>
      state.storage.get(`source:${source}`),
    );
    expect(afterRelease).toBeUndefined();
  });
});
