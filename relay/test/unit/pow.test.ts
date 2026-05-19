import { describe, it, expect } from "vitest";
import {
  PowError,
  POW_MAX_LIFETIME_MS,
  leadingZeroBits,
  parsePow,
  requestPathHash,
  tokenHash,
  verifyPow,
  type PowVerifyContext,
} from "../../src/pow";
import powCorpus from "../../../planning/collab/test-vectors/pow.json";

/**
 * vitest-pool-workers gives us a real `crypto.subtle` — no mocks needed.
 *
 * We mock the replay-set adapter as an in-memory Set keyed by token-SHA-256.
 * The mintForTests helper here matches the Rust 1.7 token format byte-for-byte
 * so we can mint cheap tokens at difficulty=12 for the suite.
 */

const ROOM = "ROOM";
const DEVICE = "DEVICE";
const METHOD = "POST";
const PATH = "/v2/rooms/R/envelopes";

const TEST_DIFFICULTY = 12;
const TEST_TTL_MS = 5 * 60 * 1000;

interface ReplaySet {
  store: Map<string, number>;
  isReplayed(hash: string): Promise<boolean>;
  markSeen(hash: string, expiresAt: number): Promise<void>;
}

function makeReplaySet(): ReplaySet {
  const store = new Map<string, number>();
  return {
    store,
    isReplayed: async (hash) => store.has(hash),
    markSeen: async (hash, expiresAt) => {
      store.set(hash, expiresAt);
    },
  };
}

function makeCtx(overrides: Partial<PowVerifyContext> = {}): PowVerifyContext & {
  replay: ReplaySet;
} {
  const replay = makeReplaySet();
  return {
    roomId: ROOM,
    deviceId: DEVICE,
    method: METHOD,
    urlPath: PATH,
    policyPowBits: TEST_DIFFICULTY,
    now: Date.now(),
    isReplayed: replay.isReplayed,
    markSeen: replay.markSeen,
    ...overrides,
    replay,
  };
}

/** Tiny in-process miner — counter-incrementing SHA-256 search. Must mirror
 * Rust 1.7 token format exactly so corpus-replay tests hold. */
async function mintForTests(
  roomId: string,
  deviceId: string,
  method: string,
  path: string,
  difficulty: number,
  expiresAt: number,
  rand: string,
): Promise<string> {
  const resource = `${roomId}:${deviceId}:${await requestPathHash(method, path)}`;
  const encoder = new TextEncoder();
  let counter = 0;
  // Loose ceiling so a runaway test fails instead of hanging the suite forever.
  const max = 10_000_000;
  while (counter < max) {
    const token = `attn-pow:v2:${difficulty}:${expiresAt}:${resource}:${rand}:${counter}`;
    const hashBytes = new Uint8Array(
      await crypto.subtle.digest("SHA-256", encoder.encode(token)),
    );
    if (leadingZeroBits(hashBytes) >= difficulty) return token;
    counter++;
  }
  throw new Error(`mintForTests exceeded ${max} attempts`);
}

const FIXED_RAND = "ELoREhMUFRYXGBkaGxwdHg"; // 16-byte base64url (from corpus vec 1)

