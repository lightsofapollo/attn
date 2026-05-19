import { describe, it, expect } from "vitest";
import {
  AdmissionError,
  base64UrlDecode,
  base64UrlEncode,
  canonicalizeQuery,
  canonicalRequest,
  constantTimeEquals,
  parseAdmissionHeader,
  rfc3986Encode,
  verifyAdmission,
} from "../../src/admission";

/**
 * Tests use the Workers-runtime `crypto.subtle` via vitest-pool-workers — we
 * do not mock crypto.
 *
 * Helper: produce a valid signed Request given an admissionKey, url, method,
 * body. Returns the request plus the path we'll pass to canonicalRequest /
 * verifyAdmission so tests can vary the path independently if desired.
 */

const KEY_A = new Uint8Array(32).fill(0xa5);
const KEY_B = new Uint8Array(32).fill(0x5a);
const ROOM_ID = "room-test-1";

async function hmacSha256(
  key: Uint8Array,
  data: Uint8Array,
): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, data));
}

async function signedRequest(opts: {
  method: string;
  url: string;
  body?: string;
  admissionKey: Uint8Array;
  /** Override the urlPath passed into canonicalRequest. Defaults to the URL's pathname. */
  pathOverride?: string;
  /** Replace the computed header value (for negative tests). */
  headerOverride?: string;
  /** Drop the header entirely. */
  omitHeader?: boolean;
  /** Swap the body that goes on the wire after signing (for tamper tests). */
  bodyOnWire?: string;
}): Promise<{ request: Request; urlPath: string; headerValue: string }> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  const bodyToSign = opts.body;
  const signingRequest = new Request(opts.url, {
    method: opts.method,
    headers,
    body: bodyToSign,
  });
  const urlPath = opts.pathOverride ?? new URL(opts.url).pathname;
  const canonical = await canonicalRequest(signingRequest, urlPath);
  const hmac = await hmacSha256(opts.admissionKey, canonical);
  const headerValue = opts.headerOverride ?? `v2.${base64UrlEncode(hmac)}`;

  const wireHeaders: Record<string, string> = { ...headers };
  if (!opts.omitHeader) wireHeaders["Attn-Admission"] = headerValue;

  const onWireBody = opts.bodyOnWire !== undefined ? opts.bodyOnWire : bodyToSign;
  const request = new Request(opts.url, {
    method: opts.method,
    headers: wireHeaders,
    body: onWireBody,
  });
  return { request, urlPath, headerValue };
}

describe("base64Url round-trip", () => {
  it("encodes and decodes arbitrary bytes", () => {
    const bytes = new Uint8Array([0, 1, 2, 3, 254, 255, 127, 128]);
    expect(base64UrlDecode(base64UrlEncode(bytes))).toEqual(bytes);
  });

  it("decodes unpadded base64url", () => {
    // base64url of "Hi" → "SGk" (unpadded), padded would be "SGk=".
    expect(Array.from(base64UrlDecode("SGk"))).toEqual([0x48, 0x69]);
  });
});

describe("rfc3986Encode", () => {
  it("percent-encodes reserved sub-delims that encodeURIComponent leaves raw", () => {
    expect(rfc3986Encode("!*'()")).toBe("%21%2A%27%28%29");
  });

  it("leaves unreserved chars untouched", () => {
    expect(rfc3986Encode("aZ09-._~")).toBe("aZ09-._~");
  });

  it("encodes space as %20", () => {
    expect(rfc3986Encode("a b")).toBe("a%20b");
  });
});

describe("canonicalizeQuery", () => {
  it("returns empty string for no params", () => {
    expect(canonicalizeQuery(new URLSearchParams())).toBe("");
  });

  it("sorts keys lexicographically regardless of insertion order", () => {
    const p = new URLSearchParams();
    p.append("zebra", "1");
    p.append("apple", "2");
    p.append("mango", "3");
    expect(canonicalizeQuery(p)).toBe("apple=2&mango=3&zebra=1");
  });

  it("breaks ties on duplicate keys by value", () => {
    const p = new URLSearchParams();
    p.append("k", "b");
    p.append("k", "a");
    expect(canonicalizeQuery(p)).toBe("k=a&k=b");
  });

  it("percent-encodes both keys and values per RFC 3986", () => {
    const p = new URLSearchParams();
    p.append("a b", "c&d");
    p.append("x", "!*'");
    expect(canonicalizeQuery(p)).toBe("a%20b=c%26d&x=%21%2A%27");
  });
});

