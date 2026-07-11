import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { BrowserStorage, BrowserStorageError, StorageConflictError } from './browser-storage';
import { inviteCapabilityFrom } from './browser-workspace-share';
import { generateBrowserIdentity } from './browser-session';
import { base64UrlEncode } from './browser-crypto';
import type { MailboxEnvelope } from './browser-ws';
import { BrowserOutbox } from './browser-outbox';

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

async function expectStorageError(promise: Promise<unknown>, message: string): Promise<void> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof BrowserStorageError) return;
    throw new Error(`${message}: expected BrowserStorageError, got ${String(error)}`);
  }
  throw new Error(`${message}: expected BrowserStorageError`);
}

let counter = 0;

async function openStorage(): Promise<{ storage: BrowserStorage; reopen: () => Promise<BrowserStorage> }> {
  counter += 1;
  const factory = new IDBFactory();
  const name = `attn-share-test-${counter}`;
  const open = () =>
    BrowserStorage.open({
      indexedDB: factory,
      databaseName: name,
      createIfMissing: true,
      filesystem: null,
      navigator: null,
    });
  return { storage: await open(), reopen: open };
}

function sampleCapability() {
  const identity = generateBrowserIdentity();
  return inviteCapabilityFrom({
    roomSecret: new Uint8Array(32).fill(7),
    ownerSigningSecret: identity.signingSecret,
    ownerEncryptionSecret: identity.encryptionSecret,
    ownerDeviceId: identity.deviceId,
    ownerParticipantId: identity.participantId,
    policy: { mode: 'hybrid', maxPeers: 8 },
  });
}

function publicationEnvelope(roomId: string, fill: number): MailboxEnvelope {
  return {
    v: 2,
    roomId,
    envelopeId: base64UrlEncode(new Uint8Array(16).fill(fill)),
    authorId: 'participant-owner',
    deviceId: 'device-owner',
    createdAt: 1_700_000_000_000,
    expiresAt: 1_700_086_400_000,
    kind: fill % 2 === 0 ? 'event' : 'snapshot_blob',
    nonce: base64UrlEncode(new Uint8Array(24).fill(fill)),
    ciphertext: base64UrlEncode(new Uint8Array(32).fill(fill)),
    ciphertextBytes: 32,
  };
}

defineCase('bind seals the capability and opens across a reload', async () => {
  const { storage, reopen } = await openStorage();
  const rootKey = await storage.createWorkspaceKey('ws-1');
  const capability = sampleCapability();
  const view = await storage.shares.bindShare(rootKey, {
    workspaceId: 'ws-1',
    capId: 'cap-1',
    roomId: 'room-abc',
    scopeKind: 'workspace',
    relayUrl: 'https://relay.example',
    capability,
  });
  assertEqual(view.publication, 'pending', 'starts pending');
  assertEqual(view.roomId, 'room-abc', 'room bound');
  storage.close();

  const reopened = await reopen();
  try {
    const key = await reopened.getWorkspaceRootKey('ws-1');
    assert(key, 'root key survives reload');
    const opened = await reopened.shares.openShare(key, 'ws-1', 'cap-1');
    assertEqual(opened.roomSecret, capability.roomSecret, 'room secret round-trips sealed');
    assertEqual(opened.ownerDeviceId, capability.ownerDeviceId, 'owner identity preserved');
  } finally {
    reopened.close();
  }
});

defineCase('bind is idempotent by capId, conflicts on a different room', async () => {
  const { storage } = await openStorage();
  try {
    const rootKey = await storage.createWorkspaceKey('ws-1');
    const capability = sampleCapability();
    await storage.shares.bindShare(rootKey, {
      workspaceId: 'ws-1',
      capId: 'cap-1',
      roomId: 'room-abc',
      scopeKind: 'workspace',
      relayUrl: 'https://relay.example',
      capability,
    });
    // Same capId + room = idempotent resume (no throw).
    const again = await storage.shares.bindShare(rootKey, {
      workspaceId: 'ws-1',
      capId: 'cap-1',
      roomId: 'room-abc',
      scopeKind: 'workspace',
      relayUrl: 'https://relay.example',
      capability,
    });
    assertEqual(again.roomId, 'room-abc', 'idempotent resume');
    let conflicted = false;
    try {
      await storage.shares.bindShare(rootKey, {
        workspaceId: 'ws-1',
        capId: 'cap-1',
        roomId: 'room-different',
        scopeKind: 'workspace',
        relayUrl: 'https://relay.example',
        capability,
      });
    } catch (error) {
      conflicted = error instanceof StorageConflictError;
    }
    assert(conflicted, 'different room conflicts');
  } finally {
    storage.close();
  }
});

