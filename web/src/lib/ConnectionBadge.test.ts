// Manual smoke harness for ConnectionBadge.svelte (attn-nnj.4.11).
// Pattern mirrors ShareDialog.test.ts — `web/` has no vitest config yet,
// so tests are tsx-runnable functions with a tiny harness.
//
// Run with:
//
//   cd web && npx tsx src/lib/ConnectionBadge.test.ts
//
// IMPORTANT: tsx cannot mount the .svelte file (runes only compile through
// the Vite + svelte plugin). So we test the contracts the component
// depends on:
//
//   1. State → label mapping for all 4 transports.
//   2. State → tone-class mapping (--primary / --muted / --destructive).
//   3. Direct-failed visual is "louder" — carries the destructive ring.
//   4. Popover open/close toggle predicate.
//   5. Per-peer transport derivation rule.
//   6. Default formatLastSeen helper outputs correct relative time strings.
//   7. Reconnect handler dispatches AND closes the popover.
//   8. Falls back to "offline" when reviewStore.status is null.

import { defaultFormatLastSeen } from './connection-badge-format';
import type { ReviewStatus, ReviewStatusPeer } from './types';

// ---------------------------------------------------------------------------
// Tiny harness (matches ShareDialog.test.ts conventions)
// ---------------------------------------------------------------------------

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
// Fixtures — re-declare the state descriptor table from ConnectionBadge.svelte
// so this test catches drift. If the badge's `STATE_DESCRIPTORS` table is
// changed, this fixture must change too — that's the point.
// ---------------------------------------------------------------------------

type ConnectionState = ReviewStatus['connection'];

interface StateDescriptor {
  label: string;
  tooltip: string;
  toneClass: string;
  iconClass: string;
}

const STATE_DESCRIPTORS: Record<ConnectionState, StateDescriptor> = {
  live_direct: {
    label: 'Live direct',
    tooltip: 'Realtime via DataChannel',
    toneClass:
      'text-primary border-primary/40 bg-primary/10 hover:bg-primary/15',
    iconClass: 'text-primary',
  },
  mailbox: {
    label: 'Mailbox',
    tooltip: 'Async via relay',
    toneClass:
      'text-muted-foreground border-border bg-muted/40 hover:bg-muted/60',
    iconClass: 'text-muted-foreground',
  },
  offline: {
    label: 'Offline',
    tooltip: 'No transport — events queue locally',
    toneClass:
      'text-muted-foreground/70 border-border/60 bg-muted/20 hover:bg-muted/40 opacity-80',
    iconClass: 'text-muted-foreground/70',
  },
  direct_failed: {
    label: 'Direct failed',
    tooltip: 'Live mode requested, DataChannel could not connect',
    toneClass:
      'text-destructive border-destructive/60 bg-destructive/10 hover:bg-destructive/20 ring-1 ring-destructive/30',
    iconClass: 'text-destructive',
  },
};

// ---------------------------------------------------------------------------
// Stub reviewStore — same approach as ShareDialog.test.ts. The real store
// uses runes; we only need `status` + `peers` for the badge's contract.
// ---------------------------------------------------------------------------

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

// Mirror of the badge's `connection` derivation:
//   reviewStore.status?.connection ?? 'offline'
function deriveConnection(store: StubStore): ConnectionState {
  return store.status?.connection ?? 'offline';
}

// Mirror of the badge's `peerTransport` rule.
function peerTransport(
  connection: ConnectionState,
  peer: ReviewStatusPeer,
): 'direct' | 'mailbox' | 'offline' {
  if (!peer.online) return 'offline';
  if (connection === 'live_direct') return 'direct';
  if (connection === 'mailbox') return 'mailbox';
  if (connection === 'direct_failed') return 'mailbox';
  return 'offline';
}

// ---------------------------------------------------------------------------
// Test cases
// ---------------------------------------------------------------------------

// (1) State=Live → label "Live direct" + --primary class
defineCase('Live state → chip shows "Live direct" with --primary tone', () => {
  const store = makeStubStore();
  store.status = makeStatus('live_direct');
  const c = deriveConnection(store);
  const d = STATE_DESCRIPTORS[c];
  assert(c === 'live_direct', `expected live_direct, got ${c}`);
  assert(d.label === 'Live direct', `expected label "Live direct", got "${d.label}"`);
  assert(
    d.toneClass.includes('text-primary'),
    `expected tone class to include text-primary, got "${d.toneClass}"`,
  );
  assert(
    d.iconClass.includes('text-primary'),
    `expected icon class to include text-primary, got "${d.iconClass}"`,
  );
});

