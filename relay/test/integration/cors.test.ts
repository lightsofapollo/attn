/**
 * Integration coverage for CORS + browser-origin allowlist (attn-nnj.9.5).
 *
 * Spec: planning/collab/relay-spec.md §Browser Considerations.
 *
 * Behavior under test:
 *   - `policy.allowBrowser == false` (default) → no CORS headers, ever; the
 *     relay is native-only and a stray browser preflight gets a polite 204
 *     with nothing else.
 *   - `policy.allowBrowser == true`:
 *       - OPTIONS preflight from an allowlisted Origin → 204 with full CORS
 *         headers (Allow-Origin matches the request, Allow-Headers + Methods
 *         contain the v2 surface).
 *       - GET/POST/DELETE/etc. from an allowlisted Origin → CORS headers
 *         attached to the real response.
 *       - WS upgrade from an allowlisted Origin → 101 succeeds; from a
 *         disallowed Origin → 403.
 *   - The ALLOWED_BROWSER_ORIGINS env var is comma-separated; multiple
 *     entries must all be honoured; non-listed origins are still 403'd.
 *
 * All tests go through SELF.fetch so they exercise the full Worker → DO
 * pipeline (corsMiddleware + tagAllowBrowserOnResponse + WS Origin check).
 */

import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { base64UrlEncode, canonicalRequest } from "../../src/admission";
import type { Env } from "../../src/env";
import type { RoomPolicy } from "../../src/schema";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

const URL_BASE = "https://relay.example";

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

function makeKeyBytes(seed: number): Uint8Array {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = (seed + i) & 0xff;
  return bytes;
}

let roomCounter = 0;
function uniqueRoomId(label: string): string {
  roomCounter += 1;
  return `${label}-${Date.now().toString(36)}-${roomCounter}`;
}

async function generateEd25519Keypair(): Promise<{
  publicKey: CryptoKey;
  privateKey: CryptoKey;
  publicKeyBytes: Uint8Array;
}> {
  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const raw = await crypto.subtle.exportKey("raw", kp.publicKey);
  if (!(raw instanceof ArrayBuffer)) {
    throw new Error("exportKey('raw') unexpectedly returned a JWK");
  }
  return {
    publicKey: kp.publicKey,
    privateKey: kp.privateKey,
    publicKeyBytes: new Uint8Array(raw),
  };
}

async function createRoom(opts: {
  roomId: string;
  allowBrowser: boolean;
}): Promise<Uint8Array> {
  // attn-nnj.5.17 (security-review §H1): first-create requires
  // Attn-Owner-Signature self-rooted to the body's ownerSigningKey. Real
  // Ed25519 keypairs are cheap — no reason to keep `makeKeyBytes` placeholder
  // owner keys around for these tests.
  const ownerKp = await generateEd25519Keypair();
  const admissionKey = makeKeyBytes((roomCounter * 13 + 0x33) & 0xff);
  const body = JSON.stringify({
    v: 2,
    policy: defaultPolicy({ allowBrowser: opts.allowBrowser }),
    ownerSigningKey: base64UrlEncode(ownerKp.publicKeyBytes),
    admissionKey: base64UrlEncode(admissionKey),
  });
  const url = `${URL_BASE}/v2/rooms/${opts.roomId}`;
  const signing = new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  const canonical = await canonicalRequest(signing, new URL(url).pathname);
  const sig = new Uint8Array(
    await crypto.subtle.sign({ name: "Ed25519" }, ownerKp.privateKey, canonical),
  );
  const res = await SELF.fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Attn-Owner-Signature": base64UrlEncode(sig),
    },
    body,
  });
  if (res.status !== 201) {
    throw new Error(`room create failed: ${res.status} ${await res.text()}`);
  }
  return admissionKey;
}

