// What the mock share publishes snapshots FOR (attn-64iy.1).
//
// The bug this guards: `handleReviewShare` emitted ShareReady and a status and
// stopped. With no snapshot, `ownerFileIdForPath` could never resolve the open
// document to a FileId, `currentFileId` stayed null, and
// `openCommentComposer` returned silently — "I highlight text but nothing
// appears". These are the decisions that pick what gets snapshotted.
//
// Run with:
//
//   cd web && npx tsx src/lib/mock-share-snapshot.test.ts

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  mockFileIdFor,
  mockSnapshotIdFor,
  pathWithinRoot,
  sharedMarkdownPaths,
  type ShareableEntry,
} from './mock-share-snapshot';

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

function eq(actual: unknown, expected: unknown, msg: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${msg}: got ${a}, expected ${b}`);
}

const md = (p: string): ShareableEntry => ({ path: p, fileType: 'markdown' });

defineCase('an explicit selection wins outright', () => {
  eq(
    sharedMarkdownPaths(
      { path: '/proj', selectedPaths: ['/proj/a.md', '/proj/deep/b.md'] },
      [md('/proj/a.md'), md('/proj/c.md')],
    ),
    ['/proj/a.md', '/proj/deep/b.md'],
    'the picker’s selection is the answer, not the store’s contents',
  );
});

defineCase('a folder share covers every markdown file under it', () => {
  // The daemon publishes one snapshot per file for a folder share; anything
  // less means commenting works on the first file and silently not the rest.
  eq(
    sharedMarkdownPaths({ path: '/proj' }, [
      md('/proj/a.md'),
      md('/proj/nested/b.md'),
      md('/other/c.md'),
    ]),
    ['/proj/a.md', '/proj/nested/b.md'],
    'files outside the shared root must not be published',
  );
});

defineCase('non-markdown entries are never snapshotted', () => {
  eq(
    sharedMarkdownPaths({ path: '/proj' }, [
      md('/proj/a.md'),
      { path: '/proj/page.html', fileType: 'html' },
      { path: '/proj/pic.png', fileType: 'image' },
    ]),
    ['/proj/a.md'],
    'a snapshot with no readable content is worse than no snapshot',
  );
});

defineCase('an empty store still shares what the message names', () => {
  // No files picked: the browser loop still renders the sample document, and
  // sharing it should produce a snapshot rather than nothing at all.
  eq(
    sharedMarkdownPaths({ path: '/sample.md' }, []),
    ['/sample.md'],
    'fall back to the shared path',
  );
  eq(
    sharedMarkdownPaths({ path: '', primaryPath: '/focused.md' }, []),
    ['/focused.md'],
    'primaryPath is the next-best name',
  );
  eq(sharedMarkdownPaths({ path: '' }, []), [], 'nothing named, nothing published');
});

defineCase('a selection is de-duplicated', () => {
  eq(
    sharedMarkdownPaths({ path: '/proj', selectedPaths: ['/proj/a.md', '/proj/a.md'] }, []),
    ['/proj/a.md'],
    'the same file twice would publish two snapshots for one document',
  );
  eq(
    sharedMarkdownPaths({ path: '/proj', selectedPaths: ['', '/proj/a.md'] }, [md('/proj/z.md')]),
    ['/proj/a.md'],
    'empty entries must not suppress the real selection',
  );
});

defineCase('root containment matches the Rust walk', () => {
  assert(pathWithinRoot('/proj/a.md', '/proj'), 'a child is within');
  assert(pathWithinRoot('/proj', '/proj'), 'the root is within itself');
  assert(pathWithinRoot('/proj/a.md', '/proj/'), 'a trailing slash on the root is tolerated');
  assert(!pathWithinRoot('/project/a.md', '/proj'), 'a path PREFIX is not containment');
  assert(pathWithinRoot('/anything', ''), 'an empty root contains everything');
});

defineCase('file ids are stable across re-shares', () => {
  // If re-sharing minted a new FileId the store would treat it as a different
  // document and strand every comment authored against the first share.
  eq(
    mockFileIdFor('/proj/a.md'),
    mockFileIdFor('/proj/a.md'),
    'the same path must always yield the same id',
  );
  assert(
    mockFileIdFor('/proj/a.md') !== mockFileIdFor('/proj/b.md'),
    'different paths must not collide',
  );
  assert(
    /^mock-file-[A-Za-z0-9-]+$/u.test(mockFileIdFor('/proj/a b/ünïcode.md')),
    'ids stay wire-safe for awkward paths',
  );
  assert(mockFileIdFor('///') === 'mock-file-untitled', 'a path with no usable slug still gets an id');
});

defineCase('snapshot ids are content-addressed', () => {
  const fileId = mockFileIdFor('/proj/a.md');
  assert(
    mockSnapshotIdFor(fileId, 'aaaaaaaabbbb') !== mockSnapshotIdFor(fileId, 'ccccccccdddd'),
    'editing a file must produce a new snapshot',
  );
  eq(
    mockSnapshotIdFor(fileId, 'aaaaaaaabbbb'),
    mockSnapshotIdFor(fileId, 'aaaaaaaabbbb'),
    're-sharing unchanged content is idempotent',
  );
});

defineCase('the mock share actually publishes what it decides', () => {
  // The decisions above are worthless if nothing calls them, and "nothing
  // called it" is precisely the shape of the original bug.
  const src = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), 'mock-ipc.ts'),
    'utf8',
  );
  const share = src.slice(src.indexOf('function handleReviewShare'));
  assert(
    share.slice(0, 2000).includes('publishMockSnapshots'),
    'handleReviewShare must publish snapshots, not just ShareReady + status',
  );
  const publisher = src.slice(src.indexOf('async function publishMockSnapshots'));
  assert(
    publisher.slice(0, 2500).includes('buildCanonicalAnchorIndex'),
    'the anchor index must be the canonical Rust/comrak one, never hand-rolled',
  );
  assert(
    publisher.slice(0, 2500).includes('contentHash'),
    'the baseHash must be the real content hash so anchors resolve by base-hash match',
  );
  assert(
    publisher.slice(0, 2500).includes('ownerDisplayPath'),
    'without ownerDisplayPath the store cannot map the open document to a FileId',
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
