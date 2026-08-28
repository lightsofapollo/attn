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

import { deriveRoomId } from './browser-crypto';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ParsedInviteV2 {
  version: 2;
  roomId: string;
  /** 32 bytes (per crypto-spec §Key Derivation). */
  roomSecret: Uint8Array;
}

export type InviteTierV3 = 'view' | 'comment' | 'suggest';

export interface ParsedInviteFragmentV3 {
  version: 3;
  tier: InviteTierV3;
  readCapabilityKey: Uint8Array;
  /** Absent for `view`; required for `comment` and `suggest`. */
  writeAdmissionKey?: Uint8Array;
  /** Owner Ed25519 proof; absent for view and required for writable tiers. */
  grantSignature?: string;
  /**
   * The owner's public signing key, pinned from the invite (attn-lb7p).
   *
   * Kept as the base64url string rather than bytes: every hosted consumer of
   * an owner key takes a 43-char string (`verifyDeviceGrantV3`), and
   * re-encoding bytes risks a spelling that differs from what was signed.
   * Optional so a fragment minted before the field existed still parses.
   */
  ownerPublicSigningKey?: string;
}

export interface ParsedInviteV3 extends ParsedInviteFragmentV3 {
  roomId: string;
}

export type ParsedInvite = ParsedInviteV2 | ParsedInviteV3;