defineCase('sealed capability is workspace-key bound: erasure makes it opaque', async () => {
  const { storage } = await openStorage();
  try {
    const rootKey = await storage.createWorkspaceKey('ws-1');
    await storage.shares.bindShare(rootKey, {
      workspaceId: 'ws-1',
      capId: 'cap-1',
      roomId: 'room-abc',
      scopeKind: 'file',
      relayUrl: 'https://relay.example',
      capability: sampleCapability(),
    });
    // Crypto-erase the workspace key, then a fresh key cannot open the cap.
    await storage.deleteWorkspaceKey('ws-1');
    const fresh = await storage.createWorkspaceKey('ws-1');
    await expectStorageError(
      storage.shares.openShare(fresh, 'ws-1', 'cap-1'),
      'erased capability is permanently opaque',
    );
  } finally {
    storage.close();
  }
});

defineCase('publication state advances and shares list/forget', async () => {
  const { storage } = await openStorage();
  try {
    const rootKey = await storage.createWorkspaceKey('ws-1');
    await storage.shares.bindShare(rootKey, {
      workspaceId: 'ws-1',
      capId: 'cap-1',
      roomId: 'room-abc',
      scopeKind: 'entries',
      relayUrl: 'https://relay.example',
      capability: sampleCapability(),
    });
    await expectStorageError(
      storage.shares.setPublication('ws-1', 'cap-1', 'published'),
      'published state requires relay ACK',
    );
    assertEqual((await storage.shares.listShares('ws-1')).length, 1, 'listed');
    const stopped = await storage.shares.setPublication('ws-1', 'cap-1', 'stopped');
    assertEqual(stopped.publication, 'stopped', 'stopped');
    assert(await storage.shares.forgetShare('ws-1', 'cap-1'), 'forgotten');
    assertEqual((await storage.shares.listShares('ws-1')).length, 0, 'gone');
    await expectStorageError(
      storage.shares.setPublication('ws-1', 'cap-1', 'stopped'),
      'missing share update errors',
    );
  } finally {
    storage.close();
  }
});

defineCase('publication commit atomically reseals manifest pointer and stable FileIds', async () => {
  const { storage, reopen } = await openStorage();
  const rootKey = await storage.createWorkspaceKey('ws-1');
  await storage.shares.bindShare(rootKey, {
    workspaceId: 'ws-1', capId: 'cap-1', roomId: 'room-abc', scopeKind: 'workspace',
    relayUrl: 'https://relay.example', capability: sampleCapability(),
  });
  const id = (length: number, fill: number) => base64UrlEncode(new Uint8Array(length).fill(fill));
  const pointer = {
    manifestSnapshotId: id(16, 1),
    entries: [{
      path: 'notes/readme.md', fileId: id(16, 2), snapshotId: id(16, 3), contentHash: id(32, 4),
    }],
  };
  const envelopes = [publicationEnvelope('room-abc', 11), publicationEnvelope('room-abc', 12)];
  await storage.shares.stagePublication(rootKey, 'ws-1', 'cap-1', pointer, envelopes);
  assertEqual(
    (await storage.shares.loadPendingPublication(rootKey, 'ws-1', 'cap-1')).length,
    2,
    'exact pending ciphertext is recoverable',
  );
  assertEqual(
    JSON.stringify(await storage.shares.loadPendingPublication(rootKey, 'ws-1', 'cap-1')),
    JSON.stringify(envelopes),
    'recovery preserves exact queued ciphertext',
  );
  await storage.acknowledge(
    'room-abc',
    envelopes,
    envelopes.map((envelope, index) => ({ envelopeId: envelope.envelopeId, serverSeq: index + 1 })),
  );
  assertEqual(
    (await storage.shares.listShares('ws-1'))[0]?.publication,
    'published',
    'last durable ACK autonomously promotes publication',
  );
  const committed = await storage.shares.commitPublication(rootKey, 'ws-1', 'cap-1');
  assertEqual(committed.publication, 'published', 'plaintext state changes in same commit');
  storage.close();
  const reopened = await reopen();
  try {
    const key = await reopened.getWorkspaceRootKey('ws-1');
    assert(key, 'workspace key reopens');
    const capability = await reopened.shares.openShare(key, 'ws-1', 'cap-1');
    assertEqual(capability.publishedManifest?.manifestSnapshotId, pointer.manifestSnapshotId, 'sealed pointer retained');
    assertEqual(capability.publishedManifest?.entries[0]?.fileId, pointer.entries[0]!.fileId, 'stable FileId retained');
  } finally { reopened.close(); }
});

