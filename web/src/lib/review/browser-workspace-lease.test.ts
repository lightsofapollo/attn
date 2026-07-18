import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { BrowserStorage, StorageConflictError } from './browser-storage';
import {
  WorkspaceLeaseManager,
  type LeaseChannelMessage,
} from './browser-workspace-lease';

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

let databaseCounter = 0;

interface Harness {
  storage: BrowserStorage;
  db: IDBDatabase;
  clock: { value: number };
  messages: LeaseChannelMessage[];
  manager: (options?: { contextId?: string }) => WorkspaceLeaseManager;
}

async function openHarness(): Promise<Harness> {
  databaseCounter += 1;
  const factory = new IDBFactory();
  const clock = { value: 1_700_000_000_000 };
  const storage = await BrowserStorage.open({
    indexedDB: factory,
    databaseName: `attn-workspace-lease-test-${databaseCounter}`,
    createIfMissing: true,
    filesystem: null,
    navigator: null,
    now: () => clock.value,
  });
  const db = (storage as unknown as { db: IDBDatabase }).db;
  const messages: LeaseChannelMessage[] = [];
  const channel = { postMessage: (m: LeaseChannelMessage) => messages.push(m), close: () => undefined };
  return {
    storage,
    db,
    clock,
    messages,
    manager: (options = {}) =>
      new WorkspaceLeaseManager(db, {
        leaseDurationMs: 10_000,
        now: () => clock.value,
        channel,
        ...(options.contextId === undefined ? {} : { contextId: options.contextId }),
      }),
  };
}

async function seedWorkspace(storage: BrowserStorage): Promise<string> {
  const created = await storage.workspaces.createWorkspace({
    name: 'Leased',
    storagePersisted: true,
    entry: { path: 'untitled.md', kind: 'markdown', body: new TextEncoder().encode('hello') },
  });
  return created.workspace.workspaceId;
}

defineCase('fresh acquire grants token 1 and fenced writes succeed', async () => {
  const { storage, manager, messages } = await openHarness();
  try {
    const ws = await seedWorkspace(storage);
    const lease = await manager().acquire(ws, 'tab-a');
    assert(lease, 'lease granted');
    assertEqual(lease.fencingToken, 1, 'first token');
    const committed = await storage.workspaces.commitRevision({
      workspaceId: ws,
      path: 'untitled.md',
      body: new TextEncoder().encode('fenced'),
      fence: lease,
    });
    assert(committed.workspace.clock > 1, 'fenced write landed');
    assertEqual(messages[0]?.event, 'acquired', 'acquire notified');
  } finally {
    storage.close();
  }
});

defineCase('a live lease denies other holders (read-only tabs)', async () => {
  const { storage, manager } = await openHarness();
  try {
    const ws = await seedWorkspace(storage);
    const a = await manager().acquire(ws, 'tab-a');
    assert(a, 'tab-a granted');
    const b = await manager().acquire(ws, 'tab-b');
    assertEqual(b, null, 'tab-b denied while tab-a is live');
    // Same holder re-acquire keeps the token.
    const again = await manager().acquire(ws, 'tab-a');
    assert(again, 're-acquire granted');
    assertEqual(again.fencingToken, 1, 'token unchanged for the same holder');
  } finally {
    storage.close();
  }
});

defineCase('expiry allows takeover; the old holder is fenced everywhere', async () => {
  const { storage, manager, clock } = await openHarness();
  try {
    const ws = await seedWorkspace(storage);
    const a = await manager().acquire(ws, 'tab-a');
    assert(a, 'tab-a granted');
    clock.value += 60_000; // lease expires
    const b = await manager().acquire(ws, 'tab-b');
    assert(b, 'tab-b takes over after expiry');
    assertEqual(b.fencingToken, 2, 'takeover bumps the fencing token');
    await expectConflict(manager().heartbeat(a), 'old holder heartbeat is fenced');
    await expectConflict(
      storage.workspaces.commitRevision({
        workspaceId: ws,
        path: 'untitled.md',
        body: new TextEncoder().encode('zombie write'),
        fence: a,
      }),
      'old holder store write is fenced',
    );
    const fresh = await storage.workspaces.commitRevision({
      workspaceId: ws,
      path: 'untitled.md',
      body: new TextEncoder().encode('new owner'),
      fence: b,
    });
    assert(fresh.workspace.clock > 1, 'new owner writes');
  } finally {
    storage.close();
  }
});

defineCase('heartbeat extends expiry without changing the token', async () => {
  const { storage, manager, clock } = await openHarness();
  try {
    const ws = await seedWorkspace(storage);
    const lease = await manager().acquire(ws, 'tab-a');
    assert(lease, 'granted');
    clock.value += 5_000;
    const extended = await manager().heartbeat(lease);
    assertEqual(extended.fencingToken, lease.fencingToken, 'token stable');
    assert(extended.expiresAt > lease.expiresAt, 'expiry extended');
    // The extension keeps other holders out past the original expiry.
    clock.value += 7_000; // original would have lapsed; extended has not
    assertEqual(await manager().acquire(ws, 'tab-b'), null, 'still owned after heartbeat');
  } finally {
    storage.close();
  }
});