export interface InviteForms {
  roomId: string;
  browserUrl: string;
  nativeUrl: string;
  cliCommand: string;
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
const ROOM_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;
export const DEFAULT_BROWSER_INVITE_BASE = 'https://attn.sh/review';

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
  if (fragment.startsWith('v=3&')) {
    return { roomId: roomIdRaw, ...parseInviteFragmentV3(`#${fragment}`) };
  }
  if (!fragment.startsWith(FRAGMENT_KEY_PREFIX)) {
    throw new InviteParseError('fragment must start with `key=` or canonical `v=3&`');
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
    version: 2,
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
  if (!fragment.startsWith(FRAGMENT_KEY_PREFIX) && !fragment.startsWith('v=3&')) return null;

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
  if (!ROOM_ID_PATTERN.test(roomId)) {
    throw new InviteParseError('roomId must contain only base64url characters');
  }
  if (!(roomSecret instanceof Uint8Array) || roomSecret.length !== ROOM_SECRET_LEN) {
    throw new InviteParseError(
      `roomSecret must be a ${ROOM_SECRET_LEN}-byte Uint8Array`,
    );
  }
  if (deriveRoomId(roomSecret) !== roomId) {
    throw new InviteParseError('roomId does not match roomSecret');
  }
  const trimmedBase = validateInviteBase(base);
  const encodedKey = base64UrlEncode(roomSecret);
  return `${trimmedBase}/${roomId}#${FRAGMENT_KEY_PREFIX}${encodedKey}`;
}

/** Build the canonical additive v3 capability fragment, including `#`. */
export function composeInviteFragmentV3(
  tier: InviteTierV3,
  readCapabilityKey: Uint8Array,
  writeAdmissionKey?: Uint8Array,
  grantSignature?: Uint8Array,
  ownerPublicSigningKey?: Uint8Array,
): string {
  requireCapabilityKey(readCapabilityKey, 'read');
  if (tier !== 'view' && tier !== 'comment' && tier !== 'suggest') {
    throw new InviteParseError(`unknown v3 invite tier: ${String(tier)}`);
  }
  // Appended LAST in every form, matching build_invite_fragment_v3 in
  // src/review/bootstrap.rs byte for byte. Both parsers re-render through
  // their composer and compare, so a difference in field ORDER between the two
  // implementations is not a cosmetic drift — it makes each side reject the
  // other's invites.
  if (ownerPublicSigningKey !== undefined) {
    requireCapabilityKey(ownerPublicSigningKey, 'owner');
  }
  const ownerSuffix =
    ownerPublicSigningKey === undefined ? '' : `&owner=${base64UrlEncode(ownerPublicSigningKey)}`;
  if (tier === 'view') {
    if (writeAdmissionKey !== undefined || grantSignature !== undefined) {
      throw new InviteParseError('view tier must not include write capability or grant');
    }
    return `#v=3&tier=view&read=${base64UrlEncode(readCapabilityKey)}${ownerSuffix}`;
  }
  if (writeAdmissionKey === undefined) {
    throw new InviteParseError(`${tier} tier requires write capability`);
  }
  requireCapabilityKey(writeAdmissionKey, 'write');
  if (!(grantSignature instanceof Uint8Array) || grantSignature.length !== 64) {
    throw new InviteParseError(`${tier} tier requires a 64-byte owner grant signature`);
  }
  return `#v=3&tier=${tier}&read=${base64UrlEncode(readCapabilityKey)}&write=${base64UrlEncode(writeAdmissionKey)}&grant=${base64UrlEncode(grantSignature)}${ownerSuffix}`;
}

/** Compose a complete native or hosted v3 invite URL. */
export function composeInviteUrlV3(
  base: string,
  roomId: string,
  tier: InviteTierV3,
  readCapabilityKey: Uint8Array,
  writeAdmissionKey?: Uint8Array,
  grantSignature?: Uint8Array,
): string {
  if (!base || !roomId) throw new InviteParseError('base and roomId are required');
  const trimmedBase = base.endsWith('/') ? base.slice(0, -1) : base;
  return `${trimmedBase}/${roomId}${composeInviteFragmentV3(tier, readCapabilityKey, writeAdmissionKey, grantSignature)}`;
}

/** Parse only the new v3 fragment grammar; legacy `#key=` stays separate. */
export function parseInviteFragmentV3(fragment: string): ParsedInviteFragmentV3 {
  if (typeof fragment !== 'string' || !fragment.startsWith('#')) {
    throw new InviteParseError('v3 fragment must start with `#`');
  }
  const parts = fragment.slice(1).split('&');
  const fields = new Map<string, string>();
  for (const part of parts) {
    const pair = part.split('=');
    if (pair.length !== 2 || pair[0]!.length === 0 || pair[1]!.length === 0) {
      throw new InviteParseError('malformed v3 fragment field');
    }
    const [key, value] = pair as [string, string];
    if (!['v', 'tier', 'read', 'write', 'grant', 'owner'].includes(key)) {
      throw new InviteParseError(`unknown v3 fragment field: ${key}`);
    }
    if (fields.has(key)) throw new InviteParseError(`duplicate v3 fragment field: ${key}`);
    fields.set(key, value);
  }
  if (fields.get('v') !== '3') throw new InviteParseError('v3 fragment requires v=3');
  const tier = fields.get('tier');
  if (tier !== 'view' && tier !== 'comment' && tier !== 'suggest') {
    throw new InviteParseError(`unknown v3 invite tier: ${String(tier)}`);
  }
  const readCapabilityKey = decodeCapability(fields.get('read'), 'read');
  const write = fields.get('write');
  const writeAdmissionKey = write === undefined ? undefined : decodeCapability(write, 'write');
  const grant = fields.get('grant');
  const grantBytes = grant === undefined ? undefined : decodeGrant(grant);
  const owner = fields.get('owner');
  const ownerBytes = owner === undefined ? undefined : decodeCapability(owner, 'owner');
  const canonical = composeInviteFragmentV3(
    tier,
    readCapabilityKey,
    writeAdmissionKey,
    grantBytes,
    ownerBytes,
  );
  if (canonical !== fragment) {
    throw new InviteParseError('v3 fragment is not in canonical field order or encoding');
  }
  return {
    version: 3,
    tier,
    readCapabilityKey,
    ...(writeAdmissionKey === undefined ? {} : { writeAdmissionKey }),
    ...(grant === undefined ? {} : { grantSignature: grant }),
    ...(owner === undefined ? {} : { ownerPublicSigningKey: owner }),
  };
}

function decodeGrant(value: string): Uint8Array {
  let decoded: Uint8Array;
  try {
    decoded = base64UrlDecode(value);
  } catch (err) {
    throw new InviteParseError(`grant signature base64url decode: ${String(err)}`);
  }
  if (decoded.length !== 64) {
    throw new InviteParseError(`grant signature must decode to 64 bytes, got ${decoded.length}`);
  }
  return decoded;
}

/** Build every public invite representation from one room secret. */
export function composeInviteForms(
  roomSecret: Uint8Array,
  browserBase = DEFAULT_BROWSER_INVITE_BASE,
): InviteForms {
  if (!(roomSecret instanceof Uint8Array) || roomSecret.length !== ROOM_SECRET_LEN) {
    throw new InviteParseError(`roomSecret must be a ${ROOM_SECRET_LEN}-byte Uint8Array`);
  }
  const roomId = deriveRoomId(roomSecret);
  const nativeUrl = composeInviteUrl('attn://review', roomId, roomSecret);
  const browserUrl = composeInviteUrl(browserBase, roomId, roomSecret);
  return {
    roomId,
    browserUrl,
    nativeUrl,
    cliCommand: `npx attnmd review join '${nativeUrl}'`,
  };
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

function requireCapabilityKey(value: Uint8Array, field: string): void {
  if (!(value instanceof Uint8Array) || value.length !== 32) {
    throw new InviteParseError(`${field} capability must be a 32-byte Uint8Array`);
  }
}

function decodeCapability(value: string | undefined, field: string): Uint8Array {
  if (value === undefined) throw new InviteParseError(`missing ${field} capability`);
  let decoded: Uint8Array;
  try {
    decoded = base64UrlDecode(value);
  } catch (err) {
    throw new InviteParseError(`${field} capability base64url decode: ${String(err)}`);
  }
  requireCapabilityKey(decoded, field);
  return decoded;
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
      throw new InviteParseError('malformed invite URL');
    }
    if (!parsed.pathname.startsWith(BROWSER_PATH_PREFIX)) {
      throw new InviteParseError(`path must start with ${BROWSER_PATH_PREFIX}`);
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
    'unsupported scheme — expected attn://review/ or https://…/review/',
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

function validateInviteBase(base: string): string {
  const trimmed = base.endsWith('/') ? base.slice(0, -1) : base;
  if (trimmed === 'attn://review') return trimmed;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new InviteParseError('browser invite base must be an absolute URL');
  }
  const loopback =
    parsed.hostname === 'localhost'
    || parsed.hostname === '127.0.0.1'
    || parsed.hostname === '[::1]';
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
    throw new InviteParseError('browser invite base must use HTTPS or exact loopback HTTP');
  }
  if (
    parsed.username.length > 0
    || parsed.password.length > 0
    || parsed.search.length > 0
    || parsed.hash.length > 0
  ) {
    throw new InviteParseError('browser invite base cannot contain credentials, query, or fragment');
  }
  if (parsed.pathname.replace(/\/+$/u, '') !== '/review') {
    throw new InviteParseError('browser invite base path must be /review');
  }
  parsed.pathname = '/review';
  return parsed.toString().replace(/\/$/u, '');
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
