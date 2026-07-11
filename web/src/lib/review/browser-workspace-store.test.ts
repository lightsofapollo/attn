import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { BrowserStorage, BrowserStorageError, StorageConflictError } from './browser-storage';
import {
  STORE_WORKSPACE_LEASES,
  WORKSPACE_RECORD_VERSION,
  type WorkspaceLeaseRecord,
} from './browser-workspace-schema';

Object.defineProperty(globalThis, 'IDBKeyRange', {
  configurable: true,
  value: IDBKeyRange,
});

interface CaseResult {
  name: string;
  ok: boolean;
  detail?: string;
}

const cases: Array<() => Promise<CaseResult>> = [];

function defineCase(name: string, fn: () => Promise<void | string> | void | string): void {
  cases.push(async () => {
    try {
      const note = await fn();
      return { name, ok: true, detail: typeof note === 'string' ? note : undefined };
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

async function expectConflict(promise: Promise<unknown>, message: string): Promise<void> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof StorageConflictError) return;
    throw new Error(`${message}: expected StorageConflictError, got ${String(error)}`);
  }
  throw new Error(`${message}: expected StorageConflictError`);
}

async function expectStorageError(promise: Promise<unknown>, message: string): Promise<void> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof BrowserStorageError) return;
    throw new Error(`${message}: expected BrowserStorageError, got ${String(error)}`);
  }
  throw new Error(`${message}: expected BrowserStorageError`);
}