describe("parsePow", () => {
  it("parses a happy-path token", () => {
    const expiresAt = 1_700_000_300_000;
    const token = `attn-pow:v2:12:${expiresAt}:ROOM:DEVICE:0KyHckSu3Cs:${FIXED_RAND}:3060`;
    const parsed = parsePow(token);
    expect(parsed.v).toBe("v2");
    expect(parsed.difficulty).toBe(12);
    expect(parsed.expiresAt).toBe(expiresAt);
    expect(parsed.roomId).toBe("ROOM");
    expect(parsed.deviceId).toBe("DEVICE");
    expect(parsed.requestPathHash).toBe("0KyHckSu3Cs");
    expect(parsed.rand).toBe(FIXED_RAND);
    expect(parsed.counter).toBe(3060);
  });

  it("rejects v1", () => {
    const token = `attn-pow:v1:12:1700000000000:ROOM:DEVICE:0KyHckSu3Cs:${FIXED_RAND}:0`;
    expect(() => parsePow(token)).toThrowError(PowError);
    try {
      parsePow(token);
    } catch (e) {
      expect((e as PowError).code).toBe("ATTN_POW_INVALID");
    }
  });

  it("rejects v3", () => {
    const token = `attn-pow:v3:12:1700000000000:ROOM:DEVICE:0KyHckSu3Cs:${FIXED_RAND}:0`;
    expect(() => parsePow(token)).toThrowError(/unsupported version: v3/);
  });

  it("rejects too few colons", () => {
    expect(() => parsePow("attn-pow:v2:12:1700000000000")).toThrowError(PowError);
  });

  it("rejects extra colons (split count > 9)", () => {
    // Extra colon inside the roomId field — splits to 10 segments.
    const token = `attn-pow:v2:12:1700000000000:ROOM:WITH:COLONS:DEVICE:0KyHckSu3Cs:${FIXED_RAND}:0`;
    expect(() => parsePow(token)).toThrowError(PowError);
  });

  it("rejects missing magic prefix", () => {
    const token = `nope:v2:12:1700000000000:ROOM:DEVICE:0KyHckSu3Cs:${FIXED_RAND}:0`;
    expect(() => parsePow(token)).toThrowError(/attn-pow/);
  });

  it("rejects malformed difficulty (non-digit)", () => {
    const token = `attn-pow:v2:1a:1700000000000:ROOM:DEVICE:0KyHckSu3Cs:${FIXED_RAND}:0`;
    expect(() => parsePow(token)).toThrowError(/difficulty/);
  });

  it("rejects malformed expiresAt (non-digit)", () => {
    const token = `attn-pow:v2:12:nope:ROOM:DEVICE:0KyHckSu3Cs:${FIXED_RAND}:0`;
    expect(() => parsePow(token)).toThrowError(/expiresAt/);
  });

  it("rejects malformed counter (non-digit)", () => {
    const token = `attn-pow:v2:12:1700000000000:ROOM:DEVICE:0KyHckSu3Cs:${FIXED_RAND}:abc`;
    expect(() => parsePow(token)).toThrowError(/counter/);
  });

  it("rejects empty resource components", () => {
    const token = `attn-pow:v2:12:1700000000000::DEVICE:0KyHckSu3Cs:${FIXED_RAND}:0`;
    expect(() => parsePow(token)).toThrowError(/resource/);
  });
});

