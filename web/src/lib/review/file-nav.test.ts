// Manual test harness for `file-nav.ts` (folder-share file switcher).
//
// The web/ package uses a custom defineCase/run harness rather than vitest.
// Run this file directly with:
//
//   cd web && npx tsx src/lib/review/file-nav.test.ts
//
// (The repo's `npm test` runner auto-discovers it under src/**/*.test.ts.)
// Each case builds a snapshot list + a currentRoomId, calls
// `deriveFileEntries`, and asserts on the resulting entry list.

import { deriveFileEntries, type ReviewFileEntry } from './file-nav';
import { deriveSharedFiles } from './shared-tree';
import type { FileId, RoomId, ReviewSnapshot } from '../types';

// ---------------------------------------------------------------------------
// Tiny harness (mirrors resolver.test.ts)
// ---------------------------------------------------------------------------

interface CaseResult {
  name: string;
  ok: boolean;
  detail?: string;
}

const cases: Array<() => CaseResult> = [];

function defineCase(name: string, fn: () => void | string): void {
  cases.push(() => {
    try {
      const note = fn();
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
// Test data builders
// ---------------------------------------------------------------------------

function snap(opts: {
  roomId: string;
  fileId: string;
  snapshotId: string;
  createdAt: number;
  markdown?: string;
}): ReviewSnapshot {
  return {
    roomId: opts.roomId as RoomId,
    fileId: opts.fileId as FileId,
    snapshotId: opts.snapshotId,
    createdAt: opts.createdAt,
    createdBy: 'author_1',
    baseHash: `hash:${opts.snapshotId}`,
    byteLength: opts.markdown ? opts.markdown.length : 0,
    docType: 'markdown',
    content: opts.markdown,
  };
}

function names(entries: ReviewFileEntry[]): string[] {
  return entries.map((e) => e.name);
}

function fileIds(entries: ReviewFileEntry[]): string[] {
  return entries.map((e) => e.fileId);
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

// Case 1: no current room → []
defineCase('null currentRoomId → empty', () => {
  const snaps = [snap({ roomId: 'r1', fileId: 'f1', snapshotId: 's1', createdAt: 1, markdown: '# A' })];
  const out = deriveFileEntries(snaps, null);
  assert(out.length === 0, `expected [], got ${JSON.stringify(out)}`);
});

// Case 2: empty snapshot list → []
defineCase('empty snapshots → empty', () => {
  const out = deriveFileEntries([], 'r1' as RoomId);
  assert(out.length === 0, `expected [], got ${JSON.stringify(out)}`);
});

// Case 3: snapshots all in a different room → []
defineCase('snapshots only in other rooms → empty', () => {
  const snaps = [
    snap({ roomId: 'other', fileId: 'f1', snapshotId: 's1', createdAt: 1, markdown: '# A' }),
    snap({ roomId: 'other', fileId: 'f2', snapshotId: 's2', createdAt: 1, markdown: '# B' }),
  ];
  const out = deriveFileEntries(snaps, 'r1' as RoomId);
  assert(out.length === 0, `expected [], got ${JSON.stringify(out)}`);
});

// Case 4: multiple files → one entry each, names from H1, sorted by name.
defineCase('multiple files → one entry each with H1 names, sorted', () => {
  const snaps = [
    snap({ roomId: 'r1', fileId: 'f1', snapshotId: 's1', createdAt: 1, markdown: '# Zeta\n\nbody' }),
    snap({ roomId: 'r1', fileId: 'f2', snapshotId: 's2', createdAt: 1, markdown: '# Alpha\n\nbody' }),
    snap({ roomId: 'r1', fileId: 'f3', snapshotId: 's3', createdAt: 1, markdown: '## Mid level\n\nbody' }),
  ];
  const out = deriveFileEntries(snaps, 'r1' as RoomId);
  assert(out.length === 3, `expected 3 entries, got ${out.length}`);
  // Sorted by name.localeCompare: Alpha, Mid level, Zeta.
  assert(
    JSON.stringify(names(out)) === JSON.stringify(['Alpha', 'Mid level', 'Zeta']),
    `name order mismatch: ${JSON.stringify(names(out))}`,
  );
  // Each entry maps to its own fileId.
  const byName = new Map(out.map((e) => [e.name, e.fileId]));
  assert(byName.get('Alpha') === 'f2', 'Alpha → f2');
  assert(byName.get('Zeta') === 'f1', 'Zeta → f1');
  assert(byName.get('Mid level') === 'f3', 'Mid level → f3');
});

// Case 5: latest snapshot wins per fileId (max createdAt).
defineCase('latest-snapshot-wins per fileId', () => {
  const snaps = [
    snap({ roomId: 'r1', fileId: 'f1', snapshotId: 's-old', createdAt: 10, markdown: '# Old Title' }),
    snap({ roomId: 'r1', fileId: 'f1', snapshotId: 's-new', createdAt: 20, markdown: '# New Title' }),
    // Out-of-order arrival: an older snapshot listed after the newest one must
    // not clobber the latest.
    snap({ roomId: 'r1', fileId: 'f1', snapshotId: 's-mid', createdAt: 15, markdown: '# Mid Title' }),
  ];
  const out = deriveFileEntries(snaps, 'r1' as RoomId);
  assert(out.length === 1, `expected 1 entry, got ${out.length}`);
  assert(out[0]!.name === 'New Title', `expected latest 'New Title', got ${out[0]!.name}`);
  assert(out[0]!.fileId === 'f1', `expected f1, got ${out[0]!.fileId}`);
});

// Case 6: heading fallback for headingless docs (deterministic Document N).
defineCase('heading fallback → Document N for headingless docs', () => {
  const snaps = [
    snap({ roomId: 'r1', fileId: 'f1', snapshotId: 's1', createdAt: 1, markdown: 'no heading here\njust body' }),
    snap({ roomId: 'r1', fileId: 'f2', snapshotId: 's2', createdAt: 1, markdown: '# Has Heading' }),
    snap({ roomId: 'r1', fileId: 'f3', snapshotId: 's3', createdAt: 1 }), // no markdown at all
  ];
  const out = deriveFileEntries(snaps, 'r1' as RoomId);
  assert(out.length === 3, `expected 3 entries, got ${out.length}`);
  // f1 is the first headingless file (Document 1), f3 the second (Document 2);
  // f2 keeps its heading. Sorted by name: "Document 1", "Document 2", "Has Heading".
  assert(
    JSON.stringify(names(out)) === JSON.stringify(['Document 1', 'Document 2', 'Has Heading']),
    `fallback name order mismatch: ${JSON.stringify(names(out))}`,
  );
  const byName = new Map(out.map((e) => [e.name, e.fileId]));
  assert(byName.get('Document 1') === 'f1', 'Document 1 → f1 (first headingless)');
  assert(byName.get('Document 2') === 'f3', 'Document 2 → f3 (second headingless)');
  assert(byName.get('Has Heading') === 'f2', 'Has Heading → f2');
});

// Case 7: leading-whitespace lines + a heading not on the first line still
// resolves to the heading; blank-only headings fall back.
defineCase('heading detection: first heading anywhere; empty heading falls back', () => {
  const withLaterHeading = snap({
    roomId: 'r1', fileId: 'f1', snapshotId: 's1', createdAt: 1,
    markdown: 'intro paragraph\n\n## Section One\n\nmore',
  });
  const emptyHeading = snap({
    roomId: 'r1', fileId: 'f2', snapshotId: 's2', createdAt: 1,
    markdown: '#   \n\nbody only',
  });
  const out = deriveFileEntries([withLaterHeading, emptyHeading], 'r1' as RoomId);
  assert(out.length === 2, `expected 2, got ${out.length}`);
  const byFile = new Map(out.map((e) => [e.fileId, e.name]));
  assert(byFile.get('f1') === 'Section One', `f1 name: ${byFile.get('f1')}`);
  assert(byFile.get('f2') === 'Document 1', `f2 fallback: ${byFile.get('f2')}`);
});

// Case 8: cross-room isolation — only currentRoom snapshots count.
defineCase('mixed rooms → only currentRoom files appear', () => {
  const snaps = [
    snap({ roomId: 'r1', fileId: 'f1', snapshotId: 's1', createdAt: 1, markdown: '# Keep' }),
    snap({ roomId: 'r2', fileId: 'f2', snapshotId: 's2', createdAt: 1, markdown: '# Drop' }),
  ];
  const out = deriveFileEntries(snaps, 'r1' as RoomId);
  assert(out.length === 1, `expected 1, got ${out.length}`);
  assert(JSON.stringify(fileIds(out)) === JSON.stringify(['f1']), `fileIds: ${JSON.stringify(fileIds(out))}`);
  assert(out[0]!.name === 'Keep', `name: ${out[0]!.name}`);
});

defineCase('assets, manifests, and pointer placeholders never become file entries', () => {
  const document = snap({
    roomId: 'r1', fileId: 'doc', snapshotId: 'doc-snapshot', createdAt: 1, markdown: '# Visible',
  });
  const inert: ReviewSnapshot[] = [
    {
      ...document,
      fileId: 'asset' as FileId,
      snapshotId: 'asset-snapshot',
      docType: 'asset',
      content: undefined,
      mediaType: 'application/octet-stream',
    },
    {
      ...document,
      fileId: 'manifest' as FileId,
      snapshotId: 'manifest-snapshot',
      docType: 'workspace_manifest',
      content: undefined,
    },
    {
      ...document,
      fileId: 'pointer' as FileId,
      snapshotId: 'pointer-snapshot',
      docType: undefined,
      content: undefined,
    },
  ];
  const out = deriveFileEntries([...inert, document], 'r1' as RoomId);
  assert(out.length === 1, `expected only one renderable entry, got ${JSON.stringify(out)}`);
  assert(out[0]?.fileId === 'doc', `expected document entry, got ${String(out[0]?.fileId)}`);
  const treeFiles = deriveSharedFiles([...inert, document], 'r1' as RoomId);
  assert(treeFiles.length === 1, `expected one shared-tree file, got ${JSON.stringify(treeFiles)}`);
  assert(treeFiles[0]?.fileId === 'doc', 'shared tree must exclude every inert snapshot');
});

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

function run(): number {
  let pass = 0;
  let fail = 0;
  for (const fn of cases) {
    const res = fn();
    const tag = res.ok ? 'PASS' : 'FAIL';
    const detail = res.detail ? ` — ${res.detail}` : '';
    // eslint-disable-next-line no-console
    console.log(`${tag}  ${res.name}${detail}`);
    if (res.ok) pass++;
    else fail++;
  }
  // eslint-disable-next-line no-console
  console.log(`\n${pass}/${pass + fail} passed`);
  return fail === 0 ? 0 : 1;
}

interface NodeProcessShape {
  argv?: string[];
  exit?: (code: number) => void;
}

const nodeProcess: NodeProcessShape | undefined = (
  globalThis as unknown as { process?: NodeProcessShape }
).process;

const isMain =
  nodeProcess !== undefined &&
  Array.isArray(nodeProcess.argv) &&
  nodeProcess.argv[1] !== undefined &&
  nodeProcess.argv[1].endsWith('file-nav.test.ts');

if (isMain) {
  const code = run();
  nodeProcess?.exit?.(code);
}

export { run as runFileNavTests };
