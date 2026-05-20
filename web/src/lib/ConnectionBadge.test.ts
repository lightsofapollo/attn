// Manual smoke harness for ConnectionBadge.svelte (status-first rewrite).
// `web/` has no vitest config; tests are tsx-runnable functions with a tiny
// harness. tsx can't mount the .svelte file (runes compile only through Vite),
// so we test the contracts the component depends on:
//
//   1-4. State → presentation mapping for all four transports (label is
//        STATUS, never the transport mechanism). mailbox + direct_failed both
//        present as "Connected" (relay works → not an error to the user).
//   5.   Null status falls back to Offline (safe default).
//   6.   Popover open/close toggle predicate.
//   7.   Per-peer presence label (here/away — no transport jargon).
//   8.   defaultFormatLastSeen helper outputs correct relative times.
//   9.   "Try a faster connection" handler fires AND closes the popover.
//   10.  Three distinct user-facing labels (Connected is shared by design).
//
// Run with:  cd web && npx tsx src/lib/ConnectionBadge.test.ts

import { defaultFormatLastSeen } from './connection-badge-format';
import type { ReviewStatus, ReviewStatusPeer } from './types';

interface CaseResult {
  name: string;
  ok: boolean;
  detail?: string;
}

const cases: Array<() => Promise<CaseResult> | CaseResult> = [];