describe("canonicalRequest", () => {
  it("produces deterministic bytes for the same request", async () => {
    const r1 = new Request("https://relay.example/v2/rooms/abc", {
      method: "POST",
      body: '{"hello":"world"}',
    });
    const r2 = new Request("https://relay.example/v2/rooms/abc", {
      method: "POST",
      body: '{"hello":"world"}',
    });
    const a = await canonicalRequest(r1, "/v2/rooms/abc");
    const b = await canonicalRequest(r2, "/v2/rooms/abc");
    expect(a).toEqual(b);
  });

  it("differs when the method changes", async () => {
    const r1 = new Request("https://relay.example/v2/rooms/abc", {
      method: "POST",
      body: "{}",
    });
    const r2 = new Request("https://relay.example/v2/rooms/abc", {
      method: "PUT",
      body: "{}",
    });
    const a = await canonicalRequest(r1, "/v2/rooms/abc");
    const b = await canonicalRequest(r2, "/v2/rooms/abc");
    expect(a).not.toEqual(b);
  });

  it("differs when the body changes", async () => {
    const r1 = new Request("https://relay.example/v2/rooms/abc", {
      method: "POST",
      body: '{"v":1}',
    });
    const r2 = new Request("https://relay.example/v2/rooms/abc", {
      method: "POST",
      body: '{"v":2}',
    });
    const a = await canonicalRequest(r1, "/v2/rooms/abc");
    const b = await canonicalRequest(r2, "/v2/rooms/abc");
    expect(a).not.toEqual(b);
  });

  it("produces the same bytes regardless of query-param insertion order", async () => {
    const r1 = new Request(
      "https://relay.example/v2/rooms/abc?b=2&a=1",
      { method: "GET" },
    );
    const r2 = new Request(
      "https://relay.example/v2/rooms/abc?a=1&b=2",
      { method: "GET" },
    );
    const a = await canonicalRequest(r1, "/v2/rooms/abc");
    const b = await canonicalRequest(r2, "/v2/rooms/abc");
    expect(a).toEqual(b);
  });

  it("does not consume the request body (clone preserves it)", async () => {
    const r = new Request("https://relay.example/v2/rooms/abc", {
      method: "POST",
      body: '{"x":1}',
    });
    await canonicalRequest(r, "/v2/rooms/abc");
    expect(await r.text()).toBe('{"x":1}');
  });

  it("includes the urlPath argument verbatim (caller controls trailing slash)", async () => {
    const r1 = new Request("https://relay.example/v2/rooms/abc", {
      method: "GET",
    });
    const r2 = new Request("https://relay.example/v2/rooms/abc", {
      method: "GET",
    });
    const a = await canonicalRequest(r1, "/v2/rooms/abc");
    const b = await canonicalRequest(r2, "/v2/rooms/abc/");
    expect(a).not.toEqual(b);
  });
});

describe("parseAdmissionHeader", () => {
  it("parses a v2.<base64url(32 bytes)> header", () => {
    const bytes = new Uint8Array(32).fill(7);
    const out = parseAdmissionHeader(`v2.${base64UrlEncode(bytes)}`);
    expect(out).toEqual(bytes);
  });

  it("throws AdmissionError on null/missing header", () => {
    expect(() => parseAdmissionHeader(null)).toThrowError(AdmissionError);
    try {
      parseAdmissionHeader(null);
    } catch (e) {
      expect((e as AdmissionError).code).toBe("ATTN_ADMISSION_INVALID");
    }
  });

  it("throws AdmissionError on empty string", () => {
    expect(() => parseAdmissionHeader("")).toThrowError(AdmissionError);
  });

  it("throws when the version prefix is not v2", () => {
    const bytes = new Uint8Array(32).fill(7);
    expect(() =>
      parseAdmissionHeader(`v1.${base64UrlEncode(bytes)}`),
    ).toThrowError(/unsupported Attn-Admission version: v1/);
  });

  it("throws when there is no `.` separator", () => {
    expect(() => parseAdmissionHeader("v2-noseparator")).toThrowError(
      AdmissionError,
    );
  });

  it("throws when the HMAC is the wrong length", () => {
    const bytes = new Uint8Array(16).fill(7); // too short
    expect(() =>
      parseAdmissionHeader(`v2.${base64UrlEncode(bytes)}`),
    ).toThrowError(/must be 32 bytes/);
  });

  it("throws on invalid base64url characters", () => {
    expect(() => parseAdmissionHeader("v2.not!valid")).toThrowError(
      AdmissionError,
    );
  });
});

describe("constantTimeEquals", () => {
  it("returns true for identical byte sequences", () => {
    const a = new Uint8Array([1, 2, 3, 4]);
    const b = new Uint8Array([1, 2, 3, 4]);
    expect(constantTimeEquals(a, b)).toBe(true);
  });

  it("returns false when lengths differ", () => {
    expect(
      constantTimeEquals(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2])),
    ).toBe(false);
  });

  it("returns false when bytes differ", () => {
    expect(
      constantTimeEquals(
        new Uint8Array([1, 2, 3]),
        new Uint8Array([1, 2, 4]),
      ),
    ).toBe(false);
  });
});

