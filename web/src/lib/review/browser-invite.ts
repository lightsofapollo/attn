// Browser-safe helpers for the review invite URL handshake.
//
// Pins:
//   - `planning/collab/crypto-spec.md` §Invite URLs
//   - `planning/collab/amendments.md` #13 (memory-only browser secret)
//
// The invite URL carries `roomSecret` in the URL fragment so it never
// touches the relay (the fragment is not sent over the network by browsers).
// On open, the browser reviewer:
//   1. Parses the fragment.
//   2. **Immediately** strips the fragment via `history.replaceState(...)`
//      so the secret stops appearing in the visible URL bar / window title /
//      `referer` of any subsequent same-document navigation.
//   3. Holds `roomSecret` only as a `Uint8Array` in the JS heap. There is no
//      `sessionStorage`, no `IndexedDB`, no cookie — reload requires re-paste.
//
// This module deliberately:
//   - Does **not** import any crypto primitives. Deriving `rootKey` is the
//     caller's job (see `crypto-spec.md` §Key Derivation). Once derived, the
//     caller should `zero(secret)` to clobber the raw secret bytes.
//   - Skips the Rust side's `roomId == derive_room_id(secret)` cross-check.
//     That requires SHA-256 (async via WebCrypto in browsers) and belongs in
//     the caller, *after* the keys are derived. Catching a corrupted invite
//     happens implicitly: a wrong secret produces a wrong `admissionKey`, so
//     the relay rejects the first request.
//
// Tests: `browser-invite.test.ts`. Run with:
//
//   cd web && npx tsx src/lib/review/browser-invite.test.ts

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ParsedInvite {
  roomId: string;
  /** 32 bytes (per crypto-spec §Key Derivation). */
  roomSecret: Uint8Array;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class InviteParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InviteParseError';
  }
}

// ---------------------------------------------------------------------------
// URL shape constants
//
// Per crypto-spec §Invite URLs:
//   Native:  attn://review/<roomId>#key=<base64url(roomSecret)>
//   Browser: https://attn.dev/review/<roomId>#key=<base64url(roomSecret)>
//
// We accept any HTTPS host for the browser form so the helper can be reused by
// staging / preview deployments. The native scheme is matched strictly.
// ---------------------------------------------------------------------------

const NATIVE_PREFIX = 'attn://review/';
const BROWSER_PATH_PREFIX = '/review/';
const FRAGMENT_KEY_PREFIX = 'key=';
const ROOM_SECRET_LEN = 32;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a raw invite URL into its `roomId` + `roomSecret` parts. Strict: any
 * malformed input throws `InviteParseError`.
 *
 * Accepts both `attn://review/<id>#key=<b64>` and
 * `https://<host>/review/<id>#key=<b64>` shapes.
 */
export function parseInviteUrl(url: string): ParsedInvite {
  if (typeof url !== 'string' || url.length === 0) {
    throw new InviteParseError('invite url must be a non-empty string');
  }

  const { roomIdRaw, fragment } = splitInvite(url);
  if (roomIdRaw.length === 0) {
    throw new InviteParseError('empty roomId');
  }
  if (fragment === null) {
    throw new InviteParseError('missing key fragment');
  }
  if (!fragment.startsWith(FRAGMENT_KEY_PREFIX)) {
    throw new InviteParseError('fragment must start with `key=`');
  }
  const keyB64 = fragment.slice(FRAGMENT_KEY_PREFIX.length);
  if (keyB64.length === 0) {
    throw new InviteParseError('empty key in fragment');
  }

  let roomSecret: Uint8Array;
  try {
    roomSecret = base64UrlDecode(keyB64);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new InviteParseError(`key base64url decode: ${message}`);
  }
  if (roomSecret.length !== ROOM_SECRET_LEN) {
    throw new InviteParseError(
      `room secret must decode to ${ROOM_SECRET_LEN} bytes, got ${roomSecret.length}`,
    );
  }

  return {
    roomId: roomIdRaw,
    roomSecret,
  };
}

