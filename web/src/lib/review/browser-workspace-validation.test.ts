// Workspace storage v3 validation extras (attn-7xl.2.7): quota fault
// injection at the IndexedDB layer and a seeded randomized property test
// over the whole transaction API.

import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { BrowserStorage, BrowserStorageError } from './browser-storage';
import { WorkspaceStore } from './browser-workspace-store';
import { STORE_WORKSPACE_REVISIONS } from './browser-workspace-schema';

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

function text(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

let databaseCounter = 0;

async function openStorage(): Promise<BrowserStorage> {
  databaseCounter += 1;
  return BrowserStorage.open({
    indexedDB: new IDBFactory(),
    databaseName: `attn-workspace-validation-${databaseCounter}`,
    createIfMissing: true,
    filesystem: null,
    navigator: null,
  });
}

/** Wrap a database so writes to one store throw QuotaExceededError. */
function quotaFaultDb(db: IDBDatabase, failStore: string, failing: { on: boolean }): IDBDatabase {
  return new Proxy(db, {
    get(target, property, receiver) {
      if (property !== 'transaction') return Reflect.get(target, property, receiver);
      return (...args: Parameters<IDBDatabase['transaction']>) => {
        const tx = target.transaction(...args);
        return new Proxy(tx, {
          get(txTarget, txProp, txReceiver) {
            if (txProp !== 'objectStore') {
              const value = Reflect.get(txTarget, txProp, txReceiver);
              return typeof value === 'function' ? value.bind(txTarget) : value;
            }
            return (name: string) => {
              const store = txTarget.objectStore(name);
              if (name !== failStore || !failing.on) return store;
              return new Proxy(store, {
                get(storeTarget, storeProp, storeReceiver) {
                  if (storeProp === 'add' || storeProp === 'put') {
                    return () => {
                      throw new DOMException('quota exceeded (injected)', 'QuotaExceededError');
                    };
                  }
                  const value = Reflect.get(storeTarget, storeProp, storeReceiver);
                  return typeof value === 'function' ? value.bind(storeTarget) : value;
                },
              });
            };
          },
        });
      };
    },
  });
}

defineCase('QuotaExceededError during commit preserves the last committed head', async () => {
  const storage = await openStorage();
  try {
    const db = (storage as unknown as { db: IDBDatabase }).db;
    const failing = { on: false };
    const store = new WorkspaceStore(quotaFaultDb(db, STORE_WORKSPACE_REVISIONS, failing), crypto, Date.now);
    const created = await store.createWorkspace({
      name: 'Quota',
      storagePersisted: true,
      entry: { path: 'untitled.md', kind: 'markdown', body: text('safe head') },
    });
    const ws = created.workspace.workspaceId;
    failing.on = true;
    let failed = false;
    try {
      await store.commitRevision({ workspaceId: ws, path: 'untitled.md', body: text('lost') });
    } catch (error) {
      failed = error instanceof BrowserStorageError || error instanceof DOMException;
    }
    assert(failed, 'quota failure surfaces an error');
    failing.on = false;
    const body = await store.getHeadBody(ws, 'untitled.md');
    assertEqual(new TextDecoder().decode(body), 'safe head', 'previous head intact');
    const after = await store.getWorkspace(ws);
    assertEqual(after!.clock, created.workspace.clock, 'failed write bumped nothing');
    // The store stays usable once pressure clears.
    const recovered = await store.commitRevision({
      workspaceId: ws,
      path: 'untitled.md',
      body: text('recovered'),
    });
    assert(recovered.workspace.clock > created.workspace.clock, 'writes resume after pressure');
  } finally {
    storage.close();
  }
});

// Seeded LCG so the property run is reproducible.
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

defineCase('property: random op sequences preserve every storage invariant', async () => {
  const storage = await openStorage();
  try {
    const store = storage.workspaces;
    const random = makeRandom(0xa77e57);
    const created = await store.createWorkspace({
      name: 'Property',
      storagePersisted: true,
      entry: { path: 'seed.md', kind: 'markdown', body: text('seed') },
    });
    const ws = created.workspace.workspaceId;
    const paths = ['seed.md', 'a.md', 'b.md', 'dir/c.md', 'dir/deep/d.md'];
    // Model: expected head content per live path.
    const model = new Map<string, string>([['seed.md', 'seed']]);
    let lastClock = created.workspace.clock;
    let operations = 0;

    for (let step = 0; step < 120; step += 1) {
      const path = paths[Math.floor(random() * paths.length)]!;
      const roll = random();
      const content = `content-${step}`;
      try {
        if (roll < 0.5) {
          if (model.has(path)) {
            await store.commitRevision({ workspaceId: ws, path, body: text(content) });
            model.set(path, content);
          } else {
            await store.createEntry({ workspaceId: ws, path, kind: 'markdown', body: text(content) });
            model.set(path, content);
          }
          operations += 1;
        } else if (roll < 0.65) {
          // Sometimes a deliberately stale optimistic commit: must conflict
          // and change nothing.
          if (model.has(path)) {
            let threw = false;
            try {
              await store.commitRevision({
                workspaceId: ws,
                path,
                body: text('stale'),
                expectedHeadRevisionId: 'rev-definitely-stale',
              });
            } catch {
              threw = true;
            }
            assert(threw, `stale commit must conflict (step ${step})`);
          }
        } else if (roll < 0.8) {
          if (model.has(path)) {
            await store.deleteEntry({ workspaceId: ws, path });
            model.delete(path);
            operations += 1;
          }
        } else {
          const target = paths[Math.floor(random() * paths.length)]!;
          if (model.has(path) && !model.has(target) && path !== target) {
            await store.renameEntry({ workspaceId: ws, fromPath: path, toPath: target });
            model.set(target, model.get(path)!);
            model.delete(path);
            operations += 1;
          }
        }
      } catch (error) {
        throw new Error(`step ${step} (${path}) failed: ${String(error)}`);
      }
      const workspace = await store.getWorkspace(ws);
      assert(workspace, 'workspace persists');
      assert(workspace.clock >= lastClock, `clock never regresses (step ${step})`);
      lastClock = workspace.clock;
    }

    // Final invariants against the model.
    const entries = await store.listEntries(ws);
    assertEqual(entries.length, model.size, 'live entry count matches the model');
    const seen = new Set<string>();
    for (const entry of entries) {
      assert(!seen.has(entry.path), 'paths are unique');
      seen.add(entry.path);
      const body = await store.getHeadBody(ws, entry.path);
      assertEqual(
        new TextDecoder().decode(body),
        model.get(entry.path),
        `head body matches the model for ${entry.path}`,
      );
      const history = await store.listRevisions(ws, entry.path);
      for (let index = 1; index < history.length; index += 1) {
        assert(history[index]!.clock > history[index - 1]!.clock, 'history clocks ascend uniquely');
      }
    }
    return `${operations} mutating ops, final clock ${lastClock}, ${model.size} live entries`;
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
  console.log(`browser-workspace-validation: ${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) process.exit(1);
}

void runAllCases();
