// Manual test harness for `browser-invite.ts` (planning issue attn-nnj.9.2).
//
// Matches the conventions used by `anchors.test.ts` / `resolver.test.ts` —
// the web/ package has no real test runner today. Run with:
//
//   cd web && npx tsx src/lib/review/browser-invite.test.ts

import {
  parseInviteUrl,
  composeInviteUrl,
  parseAndStripInviteFromUrl,
  stripFragment,
  zero,
  InviteParseError,
  type BrowserWindowLike,
  type ParsedInvite,
} from './browser-invite';

// ---------------------------------------------------------------------------
// Tiny harness
// ---------------------------------------------------------------------------

interface CaseResult {
  name: string;
  ok: boolean;
  detail?: string;
}

const cases: Array<() => CaseResult> = [];

function defineCase(name: string, fn: () => void | string): void {
  cases.push(() => {
    try {
      const note = fn();
      return { name, ok: true, detail: typeof note === 'string' ? note : undefined };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { name, ok: false, detail: message };
    }
  });
}

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function assertEq<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) {
    throw new Error(`${msg}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

function assertBytesEq(actual: Uint8Array, expected: Uint8Array, msg: string): void {
  if (actual.length !== expected.length) {
    throw new Error(
      `${msg}: length mismatch — expected ${expected.length}, got ${actual.length}`,
    );
  }
  for (let i = 0; i < actual.length; i++) {
    if (actual[i] !== expected[i]) {
      throw new Error(`${msg}: byte ${i} expected ${expected[i]}, got ${actual[i]}`);
    }
  }
}

function assertThrows(fn: () => unknown, predicate: (err: Error) => boolean, msg: string): void {
  let threw = false;
  try {
    fn();
  } catch (e) {
    threw = true;
    const err = e instanceof Error ? e : new Error(String(e));
    if (!predicate(err)) {
      throw new Error(`${msg}: predicate failed for error: ${err.message}`);
    }
  }
  if (!threw) throw new Error(`${msg}: expected throw, none observed`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a deterministic 32-byte secret for tests (0,1,2,…,31). */
function fixtureSecret(): Uint8Array {
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = i;
  return out;
}

/** base64url-no-pad of `fixtureSecret()`, computed once. */
const FIXTURE_KEY_B64URL = (() => {
  const bytes = fixtureSecret();
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
})();

/** Minimal mock of the window contract `parseAndStripInviteFromUrl` reads. */
interface MockWindow extends BrowserWindowLike {
  /** Captured calls to history.replaceState for assertions. */
  replaceStateCalls: Array<{ data: unknown; title: string; url: string | null }>;
}

function makeMockWindow(opts: {
  origin?: string;
  pathname?: string;
  search?: string;
  hash?: string;
}): MockWindow {
  const state = {
    origin: opts.origin ?? 'https://attn.dev',
    pathname: opts.pathname ?? '/review/room-id-fixture',
    search: opts.search ?? '',
    hash: opts.hash ?? '',
  };
  const replaceStateCalls: MockWindow['replaceStateCalls'] = [];
  const mock: MockWindow = {
    replaceStateCalls,
    location: {
      get origin() {
        return state.origin;
      },
      get pathname() {
        return state.pathname;
      },
      get search() {
        return state.search;
      },
      get hash() {
        return state.hash;
      },
    },
    history: {
      replaceState(data: unknown, title: string, url?: string | null) {
        replaceStateCalls.push({ data, title, url: url ?? null });
        // Mimic real `history.replaceState` updating location.{pathname,search,hash}.
        const u = url ?? '';
        const hashIdx = u.indexOf('#');
        const beforeHash = hashIdx < 0 ? u : u.slice(0, hashIdx);
        const newHash = hashIdx < 0 ? '' : u.slice(hashIdx);
        const queryIdx = beforeHash.indexOf('?');
        const newPath = queryIdx < 0 ? beforeHash : beforeHash.slice(0, queryIdx);
        const newSearch = queryIdx < 0 ? '' : beforeHash.slice(queryIdx);
        if (newPath.length > 0) state.pathname = newPath;
        state.search = newSearch;
        state.hash = newHash;
      },
    },
  };
  return mock;
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

defineCase('parseInviteUrl accepts native attn://review/<id>#key=<b64>', () => {
  const url = `attn://review/room-abc#key=${FIXTURE_KEY_B64URL}`;
  const parsed = parseInviteUrl(url);
  assertEq(parsed.roomId, 'room-abc', 'roomId');
  assertEq(parsed.roomSecret.length, 32, 'roomSecret length');
  assertBytesEq(parsed.roomSecret, fixtureSecret(), 'roomSecret bytes');
});

