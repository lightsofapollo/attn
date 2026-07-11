import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import {
  BROWSER_STORAGE_SCHEMA_VERSION,
  BrowserStorage,
  MissingBrowserStorageError,
  StorageConflictError,
  type BrowserStorageDeviceIdentity,
  type BrowserStorageNavigator,
  type BrowserStorageRoom,
  type SealedBlobFileSystem,
} from './browser-storage';
import {
  base64UrlEncode,
  deriveRoomKeys,
  toCanonicalBytes,
} from './browser-crypto';
import type { Device, MailboxEnvelope, RoomPolicy } from './browser-ws';

// fake-indexeddb intentionally avoids mutating globals when imported by name;
// production browsers provide this constructor alongside indexedDB.
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

function assertDeepEqual(actual: unknown, expected: unknown, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

function assertBytes(actual: Uint8Array, expected: Uint8Array, message: string): void {
  assertEqual(actual.length, expected.length, `${message} length`);
  for (let index = 0; index < actual.length; index += 1) {
    if (actual[index] !== expected[index]) {
      throw new Error(`${message}: byte ${index} expected ${expected[index]}, got ${actual[index]}`);
    }
  }
}

async function assertRejects(
  operation: () => Promise<unknown>,
  predicate: (error: unknown) => boolean,
  message: string,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    if (!predicate(error)) throw new Error(`${message}: unexpected error ${String(error)}`);
    return;
  }
  throw new Error(`${message}: expected rejection`);
}

let databaseCounter = 0;

function testDatabase(): { factory: IDBFactory; name: string } {
  databaseCounter += 1;
  return { factory: new IDBFactory(), name: `attn-storage-test-${databaseCounter}` };
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

function rootBytes(seed: number): Uint8Array {
  return new Uint8Array(32).map((_, index) => (seed + index) & 0xff);
}

function identity(seed: number, room: string): BrowserStorageDeviceIdentity {
  const signingSecret = rootBytes(seed);
  const encryptionSecret = rootBytes(seed + 71);
  return {
    deviceId: `device-${room}`,
    participantId: `participant-${room}`,
    signingSecret,
    signingPublic: ed25519.getPublicKey(signingSecret),
    encryptionSecret,
    publicEncryptionKey: x25519.getPublicKey(encryptionSecret),
  };
}

function signedDevice(value: BrowserStorageDeviceIdentity): Device {
  const device: Device = {
    deviceId: value.deviceId,
    participantId: value.participantId,
    publicEncryptionKey: base64UrlEncode(value.publicEncryptionKey),
    publicSigningKey: base64UrlEncode(value.signingPublic),
    client: 'attn-browser',
    kind: 'reviewer',
    selfSignature: '',
  };
  const canonical = toCanonicalBytes({
    client: device.client,
    deviceId: device.deviceId,
    kind: device.kind,
    participantId: device.participantId,
    publicEncryptionKey: device.publicEncryptionKey,
    publicSigningKey: device.publicSigningKey,
  });
  device.selfSignature = base64UrlEncode(ed25519.sign(canonical, value.signingSecret));
  return device;
}

function envelope(
  roomId: string,
  envelopeId: string,
  serverSeq?: number,
  deviceId = `device-${roomId}`,
): MailboxEnvelope {
  return {
    v: 2,
    roomId,
    envelopeId,
    ...(serverSeq === undefined ? {} : { serverSeq }),
    authorId: `participant-${roomId}`,
    deviceId,
    kind: 'event',
    createdAt: 1_700_000_000_000 + (serverSeq ?? 0),
    expiresAt: 1_800_000_000_000,
    nonce: base64UrlEncode(new Uint8Array(24).fill((serverSeq ?? 1) & 0xff)),
    ciphertext: base64UrlEncode(new Uint8Array(32).fill((serverSeq ?? 1) & 0xff)),
    ciphertextBytes: 32,
  };
}

async function createV1Database(factory: IDBFactory, name: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = factory.open(name, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('room_keys', { keyPath: 'roomId' });
      request.result.createObjectStore('rooms', { keyPath: 'roomId' });
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      request.result.close();
      resolve();
    };
  });
}

async function inspectDatabase(
  factory: IDBFactory,
  name: string,
  inspect: (database: IDBDatabase) => Promise<void> | void,
): Promise<void> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(name, BROWSER_STORAGE_SCHEMA_VERSION);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
  try {
    await inspect(database);
  } finally {
    database.close();
  }
}

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