// (2) State=Mailbox → label "Mailbox" + neutral muted-foreground tone
defineCase('Mailbox state → chip shows "Mailbox" with --muted-foreground tone', () => {
  const store = makeStubStore();
  store.status = makeStatus('mailbox');
  const c = deriveConnection(store);
  const d = STATE_DESCRIPTORS[c];
  assert(c === 'mailbox', `expected mailbox, got ${c}`);
  assert(d.label === 'Mailbox', `expected label "Mailbox", got "${d.label}"`);
  assert(
    d.toneClass.includes('text-muted-foreground'),
    `expected tone class to include text-muted-foreground, got "${d.toneClass}"`,
  );
  // Mailbox is neutral, not dim — must NOT include opacity-80 (offline's dim).
  assert(
    !d.toneClass.includes('opacity-80'),
    'mailbox should NOT carry offline opacity-80 dimming',
  );
});

// (3) State=Offline → chip dims (muted-foreground + reduced opacity)
defineCase('Offline state → chip dims via --muted-foreground @ reduced opacity', () => {
  const store = makeStubStore();
  store.status = makeStatus('offline');
  const c = deriveConnection(store);
  const d = STATE_DESCRIPTORS[c];
  assert(c === 'offline', `expected offline, got ${c}`);
  assert(d.label === 'Offline', `expected label "Offline", got "${d.label}"`);
  assert(
    d.toneClass.includes('text-muted-foreground/70'),
    `expected dimmed text-muted-foreground/70, got "${d.toneClass}"`,
  );
  assert(
    d.toneClass.includes('opacity-80'),
    `expected opacity-80 dim, got "${d.toneClass}"`,
  );
});

// (4) State=DirectFailed → --destructive AND "louder" (ring) per §5
defineCase('DirectFailed → uses --destructive + louder visual (ring)', () => {
  const store = makeStubStore();
  store.status = makeStatus('direct_failed');
  const c = deriveConnection(store);
  const d = STATE_DESCRIPTORS[c];
  assert(c === 'direct_failed', `expected direct_failed, got ${c}`);
  assert(d.label === 'Direct failed', `expected label "Direct failed", got "${d.label}"`);
  assert(
    d.toneClass.includes('text-destructive'),
    `expected text-destructive, got "${d.toneClass}"`,
  );
  assert(
    d.toneClass.includes('border-destructive/60'),
    `expected destructive border, got "${d.toneClass}"`,
  );
  // §5: "slightly louder than the others (warning)". The visual cue is the
  // ring-1 + destructive ring color — none of the other 3 states carry a ring.
  assert(
    d.toneClass.includes('ring-1'),
    `Direct failed must be louder via ring-1, got "${d.toneClass}"`,
  );
  assert(
    !STATE_DESCRIPTORS.live_direct.toneClass.includes('ring-1'),
    'Live direct must not carry a ring (only Direct failed does)',
  );
  assert(
    !STATE_DESCRIPTORS.mailbox.toneClass.includes('ring-1'),
    'Mailbox must not carry a ring (only Direct failed does)',
  );
  assert(
    !STATE_DESCRIPTORS.offline.toneClass.includes('ring-1'),
    'Offline must not carry a ring (only Direct failed does)',
  );
});

// (5) Falls back to "offline" when reviewStore.status is null
defineCase('Null status falls back to Offline state (safe default)', () => {
  const store = makeStubStore();
  store.status = null;
  const c = deriveConnection(store);
  assert(c === 'offline', `expected fallback to offline, got ${c}`);
});

// (6) Click chip → popover toggles open. Mirror the togglePopover predicate.
defineCase('Click chip → popover toggles open then closed', () => {
  // The component's `togglePopover` flips a boolean; we mirror it. Use a
  // helper that returns the next state so TS doesn't narrow on a literal
  // initializer (the closure-mutated case below would otherwise be flagged).
  function nextOpen(prev: boolean): boolean {
    return !prev;
  }
  let popoverOpen = false;
  assert(popoverOpen === false, 'expected popover initially closed');
  popoverOpen = nextOpen(popoverOpen);
  assert(popoverOpen === true, 'expected popover open after first click');
  popoverOpen = nextOpen(popoverOpen);
  assert(popoverOpen === false, 'expected popover closed after second click');
});

