import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { BrowserStorage, BrowserStorageError } from './browser-storage';
import {
  WorkspaceStore,
  workspaceBlobPath,
  workspaceBlobPrefix,
  type WorkspaceBlobFileSystem,
} from './browser-workspace-store';
import {
  MAX_INLINE_SEALED_BODY_BYTES,
  STORE_WORKSPACE_GC,
  type WorkspaceGcRecord,
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

/** In-memory sealed-blob filesystem with fault injection. */
class FakeFilesystem implements WorkspaceBlobFileSystem {
  readonly files = new Map<string, Uint8Array>();
  failNextWrite = false;
  corruptReads = false;

  async write(path: string, sealedBytes: Uint8Array): Promise<void> {
    if (this.failNextWrite) {
      this.failNextWrite = false;
      throw new DOMException('simulated write failure', 'QuotaExceededError');
    }
    this.files.set(path, new Uint8Array(sealedBytes));
  }

  async read(path: string): Promise<Uint8Array | null> {
    const bytes = this.files.get(path);
    if (!bytes) return null;
    const copy = new Uint8Array(bytes);
    if (this.corruptReads) copy[0] ^= 0xff;
    return copy;
  }

  async delete(path: string): Promise<boolean> {
    return this.files.delete(path);
  }

  async deletePrefix(prefix: string): Promise<void> {
    for (const key of [...this.files.keys()]) {
      if (key.startsWith(prefix)) this.files.delete(key);
    }
  }
}

let databaseCounter = 0;
const THRESHOLD = 64; // tiny threshold so tests stay fast

interface Harness {
  storage: BrowserStorage;
  store: WorkspaceStore;
  fs: FakeFilesystem;
  db: IDBDatabase;
}

async function openHarness(fs: FakeFilesystem | null = new FakeFilesystem()): Promise<Harness> {
  databaseCounter += 1;
  const factory = new IDBFactory();
  const storage = await BrowserStorage.open({
    indexedDB: factory,
    databaseName: `attn-workspace-opfs-test-${databaseCounter}`,
    createIfMissing: true,
    filesystem: null,
    navigator: null,
  });
  const db = (storage as unknown as { db: IDBDatabase }).db;
  const store = new WorkspaceStore(db, crypto, Date.now, {
    filesystem: fs,
    inlineThresholdBytes: THRESHOLD,
  });
  return { storage, store, fs: fs as FakeFilesystem, db };
}

function bigBody(fill: number): Uint8Array {
  return new Uint8Array(4096).fill(fill);
}

function smallBody(): Uint8Array {
  return new TextEncoder().encode('small');
}

async function listGc(db: IDBDatabase): Promise<WorkspaceGcRecord[]> {
  const tx = db.transaction(STORE_WORKSPACE_GC, 'readonly');
  return new Promise((resolve, reject) => {
    const request = tx.objectStore(STORE_WORKSPACE_GC).getAll();
    request.onsuccess = () => resolve(request.result as WorkspaceGcRecord[]);
    request.onerror = () => reject(request.error);
  });
}

defineCase('large bodies route to OPFS and open back through the record', async () => {
  const { storage, store, fs, db } = await openHarness();
  try {
    const created = await store.createWorkspace({
      name: 'Big',
      storagePersisted: true,
      entry: { path: 'big.bin', kind: 'asset', mediaType: 'application/octet-stream', body: bigBody(7) },
    });
    assertEqual(created.revision.body.location, 'opfs', 'routed to opfs');
    const path = workspaceBlobPath(created.workspace.workspaceId, created.revision.revisionId);
    assert(fs.files.has(path), 'sealed file exists at the opaque path');
    assert(!path.includes(created.workspace.workspaceId), 'path leaks no workspace id');
    const body = await store.getHeadBody(created.workspace.workspaceId, 'big.bin');
    assertEqual(body.length, 4096, 'body length');
    assertEqual(body[100], 7, 'body content');
    assertEqual((await listGc(db)).length, 0, 'commit cleared the write-ahead intent');
    // Small bodies stay inline.
    await store.createEntry({
      workspaceId: created.workspace.workspaceId,
      path: 'small.md',
      kind: 'markdown',
      body: smallBody(),
    });
    const smallRev = (await store.listRevisions(created.workspace.workspaceId, 'small.md'))[0]!;
    assertEqual(smallRev.body.location, 'idb', 'small body stays inline');
  } finally {
    storage.close();
  }
});

defineCase('corrupted OPFS bytes fail closed on read', async () => {
  const { storage, store, fs } = await openHarness();
  try {
    const created = await store.createWorkspace({
      name: 'Corrupt',
      storagePersisted: true,
      entry: { path: 'big.bin', kind: 'asset', body: bigBody(3) },
    });
    fs.corruptReads = true;
    let failed = false;
    try {
      await store.getHeadBody(created.workspace.workspaceId, 'big.bin');
    } catch (error) {
      failed = error instanceof BrowserStorageError;
    }
    assert(failed, 'corrupted sealed file must not decrypt');
  } finally {
    storage.close();
  }
});

defineCase('missing OPFS falls back to encrypted IndexedDB for every size', async () => {
  const { storage, store } = await openHarness(null);
  try {
    const created = await store.createWorkspace({
      name: 'No OPFS',
      storagePersisted: false,
      entry: { path: 'big.bin', kind: 'asset', body: bigBody(9) },
    });
    // Over the routing threshold but under the inline cap: plain idb.
    assertEqual(created.revision.body.location, 'idb', 'medium fallback stays inline');
    const body = await store.getHeadBody(created.workspace.workspaceId, 'big.bin');
    assertEqual(body[0], 9, 'fallback body opens');
    // Over the inline cap: idb-large keeps the workspace usable.
    const huge = new Uint8Array(MAX_INLINE_SEALED_BODY_BYTES + 128).fill(8);
    await store.createEntry({
      workspaceId: created.workspace.workspaceId,
      path: 'huge.bin',
      kind: 'asset',
      body: huge,
    });
    const hugeRev = (await store.listRevisions(created.workspace.workspaceId, 'huge.bin'))[0]!;
    assertEqual(hugeRev.body.location, 'idb-large', 'oversized fallback uses idb-large');
    const hugeBody = await store.getHeadBody(created.workspace.workspaceId, 'huge.bin');
    assertEqual(hugeBody.length, huge.length, 'idb-large body opens fully');
  } finally {
    storage.close();
  }
});

defineCase('OPFS write failure falls back without losing the commit', async () => {
  const { storage, store, fs, db } = await openHarness();
  try {
    fs.failNextWrite = true;
    const created = await store.createWorkspace({
      name: 'Flaky',
      storagePersisted: true,
      entry: { path: 'big.bin', kind: 'asset', body: bigBody(5) },
    });
    assertEqual(created.revision.body.location, 'idb', 'write failure falls back inline');
    const body = await store.getHeadBody(created.workspace.workspaceId, 'big.bin');
    assertEqual(body[1], 5, 'fallback body intact');
    assertEqual(fs.files.size, 0, 'no stray file');
    assertEqual((await listGc(db)).length, 0, 'no stale intent after fallback');
  } finally {
    storage.close();
  }
});

defineCase('crash between file write and commit leaves a sweepable orphan', async () => {
  const { storage, store, fs, db } = await openHarness();
  try {
    const created = await store.createWorkspace({
      name: 'Sweep',
      storagePersisted: true,
      entry: { path: 'keep.bin', kind: 'asset', body: bigBody(1) },
    });
    const ws = created.workspace.workspaceId;
    // Simulate the crash artifact: an intent row + file with no revision.
    const orphanPath = workspaceBlobPath(ws, 'rev-orphan');
    fs.files.set(orphanPath, new Uint8Array(64).fill(0xaa));
    const tx = db.transaction(STORE_WORKSPACE_GC, 'readwrite');
    tx.objectStore(STORE_WORKSPACE_GC).put({
      v: 1,
      gcId: `opfs:${ws}:rev-orphan`,
      kind: 'opfs-orphan',
      workspaceId: ws,
      target: 'rev-orphan',
      createdAt: Date.now(),
    });
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
    });

    const cleaned = await store.sweepGc();
    assertEqual(cleaned, 1, 'one orphan swept');
    assert(!fs.files.has(orphanPath), 'orphan file removed');
    // The committed revision's file survives the sweep.
    const keepPath = workspaceBlobPath(ws, created.revision.revisionId);
    assert(fs.files.has(keepPath), 'live file untouched');
    const body = await store.getHeadBody(ws, 'keep.bin');
    assertEqual(body[0], 1, 'live body still opens');
  } finally {
    storage.close();
  }
});

