import { createHash } from 'node:crypto';

import { apexRedirectTarget, buildContentSecurityPolicy } from './csp';
import { THEME_PREFLIGHT_SCRIPT, THEME_PREFLIGHT_SHA256 } from './theme-preflight';

function assertEq(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertThrows(fn: () => void, label: string): void {
  try {
    fn();
  } catch {
    return;
  }
  throw new Error(`${label}: expected an error`);
}

const staging = buildContentSecurityPolicy('https://relay-staging.attn.sh');
assertEq(
  staging.includes("connect-src 'self' https://relay-staging.attn.sh wss://relay-staging.attn.sh"),
  true,
  'staging connect-src',
);
assertEq(
  staging.includes("script-src 'self' 'wasm-unsafe-eval'"),
  true,
  'script-src permits only WebAssembly compilation',
);
assertEq(
  staging.includes("img-src 'self' blob: data: https:"),
  true,
  'HTTPS images are the only remote render capability',
);

// The theme-preflight hash and the script it admits must never drift. If they
// do, the browser silently blocks the inline stamp and the ~1.2s paper-white
// flash returns for dark-mode visitors — a regression with no error and no
// visible symptom in CI (attn-n01r.22).
assertEq(
  `sha256-${createHash('sha256').update(THEME_PREFLIGHT_SCRIPT, 'utf8').digest('base64')}`,
  THEME_PREFLIGHT_SHA256,
  'theme-preflight hash matches its script (regenerate: node scripts/theme-preflight-hash.mjs)',
);
assertEq(
  staging.includes(`'${THEME_PREFLIGHT_SHA256}'`),
  true,
  'script-src admits the theme-preflight hash',
);
// A hash must never be paired with a nonce or a blanket inline allowance —
// either would widen the policy far past the one script we mean to admit.
// Scoped to the script-src directive: style-src legitimately carries
// 'unsafe-inline', so checking the whole policy string would always trip.
const scriptSrc = staging
  .split('; ')
  .find((directive) => directive.startsWith('script-src '));
assertEq(typeof scriptSrc, 'string', 'policy carries a script-src directive');
assertEq(
  (scriptSrc ?? '').split(/\s+/u).includes("'unsafe-inline'"),
  false,
  'script-src never permits arbitrary inline script',
);
assertEq(
  (scriptSrc ?? '').includes('nonce-'),
  false,
  'script-src admits the preflight by hash, never by nonce',
);
assertEq(
  staging.split(/\s|;/u).includes("'unsafe-eval'"),
  false,
  'JavaScript unsafe-eval remains disabled',
);

const production = buildContentSecurityPolicy('https://relay.attn.sh');
assertEq(
  production.includes("connect-src 'self' https://relay.attn.sh wss://relay.attn.sh"),
  true,
  'production connect-src',
);
assertEq(
  buildContentSecurityPolicy('https://relay.attn.sh', "'self'").includes("frame-ancestors 'self'"),
  true,
  'landing demo supports same-origin framing',
);

assertThrows(() => buildContentSecurityPolicy('http://relay.attn.sh'), 'rejects http');
assertThrows(() => buildContentSecurityPolicy('https://relay.attn.sh/path'), 'rejects path');
assertThrows(() => buildContentSecurityPolicy(''), 'rejects empty');

assertEq(
  apexRedirectTarget(new URL('https://www.attn.sh/review/abc?x=1')),
  'https://attn.sh/review/abc?x=1',
  'www redirects to apex preserving path/query',
);
assertEq(apexRedirectTarget(new URL('https://attn.sh/')), undefined, 'apex is canonical');
assertEq(
  apexRedirectTarget(new URL('https://staging.attn.sh/app')),
  undefined,
  'staging is canonical',
);

console.log('hosted csp: all cases passed');
