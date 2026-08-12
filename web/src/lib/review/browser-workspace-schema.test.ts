import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import {
  BROWSER_STORAGE_SCHEMA_VERSION,
  BrowserStorage,
  BrowserStorageError,
  type BrowserStorageRoom,
} from './browser-storage';
import {
  MAX_ENTRY_PATH_BYTES,
  MAX_INLINE_SEALED_BODY_BYTES,
  REVISION_HISTORY_INDEX,
  STORE_WORKSPACES,
  STORE_WORKSPACE_ENTRIES,
  STORE_WORKSPACE_GC,
  STORE_WORKSPACE_KEYS,
  STORE_WORKSPACE_LEASES,
  STORE_WORKSPACE_RECOVERY,
  STORE_WORKSPACE_REVISIONS,
  STORE_WORKSPACE_SHARE_CAPS,
  WORKSPACE_RECORD_VERSION,
  normalizeEntryPath,
  validateSealedBody,
  validateWorkspaceEntryRecord,
  validateWorkspaceGcRecord,
  validateWorkspaceLeaseRecord,
  validateWorkspaceRecord,
  validateWorkspaceRecoveryRecord,
  validateWorkspaceRevisionRecord,
  validateWorkspaceShareCapRecord,
  type WorkspaceEntryRecord,
  type WorkspaceRecord,
  type WorkspaceRevisionRecord,
} from './browser-workspace-schema';
import type { RoomPolicy } from './browser-ws';

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

function assertRejects(fn: () => void, message: string): void {
  try {
    fn();
  } catch (error) {
    if (error instanceof BrowserStorageError) return;
    throw new Error(`${message}: threw a non-storage error: ${String(error)}`);
  }
  throw new Error(`${message}: expected a BrowserStorageError`);
}

let databaseCounter = 0;

function testDatabase(): { factory: IDBFactory; name: string } {
  databaseCounter += 1;
  return { factory: new IDBFactory(), name: `attn-workspace-schema-test-${databaseCounter}` };
}

const POLICY: RoomPolicy = {
  mode: 'hybrid',
  maxPeers: 8,
  maxSnapshotBytes: 1024 * 1024,
  maxEventBytes: 64 * 1024,
  maxEvents: 10_000,
  expiresAt: 1_900_000_000_000,
  powBits: 12,
  deleteEventsAfterOwnerAck: false,
  allowBrowser: true,
  allowRemoteAgents: false,
};

const ROOM: BrowserStorageRoom = {
  roomId: 'room-legacy',
  policy: POLICY,
  lastCreatedAt: 1_700_000_000_000,
  storagePersisted: true,
  relayUrl: 'https://relay.example',
};

const ALL_V3_STORES = [
  STORE_WORKSPACES,
  STORE_WORKSPACE_KEYS,
  STORE_WORKSPACE_ENTRIES,
  STORE_WORKSPACE_REVISIONS,
  STORE_WORKSPACE_SHARE_CAPS,
  STORE_WORKSPACE_RECOVERY,
  STORE_WORKSPACE_GC,
  STORE_WORKSPACE_LEASES,
] as const;

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionResult(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error);
    transaction.onerror = () => undefined;
  });
}

async function rawOpen(factory: IDBFactory, name: string, version: number,
  upgrade?: (db: IDBDatabase) => void): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(name, version);
    request.onupgradeneeded = () => upgrade?.(request.result);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}

function createV1Stores(db: IDBDatabase): void {
  db.createObjectStore('room_keys', { keyPath: 'roomId' });
  db.createObjectStore('rooms', { keyPath: 'roomId' });
}

function createV2Stores(db: IDBDatabase): void {
  const roomStore = (name: string, keyPath: string | string[]): IDBObjectStore => {
    const store = db.createObjectStore(name, { keyPath });
    store.createIndex('by_room', 'roomId');
    return store;
  };
  roomStore('devices', ['roomId', 'deviceId']);
  roomStore('identities', 'roomId');
  const inbox = roomStore('inbox', ['roomId', 'envelopeId']);
  inbox.createIndex('by_room_sequence', ['roomId', 'serverSeq'], { unique: true });
  roomStore('cursors', ['roomId', 'deviceId']);
  const outbox = roomStore('outbox', ['roomId', 'envelopeId']);
  outbox.createIndex('by_room_created', ['roomId', 'createdAt', 'envelopeId']);
  const history = roomStore('history', ['roomId', 'envelopeId']);
  history.createIndex('by_room_acked', ['roomId', 'ackedAt', 'envelopeId']);
}

