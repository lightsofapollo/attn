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

import {
  DropLimitError,
  DropReadError,
  MAX_DROP_DEPTH,
  MAX_DROP_FILES,
  fileDrop,
  filesToPicked,
  readDroppedFiles,
} from './file-drop';

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

type Entry = FileEntryStub | DirEntryStub | FailingDirEntryStub | FailingFileEntryStub;

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

/* Directories and files that fail PARTWAY (attn-ze60.2). The real entries API
   reports both through an error callback. `readAllEntries` used to answer one
   by resolving an empty batch — which is its own end-of-directory signal — and
   `entryFile` by resolving null, which the walk skipped. Either way the drop
   arrived as a shorter tree that looked complete. */

class FailingDirEntryStub {
  isFile = false as const;
  isDirectory = true as const;
  constructor(readonly fullPath: string, private readonly firstBatch: Entry[]) {}
  createReader(): {
    readEntries: (cb: (entries: Entry[]) => void, onError: (error: unknown) => void) => void;
  } {
    // One good batch, then a failure: the shape where "resolve empty" and
    // "genuinely finished" are indistinguishable to the caller.
    let handed = false;
    return {
      readEntries: (cb, onError) => {
        if (handed) return onError(new Error('readEntries failed'));
        handed = true;
        cb(this.firstBatch);
      },
    };
  }
}

class FailingFileEntryStub {
  isFile = true as const;
  isDirectory = false as const;
  constructor(readonly fullPath: string) {}
  file(_onSuccess: (file: File) => void, onError: (error: unknown) => void): void {
    onError(new Error('file() failed'));
  }
}

