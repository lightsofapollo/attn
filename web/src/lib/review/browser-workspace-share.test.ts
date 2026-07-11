import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { BrowserStorage, BrowserStorageError, StorageConflictError } from './browser-storage';
import { inviteCapabilityFrom } from './browser-workspace-share';
import { generateBrowserIdentity } from './browser-session';
import { base64UrlEncode, contentHash } from './browser-crypto';
import type { MailboxEnvelope } from './browser-ws';
import { BrowserOutbox } from './browser-outbox';
import type { WorkspaceFence } from './browser-workspace-store';

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

async function openStorage(
  now: () => number = Date.now,
): Promise<{ storage: BrowserStorage; reopen: () => Promise<BrowserStorage> }> {
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
      now,
    });
  return { storage: await open(), reopen: open };
}

async function acquireFence(
  storage: BrowserStorage,
  workspaceId: string,
  holderId = `${workspaceId}-publisher`,
): Promise<WorkspaceFence> {
  const manager = storage.leases({ channel: null });
  const lease = await manager.acquire(workspaceId, holderId);
  manager.close();
  assert(lease, `lease acquired for ${workspaceId}`);
  return lease;
}

function sampleCapability(sharePaths?: string[]) {
  const identity = generateBrowserIdentity();
  return inviteCapabilityFrom({
    roomSecret: new Uint8Array(32).fill(7),
    ownerSigningSecret: identity.signingSecret,
    ownerEncryptionSecret: identity.encryptionSecret,
    ownerDeviceId: identity.deviceId,
    ownerParticipantId: identity.participantId,
    policy: { mode: 'hybrid', maxPeers: 8 },
    ...(sharePaths === undefined ? {} : { sharePaths }),
  });
}

