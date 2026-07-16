import {
  BrowserRelayUrlError,
  resolveBrowserRelayUrl,
  validateBrowserRelayUrl,
} from './browser-relay-url';

function assertEq(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertRejects(value: string | undefined, label: string): void {
  try {
    validateBrowserRelayUrl(value);
  } catch (error) {
    if (error instanceof BrowserRelayUrlError) return;
    throw error;
  }
  throw new Error(`${label}: expected relay URL rejection`);
}

assertEq(validateBrowserRelayUrl('https://relay.example'), 'https://relay.example', 'https origin');
assertEq(validateBrowserRelayUrl('https://relay.example:8443/'), 'https://relay.example:8443', 'port');
assertEq(validateBrowserRelayUrl('http://localhost:8787'), 'http://localhost:8787', 'localhost');
assertEq(validateBrowserRelayUrl('http://127.0.0.1:8787'), 'http://127.0.0.1:8787', 'IPv4 loopback');
assertEq(validateBrowserRelayUrl('http://[::1]:8787'), 'http://[::1]:8787', 'IPv6 loopback');
assertEq(
  resolveBrowserRelayUrl(undefined, 'http://127.0.0.1:5199'),
  'http://127.0.0.1:5199',
  'loopback browser origin fallback',
);
assertEq(
  resolveBrowserRelayUrl('https://relay.example', 'http://127.0.0.1:5199'),
  'https://relay.example',
  'explicit relay wins over loopback fallback',
);

assertRejects(undefined, 'missing');
assertRejects('', 'empty');
assertRejects(' http://localhost:8787', 'whitespace');
assertRejects('http://relay.example', 'remote HTTP');
assertRejects('ws://localhost:8787', 'ws scheme');
assertRejects('https://relay.example/v2', 'path');
assertRejects('https://relay.example?token=x', 'query');
assertRejects('https://user:pass@relay.example', 'credentials');

try {
  resolveBrowserRelayUrl(undefined, 'https://attn.example');
  throw new Error('remote browser origin fallback: expected relay URL rejection');
} catch (error) {
  if (!(error instanceof BrowserRelayUrlError)) throw error;
}

console.log('browser-relay-url: all cases passed');
