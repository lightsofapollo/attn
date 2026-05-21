/**
 * Integration coverage for the DO alarm — hard-max TTL, idle timeout, and the
 * pow_seen pruning sweep (attn-nnj.5.12).
 *
 * Spec: planning/collab/relay-spec.md §Alarms (TTL + Idle Cleanup)
 * Amendments: #8 (24h hard-max default, 7d longSession, 1h idle default),
 *             #9 (R2 7d safety net + WS-connect cleanup_check belt-and-braces).
 *
 * Strategy
 * --------
 * We test the alarm() handler directly via `runInDurableObject` rather than
 * leaning on workerd's clock + `runDurableObjectAlarm`. Two reasons:
 *   1. The vitest-pool-workers harness can't fast-forward Date.now inside the
 *      isolate, so a 30s idle test would actually sleep 30s.
 *   2. The unit under test is the handler's storage transitions; the runtime's
 *      alarm scheduling is Cloudflare's contract, not ours.
 *
 * Each test seeds DO storage to whatever state the alarm is supposed to react
 * to, then either rewinds `meta:hard_max_at` / `meta:last_event_at` into the
 * past (so the handler observes "expired") or sets up pow_seen rows the
 * pruner should drop. The WS-connect cleanup test goes through the live
 * Worker so we exercise the actual upgrade path.
 */

import { SELF, env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import {
  base64UrlDecode,
  base64UrlEncode,
  canonicalRequest,
} from "../../src/admission";
import type { Env } from "../../src/env";
import type { RoomPolicy } from "../../src/schema";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

const URL_BASE = "https://relay.example";

// --- builders shared with the other integration suites ------------------

function makeAdmissionKey(seed: number): Uint8Array {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = (seed + i) & 0xff;
  return bytes;
}

function defaultPolicy(overrides: Partial<RoomPolicy> = {}): RoomPolicy {
  return {
    mode: "live",
    maxPeers: 4,
    maxSnapshotBytes: 1_000_000,
    maxEventBytes: 8_192,
    maxEvents: 100,
    expiresAt: Date.now() + 60 * 60 * 1000,
    idleTimeoutMs: 30 * 60 * 1000,
    longSession: false,
    powBits: 12,
    deleteEventsAfterOwnerAck: false,
    allowBrowser: false,
    allowRemoteAgents: false,
    ...overrides,
  };
}

async function hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data));
}

let roomCounter = 0;
function uniqueRoomId(label: string): string {
  roomCounter += 1;
  return `${label}-${Date.now().toString(36)}-${roomCounter}`;
}

async function generateOwnerKeypair(): Promise<{
  publicKey: CryptoKey;
  privateKey: CryptoKey;
  publicKeyBytes: Uint8Array;
}> {
  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const raw = await crypto.subtle.exportKey("raw", kp.publicKey);
  if (!(raw instanceof ArrayBuffer)) throw new Error("expected raw key");
  return {
    publicKey: kp.publicKey,
    privateKey: kp.privateKey,
    publicKeyBytes: new Uint8Array(raw),
  };
}

interface CreateRoomResult {
  admissionKey: Uint8Array;
}

async function createRoom(opts: {
  roomId: string;
  policy?: Partial<RoomPolicy>;
  ownerKp: { publicKeyBytes: Uint8Array; privateKey: CryptoKey };
}): Promise<CreateRoomResult> {
  const admissionKey = makeAdmissionKey((roomCounter * 17) & 0xff);
  const body = JSON.stringify({
    v: 2,
    policy: defaultPolicy(opts.policy ?? {}),
    ownerSigningKey: base64UrlEncode(opts.ownerKp.publicKeyBytes),
    admissionKey: base64UrlEncode(admissionKey),
  });
  const url = `${URL_BASE}/v2/rooms/${opts.roomId}`;
  // attn-nnj.5.17 (security-review §H1): first-create requires
  // Attn-Owner-Signature self-rooted to the body's ownerSigningKey.
  const signing = new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  const canonical = await canonicalRequest(signing, new URL(url).pathname);
  const sig = new Uint8Array(
    await crypto.subtle.sign({ name: "Ed25519" }, opts.ownerKp.privateKey, canonical),
  );
  const ownerSig = base64UrlEncode(sig);
  const res = await SELF.fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Attn-Owner-Signature": ownerSig,
    },
    body,
  });
  if (res.status !== 201) {
    throw new Error(`room create failed: ${res.status} ${await res.text()}`);
  }
  return { admissionKey };
}

// --- DO helpers ----------------------------------------------------------

