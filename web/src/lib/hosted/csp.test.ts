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
assertEq(staging.includes("script-src 'self'"), true, 'script-src pinned');
assertEq(staging.includes('unsafe-eval'), false, 'no unsafe-eval');

const production = buildContentSecurityPolicy('https://relay.attn.sh');
assertEq(
  production.includes("connect-src 'self' https://relay.attn.sh wss://relay.attn.sh"),
  true,
  'production connect-src',
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
