// Contract tests for review-drift-check.ts (attn-73xq). tsx-runnable:
//
//   cd web && npx tsx src/lib/review/review-drift-check.test.ts

import {
  computeReviewFingerprint,
  fingerprintsDrifted,
  startReviewDriftMonitor,
  type ReviewDriftSource,
} from './review-drift-check';

let failures = 0;
function assert(cond: boolean, detail: string): void {
  if (!cond) {
    failures += 1;
    console.log(`  FAIL ${detail}`);
  }
}

function ev(roomId: string, eventId: string) {
  return { meta: { roomId, eventId } };
}

function source(currentRoomId: string | null, events: Array<{ meta: { roomId: string; eventId: string } }>): ReviewDriftSource {
  return { currentRoomId, events };
}

// --- fingerprint: order independence + room scoping --------------------------
{
  const a = computeReviewFingerprint(source('room-1', [ev('room-1', 'e1'), ev('room-1', 'e2'), ev('room-2', 'x')]));
  const b = computeReviewFingerprint(source('room-1', [ev('room-1', 'e2'), ev('room-1', 'e1')]));
  assert(a.count === 2, 'scopes count to the active room (ignores room-2 event)');
  assert(a.eventsHash === b.eventsHash, 'hash is order-independent');
  assert(a.count === b.count, 'count matches regardless of order or extra other-room events');
}

// --- no room → empty fingerprint --------------------------------------------
{
  const f = computeReviewFingerprint(source(null, [ev('room-1', 'e1')]));
  assert(f.roomId === null && f.count === 0 && f.eventsHash === 0, 'null room yields the empty fingerprint');
}

// --- drift detection ---------------------------------------------------------
{
  const leader = computeReviewFingerprint(source('room-1', [ev('room-1', 'e1'), ev('room-1', 'e2')]));
  const followerAgree = computeReviewFingerprint(source('room-1', [ev('room-1', 'e2'), ev('room-1', 'e1')]));
  const followerBehind = computeReviewFingerprint(source('room-1', [ev('room-1', 'e1')]));
  const followerDifferent = computeReviewFingerprint(source('room-1', [ev('room-1', 'e1'), ev('room-1', 'e3')]));
  const otherRoom = computeReviewFingerprint(source('room-2', [ev('room-2', 'e1'), ev('room-2', 'e2')]));

  assert(!fingerprintsDrifted(leader, followerAgree), 'identical sets never drift');
  assert(fingerprintsDrifted(leader, followerBehind), 'a behind follower (fewer events) drifts');
  assert(fingerprintsDrifted(leader, followerDifferent), 'same count but different ids drifts');
  assert(!fingerprintsDrifted(leader, otherRoom), 'different rooms are never comparable (no false drift)');
  assert(!fingerprintsDrifted(leader, computeReviewFingerprint(source(null, []))), 'a null-room tab never drifts');
}

// --- monitor: fires onDrift across a shared channel --------------------------
async function monitorCase(): Promise<void> {
  if (typeof BroadcastChannel === 'undefined') {
    console.log('  skip  BroadcastChannel unavailable in this runtime');
    return;
  }
  const wsId = 'ws-drift-test';
  let leaderEvents = [ev('room-1', 'e1'), ev('room-1', 'e2')];
  const followerEvents = [ev('room-1', 'e1')]; // behind by one → should drift
  let drifts = 0;

  const stopLeader = startReviewDriftMonitor({
    workspaceId: wsId,
    enabled: true,
    intervalMs: 10,
    read: () => source('room-1', leaderEvents),
  });
  const stopFollower = startReviewDriftMonitor({
    workspaceId: wsId,
    enabled: true,
    intervalMs: 10,
    read: () => source('room-1', followerEvents),
    onDrift: () => {
      drifts += 1;
    },
  });

  await new Promise((r) => setTimeout(r, 80));
  assert(drifts > 0, 'the behind follower observed drift against the leader');

  // Converge the follower's view → no further drift once counts match.
  leaderEvents = [ev('room-1', 'e1')];
  const before = drifts;
  await new Promise((r) => setTimeout(r, 60));
  assert(drifts === before, 'once both tabs agree, no new drift fires');

  stopLeader();
  stopFollower();
}

async function main(): Promise<void> {
  await monitorCase();
  if (failures === 0) console.log('review-drift-check: all assertions passed');
  else {
    console.log(`review-drift-check: ${failures} assertion(s) FAILED`);
    process.exit(1);
  }
}

void main();