async function seedPublishedEntry(
  storage: BrowserStorage,
  workspaceId: string,
  path: string,
  text = `body for ${path}`,
) {
  const bytes = new TextEncoder().encode(text);
  const committed = await storage.workspaces.createWorkspace({
    workspaceId,
    name: workspaceId,
    storagePersisted: true,
    entry: { path, kind: 'markdown', body: bytes },
  });
  return {
    revisionId: committed.revision.revisionId,
    contentHash: contentHash(bytes),
  };
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

defineCase('fenced preparation allows one active share and fenced crypto-erasure', async () => {
  const { storage } = await openStorage();
  try {
    const workspaceId = 'ws-fenced-prepare';
    const rootKey = await storage.createWorkspaceKey(workspaceId);
    const fence = await acquireFence(storage, workspaceId, 'active-tab');
    const prepared = await storage.shares.bindShareFenced(rootKey, {
      workspaceId,
      capId: 'cap-prepared',
      roomId: 'room-prepared',
      scopeKind: 'entries',
      relayUrl: 'https://relay.example',
      capability: sampleCapability(['notes.md', 'assets/diagram.png']),
    }, fence);
    assertEqual(prepared.publication, 'pending', 'prepared before network');
    const opened = await storage.shares.openShare(rootKey, workspaceId, prepared.capId);
    assertEqual(opened.sharePaths?.join('|'), 'notes.md|assets/diagram.png', 'scope paths sealed');

    await expectStorageError(
      storage.shares.bindShareFenced(rootKey, {
        workspaceId,
        capId: 'cap-second',
        roomId: 'room-second',
        scopeKind: 'workspace',
        relayUrl: 'https://relay.example',
        capability: sampleCapability(['notes.md']),
      }, fence),
      'one active room per workspace',
    );
    await expectStorageError(
      storage.shares.forgetShareFenced(
        workspaceId,
        prepared.capId,
        { ...fence, holderId: 'stale-tab' },
      ),
      'passive tab cannot erase ownership',
    );
    assert(
      await storage.shares.forgetShareFenced(workspaceId, prepared.capId, fence),
      'active owner erased capability',
    );
    assertEqual((await storage.shares.listShares(workspaceId)).length, 0, 'late ACK has no record to revive');
  } finally {
    storage.close();
  }
});

defineCase('publication commit atomically reseals manifest pointer and stable FileIds', async () => {
  const { storage, reopen } = await openStorage();
  const rootKey = await storage.createWorkspaceKey('ws-1');
  const source = await seedPublishedEntry(storage, 'ws-1', 'notes/readme.md');
  await storage.shares.bindShare(rootKey, {
    workspaceId: 'ws-1', capId: 'cap-1', roomId: 'room-abc', scopeKind: 'workspace',
    relayUrl: 'https://relay.example', capability: sampleCapability(),
  });
  const id = (length: number, fill: number) => base64UrlEncode(new Uint8Array(length).fill(fill));
  const pointer = {
    manifestSnapshotId: id(16, 1),
    entries: [{
      path: 'notes/readme.md', fileId: id(16, 2), snapshotId: id(16, 3),
      contentHash: source.contentHash, revisionId: source.revisionId,
    }],
  };
  const envelopes = [publicationEnvelope('room-abc', 11), publicationEnvelope('room-abc', 12)];
  const fence = await acquireFence(storage, 'ws-1');
  await storage.shares.stagePublication(rootKey, 'ws-1', 'cap-1', pointer, envelopes, fence);
  assertEqual(
    (await storage.shares.loadPendingPublication(rootKey, 'ws-1', 'cap-1', fence)).length,
    2,
    'exact pending ciphertext is recoverable',
  );
  assertEqual(
    JSON.stringify(await storage.shares.loadPendingPublication(rootKey, 'ws-1', 'cap-1', fence)),
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
    'pending',
    'ACK alone cannot promote a fenced publication',
  );
  const committed = await storage.shares.commitPublication(rootKey, 'ws-1', 'cap-1', fence);
  assertEqual(committed.publication, 'published', 'plaintext state changes in same commit');
  storage.close();
  const reopened = await reopen();
  try {
    const key = await reopened.getWorkspaceRootKey('ws-1');
    assert(key, 'workspace key reopens');
    const capability = await reopened.shares.openShare(key, 'ws-1', 'cap-1');
    assertEqual(capability.publishedManifest?.manifestSnapshotId, pointer.manifestSnapshotId, 'sealed pointer retained');
    assertEqual(capability.publishedManifest?.entries[0]?.fileId, pointer.entries[0]!.fileId, 'stable FileId retained');
    assertEqual(
      capability.publishedManifest?.entries[0]?.revisionId,
      pointer.entries[0]!.revisionId,
      'exact source revision retained',
    );
  } finally { reopened.close(); }
});

defineCase('stagePublication rejects a source revision whose head moved after preflight', async () => {
  const { storage } = await openStorage();
  try {
    const workspaceId = 'ws-head-race';
    const rootKey = await storage.createWorkspaceKey(workspaceId);
    const source = await seedPublishedEntry(storage, workspaceId, 'race.md', 'old bytes');
    await storage.shares.bindShare(rootKey, {
      workspaceId, capId: 'cap-head-race', roomId: 'room-head-race', scopeKind: 'workspace',
      relayUrl: 'https://relay.example', capability: sampleCapability(),
    });
    const fence = await acquireFence(storage, workspaceId);
    await storage.workspaces.commitRevision({
      workspaceId,
      path: 'race.md',
      body: new TextEncoder().encode('new autosave bytes'),
      expectedHeadRevisionId: source.revisionId,
      fence,
    });
    let failed = false;
    try {
      await storage.shares.stagePublication(rootKey, workspaceId, 'cap-head-race', {
        manifestSnapshotId: base64UrlEncode(new Uint8Array(16).fill(81)),
        entries: [{
          path: 'race.md',
          fileId: base64UrlEncode(new Uint8Array(16).fill(82)),
          snapshotId: base64UrlEncode(new Uint8Array(16).fill(83)),
          contentHash: source.contentHash,
          revisionId: source.revisionId,
        }],
      }, [publicationEnvelope('room-head-race', 84)], fence);
    } catch (error) {
      failed = error instanceof StorageConflictError;
    }
    assert(failed, 'moved head was staged under an old revision pointer');
    assertEqual(
      (await storage.listOutbox('room-head-race', 'device-owner')).length,
      0,
      'head race staged no envelope',
    );
  } finally {
    storage.close();
  }
});

defineCase('promotion rejects a same-holder head advance after stage and ACK', async () => {
  const { storage } = await openStorage();
  try {
    const workspaceId = 'ws-promotion-head-race';
    const capId = 'cap-promotion-head-race';
    const roomId = 'room-promotion-head-race';
    const path = 'race.md';
    const rootKey = await storage.createWorkspaceKey(workspaceId);
    const source = await seedPublishedEntry(storage, workspaceId, path, 'staged bytes');
    await storage.shares.bindShare(rootKey, {
      workspaceId,
      capId,
      roomId,
      scopeKind: 'workspace',
      relayUrl: 'https://relay.example',
      capability: sampleCapability(),
    });
    const id = (length: number, fill: number) =>
      base64UrlEncode(new Uint8Array(length).fill(fill));
    const pointer = {
      manifestSnapshotId: id(16, 85),
      entries: [{
        path,
        fileId: id(16, 86),
        snapshotId: id(16, 87),
        contentHash: source.contentHash,
        revisionId: source.revisionId,
      }],
    };
    const envelopes = [publicationEnvelope(roomId, 88), publicationEnvelope(roomId, 89)];
    const fence = await acquireFence(storage, workspaceId);
    await storage.shares.stagePublication(
      rootKey,
      workspaceId,
      capId,
      pointer,
      envelopes,
      fence,
    );
    await storage.workspaces.commitRevision({
      workspaceId,
      path,
      body: new TextEncoder().encode('same-holder autosave after stage'),
      expectedHeadRevisionId: source.revisionId,
      fence,
    });
    await storage.acknowledge(
      roomId,
      envelopes,
      envelopes.map((envelope, index) => ({
        envelopeId: envelope.envelopeId,
        serverSeq: index + 90,
      })),
    );

    let conflicted = false;
    try {
      await storage.shares.commitPublication(rootKey, workspaceId, capId, fence);
    } catch (error) {
      conflicted = error instanceof StorageConflictError;
    }
    assert(conflicted, 'stale staged revision was promoted after the live head advanced');
    assertEqual(
      (await storage.shares.listShares(workspaceId))[0]?.publication,
      'pending',
      'failed promotion leaves the sealed journal pending',
    );
    const capability = await storage.shares.openShare(rootKey, workspaceId, capId);
    assertEqual(
      capability.publishedManifest,
      undefined,
      'failed promotion did not expose the stale pointer as published',
    );
    assertEqual(
      capability.pendingPublication?.publishedManifest.manifestSnapshotId,
      pointer.manifestSnapshotId,
      'failed promotion retained the exact pending journal',
    );
  } finally {
    storage.close();
  }
});

defineCase('stop racing a staged commit wins by generation and ACK cannot resurrect it', async () => {
  const { storage } = await openStorage();
  try {
    const rootKey = await storage.createWorkspaceKey('ws-stop');
    const source = await seedPublishedEntry(storage, 'ws-stop', 'a.md');
    await storage.shares.bindShare(rootKey, {
      workspaceId: 'ws-stop', capId: 'cap-stop', roomId: 'room-stop', scopeKind: 'workspace',
      relayUrl: 'https://relay.example', capability: sampleCapability(),
    });
    const id = (length: number, fill: number) => base64UrlEncode(new Uint8Array(length).fill(fill));
    const pointer = {
      manifestSnapshotId: id(16, 21),
      entries: [{
        path: 'a.md', fileId: id(16, 22), snapshotId: id(16, 23),
        contentHash: source.contentHash, revisionId: source.revisionId,
      }],
    };
    const envelopes = [publicationEnvelope('room-stop', 25), publicationEnvelope('room-stop', 26)];
    const fence = await acquireFence(storage, 'ws-stop');
    await storage.shares.stagePublication(rootKey, 'ws-stop', 'cap-stop', pointer, envelopes, fence);
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
      await storage.shares.commitPublication(rootKey, 'ws-stop', 'cap-stop', fence);
    } catch (error) {
      conflicted = error instanceof StorageConflictError;
    }
    assert(conflicted, 'stale commit conflicts after stop');
  } finally { storage.close(); }
});