async function putRaw(db: IDBDatabase, store: string, value: unknown): Promise<void> {
  const tx = db.transaction(store, 'readwrite');
  const done = transactionResult(tx);
  tx.objectStore(store).put(value as never);
  await done;
}

function workspaceRecord(overrides: Partial<WorkspaceRecord> = {}): WorkspaceRecord {
  return {
    v: WORKSPACE_RECORD_VERSION,
    workspaceId: 'ws-1',
    name: 'Product direction',
    clock: 4,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_400_000,
    storagePersisted: true,
    ...overrides,
  };
}

function entryRecord(overrides: Partial<WorkspaceEntryRecord> = {}): WorkspaceEntryRecord {
  return {
    v: WORKSPACE_RECORD_VERSION,
    workspaceId: 'ws-1',
    path: 'docs/notes.md',
    kind: 'markdown',
    headRevisionId: 'rev-1',
    sizeBytes: 128,
    clock: 3,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_300_000,
    ...overrides,
  };
}

function revisionRecord(
  overrides: Partial<WorkspaceRevisionRecord> = {},
): WorkspaceRevisionRecord {
  return {
    v: WORKSPACE_RECORD_VERSION,
    workspaceId: 'ws-1',
    revisionId: 'rev-1',
    path: 'docs/notes.md',
    clock: 3,
    createdAt: 1_700_000_300_000,
    sizeBytes: 128,
    bodyHash: 'aGFzaA',
    body: { location: 'idb', nonce: 'bm9uY2Utbm9uY2Utbm9uY2U', ciphertext: new Uint8Array(32) },
    ...overrides,
  };
}

// ————— path normalization —————

defineCase('path: accepts and canonicalizes valid relative paths', () => {
  assertEqual(normalizeEntryPath('untitled.md'), 'untitled.md', 'simple');
  assertEqual(normalizeEntryPath('docs/nested/notes.md'), 'docs/nested/notes.md', 'nested');
  assertEqual(normalizeEntryPath('spaced name.md'), 'spaced name.md', 'spaces allowed');
  assertEqual(normalizeEntryPath('images/desk.png'), 'images/desk.png', 'asset');
  // NFD input canonicalizes to NFC so web and native agree on one key.
  assertEqual(normalizeEntryPath('café.md'), 'café.md', 'NFC normalization');
});

defineCase('path: rejects escaping, absolute, and malformed forms', () => {
  assertRejects(() => normalizeEntryPath(''), 'empty');
  assertRejects(() => normalizeEntryPath('/abs.md'), 'absolute');
  assertRejects(() => normalizeEntryPath('dir//file.md'), 'empty segment');
  assertRejects(() => normalizeEntryPath('trailing/'), 'trailing slash');
  assertRejects(() => normalizeEntryPath('../escape.md'), 'dot-dot');
  assertRejects(() => normalizeEntryPath('a/./b.md'), 'dot segment');
  assertRejects(() => normalizeEntryPath('win\\path.md'), 'backslash');
  assertRejects(() => normalizeEntryPath('ctl.md'), 'control character');
  assertRejects(() => normalizeEntryPath(`${'x'.repeat(MAX_ENTRY_PATH_BYTES + 1)}`), 'too long');
  assertRejects(() => normalizeEntryPath(`${'a/'.repeat(65)}b.md`), 'too many segments');
});

// ————— record validation —————

defineCase('records: valid fixtures pass every validator', () => {
  validateWorkspaceRecord(workspaceRecord());
  validateWorkspaceEntryRecord(entryRecord());
  validateWorkspaceEntryRecord(
    entryRecord({ path: 'images/desk.png', kind: 'asset', mediaType: 'image/png' }),
  );
  validateWorkspaceEntryRecord(entryRecord({ path: 'report.html', kind: 'html' }));
  validateWorkspaceRevisionRecord(revisionRecord());
  validateWorkspaceRevisionRecord(
    revisionRecord({ body: { location: 'opfs', nonce: 'bm9uY2U', sealedBytes: 2_048_000 } }),
  );
  validateWorkspaceShareCapRecord({
    v: WORKSPACE_RECORD_VERSION,
    workspaceId: 'ws-1',
    capId: 'cap-1',
    roomId: 'room-1',
    scopeKind: 'workspace',
    createdAt: 1_700_000_000_000,
    nonce: 'bm9uY2U',
    ciphertext: 'c2VhbGVk',
  });
  validateWorkspaceRecoveryRecord({
    v: WORKSPACE_RECORD_VERSION,
    workspaceId: 'ws-1',
    recoveryId: 'rec-1',
    createdAt: 1_700_000_000_000,
    nonce: 'bm9uY2U',
    ciphertext: 'c2VhbGVk',
  });
  validateWorkspaceGcRecord({
    v: WORKSPACE_RECORD_VERSION,
    gcId: 'gc-1',
    kind: 'opfs-orphan',
    workspaceId: 'ws-1',
    target: '.attn-sealed/v1/x/y.bin',
    createdAt: 1_700_000_000_000,
  });
  validateWorkspaceLeaseRecord({
    v: WORKSPACE_RECORD_VERSION,
    workspaceId: 'ws-1',
    holderId: 'tab-1',
    fencingToken: 7,
    expiresAt: 1_700_000_030_000,
  });
});