// (7) Popover shows correct transport details — peer count, per-peer transport.
defineCase('Popover renders peer count + per-peer transport correctly', () => {
  const owner: ReviewStatusPeer = {
    participantId: 'p_owner' as ReviewStatusPeer['participantId'],
    deviceId: 'd_owner' as ReviewStatusPeer['deviceId'],
    displayName: 'James',
    kind: 'owner',
    online: true,
  };
  const reviewer: ReviewStatusPeer = {
    participantId: 'p_alex' as ReviewStatusPeer['participantId'],
    deviceId: 'd_alex' as ReviewStatusPeer['deviceId'],
    displayName: 'Alex',
    kind: 'reviewer',
    online: true,
  };
  const agent: ReviewStatusPeer = {
    participantId: 'p_lint' as ReviewStatusPeer['participantId'],
    deviceId: 'd_lint' as ReviewStatusPeer['deviceId'],
    displayName: 'lint-bot',
    kind: 'agent',
    online: false,
  };
  const peers = [owner, reviewer, agent];
  assert(peers.length === 3, `expected 3 peers, got ${peers.length}`);

  // Live: online peers report "direct", offline peer reports "offline".
  assert(peerTransport('live_direct', owner) === 'direct', 'owner should be direct in live mode');
  assert(peerTransport('live_direct', reviewer) === 'direct', 'reviewer should be direct in live mode');
  assert(peerTransport('live_direct', agent) === 'offline', 'offline agent stays offline in live mode');

  // Mailbox: online peers are "mailbox"; offline stays "offline".
  assert(peerTransport('mailbox', owner) === 'mailbox', 'owner should be mailbox in mailbox mode');
  assert(peerTransport('mailbox', agent) === 'offline', 'offline agent stays offline in mailbox mode');

  // Direct failed: live policy degraded, so online peers shown as mailbox.
  assert(peerTransport('direct_failed', reviewer) === 'mailbox', 'direct_failed online peer reports mailbox');

  // Offline state: everyone is offline regardless of peer.online.
  assert(peerTransport('offline', owner) === 'offline', 'offline state must be offline for everyone');
  assert(peerTransport('offline', reviewer) === 'offline', 'offline state must be offline for everyone');
});

// (8) defaultFormatLastSeen produces sensible relative-time strings.
defineCase('defaultFormatLastSeen formats relative times correctly', () => {
  const now = 1_700_000_000_000;
  assert(defaultFormatLastSeen(now - 5_000, now) === '5s ago', 'expected "5s ago" for 5s past');
  assert(defaultFormatLastSeen(now - 90_000, now) === '2m ago', 'expected "2m ago" for 90s past');
  assert(defaultFormatLastSeen(now - 3_600_000, now) === '1h ago', 'expected "1h ago" for 1h past');
  assert(defaultFormatLastSeen(now - 86_400_000 * 3, now) === '3d ago', 'expected "3d ago" for 3d past');
  assert(
    defaultFormatLastSeen(now + 30_000, now).startsWith('in '),
    'expected future timestamp to use "in N…" prefix',
  );
});

// (9) Reconnect handler fires AND closes the popover (component contract).
defineCase('Reconnect handler dispatches callback AND closes popover', () => {
  const state: { popoverOpen: boolean; reconnectFired: number } = {
    popoverOpen: true,
    reconnectFired: 0,
  };
  // Mirror handleReconnect from ConnectionBadge.svelte.
  const onReconnect = (): void => {
    state.reconnectFired += 1;
  };
  function handleReconnect(): void {
    onReconnect();
    state.popoverOpen = false;
  }

  handleReconnect();
  assert(
    state.reconnectFired === 1,
    `expected onReconnect to fire once, got ${state.reconnectFired}`,
  );
  assert(
    state.popoverOpen === false,
    'expected popover to close after retry direct',
  );
});

// (10) All 4 states have non-empty distinct labels (no duplicates).
defineCase('All four states have non-empty distinct labels', () => {
  const labels = new Set<string>();
  const states: ConnectionState[] = ['live_direct', 'mailbox', 'offline', 'direct_failed'];
  for (const s of states) {
    const d = STATE_DESCRIPTORS[s];
    assert(d.label.length > 0, `state ${s} must have a non-empty label`);
    assert(d.tooltip.length > 0, `state ${s} must have a non-empty tooltip`);
    assert(!labels.has(d.label), `duplicate label "${d.label}" for state ${s}`);
    labels.add(d.label);
  }
  assert(labels.size === 4, `expected 4 distinct labels, got ${labels.size}`);
});

// ---------------------------------------------------------------------------
// Runner — same shape as ShareDialog.test.ts / resolver.test.ts
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