defineCase('lease loss fences pending recovery and promotion while takeover can resume', async () => {
  let clock = 1_700_000_000_000;
  const { storage } = await openStorage(() => clock);
  try {
    const workspaceId = 'ws-fenced-publish';
    const rootKey = await storage.createWorkspaceKey(workspaceId);
    const source = await seedPublishedEntry(storage, workspaceId, 'fenced.md');
    await storage.shares.bindShare(rootKey, {
      workspaceId,
      capId: 'cap-fenced',
      roomId: 'room-fenced',
      scopeKind: 'workspace',
      relayUrl: 'https://relay.example',
      capability: sampleCapability(),
    });
    const ids = (length: number, fill: number) =>
      base64UrlEncode(new Uint8Array(length).fill(fill));
    const pointer = {
      manifestSnapshotId: ids(16, 61),
      entries: [{
        path: 'fenced.md',
        fileId: ids(16, 62),
        snapshotId: ids(16, 63),
        contentHash: source.contentHash,
        revisionId: source.revisionId,
      }],
    };
    const envelopes = [
      publicationEnvelope('room-fenced', 66),
      publicationEnvelope('room-fenced', 67),
    ];
    const leases = storage.leases({ channel: null, leaseDurationMs: 5, now: () => clock });
    const first = await leases.acquire(workspaceId, 'tab-first');
    assert(first, 'first publisher lease acquired');
    await storage.shares.stagePublication(
      rootKey,
      workspaceId,
      'cap-fenced',
      pointer,
      envelopes,
      first,
    );
    await storage.acknowledge(
      'room-fenced',
      envelopes,
      envelopes.map((envelope, index) => ({
        envelopeId: envelope.envelopeId,
        serverSeq: index + 70,
      })),
    );
    clock += 6;
    await expectStorageError(
      storage.shares.commitPublication(rootKey, workspaceId, 'cap-fenced', first),
      'expired holder cannot promote acknowledged publication',
    );
    assert(await leases.release(first), 'first publisher released');
    const takeover = await leases.acquire(workspaceId, 'tab-takeover');
    assert(takeover, 'takeover publisher lease acquired');
    await expectStorageError(
      storage.shares.loadPendingPublication(rootKey, workspaceId, 'cap-fenced', first),
      'stale holder cannot recover pending ciphertext',
    );
    await expectStorageError(
      storage.shares.commitPublication(rootKey, workspaceId, 'cap-fenced', first),
      'stale holder cannot promote acknowledged publication',
    );
    const committed = await storage.shares.commitPublication(
      rootKey,
      workspaceId,
      'cap-fenced',
      takeover,
    );
    assertEqual(committed.publication, 'published', 'takeover promotes exact acknowledged batch');
    leases.close();
  } finally {
    storage.close();
  }
});

