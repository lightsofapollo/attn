import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import {
  base64UrlDecode,
  base64UrlEncode,
  expandShareLinkKeys,
  toCanonicalBytes,
  type ShareLinkKeys,
  type ShareLinkTier,
} from './browser-crypto';

export interface ParsedShareInvite {
  shareId: string;
  /** Tier-specific public bearer. Never the owner's share root. */
  linkSecret: Uint8Array;
}

export interface ShareInviteWindowLike {
  location: { href: string; pathname: string; search: string; hash: string };
  history: { state?: unknown; replaceState(data: unknown, unused: string, url?: string | URL | null): void };
}

/** history.state field carrying the stripped link secret so a same-tab
 * reload (or back/forward) can rejoin instead of dead-ending. history.state
 * never appears in the URL bar, referrers, or copied links — it lives in the
 * tab's session history, the same place the fragment sat before the strip. */
const STRIPPED_KEY_STATE_FIELD = '__attnShareLinkKey';

/** Parse and synchronously strip a durable-share fragment before any network work. */
export function parseAndStripShareInvite(windowLike: ShareInviteWindowLike): ParsedShareInvite {
  const invite = parseShareInvite(windowLike.location.href);
  const prior = windowLike.history.state;
  const carried: Record<string, unknown> =
    typeof prior === 'object' && prior !== null ? { ...(prior as Record<string, unknown>) } : {};
  carried[STRIPPED_KEY_STATE_FIELD] = base64UrlEncode(invite.linkSecret);
  windowLike.history.replaceState(carried, '',
    `${windowLike.location.pathname}${windowLike.location.search}`);
  return invite;
}

/**
 * Recover the invite for a fragmentless `/s/<shareId>` boot from the key a
 * previous `parseAndStripShareInvite` stashed in this tab's history entry.
 * Returns null when this tab never held the key (fresh paste without the
 * fragment, notification click, different tab).
 */
export function recoverStrippedShareInvite(windowLike: ShareInviteWindowLike): ParsedShareInvite | null {
  const state = windowLike.history.state;
  if (typeof state !== 'object' || state === null) return null;
  const encoded = (state as Record<string, unknown>)[STRIPPED_KEY_STATE_FIELD];
  if (typeof encoded !== 'string' || encoded.length === 0) return null;
  const match = /^\/s\/([^/]+)$/u.exec(windowLike.location.pathname);
  if (!match) return null;
  let origin: string;
  try {
    origin = new URL(windowLike.location.href).origin;
  } catch {
    return null;
  }
  try {
    return parseShareInvite(`${origin}/s/${match[1]!}#key=${encoded}`);
  } catch {
    return null;
  }
}

export class ShareInviteParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShareInviteParseError';
  }
}

const BROWSER_SHARE_HOSTS = new Set(['attn.sh', 'staging.attn.sh']);

export function parseShareInvite(raw: string): ParsedShareInvite {
  if (typeof raw !== 'string' || raw.length === 0) fail('share URL must be non-empty');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    fail('invalid share URL');
  }
  let shareId: string;
  if (
    url.protocol === 'attn:' && url.hostname === 'share' && url.username === '' &&
    url.password === '' && url.port === '' && url.search === ''
  ) {
    shareId = url.pathname.slice(1);
  } else if (
    url.protocol === 'https:' && BROWSER_SHARE_HOSTS.has(url.hostname) && url.port === '' &&
    url.username === '' && url.password === '' && url.search === ''
  ) {
    const match = /^\/s\/([^/]+)$/u.exec(url.pathname);
    if (!match) fail('browser share URL must use /s/<shareId>');
    shareId = match[1]!;
  } else {
    fail('share URL must use attn://share or an attn browser origin without credentials, port, or query');
  }
  validateShareId(shareId);
  if (!url.hash.startsWith('#key=')) fail('share fragment must be exactly key=<secret>');
  const encoded = url.hash.slice('#key='.length);
  if (encoded.includes('&') || encoded.includes('=')) fail('share fragment is not canonical');
  const canonical = url.protocol === 'attn:'
    ? `attn://share/${shareId}#key=${encoded}`
    : `${url.origin}/s/${shareId}#key=${encoded}`;
  if (raw !== canonical) fail('share URL must use its exact canonical spelling');
  let linkSecret: Uint8Array;
  try {
    linkSecret = base64UrlDecode(encoded);
  } catch {
    fail('link secret must be canonical base64url');
  }
  if (linkSecret.length !== 32 || !isCanonicalBase64Url(encoded, 32)) {
    linkSecret.fill(0);
    fail('link secret must decode to 32 bytes');
  }
  return { shareId, linkSecret };
}

