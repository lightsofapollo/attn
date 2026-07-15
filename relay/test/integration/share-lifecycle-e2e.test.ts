import { SELF, env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";

import { base64UrlEncode, canonicalRequest } from "../../src/admission";
import type { Env } from "../../src/env";
import { shareArtifactPrefix } from "../../src/r2";
import { generateEd25519Keypair, ownerSignatureHeader } from "../helpers/owner-sig";
import { FIXED_POW_RAND, mintPowForTests } from "../helpers/pow";

declare module "cloudflare:test" { interface ProvidedEnv extends Env {} }

type Tier = "view" | "comment" | "suggest";
interface TierFixture {
  tier: Tier;
  bundleId: string;
  read: Uint8Array;
  write?: Uint8Array;
  sealedBundle: string;
}

const sockets: WebSocket[] = [];
afterEach(() => {
  for (const socket of sockets.splice(0)) {
    try { socket.close(1000, "test complete"); } catch { /* already closed */ }
  }
});

async function admission(
  scope: "read" | "write",
  key: Uint8Array,
  method: string,
  url: string,
  body?: string,
): Promise<string> {
  const canonical = await canonicalRequest(new Request(url, { method, body }), new URL(url).pathname);
  const imported = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", imported, canonical));
  return `v3.${scope}.${base64UrlEncode(mac)}`;
}

async function watchProtocols(url: string, bundle: TierFixture): Promise<string> {
  const proof = (await admission("read", bundle.read, "GET", url)).slice("v3.read.".length);
  return `attn.v3, bundle.${bundle.bundleId}, read-hmac.${proof}`;
}

async function binaryOwnerSignature(
  method: string,
  url: string,
  body: Uint8Array,
  privateKey: CryptoKey,
): Promise<string> {
  const canonical = await canonicalRequest(
    new Request(url, { method, body, headers: { "Content-Type": "application/octet-stream" } }),
    new URL(url).pathname,
  );
  return base64UrlEncode(new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, privateKey, canonical)));
}

async function pow(
  shareId: string,
  deviceId: string,
  method: string,
  path: string,
  suffix: string,
): Promise<string> {
  return mintPowForTests({
    roomId: shareId,
    deviceId,
    method,
    path,
    difficulty: 12,
    expiresAt: Date.now() + 300_000,
    rand: `${FIXED_POW_RAND}lifecycle-${suffix}`,
  });
}

class WatchQueue {
  readonly #messages: unknown[] = [];
  readonly #waiters: Array<(value: unknown) => void> = [];
  readonly #closes: number[] = [];
  readonly #closeWaiters: Array<(value: number) => void> = [];

  constructor(socket: WebSocket) {
    socket.addEventListener("message", event => {
      const value = JSON.parse(String(event.data)) as unknown;
      const waiter = this.#waiters.shift();
      if (waiter === undefined) this.#messages.push(value); else waiter(value);
    });
    socket.addEventListener("close", event => {
      const waiter = this.#closeWaiters.shift();
      if (waiter === undefined) this.#closes.push(event.code); else waiter(event.code);
    });
  }