function transfer(entries: Entry[], files: File[] = []): DataTransfer {
  return {
    // `types` is what the drop handler checks before it accepts a drag at all.
    types: ['Files'],
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

/* ————— the ceilings (attn-e9r2.5) —————

   Reaching one used to stop the walk and hand back the partial list, so the
   import pipeline ran to completion and reported success over a tree with
   files missing that nobody could name. A ceiling is a failure, and it has to
   arrive as one. */

async function expectLimit(
  run: () => Promise<unknown>,
  limit: 'files' | 'depth',
): Promise<void> {
  let thrown: unknown = null;
  try {
    await run();
  } catch (error) {
    thrown = error;
  }
  assert(thrown instanceof DropLimitError, `expected a DropLimitError, got ${String(thrown)}`);
  assertEqual(thrown.limit, limit, 'names which ceiling');
  assert(thrown.message.includes('Nothing was imported'), 'says nothing was imported');
}

defineCase('a cyclic tree fails loudly instead of hanging the tab', async () => {
  // A drop is an untrusted shape. This models the pathological case the depth
  // cap exists for — an entry whose reader keeps handing back a child directory
  // — and asserts the walk terminates AND reports, rather than recursing until
  // the tab dies or returning an empty list that reads as "nothing to import".
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
  await expectLimit(() => readDroppedFiles(transfer([loop])), 'depth');
});

defineCase('a folder deeper than the depth ceiling aborts', async () => {
  // One chain, one file at the bottom, one level past the cap.
  let node: Entry = new FileEntryStub('/deep/leaf.md', 'x');
  for (let level = MAX_DROP_DEPTH + 1; level > 0; level -= 1) {
    node = new DirEntryStub(`/deep-${level}`, [node]);
  }
  await expectLimit(() => readDroppedFiles(transfer([node])), 'depth');
});

defineCase('a folder over the file ceiling aborts rather than truncating', async () => {
  const many = Array.from(
    { length: MAX_DROP_FILES + 1 },
    (_, i) => new FileEntryStub(`/huge/f${i}.md`, 'x'),
  );
  await expectLimit(() => readDroppedFiles(transfer([new DirEntryStub('/huge', many)])), 'files');
});

defineCase('a folder exactly at the file ceiling still imports', async () => {
  // The ceiling is a limit, not a margin: the last allowed drop must work, or
  // the error would be firing on shapes the app claims to support.
  const many = Array.from(
    { length: MAX_DROP_FILES },
    (_, i) => new FileEntryStub(`/full/f${i}.md`, 'x'),
  );
  const dropped = await readDroppedFiles(transfer([new DirEntryStub('/full', many)]));
  assertEqual(dropped.length, MAX_DROP_FILES, 'every file survives');
});

/* ————— reads that fail partway (attn-ze60.2) ————— */

async function expectReadError(run: () => Promise<unknown>, path: string): Promise<void> {
  let thrown: unknown = null;
  try {
    await run();
  } catch (error) {
    thrown = error;
  }
  assert(thrown instanceof DropReadError, `expected a DropReadError, got ${String(thrown)}`);
  assertEqual(thrown.path, path, 'names the entry that would not read');
  assert(thrown.message.includes('Nothing was imported'), 'says nothing was imported');
}

defineCase('a directory read that fails midway reports, not imports what it had', async () => {
  const dir = new FailingDirEntryStub('/notes', [
    new FileEntryStub('/notes/a.md', 'a'),
    new FileEntryStub('/notes/b.md', 'b'),
  ]);
  await expectReadError(() => readDroppedFiles(transfer([dir])), 'notes');
});

defineCase('a file that will not open fails the drop rather than vanishing from it', async () => {
  const dir = new DirEntryStub('/notes', [
    new FileEntryStub('/notes/a.md', 'a'),
    new FailingFileEntryStub('/notes/gone.md'),
  ]);
  await expectReadError(() => readDroppedFiles(transfer([dir])), 'notes/gone.md');
});

/* ————— and the whole way out to the drop surface —————

   The callbacks are the contract every drop surface is written against: a read
   that could not finish must arrive as onError, never as a shorter onFiles. */

function fakeDropTarget(): { node: HTMLElement; drop: (data: DataTransfer) => void } {
  const listeners = new Map<string, (event: unknown) => void>();
  const node = {
    addEventListener: (type: string, fn: (event: unknown) => void) => void listeners.set(type, fn),
    removeEventListener: (type: string) => void listeners.delete(type),
    setAttribute: () => undefined,
    removeAttribute: () => undefined,
  } as unknown as HTMLElement;
  return {
    node,
    drop: (dataTransfer) =>
      listeners.get('drop')?.({ dataTransfer, preventDefault: () => undefined }),
  };
}

/** Let the drop handler's promise chain run out; every stub resolves in-process. */
async function settle(): Promise<void> {
  for (let tick = 0; tick < 20; tick += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

defineCase('a failed read reaches the surface as onError, never a short onFiles', async () => {
  const target = fakeDropTarget();
  let imported: number | null = null;
  let reported: string | null = null;
  fileDrop(target.node, {
    onFiles: (files) => {
      imported = files.length;
    },
    onError: (message) => {
      reported = message;
    },
  });
  target.drop(
    transfer([
      new FailingDirEntryStub('/notes', [new FileEntryStub('/notes/a.md', 'a')]),
    ]),
  );
  await settle();
  assertEqual(imported, null, 'nothing is imported');
  assert(reported !== null, 'the failure is reported');
  assert(
    (reported as string).includes('Nothing was imported'),
    `the message says so, got ${String(reported)}`,
  );
});

defineCase('a whole drop still reaches onFiles', async () => {
  // The counterpart: the reject path must not have made every drop an error.
  const target = fakeDropTarget();
  let imported: number | null = null;
  let reported: string | null = null;
  fileDrop(target.node, {
    onFiles: (files) => {
      imported = files.length;
    },
    onError: (message) => {
      reported = message;
    },
  });
  target.drop(transfer([new DirEntryStub('/notes', [new FileEntryStub('/notes/a.md', 'a')])]));
  await settle();
  assertEqual(reported, null, 'no error');
  assertEqual(imported, 1, 'the file is imported');
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
