// Contract tests for ShareChip.svelte (the unified share-status control that
// replaced ConnectionBadge + SharedFilesBadge + the icon share pill). tsx
// can't mount the .svelte file (runes compile only through Vite), so we test
// the pure model the component renders from:
//
//   1-4. State → presentation mapping for all four transports (label is
//        STATUS, never the transport mechanism). mailbox + direct_failed both
//        present as "Connected" (relay works → not an error to the user).
//   5.   Null status falls back to the store's connection (safe default).
//   6.   Owner chip label leads with "Sharing" + scope (single file name /
//        "N files"); scope-less rooms still read "Sharing".
//   7.   Reviewer chip label is the status word (scope lives in the popover).
//   8.   Pre-room (share sheet open) the chip reads "Share".
//   9.   Per-peer presence label (here/away — no transport jargon).
//   10.  Three distinct user-facing labels (Connected shared by design).
//
// Run with:  cd web && npx tsx src/lib/ShareChip.test.ts

import {
  SHARE_CHIP_DESCRIPTORS,
  peerPresenceLabel,
  resolveConnection,
  shareChipLabel,
  shareScopeLabel,
  type ConnectionState,
} from './share-chip-model';
import type { SharedFile } from './review/shared-tree';
import type { ReviewStatus } from './types';

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

function file(name: string, relPath: string): SharedFile {
  return { fileId: `f-${name}`, name, displayPath: `/tmp/${relPath}`, relPath, dir: '' };
}

// ---------------------------------------------------------------------------
// 1-4: state → presentation
// ---------------------------------------------------------------------------

defineCase('live_direct presents as Live', () => {
  const d = SHARE_CHIP_DESCRIPTORS.live_direct;
  assert(d.label === 'Live', `label ${d.label}`);
  assert(d.tone === 'live' && d.icon === 'live', 'tone/icon live');
  assert(!d.canTryFaster, 'already live — no faster link to try');
  assert(!/mailbox|datachannel|webrtc/i.test(d.detail), 'no transport jargon');
});

defineCase('mailbox presents as Connected (not the mechanism)', () => {
  const d = SHARE_CHIP_DESCRIPTORS.mailbox;
  assert(d.label === 'Connected', `label ${d.label}`);
  assert(d.canTryFaster, 'connected-but-not-live offers faster link');
  assert(!/mailbox/i.test(d.label) && !/mailbox/i.test(d.detail), 'no "mailbox" leakage');
});

defineCase('direct_failed presents as Connected — relay fallback is not an error', () => {
  const d = SHARE_CHIP_DESCRIPTORS.direct_failed;
  assert(d.label === 'Connected', `label ${d.label}`);
  assert(d.tone === 'connected', 'not an error tone');
  assert(d.canTryFaster, 'can retry the direct link');
  assert(!/error|fail/i.test(d.label), 'label never says failure');
});

defineCase('offline presents as Offline with local-save reassurance', () => {
  const d = SHARE_CHIP_DESCRIPTORS.offline;
  assert(d.label === 'Offline', `label ${d.label}`);
  assert(d.tone === 'offline' && !d.canTryFaster, 'offline tone; no faster action');
  assert(/saved/i.test(d.detail), 'detail reassures changes are saved');
});

// ---------------------------------------------------------------------------
// 5: connection resolution default
// ---------------------------------------------------------------------------

defineCase('null status falls back to the store connection', () => {
  assert(resolveConnection(null, 'offline') === 'offline', 'null → fallback');
  assert(resolveConnection(undefined, 'mailbox') === 'mailbox', 'undefined → fallback');
  const status = { connection: 'live_direct' } as ReviewStatus;
  assert(resolveConnection(status, 'offline') === 'live_direct', 'status wins when present');
});

// ---------------------------------------------------------------------------
// 6-8: chip label
// ---------------------------------------------------------------------------

defineCase('owner label: Sharing · <file name> for a single file', () => {
  const files = [file('Code Rewrite and Delivery Plan', 'code-plan.md')];
  const label = shareChipLabel(true, SHARE_CHIP_DESCRIPTORS.mailbox, files, true);
  assert(label === 'Sharing · Code Rewrite and Delivery Plan', `got "${label}"`);
});

defineCase('owner label: Sharing · N files for several; bare Sharing pre-snapshot', () => {
  const files = [file('A', 'a.md'), file('B', 'b.md'), file('C', 'sub/c.md')];
  assert(shareScopeLabel(files) === '3 files', 'scope collapses to count');
  const label = shareChipLabel(true, SHARE_CHIP_DESCRIPTORS.mailbox, files, true);
  assert(label === 'Sharing · 3 files', `got "${label}"`);
  const bare = shareChipLabel(true, SHARE_CHIP_DESCRIPTORS.mailbox, [], true);
  assert(bare === 'Sharing', `scope-less room reads "Sharing", got "${bare}"`);
});

defineCase('reviewer label is the status word', () => {
  const files = [file('A', 'a.md')];
  for (const state of ['live_direct', 'mailbox', 'direct_failed', 'offline'] as ConnectionState[]) {
    const label = shareChipLabel(false, SHARE_CHIP_DESCRIPTORS[state], files, true);
    assert(label === SHARE_CHIP_DESCRIPTORS[state].label, `${state} → "${label}"`);
  }
});

defineCase('pre-room (sheet open, nothing minted) the chip reads Share', () => {
  const label = shareChipLabel(true, SHARE_CHIP_DESCRIPTORS.offline, [], false);
  assert(label === 'Share', `got "${label}"`);
});

// ---------------------------------------------------------------------------
// 9: peer presence
// ---------------------------------------------------------------------------

defineCase('peer presence label is here/away — never transport jargon', () => {
  assert(peerPresenceLabel(true) === 'here', 'online → here');
  assert(peerPresenceLabel(false) === 'away', 'offline → away');
});

// ---------------------------------------------------------------------------
// 10: label distinctness
// ---------------------------------------------------------------------------

defineCase('exactly four distinct user-facing labels (Connected shared by design)', () => {
  const labels = new Set(Object.values(SHARE_CHIP_DESCRIPTORS).map((d) => d.label));
  assert(labels.size === 4, `expected 4 distinct labels, got ${labels.size}`);
  assert(
    labels.has('Live') && labels.has('Connected') && labels.has('Offline')
      // Browser-only follower state (attn-dgya): a tab mirroring the live
      // tab on this device is neither Offline (a lie) nor plain Live
      // (overclaims a direct connection of its own).
      && labels.has('Live · another tab'),
    'label set',
  );
});

// ---------------------------------------------------------------------------
// Runner — same shape as PeerStrip.test.ts / SnapshotBadge.test.ts
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  let failed = 0;
  for (const run of cases) {
    const result = await run();
    const status = result.ok ? 'PASS' : 'FAIL';
    const detail = result.detail ? ` — ${result.detail}` : '';
    console.log(`${status}  ${result.name}${detail}`);
    if (!result.ok) failed += 1;
  }
  console.log(`\n${cases.length - failed}/${cases.length} passed`);
  if (failed > 0) process.exit(1);
}

void main();
