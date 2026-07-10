/**
 * Private Worker -> RoomDO browser-origin context.
 *
 * Cloudflare rewrites the standard `Origin` header when a Worker forwards a
 * WebSocket upgrade to a Durable Object. The Worker therefore snapshots the
 * public edge value into this private header, overwriting any client-supplied
 * value. RoomDO must never use the standard `Origin` header for browser
 * authorization.
 */
export const INTERNAL_EDGE_ORIGIN_HEADER = "X-Attn-Edge-Origin";

const NATIVE_CONTEXT = "v1.native";
const INVALID_CONTEXT = "v1.invalid";
const BROWSER_CONTEXT_PREFIX = "v1.browser.";
const MAX_ORIGIN_UTF8_BYTES = 512;

export type EdgeOriginContext =
  | { kind: "native" }
  | { kind: "browser"; origin: string }
  | { kind: "invalid" };

function canonicalBrowserOrigin(raw: string): string | undefined {
  if (
    raw === "" ||
    raw === "null" ||
    raw.includes(",") ||
    new TextEncoder().encode(raw).byteLength > MAX_ORIGIN_UTF8_BYTES
  ) {
    return undefined;
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return undefined;
  }

  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    parsed.pathname !== "/" ||
    raw !== parsed.origin
  ) {
    return undefined;
  }

  return raw;
}

function encodeBase64UrlUtf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

function decodeBase64UrlUtf8(value: string): string | undefined {
  if (value === "" || !/^[A-Za-z0-9_-]+$/u.test(value)) return undefined;

  const paddingLength = (4 - (value.length % 4)) % 4;
  let binary: string;
  try {
    binary = atob(value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(paddingLength));
  } catch {
    return undefined;
  }

  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return undefined;
  }

  // Reject non-canonical base64url spellings as an internal-context error.
  return encodeBase64UrlUtf8(decoded) === value ? decoded : undefined;
}

/** Encode the public request's Origin into an unambiguous private context. */
export function encodeEdgeOriginContext(origin: string | null): string {
  if (origin === null) return NATIVE_CONTEXT;
  const canonical = canonicalBrowserOrigin(origin);
  if (canonical === undefined) return INVALID_CONTEXT;
  return `${BROWSER_CONTEXT_PREFIX}${encodeBase64UrlUtf8(canonical)}`;
}

/**
 * Parse and defensively revalidate a Worker-provided private context.
 * `undefined` means the Worker/DO trust-boundary contract was missing or
 * malformed and must fail closed.
 */
export function parseEdgeOriginContext(value: string | null): EdgeOriginContext | undefined {
  if (value === NATIVE_CONTEXT) return { kind: "native" };
  if (value === INVALID_CONTEXT) return { kind: "invalid" };
  if (value === null || !value.startsWith(BROWSER_CONTEXT_PREFIX)) return undefined;

  const decoded = decodeBase64UrlUtf8(value.slice(BROWSER_CONTEXT_PREFIX.length));
  if (decoded === undefined || canonicalBrowserOrigin(decoded) !== decoded) return undefined;
  return { kind: "browser", origin: decoded };
}
