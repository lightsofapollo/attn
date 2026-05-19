import { describe, it, expect } from "vitest";
import {
  base64UrlEncode,
  canonicalRequest,
} from "../../src/admission";
import { OwnerSigError, verifyOwnerSignature } from "../../src/owner-sig";

/**
 * Tests use the Workers-runtime `crypto.subtle` via vitest-pool-workers, which
 * provides native Ed25519 (compatibility_date 2026-01-01 in wrangler.toml).
 * We do not mock crypto.
 */

interface OwnerKeyPair {
  keyPair: CryptoKeyPair;
  publicBytes: Uint8Array;
}

async function generateOwnerKey(): Promise<OwnerKeyPair> {
  const kp = (await crypto.subtle.generateKey(
    { name: "Ed25519" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const rawPublic = (await crypto.subtle.exportKey(
    "raw",
    kp.publicKey,
  )) as ArrayBuffer;
  const publicBytes = new Uint8Array(rawPublic);
  return { keyPair: kp, publicBytes };
}

async function ed25519Sign(
  privateKey: CryptoKey,
  data: Uint8Array,
): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.sign({ name: "Ed25519" }, privateKey, data),
  );
}

interface SignedOwnerReq {
  request: Request;
  urlPath: string;
  signature: Uint8Array;
  headerValue: string;
}

async function ownerSignedRequest(opts: {
  method: string;
  url: string;
  body?: string;
  signingKey: CryptoKey;
  pathOverride?: string;
  headerOverride?: string;
  omitHeader?: boolean;
  bodyOnWire?: string;
}): Promise<SignedOwnerReq> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";

  const signingRequest = new Request(opts.url, {
    method: opts.method,
    headers,
    body: opts.body,
  });
  const urlPath = opts.pathOverride ?? new URL(opts.url).pathname;
  const canonical = await canonicalRequest(signingRequest, urlPath);
  const signature = await ed25519Sign(opts.signingKey, canonical);
  const headerValue = opts.headerOverride ?? base64UrlEncode(signature);

  const wireHeaders: Record<string, string> = { ...headers };
  if (!opts.omitHeader) wireHeaders["Attn-Owner-Signature"] = headerValue;

  const onWireBody =
    opts.bodyOnWire !== undefined ? opts.bodyOnWire : opts.body;
  const request = new Request(opts.url, {
    method: opts.method,
    headers: wireHeaders,
    body: onWireBody,
  });
  return { request, urlPath, signature, headerValue };
}

describe("verifyOwnerSignature — canonicalRequest reuse with admission", () => {
  it("signs and verifies the same canonical bytes used by admission HMAC", async () => {
    const { keyPair, publicBytes } = await generateOwnerKey();

    const req = new Request(
      "https://relay.example/v2/rooms/abc/acks",
      { method: "POST", body: '{"delete":true,"upTo":42}' },
    );
    const path = "/v2/rooms/abc/acks";

    // Both modules will hash the same bytes; admission HMACs them and owner-sig
    // Ed25519-signs them. We assert canonicalRequest itself is what we sign,
    // then that verifyOwnerSignature accepts the resulting header.
    const canonical = await canonicalRequest(req, path);
    expect(canonical.length).toBeGreaterThan(0);

    const sig = await ed25519Sign(keyPair.privateKey, canonical);
    const wire = new Request(
      "https://relay.example/v2/rooms/abc/acks",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Attn-Owner-Signature": base64UrlEncode(sig),
        },
        body: '{"delete":true,"upTo":42}',
      },
    );
    await expect(
      verifyOwnerSignature(wire, path, publicBytes),
    ).resolves.toBeUndefined();
  });
});

describe("verifyOwnerSignature — success paths", () => {
  it("resolves for a valid Ed25519 signature on a DELETE request", async () => {
    const { keyPair, publicBytes } = await generateOwnerKey();
    const { request, urlPath } = await ownerSignedRequest({
      method: "DELETE",
      url: "https://relay.example/v2/rooms/room-xyz",
      signingKey: keyPair.privateKey,
    });
    await expect(
      verifyOwnerSignature(request, urlPath, publicBytes),
    ).resolves.toBeUndefined();
  });

  it("resolves for a valid POST /acks with delete=true body", async () => {
    const { keyPair, publicBytes } = await generateOwnerKey();
    const { request, urlPath } = await ownerSignedRequest({
      method: "POST",
      url: "https://relay.example/v2/rooms/room-xyz/acks",
      body: '{"upTo":17,"delete":true}',
      signingKey: keyPair.privateKey,
    });
    await expect(
      verifyOwnerSignature(request, urlPath, publicBytes),
    ).resolves.toBeUndefined();
  });
});

describe("verifyOwnerSignature — missing header", () => {
  it("throws ATTN_OWNER_SIG_REQUIRED when header is absent", async () => {
    const { keyPair, publicBytes } = await generateOwnerKey();
    const { request, urlPath } = await ownerSignedRequest({
      method: "DELETE",
      url: "https://relay.example/v2/rooms/room-xyz",
      signingKey: keyPair.privateKey,
      omitHeader: true,
    });
    await expect(
      verifyOwnerSignature(request, urlPath, publicBytes),
    ).rejects.toMatchObject({
      name: "OwnerSigError",
      code: "ATTN_OWNER_SIG_REQUIRED",
    });
  });

  it("throws ATTN_OWNER_SIG_REQUIRED on empty-string header", async () => {
    const { keyPair, publicBytes } = await generateOwnerKey();
    const { request, urlPath } = await ownerSignedRequest({
      method: "DELETE",
      url: "https://relay.example/v2/rooms/room-xyz",
      signingKey: keyPair.privateKey,
      headerOverride: "",
    });
    await expect(
      verifyOwnerSignature(request, urlPath, publicBytes),
    ).rejects.toMatchObject({ code: "ATTN_OWNER_SIG_REQUIRED" });
  });
});

