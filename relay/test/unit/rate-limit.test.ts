/**
 * Unit coverage for the rate limiter classes (attn-nnj.5.13).
 *
 * - WorkerEdgeRateLimit lives in Worker process memory, so we test it as
 *   a plain class — no Miniflare/DO scaffolding needed.
 * - DurableObjectRateLimit is exercised against a real DO storage via
 *   `runInDurableObject`; the storage shape is observable through the
 *   spec key `rate:<deviceId>:<windowStartMin>`.
 *
 * Spec: relay-spec.md §Caps + §Anti-Abuse.
 */

import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { Env } from "../../src/env";
import {
  DEFAULT_RATE_LIMIT_CONFIG,
  DurableObjectRateLimit,
  RATE_KEY_PREFIX,
  WorkerEdgeRateLimit,
  rateKey,
} from "../../src/rate-limit";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

// --- WorkerEdgeRateLimit -------------------------------------------------

describe("WorkerEdgeRateLimit — per-IP cap", () => {
  it("allows up to perIpPerMinute requests in a single minute and rejects the (cap+1)th", () => {
    let now = 1_700_000_000_000;
    const limiter = new WorkerEdgeRateLimit(DEFAULT_RATE_LIMIT_CONFIG, () => now);

    for (let i = 0; i < 600; i++) {
      const r = limiter.check("1.2.3.4", "room-known", true);
      expect(r.ok).toBe(true);
    }
    const overflow = limiter.check("1.2.3.4", "room-known", true);
    expect(overflow.ok).toBe(false);
    expect(overflow.code).toBe("ATTN_RATE_LIMITED");
    expect(overflow.retryAfterMs).toBeGreaterThan(0);
  });

  it("resets the per-IP bucket on the next minute boundary", () => {
    let now = 60_000; // floor → window 60_000
    const limiter = new WorkerEdgeRateLimit(DEFAULT_RATE_LIMIT_CONFIG, () => now);
    for (let i = 0; i < 600; i++) limiter.check("9.9.9.9", `r${i}`, true);

    const blocked = limiter.check("9.9.9.9", "rX", true);
    expect(blocked.ok).toBe(false);

    // Advance past the minute boundary.
    now = 120_001;
    const fresh = limiter.check("9.9.9.9", "rY", true);
    expect(fresh.ok).toBe(true);
  });

  it("isolates per-IP buckets so traffic from one IP doesn't drain another's quota", () => {
    let now = 1_000_000;
    const limiter = new WorkerEdgeRateLimit(DEFAULT_RATE_LIMIT_CONFIG, () => now);
    for (let i = 0; i < 600; i++) limiter.check("1.1.1.1", "r", true);

    const b1 = limiter.check("1.1.1.1", "r", true);
    expect(b1.ok).toBe(false);

    const b2 = limiter.check("2.2.2.2", "r", true);
    expect(b2.ok).toBe(true);
  });
});

describe("WorkerEdgeRateLimit — per-IP create cap", () => {
  it("allows up to perIpCreatePerMinute creates and rejects the (cap+1)th", () => {
    const now = 1_700_000_000_000;
    const limiter = new WorkerEdgeRateLimit(DEFAULT_RATE_LIMIT_CONFIG, () => now);
    for (let i = 0; i < DEFAULT_RATE_LIMIT_CONFIG.perIpCreatePerMinute; i++) {
      expect(limiter.checkCreate("1.2.3.4").ok).toBe(true);
    }
    const overflow = limiter.checkCreate("1.2.3.4");
    expect(overflow.ok).toBe(false);
    expect(overflow.code).toBe("ATTN_RATE_LIMITED");
    expect(overflow.retryAfterMs).toBeGreaterThan(0);
  });

  it("uses a bucket separate from the general per-IP cap", () => {
    const now = 2_000_000;
    const limiter = new WorkerEdgeRateLimit(DEFAULT_RATE_LIMIT_CONFIG, () => now);
    for (let i = 0; i < DEFAULT_RATE_LIMIT_CONFIG.perIpCreatePerMinute; i++) {
      limiter.checkCreate("5.5.5.5");
    }
    // Create cap exhausted...
    expect(limiter.checkCreate("5.5.5.5").ok).toBe(false);
    // ...but general requests from the same IP still pass (separate counter).
    expect(limiter.check("5.5.5.5", "room", true).ok).toBe(true);
  });
});

