/** Admission-HMAC verification per relay-spec.md §Identity, Keys, and Admission.
 *
 * Wire format:
 *
 *   canonicalRequest = METHOD || "\n" || URL_PATH || "\n" || CANONICAL_QUERY || "\n" || SHA256(body)
 *   admissionHmac    = base64url(HMAC-SHA-256(admissionKey, canonicalRequest))
 *   Header           = `Attn-Admission: v2.<base64url-hmac>`
 *
 * Per amendments.md Decision #2, the admissionKey is per-room and HKDF-derived
 * from `roomSecret` client-side. The relay stores the 32-byte admissionKey in
 * DO storage (set by the room-create endpoint owned by attn-nnj.5.5) and uses
 * it to verify HMACs. URL possession is the trust boundary; the HMAC proves the
 * caller knows admissionKey (which is equivalent).
 *
 * canonicalRequest must be reproduced byte-for-byte on both ends. URL_PATH is
 * the request path with leading slash, no query, no trailing slash, and no
 * normalization beyond what the caller passed in. CANONICAL_QUERY is built
 * here from the URL's searchParams: keys sorted lexicographically, each
 * `key=value` pair joined by `&`, key and value RFC-3986-percent-encoded
 * (only unreserved chars left raw, everything else `%XX`).
 */

export interface AdmissionContext {
  /** Room id this request targets; surfaced on AdmissionError for logging. */
  roomId: string;
  /** Per-room admission key (32 bytes), loaded from DO storage by the caller. */
  admissionKey: Uint8Array;
}

export class AdmissionError extends Error {
  public readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "AdmissionError";
    this.code = code;
  }
}

const ADMISSION_HEADER = "Attn-Admission";
const ADMISSION_VERSION = "v2";
const HMAC_BYTE_LEN = 32;

const textEncoder = new TextEncoder();

/**
 * Build the canonical-request bytes that get HMAC-signed.
 *
 * `urlPath` is taken from the caller (router) rather than parsed off the URL
 * to keep canonicalization decisions out of this module — the caller already
 * knows the matched route path and is the authority on trailing-slash policy.
 */
export async function canonicalRequest(
  request: Request,
  urlPath: string,
): Promise<Uint8Array> {
  const method = request.method.toUpperCase();
  const url = new URL(request.url);
  const canonicalQuery = canonicalizeQuery(url.searchParams);

  // Clone before reading the body so the original request remains consumable
  // by downstream handlers.
  const bodyBytes = new Uint8Array(await request.clone().arrayBuffer());
  const bodyHash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", bodyBytes),
  );

  const newline = textEncoder.encode("\n");
  return concatBytes([
    textEncoder.encode(method),
    newline,
    textEncoder.encode(urlPath),
    newline,
    textEncoder.encode(canonicalQuery),
    newline,
    bodyHash,
  ]);
}

/**
 * Verify the `Attn-Admission` header against `ctx.admissionKey`.
 * Throws `AdmissionError` on missing header, malformed header, or HMAC mismatch.
 */
export async function verifyAdmission(
  request: Request,
  urlPath: string,
  ctx: AdmissionContext,
): Promise<void> {
  const provided = parseAdmissionHeader(request.headers.get(ADMISSION_HEADER));
  const canonical = await canonicalRequest(request, urlPath);

  const key = await crypto.subtle.importKey(
    "raw",
    ctx.admissionKey,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const expected = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, canonical),
  );

  if (!constantTimeEquals(expected, provided)) {
    throw new AdmissionError(
      "ATTN_ADMISSION_INVALID",
      `admission HMAC mismatch for room ${ctx.roomId}`,
    );
  }
}

export type AdmissionScopeV3 = "read" | "write";

export interface AdmissionContextV3 {
  roomId: string;
  readAdmissionKey: Uint8Array;
  writeAdmissionKey: Uint8Array;
}

/** Verify additive v3 scoped admission without changing the v2 wire parser. */
export async function verifyAdmissionV3(
  request: Request,
  urlPath: string,
  ctx: AdmissionContextV3,
  required: AdmissionScopeV3,
): Promise<void> {
  const parsed = parseAdmissionHeaderV3(request.headers.get(ADMISSION_HEADER));
  const canonical = await canonicalRequest(request, urlPath);
  if (required === "read") {
    if (parsed.scope !== "read" || !(await hmacMatches(ctx.readAdmissionKey, canonical, parsed.mac))) {
      throw new AdmissionError("ATTN_ADMISSION_INVALID", `admission HMAC mismatch for room ${ctx.roomId}`);
    }
    return;
  }
  if (parsed.scope === "write") {
    if (await hmacMatches(ctx.writeAdmissionKey, canonical, parsed.mac)) return;
    throw new AdmissionError("ATTN_ADMISSION_INVALID", `admission HMAC mismatch for room ${ctx.roomId}`);
  }
  if (await hmacMatches(ctx.readAdmissionKey, canonical, parsed.mac)) {
    throw new AdmissionError(
      "ATTN_WRITE_CAPABILITY_REQUIRED",
      `write capability required for room ${ctx.roomId}`,
    );
  }
  throw new AdmissionError("ATTN_ADMISSION_INVALID", `admission HMAC mismatch for room ${ctx.roomId}`);
}