/**
 * Parse the current page URL on load, strip the fragment via
 * `history.replaceState`, and return the parsed invite. Returns `null` when
 * there is no `#key=` fragment (e.g. a normal landing page visit). Every
 * non-empty fragment is stripped before inspection so malformed or future
 * secret-bearing shapes cannot linger in browser history or the URL bar.
 *
 * Per amendments #13: the caller is responsible for keeping the returned
 * `roomSecret` strictly in memory. No persistence anywhere. Reload requires
 * re-paste.
 */
export function parseAndStripInviteFromUrl(
  win: BrowserWindowLike = globalThis as unknown as BrowserWindowLike,
): ParsedInvite | null {
  const loc = win.location;
  if (!loc) return null;

  const hash = loc.hash ?? '';
  if (hash.length === 0 || hash === '#') return null;

  // `location.hash` includes the leading `#`. Strip it so `parseInviteUrl`
  // sees the same fragment shape `splitInvite` produces.
  const fragment = hash.startsWith('#') ? hash.slice(1) : hash;
  stripFragment(win);
  if (!fragment.startsWith(FRAGMENT_KEY_PREFIX)) return null;

  // Reconstruct the full URL so `parseInviteUrl` validates the path shape
  // identically to a pasted invite. We use the current origin + pathname.
  const origin = loc.origin ?? '';
  const pathname = loc.pathname ?? '';
  const search = loc.search ?? '';
  const fullUrl = `${origin}${pathname}${search}#${fragment}`;

  return parseInviteUrl(fullUrl);
}

/**
 * Strip the URL fragment via `history.replaceState`. Exposed separately so
 * callers can sanitize the URL bar even when the invite parse fails.
 *
 * No-op when `history` / `location` are unavailable (e.g. SSR / non-browser).
 */
export function stripFragment(
  win: BrowserWindowLike = globalThis as unknown as BrowserWindowLike,
): void {
  const history = win.history;
  const loc = win.location;
  if (!history || !loc || typeof history.replaceState !== 'function') return;
  const cleaned = `${loc.pathname ?? ''}${loc.search ?? ''}`;
  history.replaceState(null, '', cleaned);
}

/**
 * Compose an invite URL from its parts. `base` must be either `attn://review`
 * (native) or an `https://<host>/review` prefix (browser). Trailing slashes
 * are normalized.
 */
export function composeInviteUrl(
  base: string,
  roomId: string,
  roomSecret: Uint8Array,
): string {
  if (typeof base !== 'string' || base.length === 0) {
    throw new InviteParseError('base must be a non-empty string');
  }
  if (typeof roomId !== 'string' || roomId.length === 0) {
    throw new InviteParseError('roomId must be a non-empty string');
  }
  if (!(roomSecret instanceof Uint8Array) || roomSecret.length !== ROOM_SECRET_LEN) {
    throw new InviteParseError(
      `roomSecret must be a ${ROOM_SECRET_LEN}-byte Uint8Array`,
    );
  }
  const trimmedBase = base.endsWith('/') ? base.slice(0, -1) : base;
  const encodedKey = base64UrlEncode(roomSecret);
  return `${trimmedBase}/${roomId}#${FRAGMENT_KEY_PREFIX}${encodedKey}`;
}

/**
 * Overwrite a secret buffer with zeros. JS has no real way to guarantee a
 * value is purged from memory (the runtime may have copied it), but
 * clobbering the visible bytes prevents the most common leak vectors
 * (string interning, post-mortem heap dumps, dev-tools snapshots).
 *
 * Callers should call this once they've derived `rootKey` (and any subkeys)
 * from `roomSecret`.
 */
