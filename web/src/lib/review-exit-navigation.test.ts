// Regression harness for the review-exit navigation flow (attn-11g4.5).
//
// Symptom: choosing "Exit review" in the confirmation dismissed the dialog but
// left the user on the original document — the file they clicked never opened.
//
// Two defects produce that. Both are covered here.
//
//   1. The owner's path→room focus effect (App.svelte) resolves the room from
//      `activePath`. `confirmReviewExit` clears the room and THEN awaits a
//      flush so the rail/margin unmount before the document swaps, which means
//      that during that flush `activePath` is still the reviewed file — so the
//      effect re-selects the room the exit just cleared, inside the very flush
//      the exit is waiting on. The first case below proves that with the real
//      `ownerRoomForPath` / `roomPublishesPath` helpers; the source assertions
//      prove App.svelte now latches the exit across that window.
//
//   2. `navigate()` ran only AFTER `await tick()` resolved. Svelte aborts a
//      whole flush on the first effect that throws and `tick()` re-throws it,
//      and the click never awaits this async handler — so a throwing teardown
//      dropped the navigation silently. It must not be reachable from inside
//      the try.
//
// Run with:
//
//   cd web && npx tsx src/lib/review-exit-navigation.test.ts

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ownerRoomForPath, roomPublishesPath } from './review/room-ui';
import type { OwnerRoomPathEntry, RoomPathSnapshot } from './review/room-ui';
import type { RoomId } from './types';

interface CaseResult {
  name: string;
  ok: boolean;
  detail?: string;
}

const cases: Array<() => CaseResult> = [];