defineCase('parseInviteUrl accepts https://attn.dev/review/<id>#key=<b64>', () => {
  const url = `https://attn.dev/review/room-xyz#key=${FIXTURE_KEY_B64URL}`;
  const parsed = parseInviteUrl(url);
  assertEq(parsed.roomId, 'room-xyz', 'roomId');
  assertBytesEq(parsed.roomSecret, fixtureSecret(), 'roomSecret bytes');
});

defineCase('parseInviteUrl rejects when fragment is missing entirely', () => {
  assertThrows(
    () => parseInviteUrl('attn://review/room-abc'),
    (e) => e instanceof InviteParseError && /missing key fragment/.test(e.message),
    'native form without #fragment',
  );
  assertThrows(
    () => parseInviteUrl('https://attn.dev/review/room-abc'),
    (e) => e instanceof InviteParseError && /missing key fragment/.test(e.message),
    'browser form without #fragment',
  );
});

defineCase('parseInviteUrl rejects fragment missing key= prefix', () => {
  assertThrows(
    () => parseInviteUrl(`attn://review/room-abc#${FIXTURE_KEY_B64URL}`),
    (e) => e instanceof InviteParseError && /must start with `key=`/.test(e.message),
    'fragment without key= prefix',
  );
});

defineCase('parseInviteUrl rejects key that does not decode to 32 bytes', () => {
  // Encode just 5 bytes — far too short.
  const shortBytes = new Uint8Array([1, 2, 3, 4, 5]);
  let bin = '';
  for (let i = 0; i < shortBytes.length; i++) bin += String.fromCharCode(shortBytes[i]!);
  const shortKey = btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  assertThrows(
    () => parseInviteUrl(`attn://review/room-abc#key=${shortKey}`),
    (e) => e instanceof InviteParseError && /must decode to 32 bytes/.test(e.message),
    'short key rejected',
  );
});

defineCase('parseInviteUrl rejects non-base64url characters in the key', () => {
  assertThrows(
    () => parseInviteUrl('attn://review/room-abc#key=this is not base64!'),
    (e) => e instanceof InviteParseError && /base64url decode/.test(e.message),
    'invalid chars rejected',
  );
});

defineCase('parseInviteUrl rejects empty roomId', () => {
  assertThrows(
    () => parseInviteUrl(`attn://review/#key=${FIXTURE_KEY_B64URL}`),
    (e) => e instanceof InviteParseError && /empty roomId/.test(e.message),
    'empty roomId rejected (native)',
  );
});

defineCase('parseInviteUrl rejects unsupported scheme', () => {
  assertThrows(
    () => parseInviteUrl(`ftp://example.com/review/room-abc#key=${FIXTURE_KEY_B64URL}`),
    (e) => e instanceof InviteParseError && /unsupported scheme/.test(e.message),
    'ftp scheme rejected',
  );
});

defineCase('parseInviteUrl rejects non-/review path on https host', () => {
  assertThrows(
    () => parseInviteUrl(`https://attn.dev/other/room-abc#key=${FIXTURE_KEY_B64URL}`),
    (e) => e instanceof InviteParseError && /path must start with/.test(e.message),
    '/other rejected',
  );
});

defineCase('composeInviteUrl roundtrips through parseInviteUrl', () => {
  const secret = fixtureSecret();
  const composed = composeInviteUrl('attn://review', 'room-rt', secret);
  assertEq(
    composed,
    `attn://review/room-rt#key=${FIXTURE_KEY_B64URL}`,
    'composed native shape',
  );
  const parsed = parseInviteUrl(composed);
  assertEq(parsed.roomId, 'room-rt', 'parsed roomId');
  assertBytesEq(parsed.roomSecret, secret, 'parsed secret');

  const composedHttps = composeInviteUrl('https://attn.dev/review', 'room-rt', secret);
  const parsedHttps = parseInviteUrl(composedHttps);
  assertEq(parsedHttps.roomId, 'room-rt', 'browser parsed roomId');
  assertBytesEq(parsedHttps.roomSecret, secret, 'browser parsed secret');
});

defineCase('composeInviteUrl normalizes trailing slash on base', () => {
  const secret = fixtureSecret();
  const a = composeInviteUrl('attn://review', 'room-a', secret);
  const b = composeInviteUrl('attn://review/', 'room-a', secret);
  assertEq(a, b, 'trailing slash normalized');
});