defineCase('opens and migrates the stable v1 schema to the current version', async () => {
  const { factory, name } = testDatabase();
  await createV1Database(factory, name);
  const storage = await BrowserStorage.open({
    indexedDB: factory,
    databaseName: name,
    createIfMissing: false,
  });
  storage.close();
  await inspectDatabase(factory, name, (database) => {
    assertEqual(database.version, BROWSER_STORAGE_SCHEMA_VERSION, 'schema version');
    assertDeepEqual(
      [...database.objectStoreNames].sort(),
      [
        'cursors',
        'devices',
        'history',
        'identities',
        'inbox',
        'outbox',
        'room_keys',
        'rooms',
        'workspace_entries',
        'workspace_gc',
        'workspace_keys',
        'workspace_leases',
        'workspace_recovery',
        'workspace_revisions',
        'workspace_share_caps',
        'workspaces',
      ],
      'object stores',
    );
  });
});

defineCase('createIfMissing false aborts an absent database without leaving it behind', async () => {
  const { factory, name } = testDatabase();
  await assertRejects(
    () => BrowserStorage.open({ indexedDB: factory, databaseName: name, createIfMissing: false }),
    (error) => error instanceof MissingBrowserStorageError,
    'missing database probe',
  );
  const databases = await factory.databases();
  assert(!databases.some((database) => database.name === name), 'probe must not create a database');
});

defineCase('atomically grants one remember claim across concurrent database connections', async () => {
  const { factory, name } = testDatabase();
  const [first, second] = await Promise.all([
    BrowserStorage.open({ indexedDB: factory, databaseName: name, createIfMissing: true }),
    BrowserStorage.open({ indexedDB: factory, databaseName: name, createIfMissing: true }),
  ]);
  const room: BrowserStorageRoom = {
    roomId: 'room-claim',
    policy: POLICY,
    lastCreatedAt: 1_700_000_000_000,
    storagePersisted: false,
  };
  try {
    const claims = await Promise.all([
      first.claimRoom(room, 'claim-first'),
      second.claimRoom(room, 'claim-second'),
    ]);
    assertEqual(claims.filter(Boolean).length, 1, 'exactly one remember attempt owns the room');
    assertEqual(await first.getRoom(room.roomId), null, 'unfinished claim is hidden from resume');
    const winningClaim = claims[0] ? 'claim-first' : 'claim-second';
    await first.completeRoomClaim(room.roomId, winningClaim);
    assertDeepEqual(await first.getRoom(room.roomId), room, 'internal claim is not exposed');
    assertEqual(
      await second.forgetClaimedRoom(room.roomId, 'claim-loser'),
      false,
      'non-owner rollback cannot erase completed recovery',
    );
    assertDeepEqual(await first.getRoom(room.roomId), room, 'completed recovery survives loser rollback');
  } finally {
    first.close();
    second.close();
  }
});

defineCase('stores a non-extractable HKDF root and derives browser-crypto-compatible keys', async () => {
  const { factory, name } = testDatabase();
  const storage = await BrowserStorage.open({
    indexedDB: factory,
    databaseName: name,
    createIfMissing: true,
  });
  try {
    const secret = rootBytes(17);
    const expected = deriveRoomKeys(secret);
    const opaque = await storage.installRoomKey('room-kdf', expected.rootKey);
    assertEqual(opaque.extractable, false, 'root extractability');
    assertEqual(opaque.algorithm.name, 'HKDF', 'root algorithm');
    await assertRejects(
      () => crypto.subtle.exportKey('raw', opaque),
      (error) => error instanceof DOMException && /(?:InvalidAccess|NotSupported)/.test(error.name),
      'root export',
    );
    const actual = await storage.deriveRoomKeys('room-kdf');
    assertBytes(actual.eventKey, expected.eventKey, 'event key');
    assertBytes(actual.snapshotKey, expected.snapshotKey, 'snapshot key');
    assertBytes(actual.signalingKey, expected.signalingKey, 'signaling key');
    assertBytes(actual.admissionKey, expected.admissionKey, 'admission key');
    const reopened = await storage.getRoomRootKey('room-kdf');
    assert(reopened !== null && !reopened.extractable, 'structured-cloned key remains opaque');
  } finally {
    storage.close();
  }
});