/**
 * The test env binding inherits from the top-level [vars] in wrangler.toml,
 * which configures `ALLOWED_BROWSER_ORIGINS = "https://attn.dev,https://staging.attn.dev"`.
 * Tests in this file assume both of those origins are in the allowlist and
 * that `https://evil.example` is NOT.
 */
const ALLOWED_PROD_ORIGIN = "https://attn.dev";
const ALLOWED_STAGING_ORIGIN = "https://staging.attn.dev";
const DISALLOWED_ORIGIN = "https://evil.example";

// Sanity-check: tie the assumption to a real read so failures surface here
// instead of as confusing test failures.
function ensureFixtureEnv(): void {
  const raw = env.ALLOWED_BROWSER_ORIGINS;
  if (!raw.includes(ALLOWED_PROD_ORIGIN) || !raw.includes(ALLOWED_STAGING_ORIGIN)) {
    throw new Error(
      `cors.test.ts assumes ALLOWED_BROWSER_ORIGINS contains both attn.dev and staging.attn.dev; got ${raw}`,
    );
  }
}

// --- OPTIONS preflight ----------------------------------------------------

describe("CORS — OPTIONS preflight", () => {
  it("browser-disabled room: 204 with NO CORS headers", async () => {
    const roomId = uniqueRoomId("cors-no-browser");
    await createRoom({ roomId, allowBrowser: false });

    const res = await SELF.fetch(`${URL_BASE}/v2/rooms/${roomId}/devices`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://attn.dev",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "Content-Type, Attn-Admission",
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(res.headers.get("Access-Control-Allow-Headers")).toBeNull();
    expect(res.headers.get("Access-Control-Allow-Methods")).toBeNull();
    // The internal handshake header must never leak to the client.
    expect(res.headers.get("X-Attn-Allow-Browser")).toBeNull();
  });

  it("browser-enabled room + allowlisted Origin: 204 with full CORS headers", async () => {
    const roomId = uniqueRoomId("cors-yes-browser");
    await createRoom({ roomId, allowBrowser: true });

    const res = await SELF.fetch(`${URL_BASE}/v2/rooms/${roomId}/envelopes`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://attn.dev",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "Content-Type, Attn-Admission, Attn-PoW",
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://attn.dev");
    expect(res.headers.get("Access-Control-Allow-Headers")).toBe(
      "Content-Type, Attn-Admission, Attn-Owner-Signature, Attn-PoW",
    );
    expect(res.headers.get("Access-Control-Allow-Methods")).toBe(
      "GET, POST, DELETE, OPTIONS",
    );
    // Vary: Origin must be set so caches don't poison cross-origin replies.
    const vary = res.headers.get("Vary") ?? "";
    expect(vary.split(/,\s*/)).toContain("Origin");
    // Internal handshake header is stripped.
    expect(res.headers.get("X-Attn-Allow-Browser")).toBeNull();
  });

  it("browser-enabled room + disallowed Origin: 204 with NO CORS headers", async () => {
    const roomId = uniqueRoomId("cors-bad-origin");
    await createRoom({ roomId, allowBrowser: true });

    const res = await SELF.fetch(`${URL_BASE}/v2/rooms/${roomId}/devices`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://evil.example",
        "Access-Control-Request-Method": "POST",
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(res.headers.get("X-Attn-Allow-Browser")).toBeNull();
  });
});

// --- GET responses --------------------------------------------------------

describe("CORS — regular HTTP responses", () => {
  it("browser-disabled room: GET response has no Access-Control-Allow-Origin", async () => {
    const roomId = uniqueRoomId("cors-get-native");
    await createRoom({ roomId, allowBrowser: false });

    // GET /v2/rooms/:roomId/devices on a fresh room → 200 with empty devices list
    // (or 404 if not registered yet — both paths cover the CORS check).
    const url = `${URL_BASE}/v2/rooms/${roomId}/devices`;
    const res = await SELF.fetch(url, {
      method: "GET",
      headers: { Origin: "https://attn.dev" },
    });
    // Either 200 (empty list) or 401 (admission required). Both must lack CORS.
    expect([200, 401, 404]).toContain(res.status);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(res.headers.get("X-Attn-Allow-Browser")).toBeNull();
    // Drain body so vitest doesn't warn about unconsumed streams.
    await res.text();
  });

  it("browser-enabled room + allowlisted Origin: GET response includes CORS headers", async () => {
    const roomId = uniqueRoomId("cors-get-browser");
    await createRoom({ roomId, allowBrowser: true });

    const url = `${URL_BASE}/v2/rooms/${roomId}/devices`;
    const res = await SELF.fetch(url, {
      method: "GET",
      headers: { Origin: "https://attn.dev" },
    });
    expect([200, 401, 404]).toContain(res.status);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://attn.dev");
    expect(res.headers.get("Access-Control-Allow-Methods")).toBe(
      "GET, POST, DELETE, OPTIONS",
    );
    expect(res.headers.get("X-Attn-Allow-Browser")).toBeNull();
    await res.text();
  });

  it("browser-enabled room + disallowed Origin: GET response has no CORS headers", async () => {
    const roomId = uniqueRoomId("cors-get-bad-origin");
    await createRoom({ roomId, allowBrowser: true });

    const res = await SELF.fetch(`${URL_BASE}/v2/rooms/${roomId}/devices`, {
      method: "GET",
      headers: { Origin: "https://evil.example" },
    });
    expect([200, 401, 404]).toContain(res.status);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(res.headers.get("X-Attn-Allow-Browser")).toBeNull();
    await res.text();
  });

  it("browser-enabled room + no Origin header (native client): no CORS headers", async () => {
    const roomId = uniqueRoomId("cors-get-native-client");
    await createRoom({ roomId, allowBrowser: true });

    const res = await SELF.fetch(`${URL_BASE}/v2/rooms/${roomId}/devices`, {
      method: "GET",
    });
    expect([200, 401, 404]).toContain(res.status);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(res.headers.get("X-Attn-Allow-Browser")).toBeNull();
    await res.text();
  });
});

// --- WebSocket Origin allowlist ------------------------------------------

describe("CORS — WebSocket upgrade Origin check", () => {
  it("browser-disabled room + browser Origin: WS upgrade returns 403", async () => {
    const roomId = uniqueRoomId("ws-no-browser");
    await createRoom({ roomId, allowBrowser: false });

    const res = await SELF.fetch(
      `${URL_BASE}/v2/rooms/${roomId}/socket?device_id=d1`,
      {
        headers: {
          Upgrade: "websocket",
          Origin: "https://attn.dev",
          "Sec-WebSocket-Protocol": "attn.v2, hmac.AAAA",
        },
      },
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("ATTN_BROWSER_DISALLOWED");
  });

  it("browser-enabled room + disallowed Origin: WS upgrade returns 403", async () => {
    const roomId = uniqueRoomId("ws-bad-origin");
    await createRoom({ roomId, allowBrowser: true });

    const res = await SELF.fetch(
      `${URL_BASE}/v2/rooms/${roomId}/socket?device_id=d1`,
      {
        headers: {
          Upgrade: "websocket",
          Origin: "https://evil.example",
          "Sec-WebSocket-Protocol": "attn.v2, hmac.AAAA",
        },
      },
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("ATTN_ORIGIN_FORBIDDEN");
  });

  it("browser-enabled room + allowlisted Origin: WS upgrade passes the Origin check", async () => {
    const roomId = uniqueRoomId("ws-good-origin");
    await createRoom({ roomId, allowBrowser: true });

    // The HMAC isn't valid (we'd need to mint one), so the upgrade itself
    // fails further down with `ATTN_ADMISSION_INVALID` (returned as 101 +
    // close 4000 per spec). The point of this test is that the Origin check
    // did NOT short-circuit with 403 — we got past it to admission verify.
    const res = await SELF.fetch(
      `${URL_BASE}/v2/rooms/${roomId}/socket?device_id=d1`,
      {
        headers: {
          Upgrade: "websocket",
          Origin: "https://attn.dev",
          "Sec-WebSocket-Protocol": "attn.v2, hmac.AAAA",
        },
      },
    );
    // Either 101 (admission proceeds via close-frame) or any non-403 admission
    // failure — we just need to confirm Origin didn't get us 403'd.
    expect(res.status).not.toBe(403);
  });
});

// --- ALLOWED_BROWSER_ORIGINS multi-origin allowlist ----------------------

describe("CORS — multi-origin ALLOWED_BROWSER_ORIGINS allowlist", () => {
  it("both entries of a comma-separated allowlist are honoured; unrelated origins rejected", async () => {
    ensureFixtureEnv();
    const roomId = uniqueRoomId("cors-multi");
    await createRoom({ roomId, allowBrowser: true });

    // Production origin → CORS attached
    const prod = await SELF.fetch(`${URL_BASE}/v2/rooms/${roomId}/devices`, {
      method: "OPTIONS",
      headers: { Origin: ALLOWED_PROD_ORIGIN },
    });
    expect(prod.status).toBe(204);
    expect(prod.headers.get("Access-Control-Allow-Origin")).toBe(
      ALLOWED_PROD_ORIGIN,
    );

    // Staging origin → CORS attached
    const staging = await SELF.fetch(`${URL_BASE}/v2/rooms/${roomId}/devices`, {
      method: "OPTIONS",
      headers: { Origin: ALLOWED_STAGING_ORIGIN },
    });
    expect(staging.status).toBe(204);
    expect(staging.headers.get("Access-Control-Allow-Origin")).toBe(
      ALLOWED_STAGING_ORIGIN,
    );

    // Unrelated origin → no CORS headers
    const evil = await SELF.fetch(`${URL_BASE}/v2/rooms/${roomId}/devices`, {
      method: "OPTIONS",
      headers: { Origin: DISALLOWED_ORIGIN },
    });
    expect(evil.status).toBe(204);
    expect(evil.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("missing Origin header on OPTIONS is NOT treated as a wildcard", async () => {
    ensureFixtureEnv();
    const roomId = uniqueRoomId("cors-no-origin");
    await createRoom({ roomId, allowBrowser: true });

    // Origin missing entirely (some clients drop it on cross-origin
    // requests from `file://`); we must not turn that into a wildcard.
    const noOrigin = await SELF.fetch(
      `${URL_BASE}/v2/rooms/${roomId}/devices`,
      { method: "OPTIONS" },
    );
    expect(noOrigin.status).toBe(204);
    expect(noOrigin.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("WS upgrade against a multi-origin allowlist accepts both, rejects others", async () => {
    ensureFixtureEnv();
    const roomId = uniqueRoomId("ws-multi");
    await createRoom({ roomId, allowBrowser: true });

    for (const origin of [ALLOWED_PROD_ORIGIN, ALLOWED_STAGING_ORIGIN]) {
      const res = await SELF.fetch(
        `${URL_BASE}/v2/rooms/${roomId}/socket?device_id=d1`,
        {
          headers: {
            Upgrade: "websocket",
            Origin: origin,
            "Sec-WebSocket-Protocol": "attn.v2, hmac.AAAA",
          },
        },
      );
      expect(res.status).not.toBe(403);
    }

    const evil = await SELF.fetch(
      `${URL_BASE}/v2/rooms/${roomId}/socket?device_id=d1`,
      {
        headers: {
          Upgrade: "websocket",
          Origin: DISALLOWED_ORIGIN,
          "Sec-WebSocket-Protocol": "attn.v2, hmac.AAAA",
        },
      },
    );
    expect(evil.status).toBe(403);
    const body = (await evil.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("ATTN_ORIGIN_FORBIDDEN");
  });
});
