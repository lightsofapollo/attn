/** Worker -> RoomDO -> singleton QuotaDO integration coverage. */

import { SELF, env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { base64UrlEncode, canonicalRequest } from "../../src/admission";
import type { Env } from "../../src/env";
import type { RoomPolicy } from "../../src/schema";
import {
  generateEd25519Keypair,
  ownerSignatureHeader,
  type SubtleEd25519Keypair,
} from "../helpers/owner-sig";
import { createPowHeader } from "../helpers/pow";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

const URL_BASE = "https://relay.example";
let counter = 0;

interface CreatedRoom {
  roomId: string;
  body: string;
  owner: SubtleEd25519Keypair;
  admissionKey: Uint8Array;
  response: Response;
}

function roomId(label: string): string {
  counter += 1;
  return `quota-${label}-${Date.now().toString(36)}-${counter}`;
}

function policy(): RoomPolicy {
  return {
    mode: "live",
    maxPeers: 2,
    maxSnapshotBytes: 1024,
    maxEventBytes: 1024,
    maxEvents: 10,
    expiresAt: Date.now() + 60 * 60 * 1000,
    idleTimeoutMs: 30 * 60 * 1000,
    longSession: false,
    powBits: 12,
    deleteEventsAfterOwnerAck: false,
    allowBrowser: false,
    allowRemoteAgents: false,
  };
}

async function createRoom(sourceIp: string, label: string): Promise<CreatedRoom> {
  const id = roomId(label);
  const owner = await generateEd25519Keypair();
  const admissionKey = new Uint8Array(32).fill(counter & 0xff);
  const body = JSON.stringify({
    v: 2,
    policy: policy(),
    ownerSigningKey: base64UrlEncode(owner.publicKeyBytes),
    admissionKey: base64UrlEncode(admissionKey),
  });
  const url = `${URL_BASE}/v2/rooms/${id}`;
  const response = await SELF.fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "CF-Connecting-IP": sourceIp,
      // Must be overwritten by the Worker; clients cannot choose a bucket.
      "X-Attn-Quota-Source": "client-controlled-value",
      "Attn-Owner-Signature": await ownerSignatureHeader({
        method: "POST",
        url,
        body,
        privateKey: owner.privateKey,
      }),
      "Attn-PoW": await createPowHeader(id, owner.publicKeyBytes),
    },
    body,
  });
  return { roomId: id, body, owner, admissionKey, response };
}

async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, data));
}

async function rejoin(room: CreatedRoom, sourceIp: string): Promise<Response> {
  const url = `${URL_BASE}/v2/rooms/${room.roomId}`;
  const signing = new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: room.body,
  });
  const canonical = await canonicalRequest(signing, new URL(url).pathname);
  return SELF.fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "CF-Connecting-IP": sourceIp,
      "Attn-Admission": `v2.${base64UrlEncode(await hmac(room.admissionKey, canonical))}`,
    },
    body: room.body,
  });
}

describe("durable room quota integration", () => {
  it("limits one source, isolates another, and never charges rejoin", async () => {
    const sourceA = "192.0.2.41";
    const sourceB = "2001:db8::42";
    const first = await createRoom(sourceA, "same-a");
    const second = await createRoom(sourceA, "same-b");
    expect(first.response.status).toBe(201);
    expect(second.response.status).toBe(201);

    const denied = await createRoom(sourceA, "same-denied");
    expect(denied.response.status).toBe(429);
    const deniedBody = (await denied.response.json()) as { error: { code: string } };
    expect(deniedBody.error.code).toBe("ATTN_SOURCE_ROOM_QUOTA");
    expect(denied.response.headers.get("Retry-After")).not.toBeNull();

    // Regression: quota rejection cannot leave the create PoW marker (or any
    // other storage/alarm) behind in an otherwise uncreated RoomDO.
    const deniedStub = env.RELAY_ROOMS.get(env.RELAY_ROOMS.idFromName(denied.roomId));
    await runInDurableObject(deniedStub, async (_instance, state) => {
      expect((await state.storage.list()).size).toBe(0);
      expect(await state.storage.getAlarm()).toBeNull();
    });

    const otherSource = await createRoom(sourceB, "different-source");
    expect(otherSource.response.status).toBe(201);

    // Source A is still at its live limit. Rejoin reads existing state before
    // quota and therefore neither increments nor gets blocked by capacity.
    expect((await rejoin(first, sourceA)).status).toBe(200);

    // The singleton stores only HMAC buckets; neither canonical IP appears in
    // its durable key/value representation.
    const quota = env.RELAY_QUOTAS.get(env.RELAY_QUOTAS.idFromName("quota:v1"));
    const serialized = await runInDurableObject(quota, async (_instance, state) => {
      const entries = await state.storage.list();
      return JSON.stringify([...entries.entries()]);
    });
    expect(serialized).not.toContain(sourceA);
    expect(serialized).not.toContain(sourceB);
    expect(serialized).not.toContain("client-controlled-value");
  });

  it("blocks writes on an ambiguous pending legacy lease and confirms it on rejoin", async () => {
    const sourceIp = "198.51.100.77";
    const room = await createRoom(sourceIp, "legacy-pending");
    expect(room.response.status).toBe(201);

    const roomStub = env.RELAY_ROOMS.get(env.RELAY_ROOMS.idFromName(room.roomId));
    const active = await runInDurableObject(roomStub, async (_instance, state) =>
      state.storage.get<{
        roomId: string;
        leaseId: string;
        sourceBucket: string;
        reservedBytes: number;
        ownerSigningKeyId: string;
        createBodyHash: string;
        confirmed: boolean;
      }>("meta:quota_lease"),
    );
    expect(active?.confirmed).toBe(true);

    const quota = env.RELAY_QUOTAS.get(env.RELAY_QUOTAS.idFromName("quota:v1"));
    const released = await quota.fetch("https://quota.internal/release", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ roomId: room.roomId, leaseId: active?.leaseId }),
    });
    expect(released.status).toBe(204);

    const pending = { ...active, leaseId: crypto.randomUUID(), confirmed: false };
    await runInDurableObject(roomStub, async (_instance, state) => {
      await state.storage.put("meta:quota_lease", pending);
    });

    const blockedWrite = await SELF.fetch(`${URL_BASE}/v2/rooms/${room.roomId}/devices`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(blockedWrite.status).toBe(503);
    expect(((await blockedWrite.json()) as { error: { code: string } }).error.code).toBe(
      "ATTN_QUOTA_UNAVAILABLE",
    );

    expect((await rejoin(room, sourceIp)).status).toBe(200);
    const confirmed = await runInDurableObject(roomStub, async (_instance, state) =>
      state.storage.get<{ confirmed: boolean; leaseId: string }>("meta:quota_lease"),
    );
    expect(confirmed).toEqual({ ...pending, confirmed: true });
  });
});
