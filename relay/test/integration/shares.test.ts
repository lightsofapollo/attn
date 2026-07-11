import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { base64UrlEncode, canonicalRequest } from "../../src/admission";
import { generateEd25519Keypair, ownerSignatureHeader } from "../helpers/owner-sig";
import { createPowHeader, FIXED_POW_RAND, mintPowForTests } from "../helpers/pow";

async function admission(scope: "read" | "write", key: Uint8Array, method: string, url: string, body?: string): Promise<string> {
  const canonical = await canonicalRequest(new Request(url, { method, body }), new URL(url).pathname);
  const imported = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", imported, canonical));
  return `v3.${scope}.${base64UrlEncode(mac)}`;
}

describe("durable v3 shares", () => {
  it("creates, reads, renews, queues ordered mailbox items, and revokes", async () => {
    const shareId = `share-${Date.now().toString(36)}`;
    const url = `https://relay.example/v3/shares/${shareId}`;
    const owner = await generateEd25519Keypair();
    const read = new Uint8Array(32).fill(0x31);
    const write = new Uint8Array(32).fill(0x72);
    const ownerId = base64UrlEncode(new Uint8Array(await crypto.subtle.digest("SHA-256", owner.publicKeyBytes)));
    const body = JSON.stringify({
      v: 3, ownerSigningKey: base64UrlEncode(owner.publicKeyBytes),
      readAdmissionKey: base64UrlEncode(read), writeAdmissionKey: base64UrlEncode(write),
      currentRoomId: null, snapshots: [], placeholders: [{ fileId: "future-file" }],
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
      { envelopeId: "mail-one", type: "comment", n: 1 },
      { envelopeId: "mail-two", type: "placeholder", n: 2 },
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

    const conflictBody = JSON.stringify({ deviceId: "writer", items: [{ envelopeId: "mail-one", type: "comment", n: 99 }] });
    const conflict = await SELF.fetch(mailboxUrl, { method: "POST", body: conflictBody, headers: {
      "Content-Type": "application/json",
      "Attn-Admission": await admission("write", write, "POST", mailboxUrl, conflictBody),
    } });
    expect(conflict.status).toBe(409);
    expect((await conflict.json() as { error: { code: string } }).error.code).toBe("ATTN_ENVELOPE_ID_CONFLICT");

    for (let batch = 0; batch < 5; batch += 1) {
      const items = Array.from({ length: 26 }, (_, offset) => ({
        envelopeId: `bulk-${batch}-${offset}`,
        ciphertext: `opaque-${batch}-${offset}`,
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

  it("answers browser preflight before Durable Object dispatch", async () => {
    const response = await SELF.fetch("https://relay.example/v3/shares/preflight-share", {
      method: "OPTIONS",
      headers: {
        Origin: "https://attn.sh",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "Attn-Admission, Attn-PoW, Attn-Owner-Signature, Attn-Device-Id, Content-Type",
      },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://attn.sh");
    expect(response.headers.get("Access-Control-Allow-Headers")).toContain("Attn-Device-Id");
  });

  it("rejects equal capability keys", async () => {
    const shareId = `share-deny-${Date.now().toString(36)}`;
    const url = `https://relay.example/v3/shares/${shareId}`;
    const owner = await generateEd25519Keypair();
    const same = new Uint8Array(32).fill(0x44);
    const body = JSON.stringify({
      v: 3,
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
