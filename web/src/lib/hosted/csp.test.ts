import { apexRedirectTarget, buildContentSecurityPolicy } from './csp';

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
