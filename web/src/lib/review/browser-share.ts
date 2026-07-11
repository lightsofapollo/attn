import { base64UrlDecode, base64UrlEncode, deriveShareEpochRoomSecret } from './browser-crypto';

export interface ParsedShareInvite {
  shareId: string;
  shareSecret: Uint8Array;
}

export class ShareInviteParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShareInviteParseError';
  }
}

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
    url.protocol === 'https:' && url.hostname === 'attn.sh' && url.port === '' &&
    url.username === '' && url.password === '' && url.search === ''
  ) {
    const match = /^\/s\/([^/]+)$/u.exec(url.pathname);
    if (!match) fail('browser share URL must use /s/<shareId>');
    shareId = match[1]!;
  } else {
    fail('share URL must use attn://share or https://attn.sh without credentials, port, or query');
  }
  validateShareId(shareId);
  if (!url.hash.startsWith('#key=')) fail('share fragment must be exactly key=<secret>');
  const encoded = url.hash.slice('#key='.length);
  if (encoded.includes('&') || encoded.includes('=')) fail('share fragment is not canonical');
  const canonical = url.protocol === 'attn:'
    ? `attn://share/${shareId}#key=${encoded}`
    : `https://attn.sh/s/${shareId}#key=${encoded}`;
  if (raw !== canonical) fail('share URL must use its exact canonical spelling');
  let shareSecret: Uint8Array;
  try {
    shareSecret = base64UrlDecode(encoded);
  } catch {
    fail('share secret must be canonical base64url');
  }
  if (shareSecret.length !== 32 || base64UrlEncode(shareSecret) !== encoded) {
    shareSecret.fill(0);
    fail('share secret must decode to 32 bytes');
  }
  return { shareId, shareSecret };
}

export function composeShareInvite(
  shareId: string,
  shareSecret: Uint8Array,
  browserOrigin?: string,
): string {
  validateShareId(shareId);
  if (!(shareSecret instanceof Uint8Array) || shareSecret.length !== 32) {
    fail('share secret must be 32 bytes');
  }
  const fragment = `key=${base64UrlEncode(shareSecret)}`;
  if (browserOrigin === undefined) return `attn://share/${shareId}#${fragment}`;
  let url: URL;
  try {
    url = new URL(browserOrigin);
  } catch {
    fail('invalid browser origin');
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'attn.sh' ||
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

export function deriveShareRoomSecret(invite: ParsedShareInvite, epoch: number): Uint8Array {
  return deriveShareEpochRoomSecret(invite.shareSecret, epoch);
}

function validateShareId(shareId: string): void {
  let decoded: Uint8Array;
  try {
    decoded = base64UrlDecode(shareId);
  } catch {
    fail('shareId must be canonical base64url');
  }
  if (decoded.length !== 16 || base64UrlEncode(decoded) !== shareId) {
    decoded.fill(0);
    fail('shareId must be canonical base64url for 16 bytes');
  }
}

function fail(message: string): never {
  throw new ShareInviteParseError(message);
}