defineCase('records: malformed workspace fields are rejected', () => {
  assertRejects(() => validateWorkspaceRecord(null), 'null record');
  assertRejects(() => validateWorkspaceRecord(workspaceRecord({ v: 2 })), 'future version');
  assertRejects(() => validateWorkspaceRecord(workspaceRecord({ name: '' })), 'empty name');
  assertRejects(
    () => validateWorkspaceRecord(workspaceRecord({ name: 'x'.repeat(300) })),
    'name over cap',
  );
  assertRejects(() => validateWorkspaceRecord(workspaceRecord({ clock: -1 })), 'negative clock');
  assertRejects(
    () => validateWorkspaceRecord(workspaceRecord({ createdAt: 1.5 })),
    'fractional timestamp',
  );
  assertRejects(
    () =>
      validateWorkspaceRecord(
        workspaceRecord({ storagePersisted: 'yes' as unknown as boolean }),
      ),
    'non-boolean persistence',
  );
});

defineCase('records: malformed entries and revisions are rejected', () => {
  assertRejects(() => validateWorkspaceEntryRecord(entryRecord({ path: '../up.md' })), 'bad path');
  assertRejects(
    () => validateWorkspaceEntryRecord(entryRecord({ path: 'café.md' })),
    'non-canonical NFD path',
  );
  assertRejects(
    () => validateWorkspaceEntryRecord(entryRecord({ kind: 'blob' as 'asset' })),
    'bad kind',
  );
  assertRejects(
    () => validateWorkspaceEntryRecord(entryRecord({ mediaType: 'image/png' })),
    'mediaType on markdown',
  );
  assertRejects(
    () =>
      validateWorkspaceEntryRecord(
        entryRecord({ kind: 'asset', mediaType: 'not a mime' }),
      ),
    'malformed mediaType',
  );
  assertRejects(
    () => validateWorkspaceEntryRecord(entryRecord({ sizeBytes: -3 })),
    'negative size',
  );
  assertRejects(
    () => validateWorkspaceRevisionRecord(revisionRecord({ bodyHash: 'not base64url!' })),
    'bad body hash',
  );
  assertRejects(
    () =>
      validateWorkspaceRevisionRecord(
        revisionRecord({
          body: { location: 'idb', nonce: 'bm9uY2U', ciphertext: new Uint8Array(8) },
        }),
      ),
    'tagless inline body',
  );
  assertRejects(
    () =>
      validateSealedBody({
        location: 'idb',
        nonce: 'bm9uY2U',
        ciphertext: new Uint8Array(MAX_INLINE_SEALED_BODY_BYTES + 1),
      }),
    'inline body over cap',
  );
  assertRejects(
    () => validateSealedBody({ location: 'cloud', nonce: 'bm9uY2U' }),
    'unknown body location',
  );
});

// ————— migration corpus —————

defineCase('migration: empty database creates every v3 store', async () => {
  const { factory, name } = testDatabase();
  const storage = await BrowserStorage.open({
    indexedDB: factory,
    databaseName: name,
    createIfMissing: true,
    filesystem: null,
    navigator: null,
  });
  storage.close();
  const db = await rawOpen(factory, name, BROWSER_STORAGE_SCHEMA_VERSION);
  try {
    assertEqual(db.version, BROWSER_STORAGE_SCHEMA_VERSION, 'version');
    for (const store of ALL_V3_STORES) {
      assert(db.objectStoreNames.contains(store), `missing store ${store}`);
    }
    const revisions = db.transaction(STORE_WORKSPACE_REVISIONS, 'readonly')
      .objectStore(STORE_WORKSPACE_REVISIONS);
    assert(
      revisions.indexNames.contains(REVISION_HISTORY_INDEX),
      'revision history index missing',
    );
  } finally {
    db.close();
  }
});