defineCase('composeInviteUrl rejects wrong-length roomSecret', () => {
  assertThrows(
    () => composeInviteUrl('attn://review', 'room-a', new Uint8Array(16)),
    (e) => e instanceof InviteParseError && /32-byte/.test(e.message),
    'short secret rejected',
  );
  assertThrows(
    () => composeInviteUrl('attn://review', 'room-a', new Uint8Array(64)),
    (e) => e instanceof InviteParseError && /32-byte/.test(e.message),
    'long secret rejected',
  );
});

defineCase('parseAndStripInviteFromUrl strips the fragment via replaceState', () => {
  const win = makeMockWindow({
    origin: 'https://attn.dev',
    pathname: '/review/room-strip',
    search: '?utm=x',
    hash: `#key=${FIXTURE_KEY_B64URL}`,
  });
  const parsed: ParsedInvite | null = parseAndStripInviteFromUrl(win);
  assert(parsed !== null, 'parsed not null');
  assertEq(parsed!.roomId, 'room-strip', 'roomId');
  assertBytesEq(parsed!.roomSecret, fixtureSecret(), 'secret bytes');

  assertEq(win.replaceStateCalls.length, 1, 'replaceState called once');
  const call = win.replaceStateCalls[0]!;
  assertEq(call.data, null, 'replaceState data is null');
  assertEq(call.title, '', 'replaceState title is empty');
  assertEq(call.url, '/review/room-strip?utm=x', 'replaceState url has no fragment');

  // Sanity: the mock applied the strip, so location.hash is now empty.
  assertEq(win.location!.hash ?? '', '', 'location.hash cleared');
});

defineCase('parseAndStripInviteFromUrl returns null when no #key= fragment', () => {
  const win = makeMockWindow({ hash: '' });
  const parsed = parseAndStripInviteFromUrl(win);
  assertEq(parsed, null, 'no fragment → null');
  assertEq(win.replaceStateCalls.length, 0, 'replaceState NOT called when nothing to do');

  // Different fragment shapes also yield null, but are stripped because the
  // hosted review route never uses anchor navigation and future invite shapes
  // may still carry secrets.
  const win2 = makeMockWindow({ hash: '#some-other-anchor' });
  assertEq(parseAndStripInviteFromUrl(win2), null, '#other → null');
  assertEq(win2.replaceStateCalls.length, 1, 'non-key fragment is stripped');
  assertEq(win2.location!.hash ?? '', '', 'non-key location.hash cleared');
});

defineCase('parseAndStripInviteFromUrl propagates parse errors', () => {
  const win = makeMockWindow({ hash: '#key=not_a_valid_32byte_key' });
  assertThrows(
    () => parseAndStripInviteFromUrl(win),
    (e) => e instanceof InviteParseError,
    'malformed key throws',
  );
  assertEq(win.replaceStateCalls.length, 1, 'malformed fragment is stripped before throw');
  assertEq(win.location!.hash ?? '', '', 'malformed location.hash cleared');
});

defineCase('stripFragment is a no-op when history.replaceState is unavailable', () => {
  // Window with no history — should silently return.
  const win: BrowserWindowLike = {
    location: { pathname: '/x', search: '', hash: '#key=abc' },
  };
  stripFragment(win); // must not throw

  // Window with location but a history that lacks replaceState — also no-op.
  const win2: BrowserWindowLike = {
    location: { pathname: '/x', search: '', hash: '#key=abc' },
    history: {},
  };
  stripFragment(win2);
});

defineCase('zero clobbers the secret bytes', () => {
  const secret = fixtureSecret();
  // Sanity: not already zero.
  let nonZero = false;
  for (const b of secret) if (b !== 0) nonZero = true;
  assert(nonZero, 'fixture is non-zero before clobber');

  zero(secret);
  for (let i = 0; i < secret.length; i++) {
    if (secret[i] !== 0) throw new Error(`byte ${i} not zeroed`);
  }

  // No-op on non-Uint8Array — must not throw.
  zero(undefined as unknown as Uint8Array);
});

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
for (const run of cases) {
  const r = run();
  if (r.ok) {
    passed += 1;
    console.log(`  ok  ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${r.name}\n        ${r.detail ?? '(no detail)'}`);
  }
}
console.log(`\n${passed} passed, ${failed} failed`);

interface NodeProcessShape {
  exit?: (code: number) => void;
}
const nodeProcess: NodeProcessShape | undefined = (
  globalThis as unknown as { process?: NodeProcessShape }
).process;
if (failed > 0) nodeProcess?.exit?.(1);