describe("verifyOwnerSignature — malformed header", () => {
  it("throws ATTN_OWNER_SIG_INVALID when base64url has illegal characters", async () => {
    const { keyPair, publicBytes } = await generateOwnerKey();
    const { request, urlPath } = await ownerSignedRequest({
      method: "DELETE",
      url: "https://relay.example/v2/rooms/room-xyz",
      signingKey: keyPair.privateKey,
      headerOverride: "not!valid@base64url",
    });
    await expect(
      verifyOwnerSignature(request, urlPath, publicBytes),
    ).rejects.toMatchObject({
      name: "OwnerSigError",
      code: "ATTN_OWNER_SIG_INVALID",
    });
  });

  it("throws ATTN_OWNER_SIG_INVALID when signature is the wrong length", async () => {
    const { keyPair, publicBytes } = await generateOwnerKey();
    const shortSig = new Uint8Array(32).fill(0xab); // valid b64url, wrong length
    const { request, urlPath } = await ownerSignedRequest({
      method: "DELETE",
      url: "https://relay.example/v2/rooms/room-xyz",
      signingKey: keyPair.privateKey,
      headerOverride: base64UrlEncode(shortSig),
    });
    await expect(
      verifyOwnerSignature(request, urlPath, publicBytes),
    ).rejects.toMatchObject({ code: "ATTN_OWNER_SIG_INVALID" });
  });

  it("throws ATTN_OWNER_SIG_INVALID for a syntactically-correct but garbage signature", async () => {
    const { keyPair, publicBytes } = await generateOwnerKey();
    const garbage = new Uint8Array(64).fill(0xff);
    const { request, urlPath } = await ownerSignedRequest({
      method: "DELETE",
      url: "https://relay.example/v2/rooms/room-xyz",
      signingKey: keyPair.privateKey,
      headerOverride: base64UrlEncode(garbage),
    });
    await expect(
      verifyOwnerSignature(request, urlPath, publicBytes),
    ).rejects.toMatchObject({ code: "ATTN_OWNER_SIG_INVALID" });
  });
});

describe("verifyOwnerSignature — wrong key / tampering", () => {
  it("rejects a signature produced by a different key", async () => {
    const owner = await generateOwnerKey();
    const attacker = await generateOwnerKey();
    // Attacker signs but we verify against the real owner's pubkey.
    const { request, urlPath } = await ownerSignedRequest({
      method: "DELETE",
      url: "https://relay.example/v2/rooms/room-xyz",
      signingKey: attacker.keyPair.privateKey,
    });
    await expect(
      verifyOwnerSignature(request, urlPath, owner.publicBytes),
    ).rejects.toMatchObject({
      name: "OwnerSigError",
      code: "ATTN_OWNER_SIG_INVALID",
    });
  });

  it("rejects when the body was tampered with after signing", async () => {
    const { keyPair, publicBytes } = await generateOwnerKey();
    const { request, urlPath } = await ownerSignedRequest({
      method: "POST",
      url: "https://relay.example/v2/rooms/room-xyz/acks",
      body: '{"upTo":17,"delete":true}',
      signingKey: keyPair.privateKey,
      bodyOnWire: '{"upTo":999,"delete":true}', // attacker swaps body
    });
    await expect(
      verifyOwnerSignature(request, urlPath, publicBytes),
    ).rejects.toMatchObject({ code: "ATTN_OWNER_SIG_INVALID" });
  });

  it("rejects when the verifier disagrees with the signer about urlPath", async () => {
    const { keyPair, publicBytes } = await generateOwnerKey();
    // Signer used "/v2/rooms/room-xyz" but verifier asserts a trailing-slash
    // variant — the canonicalRequest bytes differ, so the signature fails.
    const { request } = await ownerSignedRequest({
      method: "DELETE",
      url: "https://relay.example/v2/rooms/room-xyz",
      signingKey: keyPair.privateKey,
      pathOverride: "/v2/rooms/room-xyz",
    });
    await expect(
      verifyOwnerSignature(request, "/v2/rooms/room-xyz/", publicBytes),
    ).rejects.toMatchObject({ code: "ATTN_OWNER_SIG_INVALID" });
  });
});

describe("verifyOwnerSignature — Ed25519 determinism (RFC 8032)", () => {
  it("signing the same canonical bytes twice with the same key yields the same signature", async () => {
    const { keyPair } = await generateOwnerKey();
    const req = new Request(
      "https://relay.example/v2/rooms/room-xyz",
      { method: "DELETE" },
    );
    const canonical = await canonicalRequest(req, "/v2/rooms/room-xyz");
    const sigA = await ed25519Sign(keyPair.privateKey, canonical);
    const sigB = await ed25519Sign(keyPair.privateKey, canonical);
    expect(sigA).toEqual(sigB);
  });
});

describe("verifyOwnerSignature — wrong-length public key guard", () => {
  it("throws ATTN_OWNER_SIG_INVALID if the loaded owner key isn't 32 bytes", async () => {
    const { keyPair } = await generateOwnerKey();
    const { request, urlPath } = await ownerSignedRequest({
      method: "DELETE",
      url: "https://relay.example/v2/rooms/room-xyz",
      signingKey: keyPair.privateKey,
    });
    const truncated = new Uint8Array(16); // 16 != 32, should be rejected
    await expect(
      verifyOwnerSignature(request, urlPath, truncated),
    ).rejects.toMatchObject({
      name: "OwnerSigError",
      code: "ATTN_OWNER_SIG_INVALID",
    });
  });
});
