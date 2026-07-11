import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { Fragment, Slice } from 'prosemirror-model';
import { ReplaceStep } from 'prosemirror-transform';
import {
  COLLAB_CHECKPOINT_KIND,
  COLLAB_CHECKPOINT_VERSION,
  MAX_COLLAB_CHECKPOINT_JSON_DEPTH,
  validateBrowserCollabCheckpoint,
  type BrowserCollabCheckpoint,
} from './browser-collab-checkpoint';
import { base64UrlEncode, toCanonicalString } from './browser-crypto';
import { BrowserStorage, BrowserStorageError } from './browser-storage';
import { STORE_WORKSPACE_RECOVERY } from './browser-workspace-schema';
import { schema } from '../schema';
import { CollabAuthority } from '../prosemirror/collab-authority';
import {
  CollabController,
  parseCollabWireMessage,
} from '../prosemirror/collab-controller';

Object.defineProperty(globalThis, 'IDBKeyRange', {
  configurable: true,
  value: IDBKeyRange,
});

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

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  if (actual !== expected) throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
}

async function expectStorageError(operation: () => unknown | Promise<unknown>, message: string): Promise<void> {
  try {
    await operation();
  } catch (error) {
    if (error instanceof BrowserStorageError) return;
    throw new Error(`${message}: unexpected error ${String(error)}`);
  }
  throw new Error(`${message}: expected BrowserStorageError`);
}

let databaseCounter = 0;
async function openStorage(now = () => 1_700_000_000_000): Promise<{
  storage: BrowserStorage;
  factory: IDBFactory;
  name: string;
}> {
  databaseCounter += 1;
  const factory = new IDBFactory();
  const name = `attn-collab-checkpoint-${databaseCounter}`;
  const storage = await BrowserStorage.open({
    createIfMissing: true,
    databaseName: name,
    indexedDB: factory,
    filesystem: null,
    now,
  });
  return { storage, factory, name };
}

function id(fill: number): string {
  return base64UrlEncode(new Uint8Array(16).fill(fill));
}

function checkpoint(overrides: Partial<BrowserCollabCheckpoint> = {}): BrowserCollabCheckpoint {
  const epoch = overrides.epoch ?? id(3);
  return {
    v: COLLAB_CHECKPOINT_VERSION,
    kind: COLLAB_CHECKPOINT_KIND,
    roomId: id(1),
    fileId: id(2),
    epoch,
    base: { kind: 'snapshot', id: epoch },
    version: 2,
    steps: [
      { stepType: 'replace', from: 1, to: 1, slice: { content: [{ type: 'text', text: 'a' }] } },
      { stepType: 'replace', from: 2, to: 2, slice: { content: [{ type: 'text', text: 'b' }] } },
    ],
    clientIDs: ['browser-a', 42],
    ...overrides,
  };
}

