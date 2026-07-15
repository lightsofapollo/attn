import { SELF, env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { base64UrlEncode, canonicalRequest } from "../../src/admission";
import { canonicalize, type CanonicalValue } from "../../src/canonical";
import type { Env } from "../../src/env";
import { deleteRoomBlobs, shareArtifactObjectKey, shareArtifactPrefix } from "../../src/r2";
import { generateEd25519Keypair, ownerSignatureHeader } from "../helpers/owner-sig";
import { createPowHeader, FIXED_POW_RAND, mintPowForTests } from "../helpers/pow";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

async function admission(scope: "read" | "write", key: Uint8Array, method: string, url: string, body?: string): Promise<string> {
  const canonical = await canonicalRequest(new Request(url, { method, body }), new URL(url).pathname);
  const imported = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", imported, canonical));
  return `v3.${scope}.${base64UrlEncode(mac)}`;
}

async function binaryOwnerSignature(method: string, url: string, body: Uint8Array, privateKey: CryptoKey): Promise<string> {
  const request = new Request(url, { method, body, headers: { "Content-Type": "application/octet-stream" } });
  const canonical = await canonicalRequest(request, new URL(url).pathname);
  return base64UrlEncode(new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, privateKey, canonical)));
}

function durableSubmission(input: {
  shareId: string;
  roomId: string;
  envelopeId: string;
  deviceId?: string;
  tier?: "comment" | "suggest";
  bundleId?: string;
  ciphertextByte?: number;
}) {
  const deviceId = input.deviceId ?? "writer";
  const participantId = `${deviceId}-participant`;
  const tier = input.tier ?? "comment";
  const opaqueEnvelope = (suffix: string) => ({
    v: 2 as const,
    roomId: input.roomId,
    envelopeId: `${input.envelopeId}-${suffix}`,
    authorId: participantId,
    deviceId,
    createdAt: 1_000,
    expiresAt: 10_000,
    kind: "event" as const,
    nonce: base64UrlEncode(new Uint8Array(24).fill(0x41)),
    ciphertext: base64UrlEncode(new Uint8Array(32).fill(input.ciphertextByte ?? 0x42)),
    ciphertextBytes: 32,
  });
  return {
    v: 3 as const,
    envelopeId: input.envelopeId,
    type: "review_submission" as const,
    shareId: input.shareId,
    epoch: 0,
    roomId: input.roomId,
    tier,
    ...(input.bundleId === undefined ? {} : { bundleId: input.bundleId }),
    deviceRegistration: {
      deviceId,
      participantId,
      publicSigningKey: base64UrlEncode(new Uint8Array(32).fill(0x43)),
      publicEncryptionKey: base64UrlEncode(new Uint8Array(32).fill(0x44)),
      client: "attn-browser" as const,
      kind: "reviewer" as const,
      grantTier: tier,
      grantSignature: base64UrlEncode(new Uint8Array(64).fill(0x45)),
      selfSignature: base64UrlEncode(new Uint8Array(64).fill(0x46)),
    },
    envelopes: [opaqueEnvelope("joined"), opaqueEnvelope("event")],
  };
}

async function createShare(label: string): Promise<{
  shareId: string;
  url: string;
  owner: Awaited<ReturnType<typeof generateEd25519Keypair>>;
  read: Uint8Array;
}> {
  const shareId = `${label}-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
  const url = `https://relay.example/v3/shares/${shareId}`;
  const owner = await generateEd25519Keypair();
  const read = crypto.getRandomValues(new Uint8Array(32));
  const write = crypto.getRandomValues(new Uint8Array(32));
  const body = JSON.stringify({
    v: 3,
    revision: 0,
    ownerSigningKey: base64UrlEncode(owner.publicKeyBytes),
    readAdmissionKey: base64UrlEncode(read),
    writeAdmissionKey: base64UrlEncode(write),
    snapshots: [],
    placeholders: [],
  });
  const created = await SELF.fetch(url, { method: "POST", body, headers: {
    "Content-Type": "application/json",
    "Attn-Owner-Signature": await ownerSignatureHeader({ method: "POST", url, body, privateKey: owner.privateKey }),
    "Attn-PoW": await createPowHeader(shareId, owner.publicKeyBytes, `/v3/shares/${shareId}`),
  } });
  expect(created.status).toBe(201);
  return { shareId, url, owner, read };
}

async function commitManifest(
  fixture: Awaited<ReturnType<typeof createShare>>,
  revision: number,
  snapshots: Array<Record<string, unknown>>,
): Promise<Response> {
  const body = JSON.stringify({
    v: 3,
    ownerSigningKey: base64UrlEncode(fixture.owner.publicKeyBytes),
    revision,
    snapshots,
  });
  return SELF.fetch(fixture.url, { method: "POST", body, headers: {
    "Content-Type": "application/json",
    "Attn-Owner-Signature": await ownerSignatureHeader({ method: "POST", url: fixture.url, body, privateKey: fixture.owner.privateKey }),
    "Attn-PoW": await createPowHeader(fixture.shareId, fixture.owner.publicKeyBytes, `/v3/shares/${fixture.shareId}`),
  } });
}

async function uploadSnapshot(
  fixture: Awaited<ReturnType<typeof createShare>>,
  fileId: string,
  snapshotId: string,
  ciphertext: Uint8Array,
  rand: string,
): Promise<Response> {
  const url = `${fixture.url}/snapshots/${fileId}/${snapshotId}`;
  return SELF.fetch(url, { method: "PUT", body: ciphertext, headers: {
    "Content-Type": "application/octet-stream",
    "Attn-Device-Id": fixture.shareId,
    "Attn-Owner-Signature": await binaryOwnerSignature("PUT", url, ciphertext, fixture.owner.privateKey),
    "Attn-PoW": await mintPowForTests({
      roomId: fixture.shareId,
      deviceId: fixture.shareId,
      method: "PUT",
      path: `/v3/shares/${fixture.shareId}/snapshots/${fileId}/${snapshotId}`,
      difficulty: 12,
      expiresAt: Date.now() + 300_000,
      rand,
    }),
  } });
}

