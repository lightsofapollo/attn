// Manual smoke harness for room activation rules.
//
// Run with:
//
//   cd web && npx tsx src/lib/review/room-ui.test.ts

import {
  collabRoleFor,
  isReviewerView,
  shouldActivateRoomStatus,
  shouldAutoSelectOnlyRoom,
  shouldForgetRoomStatus,
} from './room-ui';
import type { RoomId } from '../types';

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

defineCase('explicit join/share statuses activate the review UI', () => {
  assert(shouldActivateRoomStatus('Joined'), 'Joined should activate reviewer mode');
  assert(shouldActivateRoomStatus('Live'), 'Live should activate owner mode');
});

defineCase('resumed rooms stay passive until selected', () => {
  assert(!shouldActivateRoomStatus('Resumed'), 'Resumed must not hijack a local file open');
  assert(!shouldActivateRoomStatus(undefined), 'missing status must stay passive');
});

defineCase('stopped rooms are forgotten', () => {
  assert(shouldForgetRoomStatus('Stopped'), 'Stopped should clear the room from the UI list');
  assert(!shouldForgetRoomStatus('Resumed'), 'Resumed should remain available to switch into');
});

defineCase('single passive room auto-selects only when no local tab is active', () => {
  const room = 'room-a' as RoomId;
  assert(
    shouldAutoSelectOnlyRoom({
      hasActiveTab: false,
      currentRoomId: null,
      rooms: [{ roomId: room }],
    }) === room,
    'expected the lone room to activate in empty-window mode',
  );
  assert(
    shouldAutoSelectOnlyRoom({
      hasActiveTab: true,
      currentRoomId: null,
      rooms: [{ roomId: room }],
    }) === null,
    'local files must win over resumed rooms',
  );
});

defineCase('auto-select does not guess between multiple rooms', () => {
  assert(
    shouldAutoSelectOnlyRoom({
      hasActiveTab: false,
      currentRoomId: null,
      rooms: [{ roomId: 'room-a' as RoomId }, { roomId: 'room-b' as RoomId }],
    }) === null,
    'multiple rooms require an explicit choice',
  );
});

// --- attn-0wa: owner must never flip into the shared-doc view ---------------

defineCase('reviewer (Joined, no local share) sees the shared doc', () => {
  assert(
    isReviewerView({ inRoom: true, hasLocalShare: false, role: 'reviewer' }) === true,
    'a joined reviewer with no local share renders the shared doc',
  );
});

defineCase('owner with a fresh local share is not a reviewer', () => {
  assert(
    isReviewerView({ inRoom: true, hasLocalShare: true, role: 'owner' }) === false,
    'the minting owner stays on their local doc',
  );
});

defineCase('attn-0wa: owner on reconnect (role owner, share lost) does NOT flip', () => {
  // The regression: currentShare is gone after reconnect/rehydrate, but the
  // daemon still reports role `owner`. Gating on share alone flipped them.
  assert(
    isReviewerView({ inRoom: true, hasLocalShare: false, role: 'owner' }) === false,
    'owner with role=owner must not render the shared doc even without a local share',
  );
});

defineCase('unknown role (pre-status window) does NOT flip to reviewer', () => {
  assert(
    isReviewerView({ inRoom: true, hasLocalShare: false, role: 'unknown' }) === false,
    'an indeterminate role must not flip the window into shared-doc view',
  );
  assert(
    isReviewerView({ inRoom: true, hasLocalShare: false, role: undefined }) === false,
    'a missing role must not flip the window into shared-doc view',
  );
});

defineCase('no room means no reviewer view', () => {
  assert(
    isReviewerView({ inRoom: false, hasLocalShare: false, role: 'reviewer' }) === false,
    'without a current room there is no shared-doc view',
  );
});

defineCase('collabRoleFor: owner via local share OR durable role', () => {
  assert(
    collabRoleFor({ hasLocalShare: true, role: 'unknown' }) === 'owner',
    'a fresh local share marks us owner',
  );
  assert(
    collabRoleFor({ hasLocalShare: false, role: 'owner' }) === 'owner',
    'durable role=owner marks us owner after reconnect',
  );
  assert(
    collabRoleFor({ hasLocalShare: false, role: 'reviewer' }) === 'reviewer',
    'a joiner is a reviewer',
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