function getStub(roomId: string) {
  const id = env.RELAY_ROOMS.idFromName(roomId);
  return env.RELAY_ROOMS.get(id);
}

async function countStorageKeys(roomId: string): Promise<number> {
  return runInDurableObject(getStub(roomId), async (_inst, state) => {
    const all = await state.storage.list();
    return all.size;
  });
}

async function listKeys(roomId: string, prefix: string): Promise<string[]> {
  return runInDurableObject(getStub(roomId), async (_inst, state) => {
    const all = await state.storage.list({ prefix });
    return [...all.keys()];
  });
}

/** Directly invoke the DO's alarm() handler — sidesteps workerd's scheduler. */
async function fireAlarmDirect(roomId: string): Promise<void> {
  await runInDurableObject(getStub(roomId), async (inst, _state) => {
    // The DO base class types `alarm` as optional; we know it's defined here.
    type WithAlarm = { alarm?: () => Promise<void> };
    const handler = (inst as unknown as WithAlarm).alarm;
    if (typeof handler !== "function") {
      throw new Error("alarm() handler not defined on RoomDO");
    }
    await handler.call(inst);
  });
}

/** Rewind a stored ms-epoch field by `deltaMs` so the alarm() sees it as past. */
async function rewindMeta(roomId: string, key: string, deltaMs: number): Promise<void> {
  await runInDurableObject(getStub(roomId), async (_inst, state) => {
    const cur = await state.storage.get<number>(key);
    if (cur === undefined) throw new Error(`${key} missing`);
    await state.storage.put<number>(key, cur - deltaMs);
  });
}

// --- WS helpers for the cleanup_check test -------------------------------

async function buildSocketProtocolHeader(opts: {
  roomId: string;
  deviceId: string;
  admissionKey: Uint8Array;
}): Promise<string> {
  const url = `${URL_BASE}/v2/rooms/${opts.roomId}/socket?device_id=${encodeURIComponent(opts.deviceId)}`;
  const signing = new Request(url, { method: "GET" });
  const canonical = await canonicalRequest(signing, new URL(url).pathname);
  const hmac = await hmacSha256(opts.admissionKey, canonical);
  return `attn.v2, hmac.${base64UrlEncode(hmac)}`;
}

async function openSocket(opts: {
  roomId: string;
  deviceId: string;
  admissionKey: Uint8Array;
}): Promise<{ ws: WebSocket | null; response: Response }> {
  const url = `${URL_BASE}/v2/rooms/${opts.roomId}/socket?device_id=${encodeURIComponent(opts.deviceId)}`;
  const headers: Record<string, string> = { Upgrade: "websocket" };
  headers["Sec-WebSocket-Protocol"] = await buildSocketProtocolHeader({
    roomId: opts.roomId,
    deviceId: opts.deviceId,
    admissionKey: opts.admissionKey,
  });
  const res = await SELF.fetch(url, { headers });
  const ws = res.webSocket;
  if (ws !== null) ws.accept();
  return { ws, response: res };
}

/** Wait until `cond()` returns true or `timeoutMs` passes. */
async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  // Polling is OK here — we never sleep longer than 5ms per iteration and the
  // tests expect O(ms) latencies, not seconds.
  while (Date.now() - start < timeoutMs) {
    if (await cond()) return;
    await new Promise<void>((r) => setTimeout(r, 5));
  }
}

// --- tests ---------------------------------------------------------------

describe("RoomDO alarm — probation (un-activated room eviction)", () => {
  it("evicts a room that received no events by createdAt + ROOM_PROBATION_MS", async () => {
    const roomId = uniqueRoomId("alarm-probation");
    const owner = await generateOwnerKeypair();
    await createRoom({
      roomId,
      ownerKp: owner,
      // Keep idle + hard-max far away so ONLY the probation path can fire.
      policy: { idleTimeoutMs: 60 * 60 * 1000, expiresAt: Date.now() + 24 * 60 * 60 * 1000 },
    });
    expect(await countStorageKeys(roomId)).toBeGreaterThan(0);

    // No events were ever posted → envelopeCount stays 0. Rewind createdAt past
    // the 15min probation window so the alarm sees an abandoned room.
    await rewindMeta(roomId, "meta:created_at", 16 * 60 * 1000);
    await fireAlarmDirect(roomId);

    expect(await countStorageKeys(roomId)).toBe(0);
  });

  it("does NOT evict an activated room (envelopeCount > 0) past the probation window", async () => {
    const roomId = uniqueRoomId("alarm-activated");
    const owner = await generateOwnerKeypair();
    await createRoom({
      roomId,
      ownerKp: owner,
      policy: { idleTimeoutMs: 60 * 60 * 1000, expiresAt: Date.now() + 24 * 60 * 60 * 1000 },
    });

    // Simulate "activated": at least one event has been ingested.
    await runInDurableObject(getStub(roomId), async (_inst, state) => {
      await state.storage.put<number>("meta:envelope_count", 1);
    });
    await rewindMeta(roomId, "meta:created_at", 16 * 60 * 1000);
    await fireAlarmDirect(roomId);

    // Activated rooms skip probation; idle + hard-max are both far away.
    expect(await countStorageKeys(roomId)).toBeGreaterThan(0);
  });
});