function text(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

let databaseCounter = 0;

interface Harness {
  storage: BrowserStorage;
  reopen: () => Promise<BrowserStorage>;
  clock: { value: number };
}

async function openStorage(): Promise<Harness> {
  databaseCounter += 1;
  const factory = new IDBFactory();
  const name = `attn-workspace-store-test-${databaseCounter}`;
  const clock = { value: 1_700_000_000_000 };
  const open = () =>
    BrowserStorage.open({
      indexedDB: factory,
      databaseName: name,
      createIfMissing: true,
      filesystem: null,
      navigator: null,
      now: () => (clock.value += 1),
    });
  return { storage: await open(), reopen: open, clock };
}

async function createDesk(storage: BrowserStorage): Promise<string> {
  const created = await storage.workspaces.createWorkspace({
    name: 'Product direction',
    storagePersisted: true,
    entry: { path: 'untitled.md', kind: 'markdown', body: text('# Untitled\n') },
  });
  return created.workspace.workspaceId;
}

defineCase('one-click create: workspace + untitled.md + revision in one shot', async () => {
  const { storage, reopen } = await openStorage();
  const created = await storage.workspaces.createWorkspace({
    name: 'Product direction',
    storagePersisted: true,
    entry: { path: 'untitled.md', kind: 'markdown', body: text('# Untitled\n') },
  });
  assertEqual(created.workspace.clock, 1, 'clock starts at 1');
  assertEqual(created.workspace.activePath, 'untitled.md', 'created entry is selected');
  assertEqual(created.entry.headRevisionId, created.revision.revisionId, 'entry heads the revision');
  storage.close();

  const reopened = await reopen();
  try {
    const body = await reopened.workspaces.getHeadBody(
      created.workspace.workspaceId,
      'untitled.md',
    );
    assertEqual(decode(body), '# Untitled\n', 'body survives reload sealed');
    body.fill(0);
    const listed = await reopened.workspaces.listWorkspaces();
    assertEqual(listed.length, 1, 'workspace listed');
  } finally {
    reopened.close();
  }
});

defineCase('create conflicts on an existing id; orphan keys are reused on retry', async () => {
  const { storage } = await openStorage();
  try {
    const ws = await createDesk(storage);
    await expectConflict(
      storage.workspaces.createWorkspace({
        workspaceId: ws,
        name: 'Duplicate',
        storagePersisted: true,
        entry: { path: 'untitled.md', kind: 'markdown', body: text('x') },
      }),
      'duplicate workspace id',
    );
    // Orphan key (crash between key creation and record tx): simulate by
    // creating a key without records, then creating the workspace.
    await storage.createWorkspaceKey('ws-orphan');
    const created = await storage.workspaces.createWorkspace({
      workspaceId: 'ws-orphan',
      name: 'Recovered',
      storagePersisted: false,
      entry: { path: 'untitled.md', kind: 'markdown', body: text('recovered') },
    });
    const body = await storage.workspaces.getHeadBody('ws-orphan', 'untitled.md');
    assertEqual(decode(body), 'recovered', 'orphan key still opens the sealed body');
    assertEqual(created.workspace.clock, 1, 'fresh clock');
  } finally {
    storage.close();
  }
});

defineCase('commitRevision advances the head atomically with strict clocks', async () => {
  const { storage } = await openStorage();
  try {
    const ws = await createDesk(storage);
    const first = await storage.workspaces.commitRevision({
      workspaceId: ws,
      path: 'untitled.md',
      body: text('draft one'),
    });
    const second = await storage.workspaces.commitRevision({
      workspaceId: ws,
      path: 'untitled.md',
      body: text('draft two'),
      expectedHeadRevisionId: first.revision.revisionId,
    });
    assert(second.workspace.clock > first.workspace.clock, 'clock strictly increases');
    assert(second.workspace.updatedAt >= first.workspace.updatedAt, 'updatedAt monotonic');
    const body = await storage.workspaces.getHeadBody(ws, 'untitled.md');
    assertEqual(decode(body), 'draft two', 'head is the last committed body');
    const history = await storage.workspaces.listRevisions(ws, 'untitled.md');
    assertEqual(history.length, 3, 'immutable history keeps all revisions');
    assert(
      history[0]!.clock < history[1]!.clock && history[1]!.clock < history[2]!.clock,
      'history ordered by clock',
    );
  } finally {
    storage.close();
  }
});

defineCase('optimistic head expectation rejects a moved head', async () => {
  const { storage } = await openStorage();
  try {
    const ws = await createDesk(storage);
    const first = await storage.workspaces.commitRevision({
      workspaceId: ws,
      path: 'untitled.md',
      body: text('one'),
    });
    await storage.workspaces.commitRevision({
      workspaceId: ws,
      path: 'untitled.md',
      body: text('two'),
    });
    await expectConflict(
      storage.workspaces.commitRevision({
        workspaceId: ws,
        path: 'untitled.md',
        body: text('stale write'),
        expectedHeadRevisionId: first.revision.revisionId,
      }),
      'stale expected head',
    );
    const body = await storage.workspaces.getHeadBody(ws, 'untitled.md');
    assertEqual(decode(body), 'two', 'failed commit leaves the last committed head');
  } finally {
    storage.close();
  }
});

defineCase('idempotent commit: same revision id + content is a no-op replay', async () => {
  const { storage } = await openStorage();
  try {
    const ws = await createDesk(storage);
    const first = await storage.workspaces.commitRevision({
      workspaceId: ws,
      path: 'untitled.md',
      body: text('same body'),
      revisionId: 'rev-fixed',
    });
    const replay = await storage.workspaces.commitRevision({
      workspaceId: ws,
      path: 'untitled.md',
      body: text('same body'),
      revisionId: 'rev-fixed',
    });
    assertEqual(replay.revision.revisionId, 'rev-fixed', 'replay returns the stored revision');
    assertEqual(
      (await storage.workspaces.listRevisions(ws, 'untitled.md')).length,
      2,
      'no duplicate revision was written',
    );
    assertEqual(replay.workspace.clock, first.workspace.clock, 'replay does not bump the clock');
    await expectConflict(
      storage.workspaces.commitRevision({
        workspaceId: ws,
        path: 'untitled.md',
        body: text('DIFFERENT body'),
        revisionId: 'rev-fixed',
      }),
      'same id, different content',
    );
  } finally {
    storage.close();
  }
});

defineCase('createEntry enforces path uniqueness and revives tombstones', async () => {
  const { storage } = await openStorage();
  try {
    const ws = await createDesk(storage);
    await storage.workspaces.createEntry({
      workspaceId: ws,
      path: 'images/desk.png',
      kind: 'asset',
      mediaType: 'image/png',
      body: new Uint8Array([1, 2, 3]),
    });
    await expectConflict(
      storage.workspaces.createEntry({
        workspaceId: ws,
        path: 'images/desk.png',
        kind: 'asset',
        body: new Uint8Array([9]),
      }),
      'duplicate path',
    );
    await storage.workspaces.deleteEntry({ workspaceId: ws, path: 'images/desk.png' });
    assertEqual(
      await storage.workspaces.getEntry(ws, 'images/desk.png'),
      null,
      'tombstoned entry is not readable',
    );
    const revived = await storage.workspaces.createEntry({
      workspaceId: ws,
      path: 'images/desk.png',
      kind: 'asset',
      mediaType: 'image/png',
      body: new Uint8Array([4, 5]),
    });
    assertEqual(revived.entry.sizeBytes, 2, 'revived entry has the fresh body');
    const entries = await storage.workspaces.listEntries(ws);
    assertEqual(entries.length, 2, 'live entries: untitled.md + revived asset');
  } finally {
    storage.close();
  }
});

defineCase('rename re-seals the head at the new path and retires the old one', async () => {
  const { storage } = await openStorage();
  try {
    const ws = await createDesk(storage);
    await storage.workspaces.commitRevision({
      workspaceId: ws,
      path: 'untitled.md',
      body: text('renamed content'),
    });
    const renamed = await storage.workspaces.renameEntry({
      workspaceId: ws,
      fromPath: 'untitled.md',
      toPath: 'docs/direction.md',
    });
    assertEqual(renamed.entry.path, 'docs/direction.md', 'entry moved');
    assertEqual(renamed.workspace.activePath, 'docs/direction.md', 'selection follows rename');
    assertEqual(await storage.workspaces.getEntry(ws, 'untitled.md'), null, 'old path gone');
    const body = await storage.workspaces.getHeadBody(ws, 'docs/direction.md');
    assertEqual(decode(body), 'renamed content', 'body opens at the new path');
    assertEqual(
      (await storage.workspaces.listRevisions(ws, 'untitled.md')).length,
      0,
      'old-path revisions retired',
    );
    await expectConflict(
      storage.workspaces
        .createEntry({ workspaceId: ws, path: 'x.md', kind: 'markdown', body: text('x') })
        .then(() =>
          storage.workspaces.renameEntry({
            workspaceId: ws,
            fromPath: 'x.md',
            toPath: 'docs/direction.md',
          }),
        ),
      'rename onto an existing path',
    );
  } finally {
    storage.close();
  }
});

defineCase('delete tombstones the entry and clears the selection', async () => {
  const { storage } = await openStorage();
  try {
    const ws = await createDesk(storage);
    const workspace = await storage.workspaces.deleteEntry({ workspaceId: ws, path: 'untitled.md' });
    assertEqual(workspace.activePath, undefined, 'selection cleared');
    assertEqual((await storage.workspaces.listEntries(ws)).length, 0, 'no live entries');
    await expectStorageError(
      storage.workspaces.deleteEntry({ workspaceId: ws, path: 'untitled.md' }),
      'double delete',
    );
  } finally {
    storage.close();
  }
});

defineCase('select requires a live entry and persists', async () => {
  const { storage } = await openStorage();
  try {
    const ws = await createDesk(storage);
    await storage.workspaces.createEntry({
      workspaceId: ws,
      path: 'notes.md',
      kind: 'markdown',
      body: text('notes'),
    });
    const selected = await storage.workspaces.selectEntry({ workspaceId: ws, path: 'notes.md' });
    assertEqual(selected.activePath, 'notes.md', 'selection stored');
    await expectStorageError(
      storage.workspaces.selectEntry({ workspaceId: ws, path: 'missing.md' }),
      'selecting a missing entry',
    );
  } finally {
    storage.close();
  }
});

defineCase('lease fencing rejects stale holders and honors the active one', async () => {
  const { storage } = await openStorage();
  try {
    const ws = await createDesk(storage);
    // Install a lease record directly (the lease lifecycle is attn-7xl.2.6).
    const lease: WorkspaceLeaseRecord = {
      v: WORKSPACE_RECORD_VERSION,
      workspaceId: ws,
      holderId: 'tab-a',
      fencingToken: 2,
      expiresAt: 1_900_000_000_000,
    };
    // Write the lease through a raw transaction on the same database.
    await (async () => {
      const db = (storage as unknown as { db: IDBDatabase }).db;
      const tx = db.transaction(STORE_WORKSPACE_LEASES, 'readwrite');
      tx.objectStore(STORE_WORKSPACE_LEASES).put(lease);
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error);
      });
    })();
    await expectConflict(
      storage.workspaces.commitRevision({
        workspaceId: ws,
        path: 'untitled.md',
        body: text('stale'),
        fence: { holderId: 'tab-b', fencingToken: 1 },
      }),
      'stale holder is fenced off',
    );
    await expectConflict(
      storage.workspaces.commitRevision({
        workspaceId: ws,
        path: 'untitled.md',
        body: text('old token'),
        fence: { holderId: 'tab-a', fencingToken: 1 },
      }),
      'old token is fenced off',
    );
    const committed = await storage.workspaces.commitRevision({
      workspaceId: ws,
      path: 'untitled.md',
      body: text('fenced write'),
      fence: { holderId: 'tab-a', fencingToken: 2 },
    });
    assertEqual(
      decode(await storage.workspaces.getHeadBody(ws, 'untitled.md')),
      'fenced write',
      'active holder writes',
    );
    assert(committed.workspace.clock > 1, 'commit landed');
  } finally {
    storage.close();
  }
});