export function parseAdmissionHeaderV3(
  value: string | null,
): { scope: AdmissionScopeV3; mac: Uint8Array } {
  if (value === null || value === "") {
    throw new AdmissionError("ATTN_ADMISSION_INVALID", "missing Attn-Admission header");
  }
  const parts = value.split(".");
  if (parts.length !== 3 || parts[0] !== "v3" || (parts[1] !== "read" && parts[1] !== "write")) {
    throw new AdmissionError("ATTN_ADMISSION_INVALID", "Attn-Admission must be v3.read.MAC or v3.write.MAC");
  }
  let mac: Uint8Array;
  try {
    mac = base64UrlDecode(parts[2] ?? "");
  } catch (err) {
    throw new AdmissionError("ATTN_ADMISSION_INVALID", `Attn-Admission base64url decode failed: ${(err as Error).message}`);
  }
  if (mac.length !== HMAC_BYTE_LEN) {
    throw new AdmissionError("ATTN_ADMISSION_INVALID", `Attn-Admission HMAC must be ${HMAC_BYTE_LEN} bytes (got ${mac.length})`);
  }
  return { scope: parts[1], mac };
}

/**
 * Parse `v2.<base64url-hmac>`. Returns the 32-byte HMAC.
 * Throws AdmissionError with `ATTN_ADMISSION_INVALID` on any parse failure
 * (missing, wrong version, bad base64url, wrong length).
 */
export function parseAdmissionHeader(value: string | null): Uint8Array {
  if (value === null || value === "") {
    throw new AdmissionError(
      "ATTN_ADMISSION_INVALID",
      "missing Attn-Admission header",
    );
  }
  const dot = value.indexOf(".");
  if (dot < 0) {
    throw new AdmissionError(
      "ATTN_ADMISSION_INVALID",
      "Attn-Admission missing version separator",
    );
  }
  const version = value.slice(0, dot);
  if (version !== ADMISSION_VERSION) {
    throw new AdmissionError(
      "ATTN_ADMISSION_INVALID",
      `unsupported Attn-Admission version: ${version}`,
    );
  }
  const encoded = value.slice(dot + 1);
  if (encoded === "") {
    throw new AdmissionError(
      "ATTN_ADMISSION_INVALID",
      "Attn-Admission has empty HMAC",
    );
  }
  let bytes: Uint8Array;
  try {
    bytes = base64UrlDecode(encoded);
  } catch (err) {
    throw new AdmissionError(
      "ATTN_ADMISSION_INVALID",
      `Attn-Admission base64url decode failed: ${(err as Error).message}`,
    );
  }
  if (bytes.length !== HMAC_BYTE_LEN) {
    throw new AdmissionError(
      "ATTN_ADMISSION_INVALID",
      `Attn-Admission HMAC must be ${HMAC_BYTE_LEN} bytes (got ${bytes.length})`,
    );
  }
  return bytes;
}

// --- helpers --------------------------------------------------------------

/**
 * Canonicalize URLSearchParams into a deterministic `k=v&k2=v2` string.
 * - keys sorted lexicographically by their RAW (unencoded) value
 * - ties broken by raw value lexicographic order
 * - each key and value percent-encoded per RFC 3986 (only unreserved left raw)
 *
 * Empty params produce the empty string (no trailing newline added here —
 * the canonicalRequest builder owns separators).
 */
export function canonicalizeQuery(params: URLSearchParams): string {
  const pairs: Array<[string, string]> = [];
  for (const [k, v] of params) {
    pairs.push([k, v]);
  }
  pairs.sort((a, b) => {
    if (a[0] < b[0]) return -1;
    if (a[0] > b[0]) return 1;
    if (a[1] < b[1]) return -1;
    if (a[1] > b[1]) return 1;
    return 0;
  });
  return pairs
    .map(([k, v]) => `${rfc3986Encode(k)}=${rfc3986Encode(v)}`)
    .join("&");
}

/**
 * Percent-encode per RFC 3986 §2.3 unreserved set:
 *   ALPHA / DIGIT / "-" / "." / "_" / "~"
 *
 * `encodeURIComponent` leaves `!`, `*`, `'`, `(`, `)` raw, which RFC 3986
 * classifies as sub-delims (reserved). We fix that up by re-encoding them.
 */
export function rfc3986Encode(s: string): string {
  return encodeURIComponent(s).replace(
    /[!*'()]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** Constant-time byte equality. */
export function constantTimeEquals(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}

/** Decode unpadded base64url into bytes. */
export function base64UrlDecode(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) {
    throw new Error("invalid base64url character");
  }
  const padded = s + "=".repeat((4 - (s.length % 4)) % 4);
  const std = padded.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(std);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

/** Encode bytes as unpadded base64url. Exported for test helpers / tooling. */
export function base64UrlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) {
    bin += String.fromCharCode(bytes[i] ?? 0);
  }
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmacMatches(
  rawKey: Uint8Array,
  canonical: Uint8Array,
  provided: Uint8Array,
): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    "raw",
    rawKey,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const expected = new Uint8Array(await crypto.subtle.sign("HMAC", key, canonical));
  return constantTimeEquals(expected, provided);
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}