  next(): Promise<unknown> {
    const value = this.#messages.shift();
    if (value !== undefined) return Promise.resolve(value);
    return new Promise(resolve => this.#waiters.push(resolve));
  }

  closed(): Promise<number> {
    const value = this.#closes.shift();
    if (value !== undefined) return Promise.resolve(value);
    return new Promise(resolve => this.#closeWaiters.push(resolve));
  }
}

describe("durable share v3 real-stack lifecycle", () => {
  it("survives room loss and owner restart, drains mail, renews, rotates, and revokes totally", async () => {
    const shareId = `share-e2e-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
    const shareUrl = `https://relay.example/v3/shares/${shareId}`;
    const stableInvite = `https://attn.sh/s/${shareId}#key=${base64UrlEncode(new Uint8Array(32).fill(0x70))}`;
    const owner = await generateEd25519Keypair();
    const ownerKey = base64UrlEncode(owner.publicKeyBytes);
    const ownerDeviceId = base64UrlEncode(new Uint8Array(await crypto.subtle.digest("SHA-256", owner.publicKeyBytes)));
    const room0 = `room-${shareId}-e0`;
    const room1 = `room-${shareId}-e1`;
    const tiers: TierFixture[] = (["view", "comment", "suggest"] as const).map((tier, index) => ({
      tier,
      bundleId: base64UrlEncode(new Uint8Array(16).fill(0x10 + index)),
      read: new Uint8Array(32).fill(0x20 + index),
      ...(tier === "view" ? {} : { write: new Uint8Array(32).fill(0x30 + index) }),
      sealedBundle: base64UrlEncode(new Uint8Array(96).fill(0x40 + index)),
    }));
    const [view, comment, suggest] = tiers as [TierFixture, TierFixture, TierFixture];
    const bundles = () => tiers.map(tier => ({
      bundleId: tier.bundleId,
      tier: tier.tier,
      readAdmissionKey: base64UrlEncode(tier.read),
      ...(tier.write === undefined ? {} : { writeAdmissionKey: base64UrlEncode(tier.write) }),
      sealedBundle: tier.sealedBundle,
    }));

    const createBody = JSON.stringify({
      v: 3,
      ownerSigningKey: ownerKey,
      epoch: 0,
      revision: 0,
      currentRoomId: room0,
      bundles: bundles(),
      snapshots: [],
      placeholders: [],
      deviceId: ownerDeviceId,
    });
    const created = await SELF.fetch(shareUrl, { method: "POST", body: createBody, headers: {
      "Content-Type": "application/json",
      "Attn-Owner-Signature": await ownerSignatureHeader({ method: "POST", url: shareUrl, body: createBody, privateKey: owner.privateKey }),
      "Attn-PoW": await pow(shareId, ownerDeviceId, "POST", `/v3/shares/${shareId}`, "create"),
    } });
    expect(created.status).toBe(201);

    const resolve = async (tier: TierFixture): Promise<Response> => SELF.fetch(shareUrl, { headers: {
      "Attn-Share-Bundle": tier.bundleId,
      "Attn-Admission": await admission("read", tier.read, "GET", shareUrl),
    } });
    for (const tier of tiers) {
      const response = await resolve(tier);
      expect(response.status).toBe(200);
      const body = await response.json() as Record<string, unknown>;
      expect(body).toMatchObject({ shareId, epoch: 0, revision: 0, currentRoomId: room0 });
      expect(body.bundle).toEqual({ bundleId: tier.bundleId, tier: tier.tier, sealedBundle: tier.sealedBundle });
      expect(JSON.stringify(body)).not.toContain(tiers.find(candidate => candidate !== tier)!.sealedBundle);
    }

    // A browser visitor resolves live and holds a content-blind watch. The
    // same socket remains open across retained-snapshot and owner-restart
    // changes, which is the no-page-reload upgrade path.
    const watchUrl = `${shareUrl}/watch`;
    const watchResponse = await SELF.fetch(watchUrl, { headers: {
      Upgrade: "websocket",
      Origin: "https://attn.sh",
      "Sec-WebSocket-Protocol": await watchProtocols(watchUrl, comment),
    } });
    expect(watchResponse.status).toBe(101);
    const socket = watchResponse.webSocket!;
    socket.accept(); sockets.push(socket);
    const watch = new WatchQueue(socket);
    expect(await watch.next()).toMatchObject({ type: "ping" });
    socket.send(JSON.stringify({ type: "pong", ts: Date.now() }));

    // Owner retains opaque ciphertext before the ephemeral room disappears.
    const snapshot = new TextEncoder().encode("nonce24 || owner-encrypted XChaCha20Poly1305 snapshot");
    const snapshotUrl = `${shareUrl}/snapshots/readme/snapshot-e0`;
    const uploaded = await SELF.fetch(snapshotUrl, { method: "PUT", body: snapshot, headers: {
      "Content-Type": "application/octet-stream",
      "Attn-Device-Id": ownerDeviceId,
      "Attn-Owner-Signature": await binaryOwnerSignature("PUT", snapshotUrl, snapshot, owner.privateKey),
      "Attn-PoW": await pow(shareId, ownerDeviceId, "PUT", `/v3/shares/${shareId}/snapshots/readme/snapshot-e0`, "snapshot-e0"),
    } });
    expect(uploaded.status).toBe(201);
    // The upload only staged the ciphertext; the manifest, revision, and the
    // (unchanged-identity) bundles go live together in one commit upsert.
    const uploadedRef = await uploaded.json() as Record<string, unknown>;
    const commitBody = JSON.stringify({
      v: 3, ownerSigningKey: ownerKey, epoch: 0, revision: 1, currentRoomId: room0,
      snapshots: [uploadedRef], deviceId: ownerDeviceId,
    });
    expect((await SELF.fetch(shareUrl, { method: "POST", body: commitBody, headers: {
      "Content-Type": "application/json",
      "Attn-Owner-Signature": await ownerSignatureHeader({ method: "POST", url: shareUrl, body: commitBody, privateKey: owner.privateKey }),
      "Attn-PoW": await pow(shareId, ownerDeviceId, "POST", `/v3/shares/${shareId}`, "commit-e0"),
    } })).status).toBe(200);
    expect(await watch.next()).toEqual({ type: "share_changed", epoch: 0, revision: 1 });

    // Force loss of the room DO independently of ShareDO. A durable visitor
    // must still resolve the unchanged invite and download retained bytes.
    const roomStub = env.RELAY_ROOMS.get(env.RELAY_ROOMS.idFromName(room0));
    await runInDurableObject(roomStub, async (_instance, state) => {
      await state.storage.put("test:room-was-live", true);
      await state.storage.deleteAll();
      expect((await state.storage.list()).size).toBe(0);
    });
    expect(stableInvite).toBe(`https://attn.sh/s/${shareId}#key=${stableInvite.split("#key=")[1]}`);
    const fallback = await resolve(view);
    expect(fallback.status).toBe(200);
    expect(await fallback.json()).toMatchObject({ currentRoomId: room0, epoch: 0, revision: 1 });
    const retained = await SELF.fetch(`${shareUrl}/snapshots/readme`, { headers: {
      "Attn-Share-Bundle": view.bundleId,
      "Attn-Admission": await admission("read", view.read, "GET", `${shareUrl}/snapshots/readme`),
    } });
    expect(retained.status).toBe(200);
    expect(new Uint8Array(await retained.arrayBuffer())).toEqual(snapshot);

    // View cannot write. Comment can submit an exact frozen offline payload;
    // suggest is independently writable but cannot read the comment mailbox.
    const mailboxUrl = `${shareUrl}/mailbox`;
    const browserDeviceId = "browser-commenter";
    const browserParticipantId = "browser-participant";
    const opaqueEvent = (suffix: string) => ({
      v: 2,
      roomId: room0,
      envelopeId: `frozen-${suffix}`,
      authorId: browserParticipantId,
      deviceId: browserDeviceId,
      createdAt: 1_000,
      expiresAt: 10_000,
      kind: "event" as const,
      nonce: base64UrlEncode(new Uint8Array(24).fill(0x71)),
      ciphertext: base64UrlEncode(new Uint8Array(32).fill(0x72)),
      ciphertextBytes: 32,
    });
    const offlineSubmission = {
      v: 3,
      envelopeId: "offline-comment-e0",
      type: "review_submission",
      shareId,
      epoch: 0,
      roomId: room0,
      tier: "comment",
      bundleId: comment.bundleId,
      deviceRegistration: {
        deviceId: browserDeviceId,
        participantId: browserParticipantId,
        publicSigningKey: base64UrlEncode(new Uint8Array(32).fill(0x73)),
        publicEncryptionKey: base64UrlEncode(new Uint8Array(32).fill(0x74)),
        client: "attn-browser",
        kind: "reviewer",
        grantTier: "comment",
        grantSignature: base64UrlEncode(new Uint8Array(64).fill(0x75)),
        selfSignature: base64UrlEncode(new Uint8Array(64).fill(0x76)),
      },
      // Random opaque bytes are sufficient: ShareDO validates framing and
      // routing only and never interprets ReviewEvent plaintext.
      envelopes: [opaqueEvent("joined"), opaqueEvent("comment")],
    };
    const mailBody = JSON.stringify({ epoch: 0, deviceId: browserDeviceId, items: [offlineSubmission] });
    const malformedSubmissions: unknown[] = [
      { ...offlineSubmission, envelopeId: "bad-extra", unexpectedPlaintext: "must never be retained" },
      { ...offlineSubmission, envelopeId: "bad-share", shareId: `${shareId}-misrouted` },
      { ...offlineSubmission, envelopeId: "bad-bundle", bundleId: view.bundleId },
      { ...offlineSubmission, envelopeId: "bad-tier", tier: "suggest" },
      { ...offlineSubmission, envelopeId: "bad-device", deviceRegistration: {
        ...offlineSubmission.deviceRegistration, deviceId: "different-device",
      } },
      { ...offlineSubmission, envelopeId: "bad-envelope-extra", envelopes: [
        { ...offlineSubmission.envelopes[0], plaintext: "forbidden" },
        offlineSubmission.envelopes[1],
      ] },
      { ...offlineSubmission, envelopeId: "bad-envelope-duplicate", envelopes: [
        opaqueEvent("duplicate"), opaqueEvent("duplicate"),
      ] },
      { ...offlineSubmission, envelopeId: "bad-byte-count", envelopes: [
        { ...offlineSubmission.envelopes[0], ciphertextBytes: 31 },
        offlineSubmission.envelopes[1],
      ] },
    ];
    for (const [index, malformed] of malformedSubmissions.entries()) {
      const malformedBody = JSON.stringify({ epoch: 0, deviceId: browserDeviceId, items: [malformed] });
      const rejected = await SELF.fetch(mailboxUrl, { method: "POST", body: malformedBody, headers: {
        "Content-Type": "application/json",
        "Attn-Share-Bundle": comment.bundleId,
        "Attn-Admission": await admission("write", comment.write!, "POST", mailboxUrl, malformedBody),
        "Attn-PoW": await pow(shareId, browserDeviceId, "POST", `/v3/shares/${shareId}/mailbox`, `malformed-${index}`),
      } });
      expect(rejected.status, `malformed durable item ${index}`).toBe(400);
      expect(await rejected.json()).toMatchObject({ error: { code: "ATTN_BODY_INVALID" } });
    }
    const emptyAfterMalformed = await SELF.fetch(mailboxUrl, { headers: {
      "Attn-Share-Bundle": comment.bundleId,
      "Attn-Admission": await admission("read", comment.read, "GET", mailboxUrl),
    } });
    expect((await emptyAfterMalformed.json() as { items: unknown[] }).items).toEqual([]);
    const viewDenied = await SELF.fetch(mailboxUrl, { method: "POST", body: mailBody, headers: {
      "Content-Type": "application/json",
      "Attn-Share-Bundle": view.bundleId,
      "Attn-Admission": await admission("read", view.read, "POST", mailboxUrl, mailBody),
    } });
    expect(viewDenied.status).toBe(403);
    const queued = await SELF.fetch(mailboxUrl, { method: "POST", body: mailBody, headers: {
      "Content-Type": "application/json",
      "Attn-Share-Bundle": comment.bundleId,
      "Attn-Admission": await admission("write", comment.write!, "POST", mailboxUrl, mailBody),
      "Attn-PoW": await pow(shareId, browserDeviceId, "POST", `/v3/shares/${shareId}/mailbox`, "mail-e0"),
    } });
    expect(queued.status).toBe(201);
    expect(await queued.json()).toMatchObject({ acceptedThrough: 1, accepted: 1 });
    const suggestMail = await SELF.fetch(mailboxUrl, { headers: {
      "Attn-Share-Bundle": suggest.bundleId,
      "Attn-Admission": await admission("read", suggest.read, "GET", mailboxUrl),
    } });
    expect((await suggestMail.json() as { items: unknown[] }).items).toEqual([]);

    // Owner restart reads exact mail, imports it into the deterministically
    // recreated same-epoch room, ACKs contiguously, then republishes. The live
    // visitor's existing watch signals a re-resolve without a page reload.
    const ownerMail = await SELF.fetch(mailboxUrl, { headers: {
      "Attn-Share-Bundle": comment.bundleId,
      "Attn-Admission": await admission("read", comment.read, "GET", mailboxUrl),
    } });
    const ownerMailBody = await ownerMail.json() as { items: Array<{ seq: number; payload: unknown; epoch: number; tier: string }> };
    expect(ownerMailBody.items).toEqual([{ seq: 1, envelopeId: "offline-comment-e0", bytes: JSON.stringify(offlineSubmission).length,
      payload: offlineSubmission, bundleId: comment.bundleId, tier: "comment", epoch: 0 }]);
    const ackUrl = `${mailboxUrl}?through=1`;
    expect((await SELF.fetch(ackUrl, { method: "DELETE", headers: {
      "Attn-Device-Id": ownerDeviceId,
      "Attn-Owner-Signature": await ownerSignatureHeader({ method: "DELETE", url: ackUrl, privateKey: owner.privateKey }),
      "Attn-PoW": await pow(shareId, ownerDeviceId, "DELETE", `/v3/shares/${shareId}/mailbox`, "ack-e0"),
    } })).status).toBe(204);
    for (const [index, tier] of tiers.entries()) {
      tier.sealedBundle = base64UrlEncode(new Uint8Array(97).fill(0x50 + index));
    }
    const restartBody = JSON.stringify({
      v: 3, ownerSigningKey: ownerKey, epoch: 0, revision: 1, currentRoomId: room0,
      bundles: bundles(), deviceId: ownerDeviceId,
    });
    expect((await SELF.fetch(shareUrl, { method: "POST", body: restartBody, headers: {
      "Content-Type": "application/json",
      "Attn-Owner-Signature": await ownerSignatureHeader({ method: "POST", url: shareUrl, body: restartBody, privateKey: owner.privateKey }),
      "Attn-PoW": await pow(shareId, ownerDeviceId, "POST", `/v3/shares/${shareId}`, "restart-e0"),
    } })).status).toBe(200);
    expect(await watch.next()).toEqual({ type: "share_changed", epoch: 0, revision: 1 });
    expect((await resolve(comment)).status).toBe(200);

    // A no-projection-change owner connect renews the pointer. Expired state,
    // in contrast, is terminal and cannot be revived (covered below by total
    // revoke; expiry terminality also has a dedicated watch integration case).
    const shareStub = env.RELAY_SHARES.get(env.RELAY_SHARES.idFromName(shareId));
    const beforeRenew = await runInDurableObject(shareStub, async (_instance, state) => {
      const record = await state.storage.get<Record<string, unknown>>("share:record");
      if (record === undefined) throw new Error("missing share record");
      const expiresAt = Date.now() + 2_000;
      await state.storage.put("share:record", { ...record, expiresAt });
      return expiresAt;
    });
    const renewBody = JSON.stringify({ v: 3, ownerSigningKey: ownerKey, epoch: 0, revision: 1, deviceId: ownerDeviceId });
    const renewed = await SELF.fetch(shareUrl, { method: "POST", body: renewBody, headers: {
      "Content-Type": "application/json",
      "Attn-Owner-Signature": await ownerSignatureHeader({ method: "POST", url: shareUrl, body: renewBody, privateKey: owner.privateKey }),
      "Attn-PoW": await pow(shareId, ownerDeviceId, "POST", `/v3/shares/${shareId}`, "renew"),
    } });
    expect(renewed.status).toBe(200);
    expect((await renewed.json() as { expiresAt: number }).expiresAt).toBeGreaterThan(beforeRenew + 60_000);
    expect(await watch.next()).toEqual({ type: "share_changed", epoch: 0, revision: 1 });

    // Rotate into a second epoch without changing the invite. Old-epoch mail
    // is rejected and new-epoch mail can be independently drained.
    for (const [index, tier] of tiers.entries()) {
      tier.sealedBundle = base64UrlEncode(new Uint8Array(98).fill(0x60 + index));
    }
    const rotateBody = JSON.stringify({
      v: 3, ownerSigningKey: ownerKey, epoch: 1, revision: 2, currentRoomId: room1,
      bundles: bundles(), deviceId: ownerDeviceId,
    });
    expect((await SELF.fetch(shareUrl, { method: "POST", body: rotateBody, headers: {
      "Content-Type": "application/json",
      "Attn-Owner-Signature": await ownerSignatureHeader({ method: "POST", url: shareUrl, body: rotateBody, privateKey: owner.privateKey }),
      "Attn-PoW": await pow(shareId, ownerDeviceId, "POST", `/v3/shares/${shareId}`, "rotate-e1"),
    } })).status).toBe(200);
    expect(await watch.next()).toEqual({ type: "share_changed", epoch: 1, revision: 2 });
    expect(stableInvite.includes(`/s/${shareId}#key=`)).toBe(true);
    expect(await (await resolve(view)).json()).toMatchObject({ epoch: 1, revision: 2, currentRoomId: room1 });
    const stale = await SELF.fetch(mailboxUrl, { method: "POST", body: mailBody, headers: {
      "Content-Type": "application/json",
      "Attn-Share-Bundle": comment.bundleId,
      "Attn-Admission": await admission("write", comment.write!, "POST", mailboxUrl, mailBody),
    } });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ currentEpoch: 1, error: { code: "ATTN_SHARE_EPOCH_STALE", currentEpoch: 1 } });

    const epoch1Submission = {
      ...offlineSubmission,
      envelopeId: "offline-comment-e1",
      epoch: 1,
      roomId: room1,
      envelopes: offlineSubmission.envelopes.map(envelope => ({ ...envelope, roomId: room1 })),
    };
    const epoch1Body = JSON.stringify({ epoch: 1, deviceId: browserDeviceId, items: [epoch1Submission] });
    expect((await SELF.fetch(mailboxUrl, { method: "POST", body: epoch1Body, headers: {
      "Content-Type": "application/json",
      "Attn-Share-Bundle": comment.bundleId,
      "Attn-Admission": await admission("write", comment.write!, "POST", mailboxUrl, epoch1Body),
      "Attn-PoW": await pow(shareId, browserDeviceId, "POST", `/v3/shares/${shareId}/mailbox`, "mail-e1"),
    } })).status).toBe(201);
    const epoch1Mail = await SELF.fetch(mailboxUrl, { headers: {
      "Attn-Share-Bundle": comment.bundleId,
      "Attn-Admission": await admission("read", comment.read, "GET", mailboxUrl),
    } });
    expect((await epoch1Mail.json() as { items: Array<{ epoch: number }> }).items).toMatchObject([{ seq: 2, epoch: 1 }]);
    const epoch1AckUrl = `${mailboxUrl}?through=2`;
    expect((await SELF.fetch(epoch1AckUrl, { method: "DELETE", headers: {
      "Attn-Device-Id": ownerDeviceId,
      "Attn-Owner-Signature": await ownerSignatureHeader({ method: "DELETE", url: epoch1AckUrl, privateKey: owner.privateKey }),
      "Attn-PoW": await pow(shareId, ownerDeviceId, "DELETE", `/v3/shares/${shareId}/mailbox`, "ack-e1"),
    } })).status).toBe(204);

    // Revocation is logically immediate and total: pointer, snapshot, mailbox,
    // R2 objects, and the already-connected visitor watch all die together.
    const revoke = await SELF.fetch(shareUrl, { method: "DELETE", headers: {
      "Attn-Device-Id": ownerDeviceId,
      "Attn-Owner-Signature": await ownerSignatureHeader({ method: "DELETE", url: shareUrl, privateKey: owner.privateKey }),
      "Attn-PoW": await pow(shareId, ownerDeviceId, "DELETE", `/v3/shares/${shareId}`, "revoke"),
    } });
    expect(revoke.status).toBe(204);
    expect(await watch.next()).toEqual({ type: "share_changed", epoch: 1, revision: 2 });
    expect(await watch.closed()).toBe(4001);
    for (const tier of tiers) expect((await resolve(tier)).status).toBe(404);
    expect((await SELF.fetch(`${shareUrl}/snapshots/readme`)).status).toBe(404);
    expect((await SELF.fetch(mailboxUrl)).status).toBe(404);
    expect((await env.RELAY_BLOBS.list({ prefix: shareArtifactPrefix(shareId) })).objects).toHaveLength(0);
  }, 30_000);
});