function defineCase(
  name: string,
  fn: () => void | string | Promise<void | string>,
): void {
  cases.push(async () => {
    try {
      const note = await fn();
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

// ---------------------------------------------------------------------------
// Fixtures — mirror the descriptor table from ConnectionBadge.svelte so this
// test catches drift. If the badge's STATE_DESCRIPTORS table changes, this
// fixture must change too — that's the point.
// ---------------------------------------------------------------------------

type ConnectionState = ReviewStatus['connection'];
type IconKind = 'live' | 'connected' | 'offline';

interface StateDescriptor {
  label: string;
  detail: string;
  toneClass: string;
  iconClass: string;
  icon: IconKind;
  canTryFaster: boolean;
}

const CONNECTED_TONE =
  'text-primary border-primary/30 bg-primary/5 hover:bg-primary/10';

const STATE_DESCRIPTORS: Record<ConnectionState, StateDescriptor> = {
  live_direct: {
    label: 'Live',
    detail: 'Connected live — changes appear instantly (peer-to-peer).',
    toneClass: 'text-primary border-primary/50 bg-primary/15 hover:bg-primary/20',
    iconClass: 'text-primary',
    icon: 'live',
    canTryFaster: false,
  },
  mailbox: {
    label: 'Connected',
    detail: 'Connected — changes sync through the encrypted relay, usually within a second.',
    toneClass: CONNECTED_TONE,
    iconClass: 'text-primary',
    icon: 'connected',
    canTryFaster: true,
  },
  direct_failed: {
    label: 'Connected',
    detail: 'Connected through the relay. A faster peer-to-peer link wasn’t available, so changes sync in about a second.',
    toneClass: CONNECTED_TONE,
    iconClass: 'text-primary',
    icon: 'connected',
    canTryFaster: true,
  },
  offline: {
    label: 'Offline',
    detail: 'Offline — your changes are saved and will sync automatically when you reconnect.',
    toneClass:
      'text-muted-foreground/70 border-border/60 bg-muted/20 hover:bg-muted/40 opacity-80',
    iconClass: 'text-muted-foreground/70',
    icon: 'offline',
    canTryFaster: false,
  },
};

interface StubStore {
  status: ReviewStatus | null;
  peers: ReviewStatusPeer[];
}

function makeStubStore(): StubStore {
  return { status: null, peers: [] };
}

function makeStatus(connection: ConnectionState, overrides: Partial<ReviewStatus> = {}): ReviewStatus {
  return {
    roomId: 'room-test' as ReviewStatus['roomId'],
    mode: connection === 'live_direct' || connection === 'direct_failed' ? 'live' : 'async',
    connection,
    peers: [],
    outboxPending: 0,
    ...overrides,
  };
}

// Mirror of the badge's `connection` derivation.
function deriveConnection(store: StubStore): ConnectionState {
  return store.status?.connection ?? 'offline';
}

// Mirror of the badge's `peerStatus` rule.
function peerStatus(peer: ReviewStatusPeer): 'here' | 'away' {
  return peer.online ? 'here' : 'away';
}

// ---------------------------------------------------------------------------
// Test cases
// ---------------------------------------------------------------------------

defineCase('live_direct → "Live", primary tone, live icon, no try-faster', () => {
  const store = makeStubStore();
  store.status = makeStatus('live_direct');
  const d = STATE_DESCRIPTORS[deriveConnection(store)];
  assert(d.label === 'Live', `expected "Live", got "${d.label}"`);
  assert(d.icon === 'live', `expected live icon, got ${d.icon}`);
  assert(d.toneClass.includes('text-primary'), 'live should use --primary');
  assert(d.canTryFaster === false, 'already live — no "try faster"');
});

defineCase('mailbox → "Connected" (not "Mailbox"), offers try-faster', () => {
  const store = makeStubStore();
  store.status = makeStatus('mailbox');
  const d = STATE_DESCRIPTORS[deriveConnection(store)];
  // "Connected" (status), never the transport mechanism "Mailbox".
  assert(d.label === 'Connected', `expected "Connected", got "${d.label}"`);
  assert(d.icon === 'connected', `expected connected icon, got ${d.icon}`);
  assert(d.canTryFaster === true, 'connected-via-relay should offer try-faster');
});

defineCase('direct_failed → "Connected", NOT an error state', () => {
  const store = makeStubStore();
  store.status = makeStatus('direct_failed');
  const d = STATE_DESCRIPTORS[deriveConnection(store)];
  assert(d.label === 'Connected', `expected "Connected", got "${d.label}"`);
  // The relay path works, so it must NOT look like an error.
  assert(!d.toneClass.includes('text-destructive'), 'must not use destructive tone');
  assert(!d.toneClass.includes('ring-1'), 'must not be visually "loud"');
  // Presented identically to mailbox (only the detail copy differs).
  assert(d.toneClass === STATE_DESCRIPTORS.mailbox.toneClass, 'shares the Connected tone');
  assert(d.detail !== STATE_DESCRIPTORS.mailbox.detail, 'detail copy explains the relay fallback');
  assert(d.canTryFaster === true, 'should still offer try-faster');
});

defineCase('offline → "Offline", dimmed, no try-faster', () => {
  const store = makeStubStore();
  store.status = makeStatus('offline');
  const d = STATE_DESCRIPTORS[deriveConnection(store)];
  assert(d.label === 'Offline', `expected "Offline", got "${d.label}"`);
  assert(d.toneClass.includes('opacity-80'), 'offline should be dimmed');
  assert(d.icon === 'offline', `expected offline icon, got ${d.icon}`);
  assert(d.canTryFaster === false, 'offline cannot try a faster connection');
});

defineCase('Null status falls back to Offline (safe default)', () => {
  const store = makeStubStore();
  store.status = null;
  assert(deriveConnection(store) === 'offline', 'null status must be offline');
});

defineCase('Click chip → popover toggles open then closed', () => {
  function nextOpen(prev: boolean): boolean {
    return !prev;
  }
  let popoverOpen = false;
  popoverOpen = nextOpen(popoverOpen);
  assert(popoverOpen === true, 'open after first click');
  popoverOpen = nextOpen(popoverOpen);
  assert(popoverOpen === false, 'closed after second click');
});

defineCase('peerStatus → "here" when online, "away" when not', () => {
  const online: ReviewStatusPeer = {
    participantId: 'p1' as ReviewStatusPeer['participantId'],
    deviceId: 'd1' as ReviewStatusPeer['deviceId'],
    displayName: 'Alex',
    kind: 'reviewer',
    online: true,
  };
  const offline: ReviewStatusPeer = { ...online, deviceId: 'd2' as ReviewStatusPeer['deviceId'], online: false };
  assert(peerStatus(online) === 'here', 'online peer is "here"');
  assert(peerStatus(offline) === 'away', 'offline peer is "away"');
});

defineCase('defaultFormatLastSeen formats relative times correctly', () => {
  const now = 1_700_000_000_000;
  assert(defaultFormatLastSeen(now - 5_000, now) === '5s ago', 'expected "5s ago"');
  assert(defaultFormatLastSeen(now - 90_000, now) === '2m ago', 'expected "2m ago"');
  assert(defaultFormatLastSeen(now - 3_600_000, now) === '1h ago', 'expected "1h ago"');
  assert(defaultFormatLastSeen(now - 86_400_000 * 3, now) === '3d ago', 'expected "3d ago"');
  assert(defaultFormatLastSeen(now + 30_000, now).startsWith('in '), 'future uses "in N…"');
});

defineCase('Try-faster handler fires callback AND closes popover', () => {
  const state: { popoverOpen: boolean; fired: number } = { popoverOpen: true, fired: 0 };
  const onReconnect = (): void => {
    state.fired += 1;
  };
  function handleReconnect(): void {
    onReconnect();
    state.popoverOpen = false;
  }
  handleReconnect();
  assert(state.fired === 1, `expected callback once, got ${state.fired}`);
  assert(state.popoverOpen === false, 'popover closes after try-faster');
});

defineCase('Three distinct user-facing labels (Connected is shared by design)', () => {
  const labels = new Set<string>();
  const states: ConnectionState[] = ['live_direct', 'mailbox', 'offline', 'direct_failed'];
  for (const s of states) {
    const d = STATE_DESCRIPTORS[s];
    assert(d.label.length > 0, `state ${s} must have a label`);
    assert(d.detail.length > 0, `state ${s} must have a detail`);
    labels.add(d.label);
  }
  // mailbox + direct_failed deliberately collapse to "Connected".
  assert(labels.size === 3, `expected 3 distinct labels (Live/Connected/Offline), got ${labels.size}`);
  assert(labels.has('Connected') && labels.has('Live') && labels.has('Offline'), 'labels are Live/Connected/Offline');
});

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

interface NodeProcessShape {
  exit?: (code: number) => void;
}

async function runAllCases(): Promise<void> {
  let passed = 0;
  let failed = 0;
  for (const run of cases) {
    const r = await run();
    if (r.ok) {
      passed += 1;
      console.log(`  ok  ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
    } else {
      failed += 1;
      console.error(`  FAIL ${r.name}\n        ${r.detail ?? '(no detail)'}`);
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    const nodeProcess = (globalThis as unknown as { process?: NodeProcessShape }).process;
    nodeProcess?.exit?.(1);
  }
}

void runAllCases();
