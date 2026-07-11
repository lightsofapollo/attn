import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { BrowserStorage, BrowserStorageError, StorageConflictError } from './browser-storage';
import { inviteCapabilityFrom } from './browser-workspace-share';
import { generateBrowserIdentity } from './browser-session';

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
    const published = await storage.shares.setPublication('ws-1', 'cap-1', 'published');
    assertEqual(published.publication, 'published', 'published');
    assertEqual((await storage.shares.listShares('ws-1')).length, 1, 'listed');
    const stopped = await storage.shares.setPublication('ws-1', 'cap-1', 'stopped');
    assertEqual(stopped.publication, 'stopped', 'stopped');
    assert(await storage.shares.forgetShare('ws-1', 'cap-1'), 'forgotten');
    assertEqual((await storage.shares.listShares('ws-1')).length, 0, 'gone');
    await expectStorageError(
      storage.shares.setPublication('ws-1', 'cap-1', 'published'),
      'missing share update errors',
    );
  } finally {
    storage.close();
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