export function composeShareInvite(
  shareId: string,
  linkSecret: Uint8Array,
  browserOrigin?: string,
): string {
  validateShareId(shareId);
  if (!(linkSecret instanceof Uint8Array) || linkSecret.length !== 32) {
    fail('link secret must be 32 bytes');
  }
  const fragment = `key=${base64UrlEncode(linkSecret)}`;
  if (browserOrigin === undefined) return `attn://share/${shareId}#${fragment}`;
  let url: URL;
  try {
    url = new URL(browserOrigin);
  } catch {
    fail('invalid browser origin');
  }
  if (
    url.protocol !== 'https:' ||
    !BROWSER_SHARE_HOSTS.has(url.hostname) ||
    url.port !== '' ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    fail('browser origin must be a bare HTTPS origin');
  }
  url.pathname = `/s/${shareId}`;
  url.hash = fragment;
  return url.href;
}

export function deriveInviteLinkKeys(invite: ParsedShareInvite, tier: ShareLinkTier): ShareLinkKeys {
  return expandShareLinkKeys(invite.linkSecret, tier);
}

export interface ShareCapabilityBundle {
  v: 3;
  purpose: 'attn share capability bundle v3';
  bundleId: string;
  ownerSigningKey: string;
  shareId: string;
  epoch: number;
  revision: number;
  manifestDigest: string;
  tier: ShareLinkTier;
  roomId: string;
  readCapabilityKey: string;
  writeAdmissionKey?: string;
  grantSignature?: string;
}

const BUNDLE_AAD_PREFIX = new TextEncoder().encode('attn share sealed bundle v3\0');
const MAX_SEALED_BUNDLE_BYTES = 64 * 1024;
const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function decodeCanonical(value: string, bytes: number, label: string): void {
  if (!isCanonicalBase64Url(value, bytes)) fail(`${label} must encode ${bytes} bytes`);
  let decoded: Uint8Array;
  try { decoded = base64UrlDecode(value); } catch { fail(`${label} must be canonical base64url`); }
  try {
    if (decoded.length !== bytes) fail(`${label} must encode ${bytes} bytes`);
  } finally {
    decoded.fill(0);
  }
}

function validateBundle(bundle: ShareCapabilityBundle): void {
  const allowed = new Set([
    'v', 'purpose', 'bundleId', 'ownerSigningKey', 'shareId', 'epoch', 'revision',
    'manifestDigest', 'tier', 'roomId',
    'readCapabilityKey', 'writeAdmissionKey', 'grantSignature',
  ]);
  if (Object.keys(bundle).some(key => !allowed.has(key))) fail('capability bundle contains unknown fields');
  if (bundle.v !== 3 || bundle.purpose !== 'attn share capability bundle v3') fail('capability bundle version or purpose is invalid');
  validateShareId(bundle.shareId);
  decodeCanonical(bundle.bundleId, 16, 'bundleId');
  decodeCanonical(bundle.manifestDigest, 32, 'manifestDigest');
  decodeCanonical(bundle.roomId, 16, 'roomId');
  decodeCanonical(bundle.ownerSigningKey, 32, 'ownerSigningKey');
  decodeCanonical(bundle.readCapabilityKey, 32, 'readCapabilityKey');
  if (!Number.isSafeInteger(bundle.epoch) || bundle.epoch < 0) fail('epoch must be a non-negative safe integer');
  if (!Number.isSafeInteger(bundle.revision) || bundle.revision < 0) fail('revision must be a non-negative safe integer');
  if (bundle.tier === 'view') {
    if (bundle.writeAdmissionKey !== undefined || bundle.grantSignature !== undefined) fail('view bundle must not contain write capability or grant');
  } else if (bundle.tier === 'comment' || bundle.tier === 'suggest') {
    if (bundle.writeAdmissionKey === undefined || bundle.grantSignature === undefined) fail('writable bundle requires write capability and grant');
    decodeCanonical(bundle.writeAdmissionKey, 32, 'writeAdmissionKey');
    decodeCanonical(bundle.grantSignature, 64, 'grantSignature');
  } else {
    fail('invalid capability bundle tier');
  }
}

function bundleAad(shareId: string, bundleId: string): Uint8Array {
  const share = new TextEncoder().encode(shareId);
  const id = new TextEncoder().encode(bundleId);
  const aad = new Uint8Array(BUNDLE_AAD_PREFIX.length + share.length + 1 + id.length);
  aad.set(BUNDLE_AAD_PREFIX, 0);
  aad.set(share, BUNDLE_AAD_PREFIX.length);
  aad[BUNDLE_AAD_PREFIX.length + share.length] = 0;
  aad.set(id, BUNDLE_AAD_PREFIX.length + share.length + 1);
  return aad;
}