defineCase('stop racing a staged commit wins by generation and ACK cannot resurrect it', async () => {
  const { storage } = await openStorage();
  try {
    const rootKey = await storage.createWorkspaceKey('ws-stop');
    await storage.shares.bindShare(rootKey, {
      workspaceId: 'ws-stop', capId: 'cap-stop', roomId: 'room-stop', scopeKind: 'workspace',
      relayUrl: 'https://relay.example', capability: sampleCapability(),
    });
    const id = (length: number, fill: number) => base64UrlEncode(new Uint8Array(length).fill(fill));
    const pointer = {
      manifestSnapshotId: id(16, 21),
      entries: [{ path: 'a.md', fileId: id(16, 22), snapshotId: id(16, 23), contentHash: id(32, 24) }],
    };
    const envelopes = [publicationEnvelope('room-stop', 25), publicationEnvelope('room-stop', 26)];
    await storage.shares.stagePublication(rootKey, 'ws-stop', 'cap-stop', pointer, envelopes);
    await storage.shares.setPublication('ws-stop', 'cap-stop', 'stopped');
    await storage.acknowledge(
      'room-stop', envelopes,
      envelopes.map((envelope, index) => ({ envelopeId: envelope.envelopeId, serverSeq: index + 30 })),
    );
    assertEqual(
      (await storage.shares.listShares('ws-stop'))[0]?.publication,
      'stopped',
      'ACK transaction does not overwrite stop',
    );
    let conflicted = false;
    try {
      await storage.shares.commitPublication(rootKey, 'ws-stop', 'cap-stop');
    } catch (error) {
      conflicted = error instanceof StorageConflictError;
    }
    assert(conflicted, 'stale commit conflicts after stop');
  } finally { storage.close(); }
});

defineCase('late envelope conflict rolls back both publication journal and entire batch', async () => {
  const { storage } = await openStorage();
  try {
    const rootKey = await storage.createWorkspaceKey('ws-atomic');
    await storage.shares.bindShare(rootKey, {
      workspaceId: 'ws-atomic', capId: 'cap-atomic', roomId: 'room-atomic', scopeKind: 'workspace',
      relayUrl: 'https://relay.example', capability: sampleCapability(),
    });
    const first = publicationEnvelope('room-atomic', 51);
    const conflicting = publicationEnvelope('room-atomic', 52);
    await storage.putOutbox('room-atomic', {
      ...conflicting,
      ciphertext: base64UrlEncode(new Uint8Array(32).fill(99)),
    });
    const id = (length: number, fill: number) => base64UrlEncode(new Uint8Array(length).fill(fill));
    let failed = false;
    try {
      await storage.shares.stagePublication(rootKey, 'ws-atomic', 'cap-atomic', {
        manifestSnapshotId: id(16, 53),
        entries: [{ path: 'a.md', fileId: id(16, 54), snapshotId: id(16, 55), contentHash: id(32, 56) }],
      }, [first, conflicting]);
    } catch (error) {
      failed = error instanceof StorageConflictError;
    }
    assert(failed, 'late conflict aborts stage');
    assertEqual(
      (await storage.listOutbox('room-atomic', 'device-owner')).length,
      1,
      'first batch row was not partially inserted',
    );
    const capability = await storage.shares.openShare(rootKey, 'ws-atomic', 'cap-atomic');
    assertEqual(capability.pendingPublication, undefined, 'sealed journal was also rolled back');
  } finally { storage.close(); }
});