describe("requestPathHash", () => {
  it("matches the canned vector from pow.json (vec 1)", async () => {
    expect(await requestPathHash("POST", "/v2/rooms/EXAMPLE_ROOM/devices")).toBe(
      "0KyHckSu3Cs",
    );
  });

  it("differs by method", async () => {
    const a = await requestPathHash("POST", "/v2/rooms/R/envelopes");
    const b = await requestPathHash("DELETE", "/v2/rooms/R/envelopes");
    expect(a).not.toBe(b);
  });

  it("differs by path", async () => {
    const a = await requestPathHash("POST", "/v2/rooms/R/envelopes");
    const b = await requestPathHash("POST", "/v2/rooms/R/acks");
    expect(a).not.toBe(b);
  });

  it("produces 11-char base64url-no-pad (8 bytes)", async () => {
    const h = await requestPathHash("POST", "/v2/rooms/R/envelopes");
    expect(h.length).toBe(11);
    expect(h).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe("tokenHash", () => {
  it("is deterministic for the same input", async () => {
    const t = "attn-pow:v2:12:1700000000000:ROOM:DEVICE:abc:rand:0";
    expect(await tokenHash(t)).toBe(await tokenHash(t));
  });

  it("differs for different inputs", async () => {
    const a = await tokenHash("attn-pow:v2:12:1700000000000:ROOM:DEVICE:abc:rand:0");
    const b = await tokenHash("attn-pow:v2:12:1700000000000:ROOM:DEVICE:abc:rand:1");
    expect(a).not.toBe(b);
  });
});

describe("leadingZeroBits", () => {
  it("counts correctly across byte boundaries", () => {
    expect(leadingZeroBits(new Uint8Array([]))).toBe(0);
    expect(leadingZeroBits(new Uint8Array([0xff]))).toBe(0);
    expect(leadingZeroBits(new Uint8Array([0x80]))).toBe(0);
    expect(leadingZeroBits(new Uint8Array([0x40]))).toBe(1);
    expect(leadingZeroBits(new Uint8Array([0x01]))).toBe(7);
    expect(leadingZeroBits(new Uint8Array([0x00]))).toBe(8);
    expect(leadingZeroBits(new Uint8Array([0x00, 0x80]))).toBe(8);
    expect(leadingZeroBits(new Uint8Array([0x00, 0x40]))).toBe(9);
    expect(leadingZeroBits(new Uint8Array([0x00, 0x00, 0x10]))).toBe(19);
    expect(leadingZeroBits(new Uint8Array([0x00, 0x00, 0x00, 0x00]))).toBe(32);
  });
});

describe("verifyPow", () => {
  it("accepts a freshly minted token", async () => {
    const now = Date.now();
    const expiresAt = now + TEST_TTL_MS;
    const token = await mintForTests(
      ROOM,
      DEVICE,
      METHOD,
      PATH,
      TEST_DIFFICULTY,
      expiresAt,
      FIXED_RAND,
    );
    const ctx = makeCtx({ now });
    await expect(verifyPow(token, ctx)).resolves.toBeUndefined();
    expect(ctx.replay.store.size).toBe(1);
  });

  it("rejects an expired token (expiresAt < now)", async () => {
    const now = Date.now();
    const expiresAt = now - 1; // already expired
    // Mint with difficulty=12 but a past expiry. The miner doesn't care about expiry.
    const token = await mintForTests(
      ROOM,
      DEVICE,
      METHOD,
      PATH,
      TEST_DIFFICULTY,
      expiresAt,
      FIXED_RAND,
    );
    const ctx = makeCtx({ now });
    await expect(verifyPow(token, ctx)).rejects.toMatchObject({
      name: "PowError",
      code: "ATTN_POW_INVALID",
    });
  });

  it("rejects a token whose expiresAt is beyond the 10-minute skew window", async () => {
    const now = Date.now();
    const expiresAt = now + POW_MAX_LIFETIME_MS + 60_000; // 1 min beyond max
    const token = await mintForTests(
      ROOM,
      DEVICE,
      METHOD,
      PATH,
      TEST_DIFFICULTY,
      expiresAt,
      FIXED_RAND,
    );
    const ctx = makeCtx({ now });
    await expect(verifyPow(token, ctx)).rejects.toMatchObject({
      code: "ATTN_POW_INVALID",
    });
  });

  it("rejects difficulty below policy minimum", async () => {
    const now = Date.now();
    const expiresAt = now + TEST_TTL_MS;
    const token = await mintForTests(
      ROOM,
      DEVICE,
      METHOD,
      PATH,
      TEST_DIFFICULTY,
      expiresAt,
      FIXED_RAND,
    );
    // Policy demands 16 but token was minted at 12.
    const ctx = makeCtx({ now, policyPowBits: 16 });
    await expect(verifyPow(token, ctx)).rejects.toMatchObject({
      code: "ATTN_POW_INVALID",
    });
  });

  it("clamps policy below MIN_POW_BITS up to 12", async () => {
    // Spec: `difficulty >= max(policy, 12)`. A policy of 0 must still demand 12.
    const now = Date.now();
    const expiresAt = now + TEST_TTL_MS;
    const token = await mintForTests(
      ROOM,
      DEVICE,
      METHOD,
      PATH,
      8, // below MIN_POW_BITS
      expiresAt,
      FIXED_RAND,
    ).catch((e) => e);
    // Either the miner produced a low-bit token (rejected by policy) or
    // succeeded by chance. We don't actually care — we're asserting the
    // verifier never accepts difficulty < 12 even with policy=0.
    if (token instanceof Error) {
      // ok — mining short tokens isn't the goal here. Skip silently.
      return;
    }
    const ctx = makeCtx({ now, policyPowBits: 0 });
    await expect(verifyPow(token, ctx)).rejects.toMatchObject({
      code: "ATTN_POW_INVALID",
    });
  });

  it("rejects mismatching method", async () => {
    const now = Date.now();
    const expiresAt = now + TEST_TTL_MS;
    const token = await mintForTests(
      ROOM,
      DEVICE,
      "POST",
      PATH,
      TEST_DIFFICULTY,
      expiresAt,
      FIXED_RAND,
    );
    const ctx = makeCtx({ now, method: "DELETE" });
    await expect(verifyPow(token, ctx)).rejects.toMatchObject({
      code: "ATTN_POW_INVALID",
    });
  });

  it("rejects mismatching path", async () => {
    const now = Date.now();
    const expiresAt = now + TEST_TTL_MS;
    const token = await mintForTests(
      ROOM,
      DEVICE,
      METHOD,
      PATH,
      TEST_DIFFICULTY,
      expiresAt,
      FIXED_RAND,
    );
    const ctx = makeCtx({ now, urlPath: "/v2/rooms/R/acks" });
    await expect(verifyPow(token, ctx)).rejects.toMatchObject({
      code: "ATTN_POW_INVALID",
    });
  });

  it("rejects mismatching roomId", async () => {
    const now = Date.now();
    const expiresAt = now + TEST_TTL_MS;
    const token = await mintForTests(
      ROOM,
      DEVICE,
      METHOD,
      PATH,
      TEST_DIFFICULTY,
      expiresAt,
      FIXED_RAND,
    );
    const ctx = makeCtx({ now, roomId: "OTHER_ROOM" });
    await expect(verifyPow(token, ctx)).rejects.toMatchObject({
      code: "ATTN_POW_INVALID",
    });
  });

  it("rejects mismatching deviceId", async () => {
    const now = Date.now();
    const expiresAt = now + TEST_TTL_MS;
    const token = await mintForTests(
      ROOM,
      DEVICE,
      METHOD,
      PATH,
      TEST_DIFFICULTY,
      expiresAt,
      FIXED_RAND,
    );
    const ctx = makeCtx({ now, deviceId: "OTHER_DEVICE" });
    await expect(verifyPow(token, ctx)).rejects.toMatchObject({
      code: "ATTN_POW_INVALID",
    });
  });

  it("rejects a token claiming high difficulty but hashing to fewer leading zero bits", async () => {
    const now = Date.now();
    const expiresAt = now + TEST_TTL_MS;
    // Mint at difficulty=12 but tamper the claimed difficulty to 24. The hash
    // won't have 24 leading zero bits (with overwhelming probability).
    const minted = await mintForTests(
      ROOM,
      DEVICE,
      METHOD,
      PATH,
      TEST_DIFFICULTY,
      expiresAt,
      FIXED_RAND,
    );
    // Swap the difficulty field. Token layout: `attn-pow:v2:<diff>:...`.
    const tampered = minted.replace(/^attn-pow:v2:12:/, "attn-pow:v2:24:");
    const ctx = makeCtx({ now, policyPowBits: 12 });
    await expect(verifyPow(tampered, ctx)).rejects.toMatchObject({
      code: "ATTN_POW_INVALID",
    });
  });

  it("rejects replay: same token verified twice fails the second time", async () => {
    const now = Date.now();
    const expiresAt = now + TEST_TTL_MS;
    const token = await mintForTests(
      ROOM,
      DEVICE,
      METHOD,
      PATH,
      TEST_DIFFICULTY,
      expiresAt,
      FIXED_RAND,
    );
    const ctx = makeCtx({ now });
    await expect(verifyPow(token, ctx)).resolves.toBeUndefined();
    await expect(verifyPow(token, ctx)).rejects.toMatchObject({
      code: "ATTN_POW_INVALID",
    });
  });

  it("markSeen records the token's expiresAt for pruning", async () => {
    const now = Date.now();
    const expiresAt = now + TEST_TTL_MS;
    const token = await mintForTests(
      ROOM,
      DEVICE,
      METHOD,
      PATH,
      TEST_DIFFICULTY,
      expiresAt,
      FIXED_RAND,
    );
    const ctx = makeCtx({ now });
    await verifyPow(token, ctx);
    const recordedExpiries = [...ctx.replay.store.values()];
    expect(recordedExpiries).toEqual([expiresAt]);
  });
});

describe("verifyPow corpus replay (pow.json)", () => {
  // Each canned vector ships with `expiresAt = 1_700_000_300_000` and
  // `difficulty = 12`. We pin `now` to (expiresAt - 1min) so all vectors fall
  // inside both windows: `now < expiresAt` AND `expiresAt <= now + 10min`.
  it("verifies every vector against its inputs", async () => {
    const vectors = powCorpus.vectors;
    expect(vectors.length).toBeGreaterThanOrEqual(5);
    for (const v of vectors) {
      const { inputs, expected } = v;
      const now = inputs.expiresAt - 60_000;
      const ctx = makeCtx({
        roomId: inputs.roomId,
        deviceId: inputs.deviceId,
        method: inputs.method,
        urlPath: inputs.pathSubstituted,
        policyPowBits: inputs.difficulty,
        now,
      });
      await expect(
        verifyPow(expected.token, ctx),
        `${v.name}: full-token verify`,
      ).resolves.toBeUndefined();

      // Sanity: the recomputed requestPathHash matches.
      expect(await requestPathHash(inputs.method, inputs.pathSubstituted)).toBe(
        expected.requestPathHash,
      );
    }
  });
});