defineCase('migration: v1 fixture upgrades with room data intact', async () => {
  const { factory, name } = testDatabase();
  const v1 = await rawOpen(factory, name, 1, createV1Stores);
  await putRaw(v1, 'rooms', { ...ROOM });
  v1.close();

  const storage = await BrowserStorage.open({
    indexedDB: factory,
    databaseName: name,
    createIfMissing: false,
    filesystem: null,
    navigator: null,
  });
  try {
    const room = await storage.getRoom(ROOM.roomId);
    assert(room, 'legacy room survives the v3 upgrade');
    assertEqual(room.relayUrl, ROOM.relayUrl, 'room fields preserved');
  } finally {
    storage.close();
  }
  const db = await rawOpen(factory, name, BROWSER_STORAGE_SCHEMA_VERSION);
  for (const store of ALL_V3_STORES) {
    assert(db.objectStoreNames.contains(store), `missing store ${store}`);
  }
  db.close();
});

defineCase('migration: v2 fixture preserves inbox, cursor, and outbox data', async () => {
  const { factory, name } = testDatabase();
  const v2 = await rawOpen(factory, name, 2, (db) => {
    createV1Stores(db);
    createV2Stores(db);
  });
  await putRaw(v2, 'rooms', { ...ROOM });
  const sealed = {
    v: 2,
    roomId: ROOM.roomId,
    envelopeId: 'env-1',
    serverSeq: 7,
    authorId: 'participant-legacy',
    deviceId: 'device-legacy',
    kind: 'event',
    createdAt: 1_700_000_000_100,
    expiresAt: 1_800_000_000_000,
    nonce: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA0',
    ciphertext: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA0',
    ciphertextBytes: 33,
  };
  await putRaw(v2, 'inbox', {
    roomId: ROOM.roomId,
    envelopeId: 'env-1',
    serverSeq: 7,
    envelope: sealed,
  });
  await putRaw(v2, 'cursors', { roomId: ROOM.roomId, deviceId: 'device-legacy', serverSeq: 7 });
  v2.close();

  const storage = await BrowserStorage.open({
    indexedDB: factory,
    databaseName: name,
    createIfMissing: false,
    filesystem: null,
    navigator: null,
  });
  try {
    const replayed = await storage.replayInbound(ROOM.roomId);
    assertEqual(replayed.length, 1, 'inbox record preserved');
    assertEqual(replayed[0]!.serverSeq, 7, 'server sequence preserved');
    assertEqual(await storage.getCursor(ROOM.roomId, 'device-legacy'), 7, 'cursor preserved');
  } finally {
    storage.close();
  }
});

defineCase('migration: interrupted remember claim stays hidden and rolls back', async () => {
  const { factory, name } = testDatabase();
  const v2 = await rawOpen(factory, name, 2, (db) => {
    createV1Stores(db);
    createV2Stores(db);
  });
  await putRaw(v2, 'rooms', { ...ROOM, rememberClaimId: 'claim-interrupted' });
  v2.close();

  const storage = await BrowserStorage.open({
    indexedDB: factory,
    databaseName: name,
    createIfMissing: false,
    filesystem: null,
    navigator: null,
  });
  try {
    assertEqual(await storage.getRoom(ROOM.roomId), null, 'claimed room stays hidden');
    assert(
      await storage.forgetClaimedRoom(ROOM.roomId, 'claim-interrupted'),
      'interrupted claim can be rolled back after upgrade',
    );
    assertEqual(await storage.getRoom(ROOM.roomId), null, 'room gone after rollback');
  } finally {
    storage.close();
  }
});

defineCase('migration: corrupt v3 workspace records fail loudly, not silently', async () => {
  const { factory, name } = testDatabase();
  const storage = await BrowserStorage.open({
    indexedDB: factory,
    databaseName: name,
    createIfMissing: true,
    filesystem: null,
    navigator: null,
  });
  storage.close();

  const db = await rawOpen(factory, name, BROWSER_STORAGE_SCHEMA_VERSION);
  await putRaw(db, STORE_WORKSPACES, {
    v: 999,
    workspaceId: 'ws-corrupt',
    name: 42,
    clock: 'NaN',
  });
  const raw = await requestResult(
    db.transaction(STORE_WORKSPACES, 'readonly').objectStore(STORE_WORKSPACES).get('ws-corrupt'),
  );
  db.close();
  assert(raw, 'corrupt record was written for the fixture');
  assertRejects(() => validateWorkspaceRecord(raw), 'corrupt record rejected by validation');

  // The database itself remains healthy and re-openable — corruption is
  // contained to the record, never a silent wipe.
  const reopened = await BrowserStorage.open({
    indexedDB: factory,
    databaseName: name,
    createIfMissing: false,
    filesystem: null,
    navigator: null,
  });
  reopened.close();
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
  console.log(`browser-workspace-schema: ${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) process.exit(1);
}

void runAllCases();