async function openRaw(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(name);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function requestValue<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

defineCase('opaque workspace recovery APIs seal, list, open, replace, and delete', async () => {
  let clock = 100;
  const { storage, factory, name } = await openStorage(() => ++clock);
  try {
    await storage.createWorkspaceKey('ws-opaque');
    const first = new TextEncoder().encode('plaintext checkpoint sentinel');
    await storage.putWorkspaceRecovery('ws-opaque', 'opaque-a', first);
    first.fill(0);
    const second = new TextEncoder().encode('replacement');
    await storage.putWorkspaceRecovery('ws-opaque', 'opaque-a', second);
    second.fill(0);
    await storage.putWorkspaceRecovery('ws-opaque', 'opaque-b', new Uint8Array([1, 2, 3]));

    const summaries = await storage.listWorkspaceRecoveries('ws-opaque');
    assertEqual(summaries.length, 2, 'list contains both records');
    assert(summaries[0]!.createdAt < summaries[1]!.createdAt, 'list is timestamp ordered');
    const opened = await storage.getWorkspaceRecovery('ws-opaque', 'opaque-a');
    assert(opened, 'replacement opens');
    assertEqual(new TextDecoder().decode(opened), 'replacement', 'last sealed put wins');
    opened.fill(0);

    const rawDb = await openRaw(factory, name);
    const tx = rawDb.transaction(STORE_WORKSPACE_RECOVERY, 'readonly');
    const raw = await requestValue<Record<string, unknown>>(
      tx.objectStore(STORE_WORKSPACE_RECOVERY).get(['ws-opaque', 'opaque-a']),
    );
    rawDb.close();
    assert(!JSON.stringify(raw).includes('replacement'), 'IndexedDB record contains no plaintext');

    assert(await storage.deleteWorkspaceRecovery('ws-opaque', 'opaque-a'), 'delete reports removal');
    assert(!(await storage.deleteWorkspaceRecovery('ws-opaque', 'opaque-a')), 'delete is idempotent');
    assertEqual(await storage.getWorkspaceRecovery('ws-opaque', 'opaque-a'), null, 'deleted record absent');
  } finally {
    storage.close();
  }
});

defineCase('collab checkpoint round-trips, replaces by room/file, and lists by room', async () => {
  const { storage } = await openStorage();
  try {
    await storage.createWorkspaceKey('ws-checkpoint');
    const leases = storage.leases({ channel: null });
    const fence = await leases.acquire('ws-checkpoint', 'checkpoint-tab');
    assert(fence, 'checkpoint writer lease acquired');
    const first = checkpoint();
    await storage.putCollabCheckpoint('ws-checkpoint', first, {
      fence,
      expectedVersion: 0,
    });
    const recovered = await storage.getCollabCheckpoint(
      'ws-checkpoint',
      first.roomId,
      first.fileId,
      first.epoch,
    );
    assertEqual(toCanonicalString(recovered), toCanonicalString(first), 'checkpoint round-trip');

    const replacement = checkpoint({
      version: 3,
      steps: [
        ...first.steps,
        { stepType: 'replace', from: 3, to: 3 },
      ],
      clientIDs: [...first.clientIDs, 'browser-b'],
    });
    await storage.putCollabCheckpoint('ws-checkpoint', replacement, {
      fence,
      expectedVersion: first.version,
    });
    const other = checkpoint({
      roomId: id(6),
      fileId: id(7),
      epoch: id(8),
    });
    await storage.putCollabCheckpoint('ws-checkpoint', other, {
      fence,
      expectedVersion: 0,
    });

    const all = await storage.listCollabCheckpoints('ws-checkpoint');
    assertEqual(all.length, 2, 'room/file replacement does not duplicate');
    const filtered = await storage.listCollabCheckpoints('ws-checkpoint', replacement.roomId);
    assertEqual(filtered.length, 1, 'room filter');
    assertEqual(filtered[0]!.epoch, replacement.epoch, 'replacement retained');
    assertEqual(all.find((item) => item.roomId === other.roomId)?.base.id, other.epoch, 'snapshot base retained');
    assert(
      await storage.deleteCollabCheckpoint(
        'ws-checkpoint',
        replacement.roomId,
        replacement.fileId,
        replacement.epoch,
      ),
      'checkpoint deletes',
    );
    assertEqual(
      await storage.getCollabCheckpoint(
        'ws-checkpoint',
        replacement.roomId,
        replacement.fileId,
        replacement.epoch,
      ),
      null,
      'deleted checkpoint absent',
    );
  } finally {
    storage.close();
  }
});

defineCase('recovery AAD rejects a record transplanted to another workspace', async () => {
  const { storage, factory, name } = await openStorage();
  try {
    await storage.createWorkspaceKey('ws-source');
    await storage.createWorkspaceKey('ws-target');
    await storage.putWorkspaceRecovery(
      'ws-source',
      'transplant',
      new TextEncoder().encode('sealed source'),
    );
    const rawDb = await openRaw(factory, name);
    const readTx = rawDb.transaction(STORE_WORKSPACE_RECOVERY, 'readonly');
    const record = await requestValue<Record<string, unknown>>(
      readTx.objectStore(STORE_WORKSPACE_RECOVERY).get(['ws-source', 'transplant']),
    );
    const writeTx = rawDb.transaction(STORE_WORKSPACE_RECOVERY, 'readwrite');
    writeTx.objectStore(STORE_WORKSPACE_RECOVERY).put({ ...record, workspaceId: 'ws-target' });
    await new Promise<void>((resolve, reject) => {
      writeTx.oncomplete = () => resolve();
      writeTx.onabort = () => reject(writeTx.error);
    });
    rawDb.close();
    await expectStorageError(
      () => storage.getWorkspaceRecovery('ws-target', 'transplant'),
      'workspace transplant must fail authentication',
    );
  } finally {
    storage.close();
  }
});

defineCase('checkpoint validator rejects routing, shape, and log inconsistencies', async () => {
  const invalid: unknown[] = [
    { ...checkpoint(), extra: true },
    { ...checkpoint(), roomId: 'room:with:colon' },
    { ...checkpoint(), fileId: id(2) + '=' },
    { ...checkpoint(), epoch: 'epoch' },
    { ...checkpoint(), base: { kind: 'snapshot', id: 'snapshot' } },
    { ...checkpoint(), base: { kind: 'snapshot', id: id(9) } },
    { ...checkpoint(), version: 1 },
    { ...checkpoint(), clientIDs: ['only-one'] },
    { ...checkpoint(), clientIDs: [-1, 2] },
    { ...checkpoint(), base: { kind: 'revision', id: 'rev' } },
  ];
  for (const value of invalid) {
    await expectStorageError(() => validateBrowserCollabCheckpoint(value), 'invalid checkpoint');
  }

  let nested: unknown = { stepType: 'replace' };
  for (let index = 0; index < MAX_COLLAB_CHECKPOINT_JSON_DEPTH + 2; index += 1) {
    nested = { child: nested };
  }
  await expectStorageError(
    () => validateBrowserCollabCheckpoint(checkpoint({
      version: 1,
      steps: [nested as never],
      clientIDs: ['client'],
    })),
    'over-deep step JSON',
  );
});

defineCase('checkpoint and generic recovery size caps fail before durable writes', async () => {
  const { storage } = await openStorage();
  try {
    await storage.createWorkspaceKey('ws-size');
    const leases = storage.leases({ channel: null });
    const fence = await leases.acquire('ws-size', 'size-tab');
    assert(fence, 'size writer lease acquired');
    await expectStorageError(
      () => storage.putWorkspaceRecovery('ws-size', 'too-large', new Uint8Array(64 * 1024)),
      'oversized opaque recovery',
    );
    await expectStorageError(
      () => storage.putCollabCheckpoint(
        'ws-size',
        checkpoint({
          version: 1,
          steps: [{ text: 'x'.repeat(64 * 1024) }],
          clientIDs: ['client'],
        }),
        { fence, expectedVersion: 0 },
      ),
      'oversized checkpoint',
    );
    assertEqual((await storage.listWorkspaceRecoveries('ws-size')).length, 0, 'no failed rows stored');
  } finally {
    storage.close();
  }
});

defineCase('epoch keys, version CAS, and lease fencing prevent checkpoint rollback', async () => {
  let clock = 100;
  const { storage } = await openStorage(() => clock);
  try {
    await storage.createWorkspaceKey('ws-race');
    const leases = storage.leases({ channel: null, leaseDurationMs: 5 });
    const firstFence = await leases.acquire('ws-race', 'first-tab');
    assert(firstFence, 'first lease acquired');
    const epochOne = checkpoint({
      epoch: id(10),
      version: 1,
      steps: [{ stepType: 'replace', from: 1, to: 1 }],
      clientIDs: ['first'],
    });
    const epochTwo = checkpoint({
      epoch: id(11),
      version: 1,
      steps: [{ stepType: 'replace', from: 1, to: 1 }],
      clientIDs: ['second'],
    });
    await storage.putCollabCheckpoint('ws-race', epochOne, {
      fence: firstFence,
      expectedVersion: 0,
    });
    await storage.putCollabCheckpoint('ws-race', epochTwo, {
      fence: firstFence,
      expectedVersion: 0,
    });
    await expectStorageError(
      () => storage.putCollabCheckpoint('ws-race', epochOne, {
        fence: firstFence,
        expectedVersion: 0,
      }),
      'same-epoch stale version must fail CAS',
    );
    assert(
      await storage.getCollabCheckpoint(
        'ws-race',
        epochTwo.roomId,
        epochTwo.fileId,
        epochTwo.epoch,
      ),
      'new epoch survives an old-epoch write attempt',
    );

    clock = 106;
    await expectStorageError(
      () => storage.putCollabCheckpoint(
        'ws-race',
        checkpoint({
          epoch: id(12),
          version: 1,
          steps: [{ stepType: 'replace', from: 1, to: 1 }],
          clientIDs: ['expired-tab'],
        }),
        { fence: firstFence, expectedVersion: 0 },
      ),
      'expired lease must fail even before another tab takes over',
    );
    const secondFence = await leases.acquire('ws-race', 'second-tab');
    assert(secondFence, 'expired lease takeover acquired');
    await expectStorageError(
      () => storage.putCollabCheckpoint(
        'ws-race',
        checkpoint({
          epoch: id(13),
          version: 1,
          steps: [{ stepType: 'replace', from: 1, to: 1 }],
          clientIDs: ['stale-tab'],
        }),
        { fence: firstFence, expectedVersion: 0 },
      ),
      'stale lease must be fenced',
    );
  } finally {
    storage.close();
  }
});

defineCase('sealed checkpoint reload restores a controller and serves exact resync', async () => {
  const { storage, factory, name } = await openStorage();
  const workspaceId = 'ws-controller-reload';
  const roomId = id(20);
  const fileId = id(21);
  const epoch = id(22);
  const base = schema.node('doc', null, [
    schema.node('paragraph', null, [schema.text('hello')]),
  ]);
  try {
    await storage.createWorkspaceKey(workspaceId);
    const leases = storage.leases({ channel: null });
    const fence = await leases.acquire(workspaceId, 'owner-tab');
    assert(fence, 'owner lease acquired');
    const authority = new CollabAuthority(base, epoch);
    const inserted = new ReplaceStep(
      6,
      6,
      new Slice(Fragment.from(schema.text('R')), 0, 0),
    );
    assert(authority.receiveSteps(0, [inserted], 'reviewer').accepted, 'step accepted');
    const core = authority.exportCheckpoint();
    const stored: BrowserCollabCheckpoint = {
        kind: COLLAB_CHECKPOINT_KIND,
        roomId,
        fileId,
        base: { kind: 'snapshot', id: epoch },
        v: core.v,
        epoch: core.epoch,
        version: core.version,
        steps: core.steps as BrowserCollabCheckpoint['steps'],
        clientIDs: core.clientIDs,
      };
    await storage.putCollabCheckpoint(
      workspaceId,
      stored,
      { fence, expectedVersion: 0 },
    );
  } finally {
    storage.close();
  }

  const reopened = await BrowserStorage.open({
    createIfMissing: false,
    databaseName: name,
    indexedDB: factory,
    filesystem: null,
  });
  try {
    const sealed = await reopened.getCollabCheckpoint(
      workspaceId,
      roomId,
      fileId,
      epoch,
    );
    assert(sealed, 'sealed checkpoint recovered');
    const core = {
      v: sealed.v,
      epoch: sealed.epoch,
      version: sealed.version,
      steps: sealed.steps,
      clientIDs: sealed.clientIDs,
    } as const;
    const sent: string[] = [];
    const controller = new CollabController({
      isOwner: true,
      send: (payload) => sent.push(payload),
      selfClientId: 'owner',
      selfLabel: 'Owner',
      selfColor: '#000',
      getAuthorityEpoch: () => epoch,
      getAuthoritySeed: () => ({
        epoch,
        baseSnapshotId: sealed.base.id,
        doc: base,
        checkpoint: core,
      }),
    });
    controller.onInbound(
      JSON.stringify({ kind: 'resync', fileId, epoch }),
      'reviewer-device',
    );
    const outbound = parseCollabWireMessage(sent[0]);
    assert(outbound?.kind === 'broadcast', 'controller served a broadcast');
    assertEqual(outbound.broadcast.startVersion, 0, 'resync begins at base');
    assertEqual(outbound.broadcast.steps.length, 1, 'resync contains exact restored log');
    const restored = CollabAuthority.fromCheckpoint(base, epoch, core);
    assertEqual(restored.doc.textContent, 'helloR', 'restored document is exact');
  } finally {
    reopened.close();
  }
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
  console.log(`browser-collab-checkpoint: ${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) process.exit(1);
}

void runAllCases();