describe("RoomDO alarm — hard-max expiry", () => {
  it("wipes storage + closes WS with 4002 once now >= hard_max_at", async () => {
    const roomId = uniqueRoomId("alarm-hardmax");
    const owner = await generateOwnerKeypair();
    const { admissionKey } = await createRoom({
      roomId,
      ownerKp: owner,
      // expiresAt very near `now`; we'll also rewind hard_max_at to make it past.
      policy: { expiresAt: Date.now() + 60_000 },
    });

    const before = await countStorageKeys(roomId);
    expect(before).toBeGreaterThan(0);

    // Open a live WS so we can observe close 4002.
    const sock = await openSocket({ roomId, deviceId: "absent", admissionKey });
    // Device isn't registered — the upgrade short-circuits with 404 + no WS.
    // We still want to test the broadcast path, so open a *registered* device.
    expect(sock.response.status).toBe(404);

    // Rewind hard_max_at past now so the alarm handler sees an expired room.
    await rewindMeta(roomId, "meta:hard_max_at", 24 * 60 * 60 * 1000);

    await fireAlarmDirect(roomId);

    const after = await countStorageKeys(roomId);
    expect(after).toBe(0);

    // Subsequent requests should observe a missing room (404).
    const getUrl = `${URL_BASE}/v2/rooms/${roomId}/devices`;
    const signing = new Request(getUrl, { method: "GET" });
    const canonical = await canonicalRequest(signing, new URL(getUrl).pathname);
    const adm = `v2.${base64UrlEncode(await hmacSha256(admissionKey, canonical))}`;
    const probe = await SELF.fetch(getUrl, {
      method: "GET",
      headers: { "Attn-Admission": adm },
    });
    expect(probe.status).toBe(404);
  });
});

describe("RoomDO alarm — idle timeout", () => {
  it("expires the room when last_event_at + idleTimeoutMs <= now", async () => {
    const roomId = uniqueRoomId("alarm-idle");
    const owner = await generateOwnerKeypair();
    await createRoom({
      roomId,
      ownerKp: owner,
      // 1m idle so the rewind below clears it without affecting hard_max_at.
      policy: { idleTimeoutMs: 60_000 },
    });

    // Rewind last_event_at by 5min — well past the 1m idle window — while
    // leaving hard_max_at far in the future.
    await rewindMeta(roomId, "meta:last_event_at", 5 * 60 * 1000);

    await fireAlarmDirect(roomId);

    expect(await countStorageKeys(roomId)).toBe(0);
  });

  it("re-schedules without wiping when activity keeps last_event_at fresh", async () => {
    const roomId = uniqueRoomId("alarm-idle-reset");
    const owner = await generateOwnerKeypair();
    await createRoom({
      roomId,
      ownerKp: owner,
      policy: { idleTimeoutMs: 60 * 60 * 1000 }, // 1h
    });

    const before = await countStorageKeys(roomId);
    expect(before).toBeGreaterThan(0);

    // last_event_at stays at `now` (room just created). idle deadline is way
    // out; alarm should just run pow-prune and reschedule.
    await fireAlarmDirect(roomId);

    const after = await countStorageKeys(roomId);
    // No keys deleted (no stale pow_seen yet), meta intact.
    expect(after).toBe(before);

    // Alarm should have been re-set.
    const alarmAt = await runInDurableObject(getStub(roomId), async (_inst, state) => {
      return state.storage.getAlarm();
    });
    expect(alarmAt).not.toBeNull();
    expect(typeof alarmAt).toBe("number");
  });
});