describe("WorkerEdgeRateLimit — anti-enumeration cap", () => {
  it("rejects the 31st distinct unknown roomId in the same 5min window", () => {
    let now = 5_000_000_000_000;
    const limiter = new WorkerEdgeRateLimit(DEFAULT_RATE_LIMIT_CONFIG, () => now);
    for (let i = 0; i < 30; i++) {
      const r = limiter.check("3.3.3.3", `unknown-${i}`, false);
      expect(r.ok).toBe(true);
    }
    const overflow = limiter.check("3.3.3.3", "unknown-31", false);
    expect(overflow.ok).toBe(false);
    expect(overflow.code).toBe("ATTN_ENUM_LIMITED");
    expect(overflow.retryAfterMs).toBeGreaterThan(0);
  });

  it("does NOT count existing rooms against the anti-enum bucket", () => {
    let now = 7_000_000_000_000;
    const limiter = new WorkerEdgeRateLimit(DEFAULT_RATE_LIMIT_CONFIG, () => now);

    // Hit 100 different existing rooms — should never trip the enum cap.
    for (let i = 0; i < 100; i++) {
      const r = limiter.check("4.4.4.4", `existing-${i}`, true);
      expect(r.ok).toBe(true);
    }
    // After all those existing hits, we can still probe up to 30 unknowns.
    for (let i = 0; i < 30; i++) {
      const r = limiter.check("4.4.4.4", `unknown-${i}`, false);
      expect(r.ok).toBe(true);
    }
    const overflow = limiter.check("4.4.4.4", "unknown-31", false);
    expect(overflow.ok).toBe(false);
    expect(overflow.code).toBe("ATTN_ENUM_LIMITED");
  });

  it("treats re-probes of the same unknown roomId as one slot (cap is on distinct ids)", () => {
    let now = 10_000_000_000_000;
    const limiter = new WorkerEdgeRateLimit(DEFAULT_RATE_LIMIT_CONFIG, () => now);

    // Probe the same unknown id 50 times — only consumes one slot.
    for (let i = 0; i < 50; i++) {
      const r = limiter.check("5.5.5.5", "same-unknown", false);
      expect(r.ok).toBe(true);
    }
    // Still have 29 distinct slots left.
    for (let i = 0; i < 29; i++) {
      const r = limiter.check("5.5.5.5", `other-${i}`, false);
      expect(r.ok).toBe(true);
    }
    const overflow = limiter.check("5.5.5.5", "tip-over", false);
    expect(overflow.ok).toBe(false);
    expect(overflow.code).toBe("ATTN_ENUM_LIMITED");
  });

  it("prunes entries older than 5min so a slow trickle never trips the cap", () => {
    let now = 0;
    const limiter = new WorkerEdgeRateLimit(DEFAULT_RATE_LIMIT_CONFIG, () => now);

    // Probe an unknown id every 15s. After 5min only the most recent
    // ≤20 entries live in the bucket — well under the 30-id cap.
    for (let i = 0; i < 100; i++) {
      const r = limiter.check("6.6.6.6", `slow-${i}`, false);
      expect(r.ok).toBe(true);
      now += 15_000; // +15s between probes
    }
  });

  it("advances the bucket as time passes — sliding window over 5min", () => {
    let now = 0;
    const limiter = new WorkerEdgeRateLimit(DEFAULT_RATE_LIMIT_CONFIG, () => now);

    // Fill the bucket to the cap.
    for (let i = 0; i < 30; i++) {
      const r = limiter.check("8.8.8.8", `early-${i}`, false);
      expect(r.ok).toBe(true);
    }
    const blocked = limiter.check("8.8.8.8", "extra", false);
    expect(blocked.ok).toBe(false);

    // Jump past the 5min retention — every prior entry expires.
    now += 5 * 60_000 + 1;
    const refreshed = limiter.check("8.8.8.8", "new-after-window", false);
    expect(refreshed.ok).toBe(true);
  });

  it("surfaces ATTN_ENUM_LIMITED before ATTN_RATE_LIMITED when both apply", () => {
    let now = 0;
    // Choose a tight config so we can saturate both caps quickly.
    const limiter = new WorkerEdgeRateLimit(
      { perDevicePerMinute: 120, perIpPerMinute: 5, perIpCreatePerMinute: 15, antiEnumPerFiveMin: 3 },
      () => now,
    );

    // Burn 3 unknowns — at cap, next unknown trips ENUM first.
    expect(limiter.check("7.7.7.7", "u1", false).ok).toBe(true);
    expect(limiter.check("7.7.7.7", "u2", false).ok).toBe(true);
    expect(limiter.check("7.7.7.7", "u3", false).ok).toBe(true);

    const overflow = limiter.check("7.7.7.7", "u4", false);
    expect(overflow.ok).toBe(false);
    expect(overflow.code).toBe("ATTN_ENUM_LIMITED");
  });
});

// --- DurableObjectRateLimit ---------------------------------------------

