// `roomPublishesPath` decides whether a file is part of the review the owner
// is looking at — the predicate behind the exit-review confirmation
// (attn-rd3j.2). Getting it wrong is user-visible in both directions: too
// loose and switching files silently drops a live review; too strict and the
// prompt nags on every move inside a shared folder.
export {};

import type { RoomId } from '../types';
import { roomPublishesPath } from './room-ui';

interface CaseResult { name: string; ok: boolean; detail?: string }
const cases: Array<() => Promise<CaseResult>> = [];

function defineCase(name: string, fn: () => Promise<void> | void): void {
  cases.push(async () => {
    try {
      await fn();
      return { name, ok: true };
    } catch (error) {
      return {
        name,
        ok: false,
        detail: error instanceof Error ? error.stack ?? error.message : String(error),
      };
    }
  });
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const ROOM = 'room-1' as unknown as RoomId;
const OTHER = 'room-2' as unknown as RoomId;
const ROOT = '/Users/a/project';

defineCase('matches a relative snapshot path against the absolute nav path', () => {
  const snapshots = [{ roomId: ROOM, ownerDisplayPath: 'alpha.md' }];
  assert(
    roomPublishesPath({ path: `${ROOT}/alpha.md`, roomId: ROOM, snapshots, rootPath: ROOT }),
    'published file should be in the review',
  );
  assert(
    !roomPublishesPath({ path: `${ROOT}/beta.md`, roomId: ROOM, snapshots, rootPath: ROOT }),
    'unpublished sibling must NOT be in the review',
  );
});

defineCase('matches nested relative paths', () => {
  const snapshots = [{ roomId: ROOM, ownerDisplayPath: 'docs/guide.md' }];
  assert(
    roomPublishesPath({ path: `${ROOT}/docs/guide.md`, roomId: ROOM, snapshots, rootPath: ROOT }),
    'nested published file should match',
  );
  assert(
    !roomPublishesPath({ path: `${ROOT}/guide.md`, roomId: ROOM, snapshots, rootPath: ROOT }),
    'same basename at a different depth must not match',
  );
});

defineCase('falls back to a whole-segment suffix match without a root', () => {
  const snapshots = [{ roomId: ROOM, ownerDisplayPath: 'alpha.md' }];
  assert(
    roomPublishesPath({ path: `${ROOT}/alpha.md`, roomId: ROOM, snapshots }),
    'suffix match should still resolve the file',
  );
  // The leading slash in the suffix check is what stops this from matching.
  assert(
    !roomPublishesPath({
      path: `${ROOT}/beta-alpha.md`,
      roomId: ROOM,
      snapshots,
    }),
    'partial basename must not match on a non-segment boundary',
  );
});

defineCase('handles absolute snapshot paths', () => {
  const snapshots = [{ roomId: ROOM, ownerDisplayPath: `${ROOT}/alpha.md` }];
  assert(
    roomPublishesPath({ path: `${ROOT}/alpha.md`, roomId: ROOM, snapshots, rootPath: ROOT }),
    'absolute published path should match exactly',
  );
  assert(
    !roomPublishesPath({ path: `${ROOT}/beta.md`, roomId: ROOM, snapshots, rootPath: ROOT }),
    'absolute path must not match a different file',
  );
});

defineCase('a multi-file share keeps every published file inside the review', () => {
  const snapshots = [
    { roomId: ROOM, ownerDisplayPath: 'alpha.md' },
    { roomId: ROOM, ownerDisplayPath: 'beta.md' },
  ];
  for (const name of ['alpha.md', 'beta.md']) {
    assert(
      roomPublishesPath({ path: `${ROOT}/${name}`, roomId: ROOM, snapshots, rootPath: ROOT }),
      `${name} should be in the review`,
    );
  }
  assert(
    !roomPublishesPath({ path: `${ROOT}/gamma.md`, roomId: ROOM, snapshots, rootPath: ROOT }),
    'gamma.md is not shared and must read as outside',
  );
});

defineCase('ignores snapshots belonging to other rooms', () => {
  const snapshots = [{ roomId: OTHER, ownerDisplayPath: 'alpha.md' }];
  assert(
    !roomPublishesPath({ path: `${ROOT}/alpha.md`, roomId: ROOM, snapshots, rootPath: ROOT }),
    'another room publishing the file is irrelevant',
  );
});

defineCase('degenerate inputs are never "in the review"', () => {
  const snapshots = [{ roomId: ROOM, ownerDisplayPath: 'alpha.md' }];
  assert(!roomPublishesPath({ path: '', roomId: ROOM, snapshots }), 'empty path');
  assert(!roomPublishesPath({ path: null, roomId: ROOM, snapshots }), 'null path');
  assert(
    !roomPublishesPath({ path: `${ROOT}/alpha.md`, roomId: null, snapshots }),
    'no active room means nothing to leave',
  );
  assert(
    !roomPublishesPath({
      path: `${ROOT}/alpha.md`,
      roomId: ROOM,
      snapshots: [{ roomId: ROOM }],
    }),
    'a snapshot with no path cannot match',
  );
});

defineCase('trailing slashes normalize away', () => {
  const snapshots = [{ roomId: ROOM, ownerDisplayPath: 'alpha.md/' }];
  assert(
    roomPublishesPath({ path: `${ROOT}/alpha.md`, roomId: ROOM, snapshots, rootPath: `${ROOT}/` }),
    'normalization should tolerate trailing slashes on both sides',
  );
});

async function runAllCases(): Promise<void> {
  let passed = 0;
  const failures: string[] = [];
  for (const run of cases) {
    const result = await run();
    if (result.ok) {
      passed += 1;
      console.log(`PASS ${result.name}`);
    } else {
      failures.push(`${result.name}: ${result.detail ?? 'unknown failure'}`);
      console.error(`FAIL ${result.name}\n${result.detail ?? ''}`);
    }
  }
  console.log(`room-publishes-path: ${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) process.exit(1);
}

void runAllCases();