defineCase('encrypts private identity bytes and validates public keys on recovery', async () => {
  const { factory, name } = testDatabase();
  const storage = await BrowserStorage.open({
    indexedDB: factory,
    databaseName: name,
    createIfMissing: true,
  });
  const local = identity(31, 'private');
  try {
    await storage.installRoomKey('room-private', rootBytes(201));
    await storage.saveIdentity('room-private', local);
    await storage.saveIdentity('room-private', local);
    const loaded = await storage.loadIdentity('room-private');
    assert(loaded !== null, 'identity recovers');
    assertBytes(loaded.signingSecret, local.signingSecret, 'signing secret');
    assertBytes(loaded.encryptionSecret, local.encryptionSecret, 'encryption secret');

    await inspectDatabase(factory, name, async (database) => {
      const tx = database.transaction([...database.objectStoreNames], 'readonly');
      const allRecords: unknown[] = [];
      const reads = [...database.objectStoreNames].map((storeName) =>
        requestResult(tx.objectStore(storeName).getAll()),
      );
      for (const records of await Promise.all(reads)) allRecords.push(...records);
      const serialized = JSON.stringify(allRecords);
      assert(!serialized.includes(base64UrlEncode(local.signingSecret)), 'signing secret absent');
      assert(!serialized.includes(base64UrlEncode(local.encryptionSecret)), 'encryption secret absent');
    });

    await inspectDatabase(factory, name, async (database) => {
      const tx = database.transaction('identities', 'readwrite');
      const store = tx.objectStore('identities');
      const record = await requestResult<Record<string, unknown>>(store.get('room-private'));
      record.publicSigningKey = base64UrlEncode(rootBytes(99));
      store.put(record);
      await transactionResult(tx);
    });
    await assertRejects(
      () => storage.loadIdentity('room-private'),
      (error) => error instanceof Error,
      'AAD/public key tampering',
    );
  } finally {
    storage.close();
  }
});

defineCase('atomically stores inbound envelopes and keeps each device cursor monotonic', async () => {
  const { factory, name } = testDatabase();
  const storage = await BrowserStorage.open({
    indexedDB: factory,
    databaseName: name,
    createIfMissing: true,
  });
  try {
    const high = envelope('room-inbox', 'env-high', 5);
    high.target = null;
    const low = envelope('room-inbox', 'env-low', 3);
    assertEqual(await storage.commitInbound('room-inbox', 'receiver-a', high, 5), true, 'high insert');
    assertEqual(await storage.commitInbound('room-inbox', 'receiver-a', high, 5), false, 'idempotent');
    await storage.commitInbound('room-inbox', 'receiver-a', low, 3);
    assertEqual(await storage.getCursor('room-inbox', 'receiver-a'), 5, 'cursor does not regress');
    assertEqual(await storage.getCursor('room-inbox', 'receiver-b'), 0, 'cursor is device isolated');

    const conflicting = envelope('room-inbox', 'env-conflict', 5);
    await assertRejects(
      () => storage.commitInbound('room-inbox', 'receiver-a', conflicting, 5),
      (error) => error instanceof StorageConflictError,
      'duplicate server sequence',
    );
    assertEqual(await storage.getCursor('room-inbox', 'receiver-a'), 5, 'rollback keeps cursor');
    const replay = await storage.replayInbound('room-inbox');
    assertDeepEqual(replay.map((item) => item.serverSeq), [3, 5], 'safe replay order');
    assertDeepEqual(replay.map((item) => item.envelope), [low, high], 'exact sealed replay');
  } finally {
    storage.close();
  }
});

defineCase('recovers exact outbox bytes and atomically moves acknowledgements to history', async () => {
  const { factory, name } = testDatabase();
  const storage = await BrowserStorage.open({
    indexedDB: factory,
    databaseName: name,
    createIfMissing: true,
    now: () => 1_700_000_123_456,
  });
  try {
    const first = envelope('room-outbox', 'env-first', undefined, 'sender-a');
    const second = envelope('room-outbox', 'env-second', undefined, 'sender-a');
    assertEqual(await storage.putOutbox('room-outbox', first), true, 'first enqueue');
    assertEqual(await storage.putOutbox('room-outbox', first), false, 'duplicate enqueue');
    await storage.putOutbox('room-outbox', second);
    await assertRejects(
      () => storage.putOutbox('room-outbox', {
        ...first,
        ciphertext: base64UrlEncode(new Uint8Array(32).fill(9)),
      }),
      (error) => error instanceof StorageConflictError,
      'conflicting envelope id',
    );
    assertDeepEqual(
      await storage.listOutbox('room-outbox', 'sender-a'),
      [first, second],
      'exact recovery',
    );

    await storage.commitInbound('room-outbox', 'receiver-a', envelope('room-outbox', 'inbound', 4), 4);
    assertEqual(
      await storage.acknowledge(
        'room-outbox',
        [first, second],
        [{ envelopeId: first.envelopeId, serverSeq: 99 }],
      ),
      1,
      'moved count',
    );
    assertDeepEqual(await storage.listOutbox('room-outbox', 'sender-a'), [second], 'pending remains');
    const history = await storage.listHistory('room-outbox');
    assertEqual(history.length, 1, 'history count');
    assertDeepEqual(history[0]!.envelope, first, 'history exact envelope');
    assertEqual(history[0]!.serverSeq, 99, 'history acknowledgement sequence');
    assertEqual(history[0]!.ackedAt, 1_700_000_123_456, 'history timestamp');
    assertEqual(await storage.getCursor('room-outbox', 'receiver-a'), 4, 'sent seq never advances cursor');
  } finally {
    storage.close();
  }
});

