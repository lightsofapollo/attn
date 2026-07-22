// Contract tests for remote-cursor-overlap.ts (attn-5xgz). Same tsx pattern
// as PeerStrip.test.ts:
//
//   cd web && npx tsx src/lib/prosemirror/remote-cursor-overlap.test.ts

import { caretStacks, selectionSegments } from './remote-cursor-overlap';
import type { RemoteCursor } from './collab-controller';

let failures = 0;
function assert(cond: boolean, detail: string): void {
  if (!cond) {
    failures += 1;
    console.log(`  FAIL ${detail}`);
  }
}

function cursor(
  clientID: string,
  head: number,
  anchor?: number,
  color = '#4a7fa5',
): RemoteCursor {
  return { clientID, head, label: clientID, color, ...(anchor === undefined ? {} : { anchor }) };
}

// --- caretStacks ------------------------------------------------------------
{
  // Same head position → deterministic slots by clientID, regardless of
  // input order.
  const stacks = caretStacks([cursor('zed', 10), cursor('amy', 10), cursor('bob', 4)], 100);
  assert(stacks.get('amy') === 0, 'amy (lowest clientID) takes slot 0');
  assert(stacks.get('zed') === 1, 'zed climbs to slot 1');
  assert(stacks.get('bob') === 0, 'lone caret stays at slot 0');

  const reordered = caretStacks([cursor('amy', 10), cursor('zed', 10)], 100);
  assert(reordered.get('amy') === 0 && reordered.get('zed') === 1, 'input order does not change slots');

  // Clamping unifies out-of-range heads: both beyond max land at max and stack.
  const clamped = caretStacks([cursor('a', 250), cursor('b', 999)], 100);
  assert(clamped.get('a') === 0 && clamped.get('b') === 1, 'clamped-to-max heads share a stack');
}

// --- selectionSegments -------------------------------------------------------
{
  // No selections → nothing.
  assert(selectionSegments([cursor('a', 5)], 100).length === 0, 'bare carets yield no segments');

  // Identical ranges (the screenshot case) → ONE shared segment with both
  // peers, sorted by clientID.
  const same = selectionSegments([cursor('zed', 20, 10), cursor('amy', 20, 10)], 100);
  assert(same.length === 1, `identical ranges → 1 segment, got ${same.length}`);
  assert(same[0]!.from === 10 && same[0]!.to === 20, 'segment spans the shared range');
  assert(
    same[0]!.cursors.map((c) => c.clientID).join(',') === 'amy,zed',
    'covering peers sorted by clientID',
  );

  // Partial overlap → three segments: solo A, shared, solo B.
  const partial = selectionSegments([cursor('a', 15, 5), cursor('b', 25, 10)], 100);
  assert(partial.length === 3, `partial overlap → 3 segments, got ${partial.length}`);
  assert(
    partial.map((s) => `${s.from}-${s.to}:${s.cursors.map((c) => c.clientID).join('+')}`).join(' ') ===
      '5-10:a 10-15:a+b 15-25:b',
    `unexpected segmentation: ${JSON.stringify(partial.map((s) => [s.from, s.to, s.cursors.map((c) => c.clientID)]))}`,
  );

  // Reversed head/anchor normalizes; zero-width selections drop.
  const reversed = selectionSegments([cursor('a', 5, 15), cursor('b', 8, 8)], 100);
  assert(reversed.length === 1 && reversed[0]!.from === 5 && reversed[0]!.to === 15,
    'reversed selection normalizes; zero-width drops');

  // Disjoint selections stay separate single-peer segments.
  const disjoint = selectionSegments([cursor('a', 5, 2), cursor('b', 30, 20)], 100);
  assert(disjoint.length === 2 && disjoint.every((s) => s.cursors.length === 1),
    'disjoint selections never share');

  // Three peers on one range: all three recorded (renderer draws first two,
  // labels disambiguate the third).
  const trio = selectionSegments(
    [cursor('c', 9, 3), cursor('a', 9, 3), cursor('b', 9, 3)],
    100,
  );
  assert(trio.length === 1 && trio[0]!.cursors.length === 3, 'triple overlap keeps all peers');
  assert(trio[0]!.cursors[0]!.clientID === 'a', 'first covering peer is deterministic');
}

if (failures === 0) {
  console.log('remote-cursor-overlap: all assertions passed');
} else {
  console.log(`remote-cursor-overlap: ${failures} assertion(s) FAILED`);
  process.exit(1);
}