defineCase('late envelope conflict rolls back both publication journal and entire batch', async () => {
  const { storage } = await openStorage();
  try {
    const rootKey = await storage.createWorkspaceKey('ws-atomic');
    const source = await seedPublishedEntry(storage, 'ws-atomic', 'a.md');
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
    const fence = await acquireFence(storage, 'ws-atomic');
    let failed = false;
    try {
      await storage.shares.stagePublication(rootKey, 'ws-atomic', 'cap-atomic', {
        manifestSnapshotId: id(16, 53),
        entries: [{
          path: 'a.md', fileId: id(16, 54), snapshotId: id(16, 55),
          contentHash: source.contentHash, revisionId: source.revisionId,
        }],
      }, [first, conflicting], fence);
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

defineCase('reloaded outbox requires fenced promotion after the last ACK', async () => {
  const { storage, reopen } = await openStorage();
  const rootKey = await storage.createWorkspaceKey('ws-auto');
  const source = await seedPublishedEntry(storage, 'ws-auto', 'auto.md');
  await storage.shares.bindShare(rootKey, {
    workspaceId: 'ws-auto', capId: 'cap-auto', roomId: 'room-auto', scopeKind: 'workspace',
    relayUrl: 'https://relay.example', capability: sampleCapability(),
  });
  const id = (length: number, fill: number) => base64UrlEncode(new Uint8Array(length).fill(fill));
  const pointer = {
    manifestSnapshotId: id(16, 41),
    entries: [{
      path: 'auto.md', fileId: id(16, 42), snapshotId: id(16, 43),
      contentHash: source.contentHash, revisionId: source.revisionId,
    }],
  };
  const envelopes = [publicationEnvelope('room-auto', 45), publicationEnvelope('room-auto', 46)];
  const fence = await acquireFence(storage, 'ws-auto');
  await storage.shares.stagePublication(rootKey, 'ws-auto', 'cap-auto', pointer, envelopes, fence);
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
      'pending',
      'ACK transaction leaves fenced share pending',
    );
    const key = await resumedStorage.getWorkspaceRootKey('ws-auto');
    assert(key, 'workspace key survives reload');
    await resumedStorage.shares.commitPublication(key, 'ws-auto', 'cap-auto', fence);
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
