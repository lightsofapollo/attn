// Manual smoke harness for room activation rules.
//
// Run with:
//
//   cd web && npx tsx src/lib/review/room-ui.test.ts

import {
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