describe("verifyAdmission", () => {
  it("succeeds for a valid signed POST request", async () => {
    const { request, urlPath } = await signedRequest({
      method: "POST",
      url: "https://relay.example/v2/rooms/abc/envelopes",
      body: '{"batch":[]}',
      admissionKey: KEY_A,
    });
    await expect(
      verifyAdmission(request, urlPath, {
        roomId: ROOM_ID,
        admissionKey: KEY_A,
      }),
    ).resolves.toBeUndefined();
  });

  it("succeeds for a valid signed GET with query params (order-independent)", async () => {
    const { request, urlPath } = await signedRequest({
      method: "GET",
      url: "https://relay.example/v2/rooms/abc/devices?b=2&a=1",
      admissionKey: KEY_A,
    });
    await expect(
      verifyAdmission(request, urlPath, {
        roomId: ROOM_ID,
        admissionKey: KEY_A,
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects a request with no Attn-Admission header", async () => {
    const { request, urlPath } = await signedRequest({
      method: "POST",
      url: "https://relay.example/v2/rooms/abc/envelopes",
      body: "{}",
      admissionKey: KEY_A,
      omitHeader: true,
    });
    await expect(
      verifyAdmission(request, urlPath, {
        roomId: ROOM_ID,
        admissionKey: KEY_A,
      }),
    ).rejects.toMatchObject({
      name: "AdmissionError",
      code: "ATTN_ADMISSION_INVALID",
    });
  });

  it("rejects a v1.<...> header (only v2 is supported)", async () => {
    const bytes = new Uint8Array(32).fill(0);
    const { request, urlPath } = await signedRequest({
      method: "POST",
      url: "https://relay.example/v2/rooms/abc/envelopes",
      body: "{}",
      admissionKey: KEY_A,
      headerOverride: `v1.${base64UrlEncode(bytes)}`,
    });
    await expect(
      verifyAdmission(request, urlPath, {
        roomId: ROOM_ID,
        admissionKey: KEY_A,
      }),
    ).rejects.toThrowError(/unsupported Attn-Admission version: v1/);
  });

  it("rejects on HMAC mismatch (wrong key)", async () => {
    // Sign with KEY_A, verify with KEY_B.
    const { request, urlPath } = await signedRequest({
      method: "POST",
      url: "https://relay.example/v2/rooms/abc/envelopes",
      body: '{"batch":[]}',
      admissionKey: KEY_A,
    });
    await expect(
      verifyAdmission(request, urlPath, {
        roomId: ROOM_ID,
        admissionKey: KEY_B,
      }),
    ).rejects.toMatchObject({ code: "ATTN_ADMISSION_INVALID" });
  });

  it("rejects on body tampering (different SHA-256)", async () => {
    const { request, urlPath } = await signedRequest({
      method: "POST",
      url: "https://relay.example/v2/rooms/abc/envelopes",
      body: '{"batch":[1]}',
      admissionKey: KEY_A,
      bodyOnWire: '{"batch":[2]}', // tampered after signing
    });
    await expect(
      verifyAdmission(request, urlPath, {
        roomId: ROOM_ID,
        admissionKey: KEY_A,
      }),
    ).rejects.toMatchObject({ code: "ATTN_ADMISSION_INVALID" });
  });

  it("rejects when the verifier disagrees with the signer about urlPath", async () => {
    // Signer used "/v2/rooms/abc", verifier asserts "/v2/rooms/abc/" — different path,
    // therefore different canonicalRequest, therefore different HMAC.
    const { request } = await signedRequest({
      method: "POST",
      url: "https://relay.example/v2/rooms/abc",
      body: "{}",
      admissionKey: KEY_A,
      pathOverride: "/v2/rooms/abc",
    });
    await expect(
      verifyAdmission(request, "/v2/rooms/abc/", {
        roomId: ROOM_ID,
        admissionKey: KEY_A,
      }),
    ).rejects.toMatchObject({ code: "ATTN_ADMISSION_INVALID" });
  });

  it("rejects a header whose HMAC bytes are syntactically valid but wrong", async () => {
    const wrong = new Uint8Array(32).fill(0xff);
    const { request, urlPath } = await signedRequest({
      method: "POST",
      url: "https://relay.example/v2/rooms/abc/envelopes",
      body: "{}",
      admissionKey: KEY_A,
      headerOverride: `v2.${base64UrlEncode(wrong)}`,
    });
    await expect(
      verifyAdmission(request, urlPath, {
        roomId: ROOM_ID,
        admissionKey: KEY_A,
      }),
    ).rejects.toMatchObject({ code: "ATTN_ADMISSION_INVALID" });
  });
});