describe("durable v3 shares", () => {
  it("selects exactly one tier bundle for generic, snapshot, and mailbox authorization", async () => {
    const shareId = `share-tier-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
    const url = `https://relay.example/v3/shares/${shareId}`;
    const owner = await generateEd25519Keypair();
    const tiers = [
      { tier: "view", seed: 0x11 },
      { tier: "comment", seed: 0x31 },
      { tier: "suggest", seed: 0x51 },
    ] as const;
    const bundles = tiers.map(({ tier, seed }) => ({
      bundleId: base64UrlEncode(new Uint8Array(16).fill(seed)),
      tier,
      readAdmissionKey: base64UrlEncode(new Uint8Array(32).fill(seed + 1)),
      ...(tier === "view" ? {} : { writeAdmissionKey: base64UrlEncode(new Uint8Array(32).fill(seed + 2)) }),
      sealedBundle: base64UrlEncode(new Uint8Array(80).fill(seed + 3)),
    }));
    if (bundles[0] === undefined || bundles[1] === undefined || bundles[2] === undefined) {
      throw new Error("expected all three tier bundles");
    }
    const body = JSON.stringify({
      v: 3,
      ownerSigningKey: base64UrlEncode(owner.publicKeyBytes),
      epoch: 0,
      revision: 0,
      currentRoomId: "tier-room",
      bundles,
      snapshots: [],
      placeholders: [],
    });
    const created = await SELF.fetch(url, { method: "POST", body, headers: {
      "Content-Type": "application/json",
      "Attn-Owner-Signature": await ownerSignatureHeader({ method: "POST", url, body, privateKey: owner.privateKey }),
      "Attn-PoW": await createPowHeader(shareId, owner.publicKeyBytes, `/v3/shares/${shareId}`),
    } });
    expect(created.status).toBe(201);
    const createdJson = await created.json() as Record<string, unknown>;
    expect(createdJson.revision).toBe(0);
    expect(createdJson.manifestDigest).toBe("T1PNoYwrqgwDVLtfmj7L5e0Sq02OEbqHPC8RFhICuUU");
    expect(createdJson).not.toHaveProperty("bundles");
    expect(createdJson).not.toHaveProperty("readAdmissionKey");
    expect(createdJson).not.toHaveProperty("writeAdmissionKey");

    expect((await SELF.fetch(url)).status).toBe(401);
    const viewReadKey = new Uint8Array(32).fill(0x12);
    const view = await SELF.fetch(url, { headers: {
      "Attn-Share-Bundle": bundles[0].bundleId,
      "Attn-Admission": await admission("read", viewReadKey, "GET", url),
    } });
    const viewBody = await view.json() as { bundle: Record<string, unknown> } & Record<string, unknown>;
    expect(view.status).toBe(200);
    expect(viewBody.bundle).toEqual({
      bundleId: bundles[0].bundleId,
      tier: "view",
      sealedBundle: bundles[0].sealedBundle,
    });
    expect(JSON.stringify(viewBody)).not.toContain(bundles[1].sealedBundle);
    expect(JSON.stringify(viewBody)).not.toContain(bundles[2].sealedBundle);

    const crossSelected = await SELF.fetch(url, { headers: {
      "Attn-Share-Bundle": bundles[0].bundleId,
      "Attn-Admission": await admission("read", new Uint8Array(32).fill(0x32), "GET", url),
    } });
    expect(crossSelected.status).toBe(401);

    const mailboxUrl = `${url}/mailbox`;
    const mailBody = JSON.stringify({
      epoch: 0,
      deviceId: "tier-writer",
      items: [durableSubmission({
        shareId,
        roomId: "tier-room",
        envelopeId: "tier-mail",
        deviceId: "tier-writer",
        tier: "comment",
        bundleId: bundles[1].bundleId,
      })],
    });
    const viewWrite = await SELF.fetch(mailboxUrl, { method: "POST", body: mailBody, headers: {
      "Content-Type": "application/json",
      "Attn-Share-Bundle": bundles[0].bundleId,
      "Attn-Admission": await admission("read", viewReadKey, "POST", mailboxUrl, mailBody),
    } });
    expect(viewWrite.status).toBe(403);

    const commentWriteKey = new Uint8Array(32).fill(0x33);
    const missingEpochBody = JSON.stringify({ deviceId: "tier-writer", items: [{ envelopeId: "missing-epoch", ciphertext: "opaque" }] });
    const missingEpoch = await SELF.fetch(mailboxUrl, { method: "POST", body: missingEpochBody, headers: {
      "Content-Type": "application/json",
      "Attn-Share-Bundle": bundles[1].bundleId,
      "Attn-Admission": await admission("write", commentWriteKey, "POST", mailboxUrl, missingEpochBody),
    } });
    expect(missingEpoch.status).toBe(400);
    expect((await missingEpoch.json() as { error: { code: string } }).error.code).toBe("ATTN_BODY_INVALID");

    const mailPow = await mintPowForTests({ roomId: shareId, deviceId: "tier-writer", method: "POST", path: `/v3/shares/${shareId}/mailbox`, difficulty: 12, expiresAt: Date.now() + 300_000, rand: `${FIXED_POW_RAND}tm` });
    const queued = await SELF.fetch(mailboxUrl, { method: "POST", body: mailBody, headers: {
      "Content-Type": "application/json",
      "Attn-Share-Bundle": bundles[1].bundleId,
      "Attn-Admission": await admission("write", commentWriteKey, "POST", mailboxUrl, mailBody),
      "Attn-PoW": mailPow,
    } });
    expect(queued.status).toBe(201);
    expect((await queued.json() as { bundle: { bundleId: string } }).bundle.bundleId).toBe(bundles[1].bundleId);

    const suggestMailbox = await SELF.fetch(mailboxUrl, { headers: {
      "Attn-Share-Bundle": bundles[2].bundleId,
      "Attn-Admission": await admission("read", new Uint8Array(32).fill(0x52), "GET", mailboxUrl),
    } });
    expect((await suggestMailbox.json() as { items: unknown[] }).items).toEqual([]);
    const commentMailbox = await SELF.fetch(mailboxUrl, { headers: {
      "Attn-Share-Bundle": bundles[1].bundleId,
      "Attn-Admission": await admission("read", new Uint8Array(32).fill(0x32), "GET", mailboxUrl),
    } });
    const commentItems = (await commentMailbox.json() as { items: Array<{ bundleId: string; tier: string; epoch: number }> }).items;
    expect(commentItems).toHaveLength(1);
    expect(commentItems[0]).toMatchObject({ bundleId: bundles[1].bundleId, tier: "comment", epoch: 0 });

    const staleBody = JSON.stringify({ epoch: 1, deviceId: "tier-writer", items: [{ envelopeId: "stale-mail", ciphertext: "opaque" }] });
    const stale = await SELF.fetch(mailboxUrl, { method: "POST", body: staleBody, headers: {
      "Content-Type": "application/json",
      "Attn-Share-Bundle": bundles[1].bundleId,
      "Attn-Admission": await admission("write", commentWriteKey, "POST", mailboxUrl, staleBody),
    } });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({
      currentEpoch: 0,
      error: { code: "ATTN_SHARE_EPOCH_STALE", currentEpoch: 0 },
    });

    const routingBody = JSON.stringify({
      v: 3,
      ownerSigningKey: base64UrlEncode(owner.publicKeyBytes),
      currentRoomId: "different-room",
    });
    const routingChange = await SELF.fetch(url, { method: "POST", body: routingBody, headers: {
      "Content-Type": "application/json",
      "Attn-Owner-Signature": await ownerSignatureHeader({ method: "POST", url, body: routingBody, privateKey: owner.privateKey }),
    } });
    expect(routingChange.status).toBe(409);
    expect((await routingChange.json() as { error: { code: string } }).error.code).toBe("ATTN_SHARE_MAIL_PENDING");

    const epochBody = JSON.stringify({
      v: 3,
      ownerSigningKey: base64UrlEncode(owner.publicKeyBytes),
      epoch: 1,
      bundles: bundles.map(bundle => ({ ...bundle, sealedBundle: base64UrlEncode(new Uint8Array(81).fill(0x77)) })),
    });
    const epochAdvance = await SELF.fetch(url, { method: "POST", body: epochBody, headers: {
      "Content-Type": "application/json",
      "Attn-Owner-Signature": await ownerSignatureHeader({ method: "POST", url, body: epochBody, privateKey: owner.privateKey }),
    } });
    expect(epochAdvance.status).toBe(409);
    expect((await epochAdvance.json() as { error: { code: string } }).error.code).toBe("ATTN_SHARE_MAIL_PENDING");

    // Snapshot uploads stage without touching the public projection, so they
    // are allowed even while mail is pending — joiners cannot observe them.
    const stagedSnapshotUrl = `${url}/snapshots/readme/staged-while-pending`;
    const stagedCiphertext = new Uint8Array([9, 9, 9]);
    const stagedPow = await mintPowForTests({ roomId: shareId, deviceId: shareId, method: "PUT", path: `/v3/shares/${shareId}/snapshots/readme/staged-while-pending`, difficulty: 12, expiresAt: Date.now() + 300_000, rand: `${FIXED_POW_RAND}tp` });
    const stagedSnapshot = await SELF.fetch(stagedSnapshotUrl, { method: "PUT", body: stagedCiphertext, headers: {
      "Content-Type": "application/octet-stream",
      "Attn-Device-Id": shareId,
      "Attn-Owner-Signature": await binaryOwnerSignature("PUT", stagedSnapshotUrl, stagedCiphertext, owner.privateKey),
      "Attn-PoW": stagedPow,
    } });
    expect(stagedSnapshot.status).toBe(201);
    const removedDeleteUrl = `${url}/snapshots/readme`;
    const removedDelete = await SELF.fetch(removedDeleteUrl, { method: "DELETE", headers: {
      "Attn-Device-Id": shareId,
      "Attn-Owner-Signature": await ownerSignatureHeader({ method: "DELETE", url: removedDeleteUrl, privateKey: owner.privateKey }),
    } });
    expect(removedDelete.status).toBe(405);
    const unchanged = await SELF.fetch(url, { headers: {
      "Attn-Share-Bundle": bundles[0].bundleId,
      "Attn-Admission": await admission("read", viewReadKey, "GET", url),
    } });
    expect(await unchanged.json()).toMatchObject({
      revision: 0,
      manifestDigest: "T1PNoYwrqgwDVLtfmj7L5e0Sq02OEbqHPC8RFhICuUU",
      updatedAt: createdJson.updatedAt,
      expiresAt: createdJson.expiresAt,
      snapshots: [],
    });

    const drainUrl = `${mailboxUrl}?through=1`;
    const drainPow = await mintPowForTests({ roomId: shareId, deviceId: shareId, method: "DELETE", path: `/v3/shares/${shareId}/mailbox`, difficulty: 12, expiresAt: Date.now() + 300_000, rand: `${FIXED_POW_RAND}td` });
    expect((await SELF.fetch(drainUrl, { method: "DELETE", headers: {
      "Attn-Device-Id": shareId,
      "Attn-Owner-Signature": await ownerSignatureHeader({ method: "DELETE", url: drainUrl, privateKey: owner.privateKey }),
      "Attn-PoW": drainPow,
    } })).status).toBe(204);

    const snapshotId = "tier-snapshot";
    const snapshotUrl = `${url}/snapshots/readme/${snapshotId}`;
    const ciphertext = new Uint8Array([4, 2, 4, 2]);
    const snapshotPow = await mintPowForTests({ roomId: shareId, deviceId: shareId, method: "PUT", path: `/v3/shares/${shareId}/snapshots/readme/${snapshotId}`, difficulty: 12, expiresAt: Date.now() + 300_000, rand: `${FIXED_POW_RAND}ts` });
    const snapshotUpload = await SELF.fetch(snapshotUrl, { method: "PUT", body: ciphertext, headers: {
      "Content-Type": "application/octet-stream",
      "Attn-Device-Id": shareId,
      "Attn-Owner-Signature": await binaryOwnerSignature("PUT", snapshotUrl, ciphertext, owner.privateKey),
      "Attn-PoW": snapshotPow,
    } });
    expect(snapshotUpload.status).toBe(200);
    const snapshotRef = await snapshotUpload.json() as Record<string, unknown>;
    const expectedManifestDigest = base64UrlEncode(new Uint8Array(await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(canonicalize([snapshotRef as CanonicalValue])),
    )));
    // Still staged: the public record must not have moved.
    const revised = await SELF.fetch(url, { headers: {
      "Attn-Share-Bundle": bundles[0].bundleId,
      "Attn-Admission": await admission("read", viewReadKey, "GET", url),
    } });
    const revisedJson = await revised.json() as { revision: number; manifestDigest: string };
    expect(revisedJson).toMatchObject({ revision: 0, manifestDigest: "T1PNoYwrqgwDVLtfmj7L5e0Sq02OEbqHPC8RFhICuUU" });

    const synchronizedBundles = bundles.map(bundle => ({
      ...bundle,
      sealedBundle: base64UrlEncode(new Uint8Array(82).fill(0x66)),
    }));
    const syncBody = JSON.stringify({
      v: 3,
      ownerSigningKey: base64UrlEncode(owner.publicKeyBytes),
      revision: 1,
      bundles: synchronizedBundles,
      snapshots: [snapshotRef],
    });
    const ownerId = base64UrlEncode(new Uint8Array(await crypto.subtle.digest("SHA-256", owner.publicKeyBytes)));
    const syncPow = await mintPowForTests({ roomId: shareId, deviceId: ownerId, method: "POST", path: `/v3/shares/${shareId}`, difficulty: 12, expiresAt: Date.now() + 300_000, rand: `${FIXED_POW_RAND}tu` });
    const synchronized = await SELF.fetch(url, { method: "POST", body: syncBody, headers: {
      "Content-Type": "application/json",
      "Attn-Owner-Signature": await ownerSignatureHeader({ method: "POST", url, body: syncBody, privateKey: owner.privateKey }),
      "Attn-PoW": syncPow,
    } });
    expect(synchronized.status).toBe(200);
    expect(await synchronized.json()).toMatchObject({ revision: 1, manifestDigest: expectedManifestDigest });
    const snapshotReadUrl = `${url}/snapshots/readme`;
    const snapshotRead = await SELF.fetch(snapshotReadUrl, { headers: {
      "Attn-Share-Bundle": bundles[0].bundleId,
      "Attn-Admission": await admission("read", viewReadKey, "GET", snapshotReadUrl),
    } });
    expect(snapshotRead.status).toBe(200);
    expect(snapshotRead.headers.get("Attn-Share-Bundle")).toBe(bundles[0].bundleId);
    expect(snapshotRead.headers.get("Attn-Share-Tier")).toBe("view");
    expect(snapshotRead.headers.get("Attn-Sealed-Bundle")).toBe(synchronizedBundles[0]!.sealedBundle);
    expect(snapshotRead.headers.get("Attn-Sealed-Bundle")).not.toBe(bundles[1].sealedBundle);

    // Touch/renewal upsert with an EXPLICIT empty bundles array keeps the
    // stored bundles, exactly like omitting the field. Rejecting [] turned
    // every no-op owner renewal into a silent 400 and starved joiners of
    // their share_changed wake-up.
    const touchBody = JSON.stringify({
      v: 3,
      ownerSigningKey: base64UrlEncode(owner.publicKeyBytes),
      revision: 1,
      bundles: [],
    });
    const touchPow = await mintPowForTests({ roomId: shareId, deviceId: ownerId, method: "POST", path: `/v3/shares/${shareId}`, difficulty: 12, expiresAt: Date.now() + 300_000, rand: `${FIXED_POW_RAND}tt` });
    const touched = await SELF.fetch(url, { method: "POST", body: touchBody, headers: {
      "Content-Type": "application/json",
      "Attn-Owner-Signature": await ownerSignatureHeader({ method: "POST", url, body: touchBody, privateKey: owner.privateKey }),
      "Attn-PoW": touchPow,
    } });
    expect(touched.status).toBe(200);
    expect(await touched.json()).toMatchObject({ revision: 1, manifestDigest: expectedManifestDigest });
    const stillSelected = await SELF.fetch(url, { headers: {
      "Attn-Share-Bundle": bundles[0].bundleId,
      "Attn-Admission": await admission("read", viewReadKey, "GET", url),
    } });
    expect((await stillSelected.json() as { bundle: { sealedBundle: string } }).bundle.sealedBundle)
      .toBe(synchronizedBundles[0]!.sealedBundle);
  });

  it("pins only the latest owner-uploaded snapshot per file and removes all ciphertext on revoke", async () => {
    const fixture = await createShare("share-artifacts");
    const forgedManifestBody = JSON.stringify({
      v: 3,
      ownerSigningKey: base64UrlEncode(fixture.owner.publicKeyBytes),
      snapshots: [{
        fileId: "readme",
        snapshotId: "caller-selected",
        ciphertextBytes: 1,
        ciphertextSha256: base64UrlEncode(new Uint8Array(32)),
        uploadedAt: Date.now(),
        blobKey: "shares_v1/another-share/artifacts/stolen",
      }],
    });
    const forgedManifest = await SELF.fetch(fixture.url, { method: "POST", body: forgedManifestBody, headers: {
      "Content-Type": "application/json",
      "Attn-Owner-Signature": await ownerSignatureHeader({ method: "POST", url: fixture.url, body: forgedManifestBody, privateKey: fixture.owner.privateKey }),
      "Attn-PoW": await createPowHeader(fixture.shareId, fixture.owner.publicKeyBytes, `/v3/shares/${fixture.shareId}`),
    } });
    expect(forgedManifest.status).toBe(409);
    expect((await forgedManifest.json() as { error: { code: string } }).error.code).toBe("ATTN_SHARE_MANIFEST_MANAGED");

    const first = new TextEncoder().encode("opaque snapshot ciphertext v1");
    const firstUpload = await uploadSnapshot(fixture, "readme", "snapshot-one", first, `${FIXED_POW_RAND}p1`);
    expect(firstUpload.status).toBe(201);
    const firstRef = await firstUpload.json() as Record<string, unknown>;
    expect(firstRef).toMatchObject({ fileId: "readme", snapshotId: "snapshot-one", ciphertextBytes: first.byteLength });
    expect(firstRef).not.toHaveProperty("artifactId");
    expect(firstRef).not.toHaveProperty("blobKey");
    expect(firstRef).not.toHaveProperty("stagedAt");
    expect(firstRef).not.toHaveProperty("shareId");

    const prefix = shareArtifactPrefix(fixture.shareId);
    expect((await env.RELAY_BLOBS.list({ prefix })).objects).toHaveLength(1);
    // The existing room cleanup implementation can sweep every room layout
    // without ever reaching the separately encoded durable-share domain.
    await deleteRoomBlobs(env, fixture.shareId);
    expect((await env.RELAY_BLOBS.list({ prefix })).objects).toHaveLength(1);

    // Staged uploads are invisible to readers until an owner commit.
    const snapshotUrl = `${fixture.url}/snapshots/readme`;
    expect((await SELF.fetch(snapshotUrl)).status).toBe(401);
    const beforeCommit = await SELF.fetch(snapshotUrl, {
      headers: { "Attn-Admission": await admission("read", fixture.read, "GET", snapshotUrl) },
    });
    expect(beforeCommit.status).toBe(404);
    expect((await commitManifest(fixture, 1, [firstRef])).status).toBe(200);
    const downloaded = await SELF.fetch(snapshotUrl, {
      headers: { "Attn-Admission": await admission("read", fixture.read, "GET", snapshotUrl) },
    });
    expect(downloaded.status).toBe(200);
    expect(new Uint8Array(await downloaded.arrayBuffer())).toEqual(first);

    const second = new TextEncoder().encode("v2");
    const replaced = await uploadSnapshot(fixture, "readme", "snapshot-two", second, `${FIXED_POW_RAND}p2`);
    expect(replaced.status).toBe(200);
    const secondRef = await replaced.json() as Record<string, unknown>;
    // Live v1 and staged v2 coexist until the commit supersedes v1.
    expect((await env.RELAY_BLOBS.list({ prefix })).objects).toHaveLength(2);
    expect((await commitManifest(fixture, 2, [secondRef])).status).toBe(200);
    expect((await env.RELAY_BLOBS.list({ prefix })).objects).toHaveLength(1);
    const shareRead = await SELF.fetch(fixture.url, {
      headers: { "Attn-Admission": await admission("read", fixture.read, "GET", fixture.url) },
    });
    const manifest = (await shareRead.json() as { snapshots: Array<Record<string, unknown>> }).snapshots;
    expect(manifest).toHaveLength(1);
    expect(manifest[0]).toMatchObject({ fileId: "readme", snapshotId: "snapshot-two", ciphertextBytes: 2 });
    expect(manifest[0]).not.toHaveProperty("artifactId");

    // Removal is a commit without the file; the standalone DELETE is gone so
    // the manifest can never move ahead of its sealed bundles.
    const deletedSnapshot = await SELF.fetch(snapshotUrl, { method: "DELETE", headers: {
      "Attn-Device-Id": fixture.shareId,
      "Attn-Owner-Signature": await ownerSignatureHeader({ method: "DELETE", url: snapshotUrl, privateKey: fixture.owner.privateKey }),
    } });
    expect(deletedSnapshot.status).toBe(405);
    expect((await commitManifest(fixture, 3, [])).status).toBe(200);
    expect((await env.RELAY_BLOBS.list({ prefix })).objects).toHaveLength(0);
    const removedRead = await SELF.fetch(fixture.url, {
      headers: { "Attn-Admission": await admission("read", fixture.read, "GET", fixture.url) },
    });
    expect(await removedRead.json()).toMatchObject({ revision: 3, snapshots: [] });

    const deletePow = await mintPowForTests({
      roomId: fixture.shareId,
      deviceId: fixture.shareId,
      method: "DELETE",
      path: `/v3/shares/${fixture.shareId}`,
      difficulty: 12,
      expiresAt: Date.now() + 300_000,
      rand: `${FIXED_POW_RAND}p3`,
    });
    const revoked = await SELF.fetch(fixture.url, { method: "DELETE", headers: {
      "Attn-Device-Id": fixture.shareId,
      "Attn-Owner-Signature": await ownerSignatureHeader({ method: "DELETE", url: fixture.url, privateKey: fixture.owner.privateKey }),
      "Attn-PoW": deletePow,
    } });
    expect(revoked.status).toBe(204);
    expect((await env.RELAY_BLOBS.list({ prefix })).objects).toHaveLength(0);
    expect((await SELF.fetch(snapshotUrl, {
      headers: { "Attn-Admission": await admission("read", fixture.read, "GET", snapshotUrl) },
    })).status).toBe(404);
  });

  it("cannot renew an expired share before its alarm and deletes the snapshot prefix", async () => {
    const fixture = await createShare("share-artifact-expiry");
    expect((await uploadSnapshot(
      fixture,
      "notes",
      "snapshot-expired",
      new Uint8Array([1, 2, 3, 4]),
      `${FIXED_POW_RAND}e1`,
    )).status).toBe(201);
    const stub = env.RELAY_SHARES.get(env.RELAY_SHARES.idFromName(fixture.shareId));
    await runInDurableObject(stub, async (_instance, state) => {
      const record = await state.storage.get<Record<string, unknown>>("share:record");
      expect(record).toBeDefined();
      await state.storage.put("share:record", { ...record, expiresAt: Date.now() - 1 });
    });
    const touchBody = JSON.stringify({ v: 3, ownerSigningKey: base64UrlEncode(fixture.owner.publicKeyBytes) });
    const renewal = await SELF.fetch(fixture.url, { method: "POST", body: touchBody, headers: {
      "Content-Type": "application/json",
      "Attn-Owner-Signature": await ownerSignatureHeader({
        method: "POST", url: fixture.url, body: touchBody, privateKey: fixture.owner.privateKey,
      }),
      "Attn-PoW": await createPowHeader(
        fixture.shareId,
        fixture.owner.publicKeyBytes,
        `/v3/shares/${fixture.shareId}`,
      ),
    } });
    expect(renewal.status).toBe(404);
    expect((await env.RELAY_BLOBS.list({ prefix: shareArtifactPrefix(fixture.shareId) })).objects).toHaveLength(0);
    expect((await SELF.fetch(fixture.url, {
      headers: { "Attn-Admission": await admission("read", fixture.read, "GET", fixture.url) },
    })).status).toBe(404);
  });

  it("resumes share-prefix cleanup from a durable tombstone after an interrupted revoke or expiry", async () => {
    const fixture = await createShare("share-artifact-retry");
    expect((await uploadSnapshot(
      fixture,
      "retry-file",
      "snapshot-retry",
      new Uint8Array([8, 6, 7, 5, 3, 0, 9]),
      `${FIXED_POW_RAND}r1`,
    )).status).toBe(201);
    const prefix = shareArtifactPrefix(fixture.shareId);
    const stub = env.RELAY_SHARES.get(env.RELAY_SHARES.idFromName(fixture.shareId));
    // This is the durable state left if an invocation dies after making the
    // share logically dead but before its R2 delete completes.
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.deleteAll();
      await state.storage.put("share:cleanup", {
        shareId: fixture.shareId,
        reason: "expired",
        startedAt: Date.now() - 1_000,
      });
    });
    expect((await SELF.fetch(fixture.url, {
      headers: { "Attn-Admission": await admission("read", fixture.read, "GET", fixture.url) },
    })).status).toBe(404);
    expect((await env.RELAY_BLOBS.list({ prefix })).objects).toHaveLength(1);
    await runInDurableObject(stub, async (instance) => instance.alarm());
    expect((await env.RELAY_BLOBS.list({ prefix })).objects).toHaveLength(0);
  });

  it("recovers an intent-first artifact left by a crash before manifest commit", async () => {
    const fixture = await createShare("share-artifact-intent");
    const artifactId = crypto.randomUUID();
    const objectKey = shareArtifactObjectKey(fixture.shareId, artifactId);
    await env.RELAY_BLOBS.put(objectKey, new Uint8Array([9, 9, 9]));
    const stub = env.RELAY_SHARES.get(env.RELAY_SHARES.idFromName(fixture.shareId));
    await runInDurableObject(stub, async (instance, state) => {
      await state.storage.put(`artifact:delete:${artifactId}`, fixture.shareId);
      await instance.alarm();
    });
    expect(await env.RELAY_BLOBS.head(objectKey)).toBeNull();
  });

  it("recovers snapshot-delete ciphertext cleanup after the manifest transaction committed", async () => {
    const fixture = await createShare("share-artifact-delete-recovery");
    const uploaded = await uploadSnapshot(
      fixture,
      "removed-file",
      "removed-snapshot",
      new Uint8Array([2, 7, 1, 8]),
      `${FIXED_POW_RAND}delete-recovery`,
    );
    expect(uploaded.status).toBe(201);
    const uploadedRef = await uploaded.json() as Record<string, unknown>;
    expect((await commitManifest(fixture, 1, [uploadedRef])).status).toBe(200);
    const stub = env.RELAY_SHARES.get(env.RELAY_SHARES.idFromName(fixture.shareId));
    let objectKey = "";
    await runInDurableObject(stub, async (_instance, state) => {
      const record = await state.storage.get<{
        revision: number;
        snapshots: Array<{ artifactId: string }>;
      } & Record<string, unknown>>("share:record");
      const artifactId = record?.snapshots[0]?.artifactId;
      if (record === undefined || artifactId === undefined) throw new Error("missing stored snapshot");
      objectKey = shareArtifactObjectKey(fixture.shareId, artifactId);
      await state.storage.transaction(async transaction => {
        await transaction.put("share:record", { ...record, snapshots: [], revision: record.revision + 1 });
        await transaction.put(`artifact:delete:${artifactId}`, fixture.shareId);
        await transaction.setAlarm(Date.now());
      });
    });
    expect(await env.RELAY_BLOBS.head(objectKey)).not.toBeNull();
    const manifest = await SELF.fetch(fixture.url, {
      headers: { "Attn-Admission": await admission("read", fixture.read, "GET", fixture.url) },
    });
    expect(await manifest.json()).toMatchObject({ revision: 2, snapshots: [] });
    await runInDurableObject(stub, async instance => instance.alarm());
    expect(await env.RELAY_BLOBS.head(objectKey)).toBeNull();
  });

  it("rejects a lengthless oversized stream before owner authentication buffers it", async () => {
    const fixture = await createShare("share-artifact-stream-bound");
    const url = `${fixture.url}/snapshots/readme/oversized`;
    const stub = env.RELAY_SHARES.get(env.RELAY_SHARES.idFromName(fixture.shareId));
    const status = await runInDurableObject(stub, async instance => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(5 * 1024 * 1024));
          controller.enqueue(new Uint8Array([1]));
          controller.close();
        },
      });
      const response = await instance.fetch(new Request(url, {
        method: "PUT",
        body,
        headers: { "Content-Type": "application/octet-stream" },
      }));
      return response.status;
    });
    expect(status).toBe(413);
    expect((await env.RELAY_BLOBS.list({ prefix: shareArtifactPrefix(fixture.shareId) })).objects).toHaveLength(0);
  });

  it("creates, reads, renews, queues ordered mailbox items, and revokes", async () => {
    const shareId = `share-${Date.now().toString(36)}`;
    const url = `https://relay.example/v3/shares/${shareId}`;
    const owner = await generateEd25519Keypair();
    const read = new Uint8Array(32).fill(0x31);
    const write = new Uint8Array(32).fill(0x72);
    const ownerId = base64UrlEncode(new Uint8Array(await crypto.subtle.digest("SHA-256", owner.publicKeyBytes)));
    const body = JSON.stringify({
      v: 3, revision: 0, ownerSigningKey: base64UrlEncode(owner.publicKeyBytes),
      readAdmissionKey: base64UrlEncode(read), writeAdmissionKey: base64UrlEncode(write),
      currentRoomId: "legacy-room", snapshots: [], placeholders: [{ fileId: "future-file" }],
    });
    const created = await SELF.fetch(url, {
      method: "POST", body,
      headers: {
        "Content-Type": "application/json",
        "Attn-Owner-Signature": await ownerSignatureHeader({ method: "POST", url, body, privateKey: owner.privateKey }),
        "Attn-PoW": await createPowHeader(shareId, owner.publicKeyBytes, `/v3/shares/${shareId}`),
      },
    });
    expect(created.status).toBe(201);
    const initial = await created.json() as Record<string, unknown> & { expiresAt: number; placeholders: unknown[] };
    expect(initial.expiresAt).toBeGreaterThan(Date.now() + 89 * 24 * 60 * 60 * 1000);
    expect(initial.placeholders).toHaveLength(1);
    expect(initial).not.toHaveProperty("readAdmissionKey");
    expect(initial).not.toHaveProperty("writeAdmissionKey");

    const touchBody = JSON.stringify({ v: 3, ownerSigningKey: base64UrlEncode(owner.publicKeyBytes) });
    const touchPow = await mintPowForTests({ roomId: shareId, deviceId: ownerId, method: "POST", path: `/v3/shares/${shareId}`, difficulty: 12, expiresAt: Date.now() + 300_000, rand: `${FIXED_POW_RAND}t` });
    const touched = await SELF.fetch(url, { method: "POST", body: touchBody, headers: {
      "Content-Type": "application/json",
      "Attn-Owner-Signature": await ownerSignatureHeader({ method: "POST", url, body: touchBody, privateKey: owner.privateKey }),
      "Attn-PoW": touchPow,
    } });
    expect(touched.status).toBe(200);
    expect((await touched.json() as { expiresAt: number }).expiresAt).toBeGreaterThanOrEqual(initial.expiresAt);

    const attacker = await generateEd25519Keypair();
    const unauthorized = await SELF.fetch(url, { method: "POST", body: touchBody, headers: {
      "Content-Type": "application/json",
      "Attn-Owner-Signature": await ownerSignatureHeader({ method: "POST", url, body: touchBody, privateKey: attacker.privateKey }),
    } });
    expect(unauthorized.status).toBe(403);
    expect((await unauthorized.json() as { error: { code: string } }).error.code).toBe("ATTN_OWNER_SIG_INVALID");

    const readResponse = await SELF.fetch(url, { headers: { "Attn-Admission": await admission("read", read, "GET", url) } });
    expect(readResponse.status).toBe(200);
    const publicRecord = await readResponse.json() as Record<string, unknown>;
    expect(publicRecord).not.toHaveProperty("readAdmissionKey");
    expect(publicRecord).not.toHaveProperty("writeAdmissionKey");

    const mailboxUrl = `${url}/mailbox`;
    const mailboxBody = JSON.stringify({ deviceId: "writer", items: [
      durableSubmission({ shareId, roomId: "legacy-room", envelopeId: "mail-one" }),
      durableSubmission({ shareId, roomId: "legacy-room", envelopeId: "mail-two" }),
    ] });
    const mailboxPow = await mintPowForTests({ roomId: shareId, deviceId: "writer", method: "POST", path: `/v3/shares/${shareId}/mailbox`, difficulty: 12, expiresAt: Date.now() + 300_000, rand: FIXED_POW_RAND });
    const readOnWrite = await SELF.fetch(mailboxUrl, {
      method: "POST", body: mailboxBody,
      headers: { "Content-Type": "application/json", "Attn-Admission": await admission("read", read, "POST", mailboxUrl, mailboxBody), "Attn-PoW": mailboxPow },
    });
    expect(readOnWrite.status).toBe(403);
    const mailboxPow2 = await mintPowForTests({ roomId: shareId, deviceId: "writer", method: "POST", path: `/v3/shares/${shareId}/mailbox`, difficulty: 12, expiresAt: Date.now() + 300_000, rand: `${FIXED_POW_RAND}2` });
    const queued = await SELF.fetch(mailboxUrl, {
      method: "POST", body: mailboxBody,
      headers: { "Content-Type": "application/json", "Attn-Admission": await admission("write", write, "POST", mailboxUrl, mailboxBody), "Attn-PoW": mailboxPow2 },
    });
    expect(queued.status).toBe(201);
    const retryPow = await mintPowForTests({ roomId: shareId, deviceId: "writer", method: "POST", path: `/v3/shares/${shareId}/mailbox`, difficulty: 12, expiresAt: Date.now() + 300_000, rand: `${FIXED_POW_RAND}3` });
    const retry = await SELF.fetch(mailboxUrl, {
      method: "POST", body: mailboxBody,
      headers: { "Content-Type": "application/json", "Attn-Admission": await admission("write", write, "POST", mailboxUrl, mailboxBody), "Attn-PoW": retryPow },
    });
    expect(retry.status).toBe(200);
    expect((await retry.json() as { accepted: number }).accepted).toBe(0);
    const drained = await SELF.fetch(mailboxUrl, { headers: { "Attn-Admission": await admission("read", read, "GET", mailboxUrl) } });
    const items = (await drained.json() as { items: Array<{ seq: number }> }).items;
    expect(items.map(item => item.seq)).toEqual([1, 2]);

    const drainUrl = `${mailboxUrl}?through=1`;
    const drainPow = await mintPowForTests({ roomId: shareId, deviceId: shareId, method: "DELETE", path: `/v3/shares/${shareId}/mailbox`, difficulty: 12, expiresAt: Date.now() + 300_000, rand: `${FIXED_POW_RAND}4` });
    const acked = await SELF.fetch(drainUrl, { method: "DELETE", headers: {
      "Attn-Device-Id": shareId,
      "Attn-Owner-Signature": await ownerSignatureHeader({ method: "DELETE", url: drainUrl, privateKey: owner.privateKey }),
      "Attn-PoW": drainPow,
    } });
    expect(acked.status).toBe(204);
    const afterAck = await SELF.fetch(mailboxUrl, { headers: { "Attn-Admission": await admission("read", read, "GET", mailboxUrl) } });
    expect(((await afterAck.json() as { items: Array<{ seq: number }> }).items).map(item => item.seq)).toEqual([2]);

    const retryAfterAckPow = await mintPowForTests({ roomId: shareId, deviceId: "writer", method: "POST", path: `/v3/shares/${shareId}/mailbox`, difficulty: 12, expiresAt: Date.now() + 300_000, rand: `${FIXED_POW_RAND}5` });
    const retryAfterAck = await SELF.fetch(mailboxUrl, { method: "POST", body: mailboxBody, headers: {
      "Content-Type": "application/json",
      "Attn-Admission": await admission("write", write, "POST", mailboxUrl, mailboxBody),
      "Attn-PoW": retryAfterAckPow,
    } });
    const retryResult = await retryAfterAck.json() as { accepted: number; results: Array<{ envelopeId: string; seq: number; status: string }> };
    expect(retryAfterAck.status).toBe(200);
    expect(retryResult.accepted).toBe(0);
    expect(retryResult.results).toContainEqual({ envelopeId: "mail-one", seq: 1, status: "duplicate" });

    const conflictBody = JSON.stringify({ deviceId: "writer", items: [durableSubmission({
      shareId,
      roomId: "legacy-room",
      envelopeId: "mail-one",
      ciphertextByte: 0x63,
    })] });
    const conflict = await SELF.fetch(mailboxUrl, { method: "POST", body: conflictBody, headers: {
      "Content-Type": "application/json",
      "Attn-Admission": await admission("write", write, "POST", mailboxUrl, conflictBody),
    } });
    expect(conflict.status).toBe(409);
    expect((await conflict.json() as { error: { code: string } }).error.code).toBe("ATTN_ENVELOPE_ID_CONFLICT");

    for (let batch = 0; batch < 5; batch += 1) {
      const items = Array.from({ length: 26 }, (_, offset) => ({
        ...durableSubmission({
          shareId,
          roomId: "legacy-room",
          envelopeId: `bulk-${batch}-${offset}`,
          ciphertextByte: 0x50 + batch,
        }),
      }));
      const bulkBody = JSON.stringify({ deviceId: "writer", items });
      const bulkPow = await mintPowForTests({ roomId: shareId, deviceId: "writer", method: "POST", path: `/v3/shares/${shareId}/mailbox`, difficulty: 12, expiresAt: Date.now() + 300_000, rand: `${FIXED_POW_RAND}b${batch}` });
      const bulk = await SELF.fetch(mailboxUrl, { method: "POST", body: bulkBody, headers: {
        "Content-Type": "application/json",
        "Attn-Admission": await admission("write", write, "POST", mailboxUrl, bulkBody),
        "Attn-PoW": bulkPow,
      } });
      expect(bulk.status).toBe(201);
    }
    const firstPageUrl = `${mailboxUrl}?after=0&limit=100`;
    const firstPage = await SELF.fetch(firstPageUrl, { headers: { "Attn-Admission": await admission("read", read, "GET", firstPageUrl) } });
    const pageOne = await firstPage.json() as { items: Array<{ seq: number }>; nextAfter: number };
    expect(pageOne.items).toHaveLength(100);
    const secondPageUrl = `${mailboxUrl}?after=${pageOne.nextAfter}&limit=100`;
    const secondPage = await SELF.fetch(secondPageUrl, { headers: { "Attn-Admission": await admission("read", read, "GET", secondPageUrl) } });
    expect((await secondPage.json() as { items: unknown[] }).items).toHaveLength(31);

    const bulkDrainUrl = `${mailboxUrl}?through=132`;
    const bulkDrainPow = await mintPowForTests({ roomId: shareId, deviceId: shareId, method: "DELETE", path: `/v3/shares/${shareId}/mailbox`, difficulty: 12, expiresAt: Date.now() + 300_000, rand: `${FIXED_POW_RAND}z` });
    const bulkAck = await SELF.fetch(bulkDrainUrl, { method: "DELETE", headers: {
      "Attn-Device-Id": shareId,
      "Attn-Owner-Signature": await ownerSignatureHeader({ method: "DELETE", url: bulkDrainUrl, privateKey: owner.privateKey }),
      "Attn-PoW": bulkDrainPow,
    } });
    expect(bulkAck.status).toBe(204);
    const emptyMailbox = await SELF.fetch(mailboxUrl, { headers: { "Attn-Admission": await admission("read", read, "GET", mailboxUrl) } });
    expect((await emptyMailbox.json() as { items: unknown[] }).items).toEqual([]);

    const deletePow = await mintPowForTests({ roomId: shareId, deviceId: shareId, method: "DELETE", path: `/v3/shares/${shareId}`, difficulty: 12, expiresAt: Date.now() + 300_000, rand: `${FIXED_POW_RAND}x` });
    const revoked = await SELF.fetch(url, { method: "DELETE", headers: {
      "Attn-Device-Id": shareId,
      "Attn-Owner-Signature": await ownerSignatureHeader({ method: "DELETE", url, privateKey: owner.privateKey }),
      "Attn-PoW": deletePow,
    } });
    expect(revoked.status).toBe(204);
    expect((await SELF.fetch(url, { headers: { "Attn-Admission": await admission("read", read, "GET", url) } })).status).toBe(404);
    expect(ownerId).not.toBe("");
  });

  it("allows browser snapshot PUT preflight before Durable Object dispatch", async () => {
    const response = await SELF.fetch("https://relay.example/v3/shares/preflight-share/snapshots/readme/snapshot", {
      method: "OPTIONS",
      headers: {
        Origin: "https://attn.sh",
        "Access-Control-Request-Method": "PUT",
        "Access-Control-Request-Headers": "Attn-Admission, Attn-PoW, Attn-Owner-Signature, Attn-Device-Id, Content-Type",
      },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://attn.sh");
    expect(response.headers.get("Access-Control-Allow-Headers")).toContain("Attn-Device-Id");
    expect(response.headers.get("Access-Control-Allow-Methods")).toContain("PUT");
  });

  it("rejects equal capability keys", async () => {
    const shareId = `share-deny-${Date.now().toString(36)}`;
    const url = `https://relay.example/v3/shares/${shareId}`;
    const owner = await generateEd25519Keypair();
    const same = new Uint8Array(32).fill(0x44);
    const body = JSON.stringify({
      v: 3,
      revision: 0,
      ownerSigningKey: base64UrlEncode(owner.publicKeyBytes),
      readAdmissionKey: base64UrlEncode(same),
      writeAdmissionKey: base64UrlEncode(same),
    });
    const response = await SELF.fetch(url, {
      method: "POST",
      body,
      headers: {
        "Content-Type": "application/json",
        "Attn-Owner-Signature": await ownerSignatureHeader({ method: "POST", url, body, privateKey: owner.privateKey }),
        "Attn-PoW": await createPowHeader(shareId, owner.publicKeyBytes, `/v3/shares/${shareId}`),
      },
    });
    expect(response.status).toBe(400);
    expect((await response.json() as { error: { code: string } }).error.code).toBe("ATTN_BODY_INVALID");
  });

  it("serializes concurrent self-rooted creates", async () => {
    const shareId = `share-race-${Date.now().toString(36)}`;
    const url = `https://relay.example/v3/shares/${shareId}`;
    const owners = await Promise.all([generateEd25519Keypair(), generateEd25519Keypair()]);
    const requests = await Promise.all(owners.map(async (owner, index) => {
      const body = JSON.stringify({
        v: 3,
        revision: 0,
        ownerSigningKey: base64UrlEncode(owner.publicKeyBytes),
        readAdmissionKey: base64UrlEncode(new Uint8Array(32).fill(0x10 + index)),
        writeAdmissionKey: base64UrlEncode(new Uint8Array(32).fill(0x20 + index)),
      });
      return {
        body,
        headers: {
          "Content-Type": "application/json",
          "Attn-Owner-Signature": await ownerSignatureHeader({ method: "POST", url, body, privateKey: owner.privateKey }),
          "Attn-PoW": await createPowHeader(shareId, owner.publicKeyBytes, `/v3/shares/${shareId}`),
        },
      };
    }));
    const responses = await Promise.all(requests.map(({ body, headers }) => SELF.fetch(url, { method: "POST", body, headers })));
    expect(responses.map(response => response.status).sort()).toEqual([201, 409]);
  });
});