export function sealShareCapabilityBundle(
  bundleKey: Uint8Array,
  bundleId: string,
  bundle: ShareCapabilityBundle,
  nonce: Uint8Array,
): string {
  if (bundleKey.length !== 32 || nonce.length !== 24) fail('bundle key/nonce length invalid');
  decodeCanonical(bundleId, 16, 'bundleId');
  validateBundle(bundle);
  if (bundle.bundleId !== bundleId) fail('capability bundle id mismatch');
  const plaintext = toCanonicalBytes(bundle);
  const aad = bundleAad(bundle.shareId, bundleId);
  let ciphertext: Uint8Array | null = null;
  let sealed: Uint8Array | null = null;
  try {
    ciphertext = xchacha20poly1305(bundleKey, nonce, aad)
      .encrypt(plaintext);
    sealed = new Uint8Array(nonce.length + ciphertext.length);
    sealed.set(nonce, 0);
    sealed.set(ciphertext, nonce.length);
    return base64UrlEncode(sealed);
  } finally {
    plaintext.fill(0);
    aad.fill(0);
    ciphertext?.fill(0);
    sealed?.fill(0);
  }
}

export function openShareCapabilityBundle(
  bundleKey: Uint8Array,
  bundleId: string,
  expected: { shareId: string; epoch: number; revision: number; manifestDigest: string; tier: ShareLinkTier },
  sealedBundle: string,
): ShareCapabilityBundle {
  if (bundleKey.length !== 32) fail('bundle key length invalid');
  decodeCanonical(bundleId, 16, 'bundleId');
  decodeCanonical(expected.manifestDigest, 32, 'manifestDigest');
  validateShareId(expected.shareId);
  if (
    typeof sealedBundle !== 'string' || sealedBundle.length < 54 ||
    sealedBundle.length > Math.ceil(MAX_SEALED_BUNDLE_BYTES * 4 / 3) ||
    !/^[A-Za-z0-9_-]+$/u.test(sealedBundle)
  ) fail('sealed bundle is truncated, oversized, or noncanonical');
  let sealed: Uint8Array;
  try { sealed = base64UrlDecode(sealedBundle); }
  catch { fail('sealed bundle is not canonical base64url'); }
  if (sealed.length < 40 || sealed.length > MAX_SEALED_BUNDLE_BYTES ||
    !isCanonicalBase64Url(sealedBundle, sealed.length)) {
    sealed.fill(0);
    fail('sealed bundle is truncated or oversized');
  }
  let plaintext: Uint8Array | null = null;
  const aad = bundleAad(expected.shareId, bundleId);
  try {
    plaintext = xchacha20poly1305(
      bundleKey,
      sealed.subarray(0, 24),
      aad,
    ).decrypt(sealed.subarray(24));
  } catch {
    fail('capability bundle open failed');
  } finally {
    sealed.fill(0);
    aad.fill(0);
  }
  let bundle: ShareCapabilityBundle;
  try { bundle = JSON.parse(new TextDecoder().decode(plaintext)) as ShareCapabilityBundle; }
  catch { fail('capability bundle plaintext is invalid'); }
  finally { plaintext.fill(0); }
  validateBundle(bundle);
  if (bundle.bundleId !== bundleId || bundle.shareId !== expected.shareId
    || bundle.epoch !== expected.epoch || bundle.revision !== expected.revision
    || bundle.manifestDigest !== expected.manifestDigest || bundle.tier !== expected.tier) {
    fail('capability bundle context mismatch');
  }
  return bundle;
}

function validateShareId(shareId: string): void {
  if (!isCanonicalBase64Url(shareId, 16)) fail('shareId must be canonical base64url for 16 bytes');
  let decoded: Uint8Array;
  try {
    decoded = base64UrlDecode(shareId);
  } catch {
    fail('shareId must be canonical base64url');
  }
  try {
    if (decoded.length !== 16) fail('shareId must be canonical base64url for 16 bytes');
  } finally {
    decoded.fill(0);
  }
}

function isCanonicalBase64Url(value: string, bytes: number): boolean {
  const expectedLength = Math.ceil(bytes * 8 / 6);
  if (value.length !== expectedLength || !/^[A-Za-z0-9_-]+$/u.test(value)) return false;
  const final = BASE64URL_ALPHABET.indexOf(value.at(-1)!);
  if (final < 0) return false;
  const remainder = bytes % 3;
  return remainder === 1 ? (final & 0x0f) === 0 : remainder === 2 ? (final & 0x03) === 0 : true;
}

function fail(message: string): never {
  throw new ShareInviteParseError(message);
}