// We need a real DO storage to test DurableObjectRateLimit. Reusing the
// RELAY_ROOMS namespace from wrangler.toml (the RoomDO storage handle is
// what production uses). Each test scopes its bucket via a unique deviceId
// so writes never collide across cases.

let testCounter = 0;
function uniqueId(label: string): string {
  testCounter += 1;
  return `${label}-${Date.now().toString(36)}-${testCounter}`;
}

describe("DurableObjectRateLimit — per-device cap (DO storage)", () => {
  it("allows 120 calls/min and rejects the 121st with ATTN_RATE_LIMITED", async () => {
    const { env } = await import("cloudflare:test");
    const id = env.RELAY_ROOMS.idFromName(uniqueId("rate-do-cap"));
    const stub = env.RELAY_ROOMS.get(id);
    const result = await runInDurableObject(stub, async (_inst, ctx) => {
      let now = 100_000;
      const limiter = new DurableObjectRateLimit(
        ctx.storage,
        DEFAULT_RATE_LIMIT_CONFIG,
        () => now,
      );
      const deviceId = "device-A";
      for (let i = 0; i < 120; i++) {
        const r = await limiter.check(deviceId);
        if (!r.ok) throw new Error(`unexpected reject at i=${i}: ${JSON.stringify(r)}`);
      }
      return limiter.check(deviceId);
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("ATTN_RATE_LIMITED");
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });

  it("isolates per-device buckets — a second device gets a fresh quota", async () => {
    const { env } = await import("cloudflare:test");
    const id = env.RELAY_ROOMS.idFromName(uniqueId("rate-do-isolation"));
    const stub = env.RELAY_ROOMS.get(id);
    const out = await runInDurableObject(stub, async (_inst, ctx) => {
      let now = 200_000;
      const limiter = new DurableObjectRateLimit(
        ctx.storage,
        DEFAULT_RATE_LIMIT_CONFIG,
        () => now,
      );
      // Burn device-X to its cap.
      for (let i = 0; i < 120; i++) await limiter.check("device-X");
      const blocked = await limiter.check("device-X");
      const fresh = await limiter.check("device-Y");
      return { blocked, fresh };
    });
    expect(out.blocked.ok).toBe(false);
    expect(out.fresh.ok).toBe(true);
  });

  it("rolls over to a fresh bucket on the next minute (count resets)", async () => {
    const { env } = await import("cloudflare:test");
    const id = env.RELAY_ROOMS.idFromName(uniqueId("rate-do-rollover"));
    const stub = env.RELAY_ROOMS.get(id);
    const out = await runInDurableObject(stub, async (_inst, ctx) => {
      let now = 300_000;
      const limiter = new DurableObjectRateLimit(
        ctx.storage,
        DEFAULT_RATE_LIMIT_CONFIG,
        () => now,
      );
      const deviceId = "device-roll";
      for (let i = 0; i < 120; i++) await limiter.check(deviceId);
      const blocked = await limiter.check(deviceId);
      // Advance one full minute.
      now += 60_000;
      const refreshed = await limiter.check(deviceId);
      return { blocked, refreshed };
    });
    expect(out.blocked.ok).toBe(false);
    expect(out.refreshed.ok).toBe(true);
  });

  it("persists per-(deviceId, minute) counts under the rate:<id>:<windowMin> key", async () => {
    const { env } = await import("cloudflare:test");
    const id = env.RELAY_ROOMS.idFromName(uniqueId("rate-do-key-shape"));
    const stub = env.RELAY_ROOMS.get(id);
    const stored = await runInDurableObject(stub, async (_inst, ctx) => {
      let now = 1_800_000; // windowMin = 30
      const limiter = new DurableObjectRateLimit(
        ctx.storage,
        DEFAULT_RATE_LIMIT_CONFIG,
        () => now,
      );
      const deviceId = "device-shape";
      await limiter.check(deviceId);
      await limiter.check(deviceId);
      await limiter.check(deviceId);
      const key = rateKey(deviceId, 30);
      return await ctx.storage.get<number>(key);
    });
    expect(stored).toBe(3);
  });
});

describe("rate-limit module — invariants", () => {
  it("RATE_KEY_PREFIX is the literal storage prefix", () => {
    expect(RATE_KEY_PREFIX).toBe("rate:");
    expect(rateKey("dev", 42).startsWith(RATE_KEY_PREFIX)).toBe(true);
  });

  it("DEFAULT_RATE_LIMIT_CONFIG matches the spec table", () => {
    expect(DEFAULT_RATE_LIMIT_CONFIG.perDevicePerMinute).toBe(120);
    expect(DEFAULT_RATE_LIMIT_CONFIG.perIpPerMinute).toBe(600);
    expect(DEFAULT_RATE_LIMIT_CONFIG.antiEnumPerFiveMin).toBe(30);
  });
});
