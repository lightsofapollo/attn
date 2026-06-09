// Manual smoke harness for room activation rules.
//
// Run with:
//
//   cd web && npx tsx src/lib/review/room-ui.test.ts

import {
  collabRoleFor,
  collabSeedReady,
  isReviewerView,
  roomDisplayName,
  shareTargetMatches,
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

// --- attn-d5x: never seed a collab session from empty/transient content -----

defineCase('collabSeedReady: owner with loaded content can seed', () => {
  assert(
    collabSeedReady({
      effectiveMarkdown: '# Plan\n\nbody',
      isReviewerInRoom: false,
      isReviewerViewingSnapshot: false,
    }) === true,
    'an owner with real markdown should seed collab',
  );
});

defineCase('collabSeedReady: empty markdown never seeds (the blank-editor bug)', () => {
  // The regression: collab activates on a reconnect blip while effectiveMarkdown
  // is momentarily '' — seeding '' locks the editor BLANK for the session.
  assert(
    collabSeedReady({
      effectiveMarkdown: '',
      isReviewerInRoom: false,
      isReviewerViewingSnapshot: false,
    }) === false,
    'empty content must not be captured as the collab seed',
  );
});

defineCase('collabSeedReady: reviewer waits for the shared snapshot before seeding', () => {
  // A reviewer who also has a local markdown file open: collab could activate
  // before the shared snapshot lands. We must NOT seed from their local file.
  assert(
    collabSeedReady({
      effectiveMarkdown: '# my local file',
      isReviewerInRoom: true,
      isReviewerViewingSnapshot: false,
    }) === false,
    'a reviewer must not seed collab until the shared snapshot is present',
  );
  assert(
    collabSeedReady({
      effectiveMarkdown: '# shared doc',
      isReviewerInRoom: true,
      isReviewerViewingSnapshot: true,
    }) === true,
    'a reviewer seeds once the shared snapshot has landed',
  );
});

// --- room names derived from shared files -----------------------------------

defineCase('roomDisplayName: single-file room is named after the file', () => {
  const snaps = [
    { roomId: 'r1' as RoomId, ownerDisplayPath: '/Users/me/proj/goals.md' },
  ];
  assert(
    roomDisplayName(snaps, 'r1' as RoomId) === 'goals.md',
    'a single-file room should read as its basename',
  );
});

defineCase('roomDisplayName: folder room is named after the shared folder + count', () => {
  const snaps = [
    { roomId: 'r1' as RoomId, ownerDisplayPath: '/Users/me/planning/a.md' },
    { roomId: 'r1' as RoomId, ownerDisplayPath: '/Users/me/planning/b.md' },
    { roomId: 'r1' as RoomId, ownerDisplayPath: '/Users/me/planning/sub/c.md' },
  ];
  assert(
    roomDisplayName(snaps, 'r1' as RoomId) === 'planning/ (3 files)',
    `expected 'planning/ (3 files)', got '${roomDisplayName(snaps, 'r1' as RoomId)}'`,
  );
});

defineCase('roomDisplayName: dedupes repeated snapshots for one file', () => {
  // Owner edits republish a new snapshot per save — same path, still one file.
  const snaps = [
    { roomId: 'r1' as RoomId, ownerDisplayPath: '/p/x.md' },
    { roomId: 'r1' as RoomId, ownerDisplayPath: '/p/x.md' },
  ];
  assert(roomDisplayName(snaps, 'r1' as RoomId) === 'x.md', 'republished snapshots must not inflate the count');
});

defineCase('roomDisplayName: null when no snapshots for the room yet', () => {
  const snaps = [{ roomId: 'other' as RoomId, ownerDisplayPath: '/p/x.md' }];
  assert(roomDisplayName(snaps, 'r1' as RoomId) === null, 'no snapshots → null so the caller falls back to the short id');
});

// --- shareTargetMatches (owner-share path gate; replaces snapshot scan) -----

defineCase('shareTargetMatches: single shared file matches itself', () => {
  assert(
    shareTargetMatches('/Users/me/plan.md', '/Users/me/plan.md') === true,
    'the exact shared file must be recognized as current',
  );
});

defineCase('shareTargetMatches: shared folder matches the folder itself', () => {
  assert(
    shareTargetMatches('/Users/me/planning', '/Users/me/planning') === true,
    'the shared folder path must match itself',
  );
});

defineCase('shareTargetMatches: child file under a shared folder matches', () => {
  assert(
    shareTargetMatches('/Users/me/planning', '/Users/me/planning/a.md') === true,
    'a markdown file beneath the shared folder must be recognized as current',
  );
  assert(
    shareTargetMatches('/Users/me/planning', '/Users/me/planning/sub/c.md') === true,
    'a nested child of the shared folder must also match',
  );
});

defineCase('shareTargetMatches: trailing slashes are tolerated on both sides', () => {
  assert(
    shareTargetMatches('/Users/me/planning/', '/Users/me/planning/a.md') === true,
    'a folder share stored with a trailing slash must still match its children',
  );
  assert(
    shareTargetMatches('/Users/me/plan.md', '/Users/me/plan.md/') === true,
    'a stray trailing slash on the target must not break an exact match',
  );
});

defineCase('shareTargetMatches: a different unshared file does NOT match', () => {
  assert(
    shareTargetMatches('/Users/me/plan.md', '/Users/me/other.md') === false,
    'an unrelated file must not be treated as the current share',
  );
  assert(
    shareTargetMatches('/Users/me/planning', '/Users/me/planningX/a.md') === false,
    'a sibling whose name merely shares a prefix must not match (segment boundary required)',
  );
  assert(
    shareTargetMatches('/Users/me/planning', '/Users/me/planning-notes.md') === false,
    'a non-boundary prefix collision must not match',
  );
});

defineCase('shareTargetMatches: empty / null inputs never match', () => {
  assert(shareTargetMatches(null, '/Users/me/plan.md') === false, 'no active share → no match');
  assert(shareTargetMatches('/Users/me/plan.md', null) === false, 'no target selected → no match');
  assert(shareTargetMatches('', '') === false, 'both empty → no match');
  assert(shareTargetMatches(undefined, undefined) === false, 'undefined inputs are safe → no match');
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