export function zero(secret: Uint8Array): void {
  if (!(secret instanceof Uint8Array)) return;
  secret.fill(0);
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface BrowserLocationLike {
  hash?: string;
  origin?: string;
  pathname?: string;
  search?: string;
}

interface BrowserHistoryLike {
  replaceState?: (data: unknown, unused: string, url?: string | null) => void;
}

export interface BrowserWindowLike {
  location?: BrowserLocationLike;
  history?: BrowserHistoryLike;
  addEventListener?: (type: string, listener: () => void) => void;
  removeEventListener?: (type: string, listener: () => void) => void;
}

interface SplitResult {
  roomIdRaw: string;
  /** `null` when the URL had no `#…` fragment at all. */
  fragment: string | null;
}

/**
 * Pull `<roomId>` and `<fragment>` out of an invite URL, validating only the
 * outer shape (scheme + path prefix). Detailed key parsing lives in
 * `parseInviteUrl`.
 */
function splitInvite(url: string): SplitResult {
  // Native: attn://review/<rest>
  if (url.startsWith(NATIVE_PREFIX)) {
    const rest = url.slice(NATIVE_PREFIX.length);
    return splitFragment(rest);
  }

  // Browser: https://<host>/review/<rest>  (also accept http:// for tests/dev)
  if (url.startsWith('https://') || url.startsWith('http://')) {
    // Use the WHATWG URL parser so we don't have to hand-roll host parsing.
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new InviteParseError(`malformed URL: ${url}`);
    }
    if (!parsed.pathname.startsWith(BROWSER_PATH_PREFIX)) {
      throw new InviteParseError(
        `path must start with ${BROWSER_PATH_PREFIX} (got ${parsed.pathname})`,
      );
    }
    const rest = parsed.pathname.slice(BROWSER_PATH_PREFIX.length);
    // `URL.hash` includes the leading `#` (or is empty). Normalize to match
    // what we expect from the native form.
    const fragment =
      parsed.hash.length === 0
        ? null
        : parsed.hash.startsWith('#')
          ? parsed.hash.slice(1)
          : parsed.hash;
    return { roomIdRaw: rest, fragment };
  }

  throw new InviteParseError(
    `unsupported scheme — expected attn://review/ or https://…/review/ (got: ${truncate(url, 40)})`,
  );
}

function splitFragment(rest: string): SplitResult {
  const hashIdx = rest.indexOf('#');
  if (hashIdx < 0) {
    return { roomIdRaw: rest, fragment: null };
  }
  return {
    roomIdRaw: rest.slice(0, hashIdx),
    fragment: rest.slice(hashIdx + 1),
  };
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

// ---------------------------------------------------------------------------
// base64url codec (no-pad)
//
// Matches the Rust side's `URL_SAFE_NO_PAD` (`base64::engine::general_purpose`)
// and the rest of the spec's `base64url` usage. Pure JS so this module stays
// usable in any browser context (no WebCrypto dependency).
// ---------------------------------------------------------------------------

function base64UrlEncode(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) {
    bin += String.fromCharCode(bytes[i]!);
  }
  // `btoa` exists in browsers + Node ≥ 16 + tsx.
  const b64 = btoa(bin);
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(s: string): Uint8Array {
  // Reject characters outside the base64url alphabet outright so a "looks
  // close but not really" key fails fast rather than producing partial bytes.
  if (!/^[A-Za-z0-9_-]+$/.test(s)) {
    throw new Error('invalid base64url characters');
  }
  // Convert to standard base64 and pad to a multiple of 4.
  let std = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = std.length % 4;
  if (pad === 2) std += '==';
  else if (pad === 3) std += '=';
  else if (pad === 1) {
    // A length-of-4n+1 base64 string is invalid (cannot encode any whole byte
    // count). Reject explicitly so the error surfaces here rather than as a
    // confusing "decoded to N bytes" message.
    throw new Error('invalid base64url length');
  }
  let bin: string;
  try {
    bin = atob(std);
  } catch {
    throw new Error('invalid base64url encoding');
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}
