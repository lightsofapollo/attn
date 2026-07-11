import { SELF, fetchMock, runInDurableObject, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { base64UrlEncode, canonicalRequest } from "../../src/admission";
import { canonicalize } from "../../src/canonical";
import type { Env } from "../../src/env";
import { generateEd25519Keypair, ownerSignatureHeader } from "../helpers/owner-sig";
import { FIXED_POW_RAND, createPowHeader, mintPowForTests } from "../helpers/pow";

declare module "cloudflare:test" { interface ProvidedEnv extends Env {} }

const PUSH_BODY = JSON.stringify({
  v: 3,
  endpoint: "https://fcm.googleapis.com/fcm/send/attn-test-target",
  expirationTime: null,
  keys: {
    p256dh: "BKOaMoQCJMzoFLApwG1J8FvD2rB3JECjlJ_ZU2qhp4tUGJSfB2Z-5OI6wxAVDd2DilYJoXLRkN0bOSDRA32s7HI",
    auth: base64UrlEncode(new Uint8Array(16).fill(0x51)),
  },
});

beforeEach(() => { fetchMock.activate(); fetchMock.disableNetConnect(); });
afterEach(() => {
  try { fetchMock.assertNoPendingInterceptors(); } finally { fetchMock.deactivate(); }
});

async function admission(scope: "read" | "write", key: Uint8Array, method: string, url: string, body?: string): Promise<string> {
  const canonical = await canonicalRequest(new Request(url, { method, body }), new URL(url).pathname);
  const imported = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", imported, canonical));
  return `v3.${scope}.${base64UrlEncode(mac)}`;
}

async function pow(roomId: string, deviceId: string, method: string, path: string, suffix: string, difficulty = 12): Promise<string> {
  return mintPowForTests({
    roomId, deviceId, method, path, difficulty,
    expiresAt: Date.now() + 300_000,
    rand: `${FIXED_POW_RAND}${suffix}`,
  });
}

describe("payloadless v3 Web Push", () => {
  it("stores share subscriptions idempotently, pings only fresh offline mail, debounces, and removes gone endpoints", async () => {
    const shareId = `share-push-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
    const shareUrl = `https://relay.example/v3/shares/${shareId}`;
    const owner = await generateEd25519Keypair();
    const bundleId = base64UrlEncode(new Uint8Array(16).fill(0x21));
    const read = new Uint8Array(32).fill(0x31);
    const write = new Uint8Array(32).fill(0x41);
    const siblingBundleId = base64UrlEncode(new Uint8Array(16).fill(0x22));
    const siblingRead = new Uint8Array(32).fill(0x32);
    const siblingWrite = new Uint8Array(32).fill(0x42);
    const createBody = JSON.stringify({
      v: 3, ownerSigningKey: base64UrlEncode(owner.publicKeyBytes), epoch: 0, revision: 0,
      bundles: [{
        bundleId, tier: "comment", readAdmissionKey: base64UrlEncode(read),
        writeAdmissionKey: base64UrlEncode(write), sealedBundle: base64UrlEncode(new Uint8Array(80).fill(0x61)),
      }, {
        bundleId: siblingBundleId, tier: "suggest", readAdmissionKey: base64UrlEncode(siblingRead),
        writeAdmissionKey: base64UrlEncode(siblingWrite), sealedBundle: base64UrlEncode(new Uint8Array(80).fill(0x62)),
      }],
      snapshots: [], placeholders: [],
    });
    const created = await SELF.fetch(shareUrl, { method: "POST", body: createBody, headers: {
      "Content-Type": "application/json",
      "Attn-Owner-Signature": await ownerSignatureHeader({ method: "POST", url: shareUrl, body: createBody, privateKey: owner.privateKey }),
      "Attn-PoW": await createPowHeader(shareId, owner.publicKeyBytes, `/v3/shares/${shareId}`),
    } });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ features: { push: true } });

    const deviceId = "offline-reviewer";
    const pushPath = `/v3/shares/${shareId}/push-subscriptions/${deviceId}`;
    const pushUrl = `https://relay.example${pushPath}`;
    const oversized = await SELF.fetch(pushUrl, { method: "POST", body: "x".repeat(4097), headers: {
      "Attn-Device-Id": deviceId, "Attn-Share-Bundle": bundleId,
    } });
    expect(oversized.status).toBe(413);
    const subscribe = async (suffix: string) => SELF.fetch(pushUrl, { method: "POST", body: PUSH_BODY, headers: {
      "Content-Type": "application/json", "Attn-Device-Id": deviceId, "Attn-Share-Bundle": bundleId,
      "Attn-Admission": await admission("write", write, "POST", pushUrl, PUSH_BODY),
      "Attn-PoW": await pow(shareId, deviceId, "POST", pushPath, suffix),
    } });
    expect((await subscribe("s1")).status).toBe(201);
    expect((await subscribe("s2")).status).toBe(200);

    const siblingOverwrite = await SELF.fetch(pushUrl, { method: "POST", body: PUSH_BODY, headers: {
      "Content-Type": "application/json", "Attn-Device-Id": deviceId, "Attn-Share-Bundle": siblingBundleId,
      "Attn-Admission": await admission("write", siblingWrite, "POST", pushUrl, PUSH_BODY),
      "Attn-PoW": await pow(shareId, deviceId, "POST", pushPath, "sibling-post"),
    } });
    expect(siblingOverwrite.status).toBe(409);
    expect((await siblingOverwrite.json() as { error: { code: string } }).error.code).toBe("ATTN_PUSH_SUBSCRIPTION_BINDING_CONFLICT");
    const siblingDeletePow = await pow(shareId, deviceId, "DELETE", pushPath, "sibling-delete");
    const siblingDelete = await SELF.fetch(pushUrl, { method: "DELETE", headers: {
      "Attn-Device-Id": deviceId, "Attn-Share-Bundle": siblingBundleId,
      "Attn-Admission": await admission("write", siblingWrite, "DELETE", pushUrl),
      "Attn-PoW": siblingDeletePow,
    } });
    expect(siblingDelete.status).toBe(204);
    const replayedSiblingDeletePow = await SELF.fetch(pushUrl, { method: "DELETE", headers: {
      "Attn-Device-Id": deviceId, "Attn-Share-Bundle": bundleId,
      "Attn-Admission": await admission("write", write, "DELETE", pushUrl),
      "Attn-PoW": siblingDeletePow,
    } });
    expect(replayedSiblingDeletePow.status).toBe(400);
    expect((await replayedSiblingDeletePow.json() as { error: { code: string } }).error.code).toBe("ATTN_POW_INVALID");

    const get = await SELF.fetch(pushUrl, { headers: {
      "Attn-Device-Id": deviceId, "Attn-Share-Bundle": bundleId,
      "Attn-Admission": await admission("read", read, "GET", pushUrl),
    } });
    expect(get.status).toBe(200);
    const publicSubscription = await get.json() as Record<string, unknown>;
    expect(publicSubscription).toMatchObject({ v: 3, deviceId, bundleId });
    expect(publicSubscription).not.toHaveProperty("endpoint");
    expect(publicSubscription).not.toHaveProperty("keys");

    fetchMock.get("https://fcm.googleapis.com")
      .intercept({ path: "/fcm/send/attn-test-target", method: "POST", body: "", headers: { TTL: "300" } })
      .reply(201);
    const mailUrl = `${shareUrl}/mailbox`;
    const postMail = async (envelopeId: string, suffix: string) => {
      const body = JSON.stringify({ epoch: 0, deviceId: "mail-sender", items: [{ envelopeId, ciphertext: "opaque" }] });
      return SELF.fetch(mailUrl, { method: "POST", body, headers: {
        "Content-Type": "application/json", "Attn-Share-Bundle": bundleId,
        "Attn-Admission": await admission("write", write, "POST", mailUrl, body),
        "Attn-PoW": await pow(shareId, "mail-sender", "POST", `/v3/shares/${shareId}/mailbox`, suffix),
      } });
    };
    expect((await postMail("push-mail-1", "m1")).status).toBe(201);
    // A second accepted envelope inside the durable debounce window emits no request.
    expect((await postMail("push-mail-2", "m2")).status).toBe(201);

    await runInDurableObject(env.RELAY_SHARES.get(env.RELAY_SHARES.idFromName(shareId)), async (_instance, state) => {
      await state.storage.put(`push:last-sent:${deviceId}`, Date.now() - 31_000);
    });
    // An idempotent mailbox retry does not push even after the debounce floor.
    expect((await postMail("push-mail-2", "m2-retry")).status).toBe(200);

    const watchUrl = `${shareUrl}/watch`;
    const canonicalWatch = await canonicalRequest(new Request(watchUrl), new URL(watchUrl).pathname);
    const watchKey = await crypto.subtle.importKey("raw", read, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const watchMac = base64UrlEncode(new Uint8Array(await crypto.subtle.sign("HMAC", watchKey, canonicalWatch)));
    const watch = await SELF.fetch(watchUrl, { headers: {
      Upgrade: "websocket", Origin: "https://attn.sh",
      "Sec-WebSocket-Protocol": `attn.v3, bundle.${bundleId}, read-hmac.${watchMac}`,
    } });
    expect(watch.status).toBe(101);
    const watchSocket = watch.webSocket!;
    watchSocket.accept();
    // A live selected-bundle watch suppresses a push even though the durable
    // debounce timestamp was deliberately moved outside the window.
    expect((await postMail("push-mail-3", "m3-live")).status).toBe(201);
    await runInDurableObject(env.RELAY_SHARES.get(env.RELAY_SHARES.idFromName(shareId)), async (_instance, state) => {
      for (const serverSocket of state.getWebSockets()) {
        const attachment = serverSocket.deserializeAttachment() as Record<string, unknown>;
        serverSocket.serializeAttachment({ ...attachment, bundleId: "different-bundle" });
        serverSocket.close(1000, "test complete");
      }
    });

    fetchMock.get("https://fcm.googleapis.com")
      .intercept({ path: "/fcm/send/attn-test-target", method: "POST", body: "", headers: { TTL: "300" } })
      .reply(410);
    expect((await postMail("push-mail-4", "m4")).status).toBe(201);
    const gone = await SELF.fetch(pushUrl, { headers: {
      "Attn-Device-Id": deviceId, "Attn-Share-Bundle": bundleId,
      "Attn-Admission": await admission("read", read, "GET", pushUrl),
    } });
    expect(gone.status).toBe(404);

    await runInDurableObject(env.RELAY_SHARES.get(env.RELAY_SHARES.idFromName(shareId)), async (_instance, state) => {
      const now = Date.now();
      const input = JSON.parse(PUSH_BODY) as { endpoint: string; expirationTime: null; keys: { p256dh: string; auth: string } };
      const writes: Record<string, unknown> = {
        [`push:subscription:${deviceId}`]: {
          v: 3, deviceId, bundleId, ...input, createdAt: now - 1_000, updatedAt: now - 1_000, expiresAt: now - 1,
        },
      };
      for (let index = 0; index < 32; index++) {
        const cappedDevice = `cap-device-${index}`;
        writes[`push:subscription:${cappedDevice}`] = {
          v: 3, deviceId: cappedDevice, bundleId, ...input,
          endpoint: `https://fcm.googleapis.com/fcm/send/cap-${index}`,
          createdAt: now, updatedAt: now, expiresAt: now + 60_000,
        };
      }
      await state.storage.put(writes);
    });
    expect((await subscribe("cap-reactivate")).status).toBe(413);
  });

  it("binds room subscriptions to registered devices and suppresses self-authored events", async () => {
    const roomId = `room-push-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
    const roomUrl = `https://relay.example/v3/rooms/${roomId}`;
    const owner = await generateEd25519Keypair();
    const read = new Uint8Array(32).fill(0x71);
    const write = new Uint8Array(32).fill(0x72);
    const policyExpiresAt = Date.now() + 3_600_000;
    const createBody = JSON.stringify({
      v: 3,
      policy: { mode: "hybrid", maxPeers: 4, maxSnapshotBytes: 1_000_000, maxEventBytes: 8192, maxEvents: 100, expiresAt: policyExpiresAt, allowBrowser: true },
      ownerSigningKey: base64UrlEncode(owner.publicKeyBytes),
      readAdmissionKey: base64UrlEncode(read), writeAdmissionKey: base64UrlEncode(write),
    });
    expect((await SELF.fetch(roomUrl, { method: "POST", body: createBody, headers: {
      "Content-Type": "application/json",
      "Attn-Owner-Signature": await ownerSignatureHeader({ method: "POST", url: roomUrl, body: createBody, privateKey: owner.privateKey }),
      "Attn-PoW": await createPowHeader(roomId, owner.publicKeyBytes, `/v3/rooms/${roomId}`),
    } })).status).toBe(201);

    const register = async (deviceId: string, participantId: string) => {
      const device = await generateEd25519Keypair();
      const grant = canonicalize({ grantTier: "comment", purpose: "attn device grant v3", roomId, v: 3 });
      const unsigned = {
        deviceId, participantId, publicSigningKey: base64UrlEncode(device.publicKeyBytes),
        publicEncryptionKey: base64UrlEncode(new Uint8Array(32).fill(0x44)), client: "attn-browser", kind: "reviewer",
        grantTier: "comment",
        grantSignature: base64UrlEncode(new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, owner.privateKey, new TextEncoder().encode(grant)))),
      };
      const body = JSON.stringify({
        ...unsigned,
        selfSignature: base64UrlEncode(new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, device.privateKey, new TextEncoder().encode(canonicalize(unsigned))))),
      });
      const url = `${roomUrl}/devices`;
      const response = await SELF.fetch(url, { method: "POST", body, headers: {
        "Content-Type": "application/json", "Attn-Admission": await admission("write", write, "POST", url, body),
        "Attn-PoW": await pow(roomId, deviceId, "POST", `/v3/rooms/${roomId}/devices`, `r-${deviceId}`, 16),
      } });
      expect(response.status, await response.clone().text()).toBe(204);
    };
    await register("event-sender", "participant-sender");
    await register("offline-target", "participant-target");

    const pushPath = `/v3/rooms/${roomId}/push-subscriptions/offline-target`;
    const pushUrl = `https://relay.example${pushPath}`;
    const subscribed = await SELF.fetch(pushUrl, { method: "POST", body: PUSH_BODY, headers: {
      "Content-Type": "application/json", "Attn-Device-Id": "offline-target",
      "Attn-Admission": await admission("write", write, "POST", pushUrl, PUSH_BODY),
      "Attn-PoW": await pow(roomId, "offline-target", "POST", pushPath, "sub", 16),
    } });
    expect(subscribed.status).toBe(201);
    const publicRoomSubscription = await subscribed.json() as Record<string, unknown>;
    expect(publicRoomSubscription).not.toHaveProperty("endpoint");
    expect(publicRoomSubscription).not.toHaveProperty("keys");
    expect(publicRoomSubscription.expiresAt).toBe(policyExpiresAt);

    fetchMock.get("https://fcm.googleapis.com")
      .intercept({ path: "/fcm/send/attn-test-target", method: "POST", body: "", headers: { TTL: "300" } })
      .reply(201);
    const envelopesUrl = `${roomUrl}/envelopes`;
    const envelope = {
      envelopeId: "push-room-event", authorId: "participant-sender", deviceId: "event-sender", kind: "event", target: null,
      createdAt: Date.now(), expiresAt: Date.now() + 60_000,
      nonce: base64UrlEncode(new Uint8Array(24).fill(0x55)), ciphertext: base64UrlEncode(new Uint8Array(16).fill(0x66)), ciphertextBytes: 16,
    };
    const body = JSON.stringify({ envelopes: [envelope] });
    const posted = await SELF.fetch(envelopesUrl, { method: "POST", body, headers: {
      "Content-Type": "application/json", "Attn-Admission": await admission("write", write, "POST", envelopesUrl, body),
      "Attn-PoW": await pow(roomId, "event-sender", "POST", `/v3/rooms/${roomId}/envelopes`, "event", 16),
    } });
    expect(posted.status, await posted.clone().text()).toBe(201);

    await runInDurableObject(env.RELAY_ROOMS.get(env.RELAY_ROOMS.idFromName(roomId)), async (_instance, state) => {
      await state.storage.put("push:last-sent:offline-target", Date.now() - 31_000);
    });
    const socketUrl = `${roomUrl}/socket?device_id=offline-target`;
    const readProof = (await admission("read", read, "GET", socketUrl)).split(".")[2];
    const writeProof = (await admission("write", write, "GET", socketUrl)).split(".")[2];
    const socketResponse = await SELF.fetch(socketUrl, { headers: {
      Upgrade: "websocket", Origin: "https://attn.sh",
      "Sec-WebSocket-Protocol": `attn.v3, read-hmac.${readProof}, write-hmac.${writeProof}`,
    } });
    expect(socketResponse.status).toBe(101);
    const socket = socketResponse.webSocket!;
    socket.accept();
    const liveEnvelope = { ...envelope, envelopeId: "push-room-live-event" };
    const liveBody = JSON.stringify({ envelopes: [liveEnvelope] });
    const livePosted = await SELF.fetch(envelopesUrl, { method: "POST", body: liveBody, headers: {
      "Content-Type": "application/json", "Attn-Admission": await admission("write", write, "POST", envelopesUrl, liveBody),
      "Attn-PoW": await pow(roomId, "event-sender", "POST", `/v3/rooms/${roomId}/envelopes`, "event-live", 16),
    } });
    expect(livePosted.status, await livePosted.clone().text()).toBe(201);
    socket.close(1000, "test complete");

    const deleted = await SELF.fetch(pushUrl, { method: "DELETE", headers: {
      "Attn-Device-Id": "offline-target",
      "Attn-Admission": await admission("write", write, "DELETE", pushUrl),
      "Attn-PoW": await pow(roomId, "offline-target", "DELETE", pushPath, "delete", 16),
    } });
    expect(deleted.status).toBe(204);

    await runInDurableObject(env.RELAY_ROOMS.get(env.RELAY_ROOMS.idFromName(roomId)), async (_instance, state) => {
      const now = Date.now();
      const input = JSON.parse(PUSH_BODY) as { endpoint: string; expirationTime: null; keys: { p256dh: string; auth: string } };
      const writes: Record<string, unknown> = {
        "push:subscription:offline-target": {
          v: 3, deviceId: "offline-target", ...input, createdAt: now - 1_000, updatedAt: now - 1_000, expiresAt: now - 1,
        },
      };
      for (let index = 0; index < 32; index++) {
        const cappedDevice = `room-cap-device-${index}`;
        writes[`push:subscription:${cappedDevice}`] = {
          v: 3, deviceId: cappedDevice, ...input,
          endpoint: `https://fcm.googleapis.com/fcm/send/room-cap-${index}`,
          createdAt: now, updatedAt: now, expiresAt: now + 60_000,
        };
      }
      await state.storage.put(writes);
    });
    const reactivated = await SELF.fetch(pushUrl, { method: "POST", body: PUSH_BODY, headers: {
      "Content-Type": "application/json", "Attn-Device-Id": "offline-target",
      "Attn-Admission": await admission("write", write, "POST", pushUrl, PUSH_BODY),
      "Attn-PoW": await pow(roomId, "offline-target", "POST", pushPath, "reactivate", 16),
    } });
    expect(reactivated.status).toBe(413);
  });
});