class MemorySealedFilesystem implements SealedBlobFileSystem {
  readonly files = new Map<string, Uint8Array>();
  readonly writtenPaths: string[] = [];

  async write(path: string, sealedBytes: Uint8Array): Promise<void> {
    this.writtenPaths.push(path);
    this.files.set(path, new Uint8Array(sealedBytes));
  }

  async read(path: string): Promise<Uint8Array | null> {
    const bytes = this.files.get(path);
    return bytes ? new Uint8Array(bytes) : null;
  }

  async delete(path: string): Promise<boolean> {
    return this.files.delete(path);
  }

  async deletePrefix(prefix: string): Promise<void> {
    for (const path of this.files.keys()) if (path.startsWith(prefix)) this.files.delete(path);
  }
}

defineCase('isolates rooms, crypto-erases forgotten state, and roundtrips only sealed blobs', async () => {
  const { factory, name } = testDatabase();
  const filesystem = new MemorySealedFilesystem();
  const navigatorImpl: BrowserStorageNavigator = {
    storage: {
      persist: async () => true,
      estimate: async () => ({ usage: 123, quota: 456 }),
    },
  };
  const storage = await BrowserStorage.open({
    indexedDB: factory,
    databaseName: name,
    createIfMissing: true,
    filesystem,
    navigator: navigatorImpl,
  });
  try {
    const one = identity(41, 'one');
    const two = identity(81, 'two');
    for (const [roomId, local, key] of [
      ['room-one', one, rootBytes(1)],
      ['room-two', two, rootBytes(2)],
    ] as const) {
      await storage.installRoomKey(roomId, key);
      await storage.putRoom({
        roomId,
        policy: POLICY,
        lastCreatedAt: 0,
        storagePersisted: true,
      });
      await storage.saveIdentity(roomId, local);
      await storage.putDevice(roomId, signedDevice(local));
      await storage.putOutbox(roomId, envelope(roomId, `out-${roomId}`));
    }
    const sealed = new Uint8Array(48).fill(0xa7);
    assertEqual(await storage.putSealedBlob('room-one', 'snapshot-secret-name', sealed), true, 'blob write');
    assertBytes((await storage.getSealedBlob('room-one', 'snapshot-secret-name'))!, sealed, 'blob read');
    assert(
      filesystem.writtenPaths.every(
        (path) => !path.includes('room-one') && !path.includes('snapshot-secret-name'),
      ),
      'OPFS paths are opaque hashes',
    );
    assertEqual(await storage.requestPersistence(), true, 'persistence wrapper');
    assertDeepEqual(await storage.estimateStorage(), { usage: 123, quota: 456 }, 'estimate wrapper');

    await storage.forgetRoom('room-one');
    assertEqual(await storage.getRoomRootKey('room-one'), null, 'forgotten root removed first');
    assertEqual(await storage.getRoom('room-one'), null, 'forgotten metadata removed');
    assertEqual(await storage.loadIdentity('room-one'), null, 'forgotten identity removed');
    assertDeepEqual(await storage.listOutbox('room-one', one.deviceId), [], 'forgotten outbox removed');
    assertEqual(await storage.getSealedBlob('room-one', 'snapshot-secret-name'), null, 'forgotten OPFS removed');

    assert(await storage.getRoomRootKey('room-two'), 'other room key remains');
    assert(await storage.loadIdentity('room-two'), 'other room identity remains');
    assertEqual((await storage.listDevices('room-two')).length, 1, 'other room devices remain');
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
  console.log(`browser-storage: ${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) process.exit(1);
}

void runAllCases();