defineCase('reloaded outbox autonomously publishes on the last ACK', async () => {
  const { storage, reopen } = await openStorage();
  const rootKey = await storage.createWorkspaceKey('ws-auto');
  await storage.shares.bindShare(rootKey, {
    workspaceId: 'ws-auto', capId: 'cap-auto', roomId: 'room-auto', scopeKind: 'workspace',
    relayUrl: 'https://relay.example', capability: sampleCapability(),
  });
  const id = (length: number, fill: number) => base64UrlEncode(new Uint8Array(length).fill(fill));
  const pointer = {
    manifestSnapshotId: id(16, 41),
    entries: [{ path: 'auto.md', fileId: id(16, 42), snapshotId: id(16, 43), contentHash: id(32, 44) }],
  };
  const envelopes = [publicationEnvelope('room-auto', 45), publicationEnvelope('room-auto', 46)];
  await storage.shares.stagePublication(rootKey, 'ws-auto', 'cap-auto', pointer, envelopes);
  storage.close();

  const resumedStorage = await reopen();
  const outbox = new BrowserOutbox({
    relayUrl: 'https://relay.example',
    roomId: 'room-auto',
    deviceId: 'device-owner',
    admissionKey: new Uint8Array(32).fill(1),
    powBits: 12,
    maxEventBytes: 1024,
    maxSnapshotBytes: 1024,
    now: () => 1_700_000_000_001,
    mintPow: async () => 'test-pow',
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body) as { envelopes: Array<{ envelopeId: string }> };
      return {
        status: 201,
        text: async () => JSON.stringify({
          accepted: body.envelopes.map((envelope, index) => ({
            envelopeId: envelope.envelopeId,
            serverSeq: index + 100,
          })),
        }),
      };
    },
    persistence: {
      loadPending: () => resumedStorage.listOutbox('room-auto', 'device-owner'),
      putPending: async (envelope) => { await resumedStorage.putOutbox('room-auto', envelope); },
      putPendingBatch: async (batch) => { await resumedStorage.putOutboxBatch('room-auto', batch); },
      acknowledge: async (batch, accepted) => {
        await resumedStorage.acknowledge('room-auto', batch, accepted);
      },
    },
  });
  try {
    await outbox.initialize();
    assertEqual(outbox.getState().pendingCount, 2, 'reload recovers exact batch');
    await outbox.flushNow();
    assertEqual(outbox.getState().pendingCount, 0, 'relay ACK drains recovered batch');
    assertEqual(
      (await resumedStorage.shares.listShares('ws-auto'))[0]?.publication,
      'published',
      'ACK transaction autonomously promotes share',
    );
    const key = await resumedStorage.getWorkspaceRootKey('ws-auto');
    assert(key, 'workspace key survives reload');
    const capability = await resumedStorage.shares.openShare(key, 'ws-auto', 'cap-auto');
    assertEqual(
      capability.publishedManifest?.manifestSnapshotId,
      pointer.manifestSnapshotId,
      'history-only published capability retains pointer',
    );
  } finally {
    outbox.close();
    resumedStorage.close();
  }
});

defineCase('invalid inputs are rejected', async () => {
  const { storage } = await openStorage();
  try {
    const rootKey = await storage.createWorkspaceKey('ws-1');
    await expectStorageError(
      storage.shares.bindShare(rootKey, {
        workspaceId: 'ws-1',
        capId: 'cap-1',
        roomId: 'room-abc',
        scopeKind: 'workspace',
        relayUrl: 'ftp://bad',
        capability: sampleCapability(),
      }),
      'non-http relay rejected',
    );
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
  console.log(`browser-workspace-share: ${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) process.exit(1);
}

void runAllCases();