defineCase('release hands off cleanly and tokens stay monotonic', async () => {
  const { storage, manager, messages } = await openHarness();
  try {
    const ws = await seedWorkspace(storage);
    const a = await manager().acquire(ws, 'tab-a');
    assert(a, 'granted');
    assert(await manager().release(a), 'released');
    assertEqual(messages.at(-1)?.event, 'released', 'release notified');
    assert(!(await manager().release(a)), 'double release is a no-op');
    const b = await manager().acquire(ws, 'tab-b');
    assert(b, 'next holder granted');
    assertEqual(b.fencingToken, 2, 'token increments across release/reacquire');
  } finally {
    storage.close();
  }
});

defineCase('a duplicated tab (copied holder id) is a takeover, never a co-writer', async () => {
  const { storage, manager, clock } = await openHarness();
  try {
    const ws = await seedWorkspace(storage);
    // Tab duplication copies sessionStorage, so both contexts present the
    // SAME holder id. The JS-context nonce cannot be copied, so the second
    // context must bump the token and fence the first off — matching-token
    // co-writers would both pass store fencing.
    const original = manager({ contextId: 'ctx-original' });
    const duplicate = manager({ contextId: 'ctx-duplicate' });
    const a = await original.acquire(ws, 'tab-a');
    assert(a, 'original granted');
    assertEqual(a.fencingToken, 1, 'original holds the first token');
    const b = await duplicate.acquire(ws, 'tab-a');
    assert(b, 'duplicate acquires under the copied holder id');
    assertEqual(b.fencingToken, 2, 'duplicate context bumps the token');
    await expectConflict(original.heartbeat(a), 'original heartbeat is fenced');
    await expectConflict(
      storage.workspaces.commitRevision({
        workspaceId: ws,
        path: 'untitled.md',
        body: new TextEncoder().encode('stale duplicate-origin write'),
        fence: a,
      }),
      'original context store write is fenced',
    );
    const fresh = await storage.workspaces.commitRevision({
      workspaceId: ws,
      path: 'untitled.md',
      body: new TextEncoder().encode('single live writer'),
      fence: b,
    });
    assert(fresh.workspace.clock > 1, 'exactly one context can write');
    // A reload of the surviving context (same holder, new context) also
    // takes over its own lease immediately instead of waiting out expiry.
    clock.value += 1;
    const reloaded = manager({ contextId: 'ctx-after-reload' });
    const c = await reloaded.acquire(ws, 'tab-a');
    assert(c, 'reload reacquires without waiting for expiry');
    assertEqual(c.fencingToken, 3, 'reload is a token-bumping takeover of itself');
  } finally {
    storage.close();
  }
});

defineCase('concurrent acquires resolve to exactly one writer', async () => {
  const { storage, manager } = await openHarness();
  try {
    const ws = await seedWorkspace(storage);
    const [a, b, c] = await Promise.all([
      manager().acquire(ws, 'tab-a'),
      manager().acquire(ws, 'tab-b'),
      manager().acquire(ws, 'tab-c'),
    ]);
    const winners = [a, b, c].filter((lease) => lease !== null);
    assertEqual(winners.length, 1, 'exactly one concurrent winner');
    assertEqual(winners[0]!.fencingToken, 1, 'winner holds the first token');
  } finally {
    storage.close();
  }
});

defineCase('takeover claims an unexpired lease and fences the previous holder', async () => {
  const { storage, manager, messages } = await openHarness();
  try {
    const ws = await seedWorkspace(storage);
    const a = await manager({ contextId: 'ctx-a' }).acquire(ws, 'tab-a');
    assert(a, 'tab-a granted');
    const b = await manager({ contextId: 'ctx-b' }).takeover(ws, 'tab-b');
    assertEqual(b.fencingToken, a.fencingToken + 1, 'takeover bumps the token');
    // The fenced-off previous holder's writes must now be rejected.
    await expectConflict(
      storage.workspaces.commitRevision({
        workspaceId: ws,
        path: 'untitled.md',
        body: new TextEncoder().encode('stale write'),
        fence: a,
      }),
      'previous holder is fenced after takeover',
    );
    const fenced = await storage.workspaces.commitRevision({
      workspaceId: ws,
      path: 'untitled.md',
      body: new TextEncoder().encode('new holder write'),
      fence: b,
    });
    assert(fenced.workspace.clock > 1, 'new holder writes under the taken lease');
    assert(
      messages.some((m) => m.event === 'acquired' && m.holderId === 'tab-b'),
      'takeover broadcasts acquired',
    );
  } finally {
    storage.close();
  }
});

defineCase('requestHandoff rings the doorbell without touching the record', async () => {
  const { storage, manager, messages } = await openHarness();
  try {
    const ws = await seedWorkspace(storage);
    const a = await manager().acquire(ws, 'tab-a');
    assert(a, 'tab-a granted');
    manager().requestHandoff(ws, 'tab-b');
    const rung = messages.find((m) => m.event === 'handoff-request');
    assert(rung && rung.workspaceId === ws && rung.holderId === 'tab-b', 'doorbell posted');
    const record = await manager().current(ws);
    assert(record?.holderId === 'tab-a', 'record untouched by the doorbell');
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
  console.log(`browser-workspace-lease: ${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) process.exit(1);
}

void runAllCases();