defineCase('rename and delete retire OPFS bodies through the ledger', async () => {
  const { storage, store, fs } = await openHarness();
  try {
    const created = await store.createWorkspace({
      name: 'Retire',
      storagePersisted: true,
      entry: { path: 'big.bin', kind: 'asset', body: bigBody(2) },
    });
    const ws = created.workspace.workspaceId;
    const oldPath = workspaceBlobPath(ws, created.revision.revisionId);
    const renamed = await store.renameEntry({ workspaceId: ws, fromPath: 'big.bin', toPath: 'moved.bin' });
    assertEqual(renamed.revision.body.location, 'opfs', 'renamed head re-routed to opfs');
    const body = await store.getHeadBody(ws, 'moved.bin');
    assertEqual(body[7], 2, 'renamed body opens at the new path');
    await store.sweepGc();
    assert(!fs.files.has(oldPath), 'old sealed file swept after rename');

    await store.deleteEntry({ workspaceId: ws, path: 'moved.bin' });
    await store.sweepGc();
    const prefix = workspaceBlobPrefix(ws);
    const remaining = [...fs.files.keys()].filter((key) => key.startsWith(prefix));
    assertEqual(remaining.length, 0, 'deleted entry leaves no sealed files');
  } finally {
    storage.close();
  }
});

defineCase('deleteWorkspace removes the entire OPFS prefix', async () => {
  const { storage, store, fs } = await openHarness();
  try {
    const created = await store.createWorkspace({
      name: 'Gone',
      storagePersisted: true,
      entry: { path: 'big.bin', kind: 'asset', body: bigBody(4) },
    });
    const ws = created.workspace.workspaceId;
    await store.createEntry({ workspaceId: ws, path: 'more.bin', kind: 'asset', body: bigBody(6) });
    assert(fs.files.size >= 2, 'two sealed files exist');
    assert(await store.deleteWorkspace(ws), 'workspace deleted');
    const prefix = workspaceBlobPrefix(ws);
    const remaining = [...fs.files.keys()].filter((key) => key.startsWith(prefix));
    assertEqual(remaining.length, 0, 'prefix fully removed');
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
  console.log(`browser-workspace-opfs: ${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) process.exit(1);
}

void runAllCases();
