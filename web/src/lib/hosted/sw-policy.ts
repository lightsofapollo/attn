// Service-worker caching policy (attn-7xl.6.2) — pure and unit-tested.
//
// The cache may hold exactly two kinds of things:
//   1. immutable hashed build assets (and self-hosted font files), and
//   2. the three entry shells' HTML as a last-known offline fallback.
//
// Nothing else. User content never transits same-origin HTTP (it lives in
// IndexedDB/OPFS), the relay is cross-origin (out of SW scope by origin
// check), and invite secrets live in URL fragments which never reach the
// network or the service worker — but the policy still refuses query strings
// and unknown paths outright, so a future mistake fails closed.

export const SHELL_CACHE = 'attn-shell-v1';
export const ASSET_CACHE = 'attn-assets-v1';

/** Hashed immutable build output: /assets/name-HASH.ext (fonts included). */
const IMMUTABLE_ASSET = /^\/assets\/[\w.-]+-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/u;

/** Small static files that are safe and useful for an installed shell. */
const STATIC_SHELL_FILES = new Set([
  '/manifest.webmanifest',
  '/favicon.png',
  '/icon.png',
  '/icon-192.png',
  '/icon-512.png',
  '/apple-touch-icon.png',
]);

export type FetchDecision =
  | { kind: 'asset-cache-first' }
  | { kind: 'navigation-network-first'; shellPath: '/' | '/app/' | '/review/' }
  | { kind: 'bypass' };

export function decideFetch(input: {
  method: string;
  url: string;
  mode: RequestMode | string;
  swOrigin: string;
}): FetchDecision {
  if (input.method !== 'GET') return { kind: 'bypass' };
  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    return { kind: 'bypass' };
  }
  // Cross-origin (relay, anything else): never intercepted.
  if (url.origin !== input.swOrigin) return { kind: 'bypass' };
  // Query strings could smuggle state; the app never needs them cached.
  if (url.search.length > 0) return { kind: 'bypass' };

  if (input.mode === 'navigate') {
    return { kind: 'navigation-network-first', shellPath: shellPathFor(url.pathname) };
  }
  if (IMMUTABLE_ASSET.test(url.pathname) || STATIC_SHELL_FILES.has(url.pathname)) {
    return { kind: 'asset-cache-first' };
  }
  return { kind: 'bypass' };
}

/** Which cached shell serves an offline navigation. */
export function shellPathFor(pathname: string): '/' | '/app/' | '/review/' {
  if (/^\/(?:review|s)(?:\/|$)/u.test(pathname)) return '/review/';
  if (/^\/(?:app|open)(?:\/|$)/u.test(pathname)) return '/app/';
  return '/';
}

/** A response may enter the shell cache only if it is a clean same-origin
 * 200 HTML document. Errors and opaque/redirect responses never do. */
export function mayCacheShellResponse(input: {
  ok: boolean;
  status: number;
  type: string;
  contentType: string | null;
}): boolean {
  return (
    input.ok &&
    input.status === 200 &&
    input.type === 'basic' &&
    (input.contentType ?? '').includes('text/html')
  );
}

/** Assets must be clean same-origin 200s too. */
export function mayCacheAssetResponse(input: { ok: boolean; status: number; type: string }): boolean {
  return input.ok && input.status === 200 && input.type === 'basic';
}