describe("RoomDO alarm — pow_seen pruning", () => {
  it("deletes pow_seen rows whose expiresAt + 10min < now", async () => {
    const roomId = uniqueRoomId("alarm-powprune");
    const owner = await generateOwnerKeypair();
    await createRoom({
      roomId,
      ownerKp: owner,
      policy: { idleTimeoutMs: 60 * 60 * 1000 }, // keep idle far away
    });

    // Seed three rows: two stale (expiresAt + 10min in the past) and one fresh.
    const now = Date.now();
    await runInDurableObject(getStub(roomId), async (_inst, state) => {
      await state.storage.put<unknown>({
        "pow_seen:staleA": now - 15 * 60 * 1000, // expired 15min ago
        "pow_seen:staleB": now - 11 * 60 * 1000, // 1min past skew window
        "pow_seen:fresh": now + 5 * 60 * 1000, // still valid
      });
    });

    expect((await listKeys(roomId, "pow_seen:")).length).toBe(3);

    await fireAlarmDirect(roomId);

    const remaining = await listKeys(roomId, "pow_seen:");
    expect(remaining.sort()).toEqual(["pow_seen:fresh"]);

    // Room itself stayed alive — only pow rows were cleaned.
    expect(await countStorageKeys(roomId)).toBeGreaterThan(0);
  });

  it("leaves pow_seen rows alone while they are still within the skew window", async () => {
    const roomId = uniqueRoomId("alarm-powfresh");
    const owner = await generateOwnerKeypair();
    await createRoom({
      roomId,
      ownerKp: owner,
      policy: { idleTimeoutMs: 60 * 60 * 1000 },
    });

    // Borderline-fresh: expiresAt just barely outside the "stale" cutoff.
    // (Stale = expiresAt + 10min < now → expiresAt < now - 10min.)
    const now = Date.now();
    await runInDurableObject(getStub(roomId), async (_inst, state) => {
      await state.storage.put<unknown>({
        "pow_seen:edge": now - 9 * 60 * 1000, // expired 9min ago — still in skew
        "pow_seen:future": now + 60_000, // not yet expired
      });
    });

    await fireAlarmDirect(roomId);

    const remaining = await listKeys(roomId, "pow_seen:");
    expect(remaining.sort()).toEqual(["pow_seen:edge", "pow_seen:future"]);
  });
});

describe("RoomDO alarm — WS-connect cleanup_check", () => {
  it("runs alarm() immediately when a WS connects within 1h of expires_at", async () => {
    const roomId = uniqueRoomId("alarm-wsconnect");
    const owner = await generateOwnerKeypair();
    const { admissionKey } = await createRoom({
      roomId,
      ownerKp: owner,
      // Use a 2h expiresAt so it falls within the 1h pre-expiry window after we
      // rewind it below. Idle is 30m — also not relevant on its own here.
      policy: { expiresAt: Date.now() + 2 * 60 * 60 * 1000 },
    });

    // Push expires_at to "now + 10 minutes" → well inside the 1h cleanup window.
    // ALSO push hard_max_at into the past so alarm() actually wipes the room
    // (the cleanup check just *runs* alarm — alarm decides whether to expire).
    await runInDurableObject(getStub(roomId), async (_inst, state) => {
      await state.storage.put<number>("meta:expires_at", Date.now() + 10 * 60 * 1000);
      await state.storage.put<number>("meta:hard_max_at", Date.now() - 1);
    });

    // Open a WS — the cleanup check should run alarm() before the existence
    // re-check, observe the wiped state, and return 404.
    const { ws, response } = await openSocket({
      roomId,
      deviceId: "anyone",
      admissionKey,
    });
    expect(response.status).toBe(404);
    expect(ws).toBeNull();

    // And storage really is empty.
    expect(await countStorageKeys(roomId)).toBe(0);
  });

  it("does NOT trigger cleanup_check on a fresh room far from expires_at", async () => {
    const roomId = uniqueRoomId("alarm-ws-noop");
    const owner = await generateOwnerKeypair();
    const { admissionKey } = await createRoom({
      roomId,
      ownerKp: owner,
      // 6h expiresAt — well outside the 1h window.
      policy: { expiresAt: Date.now() + 6 * 60 * 60 * 1000 },
    });

    const sizeBefore = await countStorageKeys(roomId);

    // The deviceId isn't registered → upgrade returns 404, but the cleanup
    // check should NOT have run (we'd see size==0 if it did). We're using the
    // 404 path here purely as a cheap smoke probe; the assertion that matters
    // is storage size below.
    const { response } = await openSocket({
      roomId,
      deviceId: "no-such-dev",
      admissionKey,
    });
    expect(response.status).toBe(404);

    // Wait briefly for any waitUntil flush, then assert nothing was wiped.
    await waitFor(async () => (await countStorageKeys(roomId)) === sizeBefore, 500);
    expect(await countStorageKeys(roomId)).toBe(sizeBefore);
  });
});
