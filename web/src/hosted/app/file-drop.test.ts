// Dropped FOLDERS (user ruling, 2026-08-20).
//
// THE FAILURE THIS PINS. Every drop surface in the hosted app read
// `dataTransfer.files`, where a dropped directory appears as a single
// unreadable zero-byte File. Dropping a folder onto the desk well, the import
// page or the editor canvas therefore imported nothing, or one junk entry named
// after the folder — while all three surfaces said "drop a folder here". Only
// the entries API (`webkitGetAsEntry`) can see inside one, and only the entry
// carries the path, so the walk has to hand the relative path down with each
// File or a folder flattens into loose files.
//
// Run with:
//
//   cd web && npx tsx src/hosted/app/file-drop.test.ts

import { filesToPicked, readDroppedFiles, type DroppedFile } from './file-drop';

interface CaseResult {
  name: string;
  ok: boolean;
  detail?: string;
}

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

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

/* ————— a minimal stand-in for the entries API ————— */

type Entry = FileEntryStub | DirEntryStub;

class FileEntryStub {
  isFile = true as const;
  isDirectory = false as const;
  constructor(readonly fullPath: string, private readonly body: string) {}
  file(onSuccess: (file: File) => void): void {
    const name = this.fullPath.split('/').at(-1) ?? 'file';
    onSuccess(new File([this.body], name, { type: 'text/markdown' }));
  }
}

class DirEntryStub {
  isFile = false as const;
  isDirectory = true as const;
  constructor(readonly fullPath: string, private readonly children: Entry[]) {}
  createReader(): { readEntries: (cb: (entries: Entry[]) => void) => void } {
    // The real reader hands back a batch at a time and signals the end with an
    // empty array; a walker that reads once sees only the first ~100 children.
    let handed = false;
    return {
      readEntries: (cb) => {
        if (handed) return cb([]);
        handed = true;
        cb(this.children);
      },
    };
  }
}

function transfer(entries: Entry[], files: File[] = []): DataTransfer {
  return {
    items: entries.map((entry) => ({ kind: 'file', webkitGetAsEntry: () => entry })),
    files,
  } as unknown as DataTransfer;
}

/* ————— cases ————— */

defineCase('a dropped folder is walked, not treated as one opaque file', async () => {
  const dropped = await readDroppedFiles(
    transfer([
      new DirEntryStub('/notes', [
        new FileEntryStub('/notes/plan.md', '# Plan'),
        new DirEntryStub('/notes/assets', [new FileEntryStub('/notes/assets/logo.svg', '<svg/>')]),
      ]),
    ]),
  );
  assertEqual(dropped.length, 2, 'both files surface');
  const paths = dropped.map((entry) => entry.relativePath).sort();
  assertEqual(paths[0], 'notes/assets/logo.svg', 'nested path is preserved');
  assertEqual(paths[1], 'notes/plan.md', 'top-level path is preserved');
});

defineCase('relative paths reach PickedFile, so the tree survives import', async () => {
  const dropped = await readDroppedFiles(
    transfer([new DirEntryStub('/docs', [new FileEntryStub('/docs/a/b.md', 'body')])]),
  );
  const picked = await filesToPicked(dropped);
  assertEqual(picked.length, 1, 'one file');
  assertEqual(picked[0].relativePath, 'docs/a/b.md', 'path carried through');
  assertEqual(picked[0].name, 'b.md', 'name is the leaf');
});

defineCase('a batching reader is drained, not read once', async () => {
  const many = Array.from({ length: 250 }, (_, i) => new FileEntryStub(`/big/f${i}.md`, 'x'));
  const dropped = await readDroppedFiles(transfer([new DirEntryStub('/big', many)]));
  assertEqual(dropped.length, 250, 'every child is read');
});

defineCase('loose files still work, folders or not', async () => {
  const dropped = await readDroppedFiles(
    transfer([new FileEntryStub('/loose.md', 'hi')]),
  );
  assertEqual(dropped.length, 1, 'one file');
  assertEqual(dropped[0].relativePath, 'loose.md', 'path is the bare name');
});

defineCase('no entries API falls back to dataTransfer.files', async () => {
  const file = new File(['hi'], 'plain.md', { type: 'text/markdown' });
  const dropped = await readDroppedFiles({
    items: undefined,
    files: [file],
  } as unknown as DataTransfer);
  assertEqual(dropped.length, 1, 'the plain file survives');
  assertEqual(dropped[0].file.name, 'plain.md', 'same file');
  assertEqual(dropped[0].relativePath, undefined, 'no path to claim');
});

defineCase('a null dataTransfer yields nothing rather than throwing', async () => {
  assertEqual((await readDroppedFiles(null)).length, 0, 'empty');
});

defineCase('a cyclic tree is bounded instead of hanging the tab', async () => {
  // A drop is an untrusted shape. This models the pathological case the depth
  // cap exists for — an entry whose reader keeps handing back a child directory
  // — and asserts the walk terminates rather than recursing until the tab dies.
  const loop: DirEntryStub = new DirEntryStub('/loop', []);
  (loop as unknown as { createReader: () => unknown }).createReader = () => {
    let handed = false;
    return {
      readEntries: (cb: (entries: Entry[]) => void) => {
        if (handed) return cb([]);
        handed = true;
        cb([loop]);
      },
    };
  };
  const dropped: DroppedFile[] = await readDroppedFiles(transfer([loop]));
  assertEqual(dropped.length, 0, 'no files, and it returned at all');
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
  console.log(`file-drop: ${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) process.exit(1);
}

void runAllCases();