function defineCase(name: string, fn: () => void): void {
  cases.push(() => {
    try {
      fn();
      return { name, ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { name, ok: false, detail: message };
    }
  });
}

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const libDir = path.dirname(fileURLToPath(import.meta.url));
const source = (relative: string): string =>
  fs.readFileSync(path.join(libDir, relative), 'utf8');

const app = source('../App.svelte');
const confirmDialog = source('ReviewExitConfirm.svelte');

/** Body of a named function/effect, sliced between two anchors in the source. */
function slice(text: string, from: string, to: string, label: string): string {
  const start = text.indexOf(from);
  assert(start !== -1, `${label}: could not find anchor ${JSON.stringify(from)}`);
  const end = text.indexOf(to, start);
  assert(end !== -1, `${label}: could not find closing anchor ${JSON.stringify(to)}`);
  return text.slice(start, end);
}

const confirmReviewExit = slice(
  app,
  'async function confirmReviewExit',
  'function cancelReviewExit',
  'confirmReviewExit',
);
const ownerFocusEffect = slice(
  app,
  '// Owner collaboration follows the local file tree.',
  'let shareTargetIsCurrent',
  'owner path→room focus effect',
);

// ---------------------------------------------------------------------------
// 1. The mechanism: resolving the room from a not-yet-moved `activePath`
// ---------------------------------------------------------------------------

const ROOM: RoomId = 'room-alpha' as RoomId;
const REVIEWED = '/Users/me/proj/alpha.md';
const CLICKED = '/Users/me/other/beta.md';

const rooms: OwnerRoomPathEntry[] = [
  { roomId: ROOM, role: 'owner', share: { ownerDisplayPath: REVIEWED } },
];
const snapshots: RoomPathSnapshot[] = [{ roomId: ROOM, ownerDisplayPath: REVIEWED }];

defineCase(
  'mid-exit, the reviewed path still resolves to the room being left',
  () => {
    // This is the state during `await tick()`: the room selection is already
    // cleared (currentRoomId null) but the navigation has not run, so
    // `activePath` is unchanged.
    const resolved = ownerRoomForPath({
      path: REVIEWED,
      currentRoomId: null,
      rooms,
      snapshots,
    });
    assert(
      resolved === ROOM,
      'the exited room is still the answer for the reviewed path — an unguarded '
        + 'focus effect re-selects it and the exit never completes',
    );
    assert(
      roomPublishesPath({ path: REVIEWED, roomId: ROOM, snapshots, rootPath: '/Users/me/proj' }),
      'the reviewed path is in the published set, so the effect takes its select branch',
    );
  },
);

defineCase('once the navigation lands, the clicked path releases the exit', () => {
  const resolved = ownerRoomForPath({
    path: CLICKED,
    currentRoomId: null,
    rooms,
    snapshots,
  });
  assert(
    resolved === null,
    'the clicked file resolves to no room, which is what releases the suppression latch',
  );
});

// ---------------------------------------------------------------------------
// 2. App.svelte holds the exit across the flush
// ---------------------------------------------------------------------------

defineCase('confirmReviewExit latches the exit before clearing the room', () => {
  const latch = confirmReviewExit.indexOf('reviewExitSuppressedRoomId = exitingRoomId');
  const clear = confirmReviewExit.indexOf('reviewStore.clearRoomSelection()');
  assert(latch !== -1, 'confirmReviewExit must claim the focus-effect suppression latch');
  assert(clear !== -1, 'confirmReviewExit must still clear the room selection');
  assert(
    latch < clear,
    'the latch has to be claimed BEFORE the clear, or the focus effect wins the flush',
  );
});

defineCase('the owner focus effect honours the suppression latch', () => {
  assert(
    ownerFocusEffect.includes('reviewExitSuppressedRoomId'),
    'the path→room focus effect must consult the exit latch',
  );
  assert(
    /if \(roomId === reviewExitSuppressedRoomId\) return;/.test(ownerFocusEffect),
    'a room whose exit is still in flight must not be re-selected',
  );
  assert(
    ownerFocusEffect.includes('reviewExitSuppressedRoomId = null'),
    'the latch must release once focus resolves to a different room',
  );
});

// ---------------------------------------------------------------------------
// 3. A failed teardown flush can never eat the navigation
// ---------------------------------------------------------------------------

defineCase('the parked navigation runs outside the tick() try block', () => {
  const tryStart = confirmReviewExit.indexOf('try {');
  const tickCall = confirmReviewExit.indexOf('await tick()');
  const catchStart = confirmReviewExit.indexOf('} catch');
  assert(tryStart !== -1, 'the teardown flush must be guarded');
  assert(tickCall > tryStart, 'await tick() must sit inside the guard');
  assert(catchStart > tickCall, 'a rejected tick() must be caught, not left unhandled');

  const afterCatch = confirmReviewExit.slice(catchStart);
  assert(
    /\n\s*navigate\(\);/.test(afterCatch),
    'navigate() must run after the catch — a throwing teardown effect must not '
      + 'cancel the file switch the user asked for',
  );
  assert(
    !/\n\s*navigate\(\);/.test(confirmReviewExit.slice(tryStart, catchStart)),
    'navigate() must not be inside the try, where a rethrow would skip it',
  );
});

defineCase('a stale confirm with nothing parked is a no-op', () => {
  assert(
    confirmReviewExit.includes('if (navigate === null) return;'),
    'confirming with no parked navigation must not tear the review down with nowhere to go',
  );
});

// ---------------------------------------------------------------------------
// 4. Confirming never also reports a cancel
// ---------------------------------------------------------------------------

defineCase('ReviewExitConfirm distinguishes confirm-close from cancel-close', () => {
  assert(
    !confirmDialog.includes('if (!next) onCancel();'),
    'the inline onOpenChange handler treated every close as a cancel',
  );
  assert(
    confirmDialog.includes('onOpenChange={handleOpenChange}'),
    'closes must route through the handler that knows why the dialog closed',
  );
  assert(
    /function handleConfirm\(\): void \{\s*confirming = true;\s*onConfirm\(\);/.test(confirmDialog),
    'the confirm button must latch its intent before handing off',
  );
  assert(
    /if \(confirming\) \{\s*confirming = false;\s*return;\s*\}/.test(confirmDialog),
    'a close that followed a confirm must not fall through to onCancel',
  );
  assert(
    confirmDialog.includes('onclick={handleConfirm}'),
    'the Exit review button must go through the latching handler',
  );
  assert(
    confirmDialog.includes('onclick={onCancel}'),
    'Keep reviewing stays a direct cancel',
  );
});

let failed = 0;
for (const run of cases) {
  const result = run();
  if (result.ok) {
    console.log(`PASS ${result.name}`);
  } else {
    failed += 1;
    console.error(`FAIL ${result.name}`);
    if (result.detail) console.error(`  ${result.detail}`);
  }
}

if (failed > 0) process.exit(1);
