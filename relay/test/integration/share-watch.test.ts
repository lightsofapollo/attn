import { SELF, env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { base64UrlEncode, canonicalRequest } from "../../src/admission";
import type { Env } from "../../src/env";
import { generateEd25519Keypair, ownerSignatureHeader } from "../helpers/owner-sig";
import { createPowHeader, FIXED_POW_RAND, mintPowForTests } from "../helpers/pow";

declare module "cloudflare:test" { interface ProvidedEnv extends Env {} }

const sockets: WebSocket[] = [];
afterEach(() => { for (const socket of sockets.splice(0)) try { socket.close(1000, "test complete"); } catch { /* closed */ } });

async function watchProtocol(url: string, bundleId: string, key: Uint8Array): Promise<string> {
  const canonical = await canonicalRequest(new Request(url), new URL(url).pathname);
  const imported = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", imported, canonical));
  return `attn.v3, bundle.${bundleId}, read-hmac.${base64UrlEncode(mac)}`;
}

class WatchQueue {
  private readonly frames: unknown[] = [];
  private readonly waiters: Array<(frame: unknown) => void> = [];
  closeCode: number | undefined;
  private closeWaiter: ((code: number) => void) | undefined;
  constructor(socket: WebSocket) {
    socket.addEventListener("message", event => {
      const frame = JSON.parse(String(event.data)) as unknown;
      const waiter = this.waiters.shift();
      if (waiter) waiter(frame); else this.frames.push(frame);
    });
    socket.addEventListener("close", event => {
      this.closeCode = event.code;
      this.closeWaiter?.(event.code);
      for (const waiter of this.waiters.splice(0)) waiter(undefined);
    });
  }
  async next(timeoutMs = 2_000): Promise<unknown> {
    const frame = this.frames.shift();
    if (frame !== undefined) return frame;
    return new Promise(resolve => {
      const timer = setTimeout(() => resolve(undefined), timeoutMs);
      this.waiters.push(value => { clearTimeout(timer); resolve(value); });
    });
  }
  async closed(timeoutMs = 2_000): Promise<number | undefined> {
    if (this.closeCode !== undefined) return this.closeCode;
    return new Promise(resolve => {
      const timer = setTimeout(() => resolve(undefined), timeoutMs);
      this.closeWaiter = code => { clearTimeout(timer); resolve(code); };
    });
  }
}

async function createViewWatchShare(label: string): Promise<{
  shareId: string; url: string; watchUrl: string; bundleId: string; readKey: Uint8Array;
}> {
  const shareId = `${label}-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
  const url = `https://relay.example/v3/shares/${shareId}`;
  const owner = await generateEd25519Keypair();
  const bundleId = base64UrlEncode(crypto.getRandomValues(new Uint8Array(16)));
  const readKey = crypto.getRandomValues(new Uint8Array(32));
  const body = JSON.stringify({
    v: 3, epoch: 7, revision: 0, ownerSigningKey: base64UrlEncode(owner.publicKeyBytes),
    bundles: [{
      bundleId, tier: "view", readAdmissionKey: base64UrlEncode(readKey),
      sealedBundle: base64UrlEncode(new Uint8Array(80).fill(0x65)),
    }],
    snapshots: [], placeholders: [],
  });
  const created = await SELF.fetch(url, { method: "POST", body, headers: {
    "Content-Type": "application/json",
    "Attn-Owner-Signature": await ownerSignatureHeader({ method: "POST", url, body, privateKey: owner.privateKey }),
    "Attn-PoW": await createPowHeader(shareId, owner.publicKeyBytes, `/v3/shares/${shareId}`),
  } });
  if (created.status !== 201) throw new Error(`share create failed: ${created.status} ${await created.text()}`);
  return { shareId, url, watchUrl: `${url}/watch`, bundleId, readKey };
}

async function openWatch(fixture: Awaited<ReturnType<typeof createViewWatchShare>>): Promise<{ socket: WebSocket; queue: WatchQueue }> {
  const response = await SELF.fetch(fixture.watchUrl, { headers: {
    Upgrade: "websocket", Origin: "https://attn.sh",
    "Sec-WebSocket-Protocol": await watchProtocol(fixture.watchUrl, fixture.bundleId, fixture.readKey),
  } });
  expect(response.status).toBe(101);
  const socket = response.webSocket!;
  socket.accept(); sockets.push(socket);
  const queue = new WatchQueue(socket);
  expect(await queue.next()).toMatchObject({ type: "ping" });
  return { socket, queue };
}

describe("v3 durable share watch", () => {
  it("authenticates the selected bundle and broadcasts content-blind changes through revoke", async () => {
    const shareId = `share-watch-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
    const url = `https://relay.example/v3/shares/${shareId}`;
    const watchUrl = `${url}/watch`;
    const owner = await generateEd25519Keypair();
    const tiers = ["view", "comment", "suggest"] as const;
    const bundleKeys = tiers.map((tier, index) => ({
      tier,
      bundleId: base64UrlEncode(new Uint8Array(16).fill(0x10 + index)),
      read: new Uint8Array(32).fill(0x20 + index),
      write: tier === "view" ? undefined : new Uint8Array(32).fill(0x30 + index),
      sealedBundle: base64UrlEncode(new Uint8Array(80).fill(0x40 + index)),
    }));
    const bundles = bundleKeys.map(bundle => ({
      bundleId: bundle.bundleId,
      tier: bundle.tier,
      readAdmissionKey: base64UrlEncode(bundle.read),
      ...(bundle.write === undefined ? {} : { writeAdmissionKey: base64UrlEncode(bundle.write) }),
      sealedBundle: bundle.sealedBundle,
    }));
    const createBody = JSON.stringify({
      v: 3, ownerSigningKey: base64UrlEncode(owner.publicKeyBytes), epoch: 0, revision: 0,
      bundles, snapshots: [], placeholders: [],
    });
    expect((await SELF.fetch(url, { method: "POST", body: createBody, headers: {
      "Content-Type": "application/json",
      "Attn-Owner-Signature": await ownerSignatureHeader({ method: "POST", url, body: createBody, privateKey: owner.privateKey }),
      "Attn-PoW": await createPowHeader(shareId, owner.publicKeyBytes, `/v3/shares/${shareId}`),
    } })).status).toBe(201);

    const missingSelector = await SELF.fetch(watchUrl, { headers: {
      Upgrade: "websocket", "Sec-WebSocket-Protocol": "attn.v3, read-hmac.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    } });
    expect(missingSelector.status).toBe(401);
    const wrongSelector = await SELF.fetch(watchUrl, { headers: {
      Upgrade: "websocket", "Sec-WebSocket-Protocol": await watchProtocol(watchUrl, base64UrlEncode(new Uint8Array(16).fill(0xee)), bundleKeys[0]!.read),
    } });
    expect(wrongSelector.status).toBe(401);
    const validProtocol = await watchProtocol(watchUrl, bundleKeys[0]!.bundleId, bundleKeys[0]!.read);
    const [, bundleToken, proofToken] = validProtocol.split(",").map(token => token.trim());
    for (const malformed of [
      `attn.v3, ${proofToken}, ${bundleToken}`,
      `attn.v3, ${bundleToken}, ${bundleToken}, ${proofToken}`,
      `attn.v3, , ${bundleToken}, ${proofToken}`,
      `${validProtocol},`,
    ]) {
      const denied = await SELF.fetch(watchUrl, { headers: {
        Upgrade: "websocket", "Sec-WebSocket-Protocol": malformed,
      } });
      expect(denied.status).toBe(401);
      expect((await denied.json() as { error: { code: string } }).error.code).toBe("ATTN_ADMISSION_INVALID");
    }
    const forbiddenOrigin = await SELF.fetch(watchUrl, { headers: {
      Upgrade: "websocket", Origin: "https://evil.example",
      "Sec-WebSocket-Protocol": await watchProtocol(watchUrl, bundleKeys[0]!.bundleId, bundleKeys[0]!.read),
    } });
    expect(forbiddenOrigin.status).toBe(403);

    const badKey = await SELF.fetch(watchUrl, { headers: {
      Upgrade: "websocket",
      "Sec-WebSocket-Protocol": await watchProtocol(watchUrl, bundleKeys[0]!.bundleId, new Uint8Array(32).fill(0xdd)),
    } });
    expect(badKey.status).toBe(101);
    expect(badKey.webSocket).not.toBeNull();
    badKey.webSocket!.accept(); sockets.push(badKey.webSocket!);
    expect(await new WatchQueue(badKey.webSocket!).closed()).toBe(4000);

    const queues: WatchQueue[] = [];
    for (const bundle of bundleKeys) {
      const response = await SELF.fetch(watchUrl, { headers: {
        Upgrade: "websocket", Origin: "https://attn.sh",
        "Sec-WebSocket-Protocol": await watchProtocol(watchUrl, bundle.bundleId, bundle.read),
      } });
      expect(response.status).toBe(101);
      expect(response.headers.get("Sec-WebSocket-Protocol")).toBe("attn.v3");
      const socket = response.webSocket!; socket.accept(); sockets.push(socket);
      const queue = new WatchQueue(socket); queues.push(queue);
      expect(await queue.next()).toMatchObject({ type: "ping" });
      socket.send(JSON.stringify({ type: "pong", ts: Date.now() }));
    }

    // With three configured bundles and HARD_MAX_VIEWER_SOCKETS=32, each
    // bundle receives an 11-socket share. The twelfth view socket is accepted
    // then deterministically closed with the watch cap code.
    for (let index = 0; index < 10; index += 1) {
      const response = await SELF.fetch(watchUrl, { headers: {
        Upgrade: "websocket", "Sec-WebSocket-Protocol": await watchProtocol(watchUrl, bundleKeys[0]!.bundleId, bundleKeys[0]!.read),
      } });
      const socket = response.webSocket!; socket.accept(); sockets.push(socket);
    }
    const capped = await SELF.fetch(watchUrl, { headers: {
      Upgrade: "websocket", "Sec-WebSocket-Protocol": await watchProtocol(watchUrl, bundleKeys[0]!.bundleId, bundleKeys[0]!.read),
    } });
    const cappedSocket = capped.webSocket!; cappedSocket.accept(); sockets.push(cappedSocket);
    expect(await new WatchQueue(cappedSocket).closed()).toBe(4003);

    const ownerId = base64UrlEncode(new Uint8Array(await crypto.subtle.digest("SHA-256", owner.publicKeyBytes)));
    const updateBody = JSON.stringify({ v: 3, ownerSigningKey: base64UrlEncode(owner.publicKeyBytes), epoch: 1, revision: 1 });
    const updatePow = await mintPowForTests({ roomId: shareId, deviceId: ownerId, method: "POST", path: `/v3/shares/${shareId}`, difficulty: 12, expiresAt: Date.now() + 300_000, rand: `${FIXED_POW_RAND}watch-u` });
    expect((await SELF.fetch(url, { method: "POST", body: updateBody, headers: {
      "Content-Type": "application/json",
      "Attn-Owner-Signature": await ownerSignatureHeader({ method: "POST", url, body: updateBody, privateKey: owner.privateKey }),
      "Attn-PoW": updatePow,
    } })).status).toBe(200);
    for (const queue of queues) {
      const frame = await queue.next();
      expect(frame).toEqual({ type: "share_changed", epoch: 1, revision: 1 });
      expect(JSON.stringify(frame)).not.toContain("sealedBundle");
      expect(JSON.stringify(frame)).not.toContain("bundleId");
    }

    // A staged upload is content-blind AND broadcast-blind: watchers only hear
    // about the commit upsert that lands the manifest with its sealed bundles.
    // (If the PUT had broadcast, the next frame below would carry its
    // premature revision and the assertion would fail.)
    const snapshotUrl = `${url}/snapshots/readme/watch-snapshot`;
    const ciphertext = new Uint8Array([1, 2, 3, 4]);
    const canonical = await canonicalRequest(new Request(snapshotUrl, { method: "PUT", body: ciphertext }), new URL(snapshotUrl).pathname);
    const ownerSig = base64UrlEncode(new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, owner.privateKey, canonical)));
    const snapshotPow = await mintPowForTests({ roomId: shareId, deviceId: shareId, method: "PUT", path: `/v3/shares/${shareId}/snapshots/readme/watch-snapshot`, difficulty: 12, expiresAt: Date.now() + 300_000, rand: `${FIXED_POW_RAND}watch-s` });
    const stagedUpload = await SELF.fetch(snapshotUrl, { method: "PUT", body: ciphertext, headers: {
      "Content-Type": "application/octet-stream", "Attn-Device-Id": shareId,
      "Attn-Owner-Signature": ownerSig, "Attn-PoW": snapshotPow,
    } });
    expect(stagedUpload.status).toBe(201);
    const stagedRef = await stagedUpload.json() as Record<string, unknown>;
    const commitBody = JSON.stringify({ v: 3, ownerSigningKey: base64UrlEncode(owner.publicKeyBytes), revision: 2, snapshots: [stagedRef] });
    const commitPow = await mintPowForTests({ roomId: shareId, deviceId: ownerId, method: "POST", path: `/v3/shares/${shareId}`, difficulty: 12, expiresAt: Date.now() + 300_000, rand: `${FIXED_POW_RAND}watch-c` });
    expect((await SELF.fetch(url, { method: "POST", body: commitBody, headers: {
      "Content-Type": "application/json",
      "Attn-Owner-Signature": await ownerSignatureHeader({ method: "POST", url, body: commitBody, privateKey: owner.privateKey }),
      "Attn-PoW": commitPow,
    } })).status).toBe(200);
    for (const queue of queues) expect(await queue.next()).toEqual({ type: "share_changed", epoch: 1, revision: 2 });

    const removeBody = JSON.stringify({ v: 3, ownerSigningKey: base64UrlEncode(owner.publicKeyBytes), revision: 3, snapshots: [] });
    const removePow = await mintPowForTests({ roomId: shareId, deviceId: ownerId, method: "POST", path: `/v3/shares/${shareId}`, difficulty: 12, expiresAt: Date.now() + 300_000, rand: `${FIXED_POW_RAND}watch-d` });
    expect((await SELF.fetch(url, { method: "POST", body: removeBody, headers: {
      "Content-Type": "application/json",
      "Attn-Owner-Signature": await ownerSignatureHeader({ method: "POST", url, body: removeBody, privateKey: owner.privateKey }),
      "Attn-PoW": removePow,
    } })).status).toBe(200);
    for (const queue of queues) expect(await queue.next()).toEqual({ type: "share_changed", epoch: 1, revision: 3 });

    const revokePow = await mintPowForTests({ roomId: shareId, deviceId: shareId, method: "DELETE", path: `/v3/shares/${shareId}`, difficulty: 12, expiresAt: Date.now() + 300_000, rand: `${FIXED_POW_RAND}watch-r` });
    expect((await SELF.fetch(url, { method: "DELETE", headers: {
      "Attn-Device-Id": shareId,
      "Attn-Owner-Signature": await ownerSignatureHeader({ method: "DELETE", url, privateKey: owner.privateKey }),
      "Attn-PoW": revokePow,
    } })).status).toBe(204);
    for (const queue of queues) {
      expect(await queue.next()).toEqual({ type: "share_changed", epoch: 1, revision: 3 });
      expect(await queue.closed()).toBe(4001);
    }
  });

  it("bounds frames and closes idle watches from hibernated attachments", async () => {
    const fixture = await createViewWatchShare("share-watch-idle");
    const { socket, queue } = await openWatch(fixture);
    socket.send("x".repeat(1025));
    expect(await queue.closed()).toBe(1009);

    const second = await openWatch(fixture);
    await runInDurableObject(env.RELAY_SHARES.get(env.RELAY_SHARES.idFromName(fixture.shareId)), async (instance, state) => {
      const server = state.getWebSockets()[0];
      if (server === undefined) throw new Error("expected hibernated watch socket");
      const attachment = server.deserializeAttachment() as { v: 1; bundleId: string; lastPongTs: number };
      server.serializeAttachment({ ...attachment, lastPongTs: Date.now() - 91_000 });
      await instance.alarm();
    });
    expect(await second.queue.closed()).toBe(4002);
  });

  it("terminally closes on expiry and recovers a persisted cleanup tombstone", async () => {
    const expiring = await createViewWatchShare("share-watch-expiry");
    const expiryWatch = await openWatch(expiring);
    await runInDurableObject(env.RELAY_SHARES.get(env.RELAY_SHARES.idFromName(expiring.shareId)), async (instance, state) => {
      const record = await state.storage.get<Record<string, unknown>>("share:record");
      if (record === undefined) throw new Error("missing share record");
      await state.storage.put("share:record", { ...record, epoch: 7, revision: 9, expiresAt: Date.now() - 1 });
      await instance.alarm();
    });
    expect(await expiryWatch.queue.next()).toEqual({ type: "share_changed", epoch: 7, revision: 9 });
    expect(await expiryWatch.queue.closed()).toBe(4001);
    expect((await SELF.fetch(expiring.url)).status).toBe(404);

    const recovering = await createViewWatchShare("share-watch-recovery");
    const recoveryWatch = await openWatch(recovering);
    await runInDurableObject(env.RELAY_SHARES.get(env.RELAY_SHARES.idFromName(recovering.shareId)), async (instance, state) => {
      await state.storage.deleteAll();
      await state.storage.put("share:cleanup", {
        shareId: recovering.shareId, reason: "revoked", startedAt: Date.now(), epoch: 11, revision: 13,
      });
      await state.storage.setAlarm(Date.now());
      await instance.alarm();
    });
    expect(await recoveryWatch.queue.next()).toEqual({ type: "share_changed", epoch: 11, revision: 13 });
    expect(await recoveryWatch.queue.closed()).toBe(4001);
  });
});
