import {
  decideFetch,
  mayCacheAssetResponse,
  mayCacheShellResponse,
  shellPathFor,
} from './sw-policy';

function assertEq(actual: unknown, expected: unknown, label: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${label}: expected ${b}, got ${a}`);
}

const ORIGIN = 'https://attn.sh';
const base = { method: 'GET', swOrigin: ORIGIN, mode: 'no-cors' as const };

// Immutable hashed assets are cache-first.
assertEq(
  decideFetch({ ...base, url: `${ORIGIN}/assets/landing-DK6S2VJx.js` }),
  { kind: 'asset-cache-first' },
  'hashed js',
);
assertEq(
  decideFetch({ ...base, url: `${ORIGIN}/assets/source-serif-4-latin-wght-normal-CvbBwnfM.woff2` }),
  { kind: 'asset-cache-first' },
  'hashed font',
);
assertEq(
  decideFetch({ ...base, url: `${ORIGIN}/manifest.webmanifest` }),
  { kind: 'asset-cache-first' },
  'manifest',
);

// Navigations are network-first with the right shell fallback.
assertEq(
  decideFetch({ ...base, mode: 'navigate', url: `${ORIGIN}/app/w/ws1/docs/notes.md` }),
  { kind: 'navigation-network-first', shellPath: '/app/' },
  'deep app navigation',
);
assertEq(
  decideFetch({ ...base, mode: 'navigate', url: `${ORIGIN}/review/room-1` }),
  { kind: 'navigation-network-first', shellPath: '/review/' },
  'review navigation',
);
assertEq(
  decideFetch({ ...base, mode: 'navigate', url: `${ORIGIN}/anything` }),
  { kind: 'navigation-network-first', shellPath: '/' },
  'landing fallback',
);

// Forbidden: everything else bypasses the cache entirely.
assertEq(decideFetch({ ...base, method: 'POST', url: `${ORIGIN}/assets/a-12345678.js` }), { kind: 'bypass' }, 'non-GET');
assertEq(
  decideFetch({ ...base, url: 'https://relay.attn.sh/v2/rooms/x/envelopes' }),
  { kind: 'bypass' },
  'cross-origin relay',
);
assertEq(
  decideFetch({ ...base, url: `${ORIGIN}/assets/landing-DK6S2VJx.js?cap=secret` }),
  { kind: 'bypass' },
  'query strings never cached',
);
assertEq(decideFetch({ ...base, url: `${ORIGIN}/v2/rooms/abc` }), { kind: 'bypass' }, 'unknown path');
assertEq(decideFetch({ ...base, url: `${ORIGIN}/assets/no-hash.js` }), { kind: 'bypass' }, 'unhashed asset');
assertEq(decideFetch({ ...base, url: 'not a url' }), { kind: 'bypass' }, 'malformed url');

// Shell fallback keys.
assertEq(shellPathFor('/open'), '/app/', 'open uses app shell');
assertEq(shellPathFor('/reviewzzz'), '/', 'prefix does not leak');

// Response gating: errors and redirects never enter caches.
assertEq(
  mayCacheShellResponse({ ok: true, status: 200, type: 'basic', contentType: 'text/html; charset=utf-8' }),
  true,
  'clean shell cacheable',
);
assertEq(mayCacheShellResponse({ ok: false, status: 503, type: 'basic', contentType: 'text/html' }), false, 'errors never cached');
assertEq(mayCacheShellResponse({ ok: true, status: 200, type: 'opaqueredirect', contentType: 'text/html' }), false, 'redirects never cached');
assertEq(mayCacheShellResponse({ ok: true, status: 200, type: 'basic', contentType: 'application/json' }), false, 'non-HTML never shell-cached');
assertEq(mayCacheAssetResponse({ ok: true, status: 200, type: 'basic' }), true, 'clean asset cacheable');
assertEq(mayCacheAssetResponse({ ok: false, status: 404, type: 'basic' }), false, '404 asset never cached');

console.log('sw-policy: all cases passed');