defineCase('aborted transactions leave the previous committed state intact', async () => {
  const { storage } = await openStorage();
  try {
    const ws = await createDesk(storage);
    const before = await storage.workspaces.getWorkspace(ws);
    assert(before, 'workspace exists');
    // Force a failure inside apply: commit onto a path deleted mid-flight.
    await storage.workspaces.createEntry({
      workspaceId: ws,
      path: 'doomed.md',
      kind: 'markdown',
      body: text('doomed'),
    });
    const afterCreate = await storage.workspaces.getWorkspace(ws);
    await expectConflict(
      storage.workspaces.createEntry({
        workspaceId: ws,
        path: 'doomed.md',
        kind: 'markdown',
        body: text('conflicting create'),
      }),
      'duplicate create aborts',
    );
    const after = await storage.workspaces.getWorkspace(ws);
    assertEqual(after!.clock, afterCreate!.clock, 'failed mutation does not bump the clock');
    assertEqual(
      decode(await storage.workspaces.getHeadBody(ws, 'doomed.md')),
      'doomed',
      'previous head intact after abort',
    );
  } finally {
    storage.close();
  }
});

defineCase('timestamps stay monotonic even when the wall clock runs backwards', async () => {
  const { storage, clock } = await openStorage();
  try {
    const ws = await createDesk(storage);
    const first = await storage.workspaces.getWorkspace(ws);
    clock.value = 1; // wall clock jumps far into the past
    const committed = await storage.workspaces.commitRevision({
      workspaceId: ws,
      path: 'untitled.md',
      body: text('backwards clock'),
    });
    assert(
      committed.workspace.updatedAt >= first!.updatedAt,
      'updatedAt never decreases',
    );
    assert(committed.workspace.clock > first!.clock, 'clock still strictly increases');
  } finally {
    storage.close();
  }
});

defineCase('deleteWorkspace crypto-erases the key before removing records', async () => {
  const { storage } = await openStorage();
  try {
    const ws = await createDesk(storage);
    assert(await storage.workspaces.deleteWorkspace(ws), 'delete reports success');
    assertEqual(await storage.workspaces.getWorkspace(ws), null, 'workspace gone');
    assertEqual(await storage.getWorkspaceRootKey(ws), null, 'root key gone');
    assertEqual((await storage.workspaces.listWorkspaces()).length, 0, 'not listed');
    assert(!(await storage.workspaces.deleteWorkspace(ws)), 'second delete is a no-op');
  } finally {
    storage.close();
  }
});

async function runAllCases(): Promise<void> {
  let passed = 0;
  const failures: string[] = [];
  for (const run of cases) {
    const result = await run();
    if (result.ok) {
      passed += 1;
      console.log(`PASS ${result.name}${result.detail ? ` — ${result.detail}` : ''}`);
    } else {
      failures.push(`${result.name}: ${result.detail ?? 'unknown failure'}`);
      console.error(`FAIL ${result.name}\n${result.detail ?? ''}`);
    }
  }
  console.log(`browser-workspace-store: ${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) process.exit(1);
}

void runAllCases();
