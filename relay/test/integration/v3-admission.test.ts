import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { base64UrlEncode, canonicalRequest } from "../../src/admission";
import { generateEd25519Keypair, ownerSignatureHeader } from "../helpers/owner-sig";
import { createPowHeader } from "../helpers/pow";
import { FIXED_POW_RAND, mintPowForTests } from "../helpers/pow";
import { presignBlobDownload, presignBlobUpload } from "../../src/r2";
import { canonicalize } from "../../src/canonical";

async function scopedHeader(
  scope: "read" | "write",
  key: Uint8Array,
  method: string,
  url: string,
  body?: string,
): Promise<string> {
  const unsigned = new Request(url, { method, body });
  const canonical = await canonicalRequest(unsigned, new URL(url).pathname);
  const cryptoKey = await crypto.subtle.importKey(
    "raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, canonical));
  return `v3.${scope}.${base64UrlEncode(mac)}`;
}

describe("additive /v3 scoped admission", () => {
  it("binds upload and download caps to their route protocol version", async () => {
    const roomId = `v3-cap-swap-${Date.now().toString(36)}`;
    const uploadV3 = await presignBlobUpload(
      env, roomId, "lease", "upload", "claim", 3, undefined, 2, 3,
    );
    const uploadV2 = await presignBlobUpload(
      env, roomId, "lease", "upload", "claim", 3,
    );
    for (const swapped of [
      uploadV3.uploadUrl.replace("/v3/", "/v2/"),
      uploadV2.uploadUrl.replace("/v2/", "/v3/"),
    ]) {
      const response = await SELF.fetch(`https://relay.example${swapped}`, {
        method: "PUT", body: new Uint8Array(3),
      });
      expect(response.status).toBe(401);
      expect((await response.json() as { error: { code: string } }).error.code)
        .toBe("ATTN_BLOB_CAP_INVALID");
    }

    const downloadV3 = await presignBlobDownload(env, roomId, "lease", "download", undefined, 2, 3);
    const downloadV2 = await presignBlobDownload(env, roomId, "lease", "download");
    for (const swapped of [
      downloadV3.downloadUrl.replace("/v3/", "/v2/"),
      downloadV2.downloadUrl.replace("/v2/", "/v3/"),
    ]) {
      const response = await SELF.fetch(`https://relay.example${swapped}`);
      expect(response.status).toBe(401);
      expect((await response.json() as { error: { code: string } }).error.code)
        .toBe("ATTN_BLOB_CAP_INVALID");
    }
  });

  it("permits read, rejects read proof on write with 403, and accepts write proof", async () => {
    const roomId = `v3-matrix-${Date.now().toString(36)}`;
    const roomUrl = `https://relay.example/v3/rooms/${roomId}`;
    const owner = await generateEd25519Keypair();
    const readKey = new Uint8Array(32).fill(0x31);
    const writeKey = new Uint8Array(32).fill(0x72);
    const createShape = {
      v: 3,
      policy: {
        mode: "live", maxPeers: 4, maxSnapshotBytes: 1_000_000,
        maxEventBytes: 8192, maxEvents: 100, expiresAt: Date.now() + 3_600_000,
      },
      ownerSigningKey: base64UrlEncode(owner.publicKeyBytes),
      readAdmissionKey: base64UrlEncode(readKey),
      writeAdmissionKey: base64UrlEncode(writeKey),
    };
    const equalRoomId = `${roomId}-equal`;
    const equalUrl = `https://relay.example/v3/rooms/${equalRoomId}`;
    const equalBody = JSON.stringify({
      ...createShape,
      writeAdmissionKey: createShape.readAdmissionKey,
    });
    const equalResponse = await SELF.fetch(equalUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Attn-Owner-Signature": await ownerSignatureHeader({
          method: "POST", url: equalUrl, body: equalBody, privateKey: owner.privateKey,
        }),
        "Attn-PoW": await createPowHeader(equalRoomId, owner.publicKeyBytes, `/v3/rooms/${equalRoomId}`),
      },
      body: equalBody,
    });
    expect(equalResponse.status).toBe(400);
    expect((await equalResponse.json() as { error: { code: string } }).error.code)
      .toBe("ATTN_BODY_INVALID");

    const body = JSON.stringify(createShape);
    const ownerSig = await ownerSignatureHeader({
      method: "POST", url: roomUrl, body, privateKey: owner.privateKey,
    });
    const created = await SELF.fetch(roomUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Attn-Owner-Signature": ownerSig,
        "Attn-PoW": await createPowHeader(roomId, owner.publicKeyBytes, `/v3/rooms/${roomId}`),
      },
      body,
    });
    expect(created.status).toBe(201);

    const register = async (
      deviceLabel: string,
      grantRoomId: string,
    ): Promise<Response> => {
      const device = await generateEd25519Keypair();
      const grantBytes = new TextEncoder().encode(canonicalize({
        grantTier: "comment",
        purpose: "attn device grant v3",
        roomId: grantRoomId,
        v: 3,
      }));
      const grantSignature = base64UrlEncode(new Uint8Array(
        await crypto.subtle.sign({ name: "Ed25519" }, owner.privateKey, grantBytes),
      ));
      const unsigned = {
        deviceId: deviceLabel,
        participantId: `participant-${deviceLabel}`,
        publicSigningKey: base64UrlEncode(device.publicKeyBytes),
        publicEncryptionKey: base64UrlEncode(new Uint8Array(32).fill(0x44)),
        client: "attn-browser",
        kind: "reviewer",
        grantTier: "comment",
        grantSignature,
      };
      const selfSignature = base64UrlEncode(new Uint8Array(
        await crypto.subtle.sign(
          { name: "Ed25519" },
          device.privateKey,
          new TextEncoder().encode(canonicalize(unsigned)),
        ),
      ));
      const registration = JSON.stringify({ ...unsigned, selfSignature });
      const devicesUrl = `${roomUrl}/devices`;
      return SELF.fetch(devicesUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Attn-Admission": await scopedHeader("write", writeKey, "POST", devicesUrl, registration),
          "Attn-PoW": await mintPowForTests({
            roomId,
            deviceId: deviceLabel,
            method: "POST",
            path: `/v3/rooms/${roomId}/devices`,
            difficulty: 16,
            expiresAt: Date.now() + 300_000,
            rand: FIXED_POW_RAND,
          }),
        },
        body: registration,
      });
    };

    const validGrant = await register("v3-grant-valid", roomId);
    expect(validGrant.status, await validGrant.clone().text()).toBe(204);
    const crossRoom = await register("v3-grant-cross-room", `${roomId}-other`);
    expect(crossRoom.status).toBe(403);
    expect((await crossRoom.json() as { error: { code: string } }).error.code)
      .toBe("ATTN_GRANT_INVALID");

    const devicesUrl = `${roomUrl}/devices`;
    const read = await SELF.fetch(devicesUrl, {
      headers: { "Attn-Admission": await scopedHeader("read", readKey, "GET", devicesUrl) },
    });
    expect(read.status).toBe(200);

    const missingBlobUrl = `${roomUrl}/blobs/missing-envelope`;
    const missingBlob = await SELF.fetch(missingBlobUrl, {
      headers: {
        "Attn-Admission": await scopedHeader("read", readKey, "GET", missingBlobUrl),
      },
    });
    expect(missingBlob.status).toBe(404);
    expect((await missingBlob.json() as { error: { code: string } }).error.code)
      .not.toBe("ATTN_ADMISSION_INVALID");

    const socketUrl = `${roomUrl}/socket?device_id=view-only-unregistered&proof_expires=${Date.now() + 60_000}&proof_nonce=${base64UrlEncode(new Uint8Array(16).fill(0x55))}`;
    const socketAdmission = await scopedHeader("read", readKey, "GET", socketUrl);
    const readOnlyDeviceSocket = await SELF.fetch(socketUrl, {
      headers: {
        Upgrade: "websocket",
        "Sec-WebSocket-Protocol": `attn.v3, read-hmac.${socketAdmission.split(".")[2]}`,
      },
    });
    expect(readOnlyDeviceSocket.status).toBe(401);
    expect((await readOnlyDeviceSocket.json() as { error: { code: string } }).error.code)
      .toBe("ATTN_ADMISSION_INVALID");

    const socketWriteAdmission = await scopedHeader("write", writeKey, "GET", socketUrl);
    const socket = await SELF.fetch(socketUrl, {
      headers: {
        Upgrade: "websocket",
        "Sec-WebSocket-Protocol": `attn.v3, read-hmac.${socketAdmission.split(".")[2]}, write-hmac.${socketWriteAdmission.split(".")[2]}, device-proof.${base64UrlEncode(new Uint8Array(64).fill(0x77))}`,
      },
    });
    expect(socket.status).toBe(404);
    expect((await socket.json() as { error: { code: string } }).error.code)
      .toBe("ATTN_DEVICE_UNREGISTERED");

    const readOnWrite = await SELF.fetch(roomUrl, {
      method: "POST",
      headers: { "Attn-Admission": await scopedHeader("read", readKey, "POST", roomUrl, body) },
      body,
    });
    expect(readOnWrite.status).toBe(403);
    expect((await readOnWrite.json() as { error: { code: string } }).error.code)
      .toBe("ATTN_WRITE_CAPABILITY_REQUIRED");

    for (const mutation of [
      { method: "POST", url: `${roomUrl}/devices`, body: "{}" },
      { method: "POST", url: `${roomUrl}/envelopes`, body: "{}" },
      { method: "POST", url: `${roomUrl}/acks`, body: "{}" },
      { method: "POST", url: `${roomUrl}/blobs`, body: "{}" },
      { method: "DELETE", url: roomUrl, body: undefined },
    ]) {
      const response = await SELF.fetch(mutation.url, {
        method: mutation.method,
        headers: {
          "Attn-Admission": await scopedHeader(
            "read", readKey, mutation.method, mutation.url, mutation.body,
          ),
        },
        body: mutation.body,
      });
      expect(response.status, `${mutation.method} ${mutation.url}`).toBe(403);
      expect((await response.json() as { error: { code: string } }).error.code)
        .toBe("ATTN_WRITE_CAPABILITY_REQUIRED");
    }

    const write = await SELF.fetch(roomUrl, {
      method: "POST",
      headers: { "Attn-Admission": await scopedHeader("write", writeKey, "POST", roomUrl, body) },
      body,
    });
    expect(write.status).toBe(200);

    const mismatch = await SELF.fetch(`https://relay.example/v2/rooms/${roomId}/devices`, {
      headers: { "Attn-Admission": "v2.invalid" },
    });
    expect(mismatch.status).toBe(409);
    expect((await mismatch.json() as { error: { code: string } }).error.code)
      .toBe("ATTN_PROTOCOL_VERSION_MISMATCH");
  });
});
