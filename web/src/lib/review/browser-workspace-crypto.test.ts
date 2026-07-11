import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { BrowserStorage, BrowserStorageError, StorageConflictError } from './browser-storage';
import {
  INFO_WORKSPACE_CAPABILITY,
  INFO_WORKSPACE_RECOVERY,
  INFO_WORKSPACE_REVISION,
  deriveWorkspaceSubkey,
  generateWorkspaceRootKey,
  openCapability,
  openRecovery,
  openRevisionBody,
  sealCapability,
  sealRecovery,
  sealRevisionBody,
  validateWorkspaceRootKey,
  type RevisionAad,
} from './browser-workspace-crypto';

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

async function assertRejectsStorage(promise: Promise<unknown>, message: string): Promise<void> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof BrowserStorageError) return;
    throw new Error(`${message}: threw a non-storage error: ${String(error)}`);
  }
  throw new Error(`${message}: expected a BrowserStorageError`);
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

let databaseCounter = 0;

async function openStorage(): Promise<{ storage: BrowserStorage; reopen: () => Promise<BrowserStorage> }> {
  databaseCounter += 1;
  const factory = new IDBFactory();
  const name = `attn-workspace-crypto-test-${databaseCounter}`;
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

const REVISION_META: RevisionAad = {
  workspaceId: 'ws-1',
  revisionId: 'rev-1',
  path: 'docs/notes.md',
  clock: 3,
  sizeBytes: 11,
  bodyHash: 'aGFzaA',
};

// Known-answer vectors: fixed IKM 0x01..0x20, empty salt, HKDF-SHA256.
// These pin the derivation domain separation — a silent change here would
// orphan every sealed record in the field.
const KAT_IKM = new Uint8Array(32).map((_, index) => index + 1);
const KAT = [
  [INFO_WORKSPACE_REVISION, 'a2f921799c1104f5d15184d4fc00c2aaf6134e4dd021d205c68d2f32371f90e3'],
  [INFO_WORKSPACE_CAPABILITY, 'fb2c4b33bd0fcacafb982d111067c5a5017221281037541a680230e6af64ee44'],
  [INFO_WORKSPACE_RECOVERY, 'bc358f389904250c6b2e9c952cb67a97acdfa0523a42ae9be3259c86ead26223'],
] as const;

defineCase('derivation matches pinned known-answer vectors', async () => {
  const rootKey = await crypto.subtle.importKey('raw', KAT_IKM, 'HKDF', false, ['deriveBits']);
  for (const [info, expected] of KAT) {
    const subkey = await deriveWorkspaceSubkey(crypto, rootKey, info);
    assertEqual(hex(subkey), expected, `KAT ${new TextDecoder().decode(info)}`);
    subkey.fill(0);
  }
  // Zeroing a returned subkey must not poison later derivations (no caching).
  const again = await deriveWorkspaceSubkey(crypto, rootKey, INFO_WORKSPACE_REVISION);
  assertEqual(hex(again), KAT[0][1], 'derivation is stateless');
  again.fill(0);
});

defineCase('workspace root keys are non-extractable and unexportable', async () => {
  const rootKey = await generateWorkspaceRootKey(crypto);
  validateWorkspaceRootKey(rootKey);
  assertEqual(rootKey.extractable, false, 'extractable flag');
  let exported = false;
  try {
    await crypto.subtle.exportKey('raw', rootKey);
    exported = true;
  } catch {
    // expected
  }
  assert(!exported, 'raw export must fail');
});

defineCase('create/get/delete workspace key lifecycle with conflicts', async () => {
  const { storage } = await openStorage();
  try {
    const created = await storage.createWorkspaceKey('ws-1');
    validateWorkspaceRootKey(created);
    let conflicted = false;
    try {
      await storage.createWorkspaceKey('ws-1');
    } catch (error) {
      conflicted = error instanceof StorageConflictError;
    }
    assert(conflicted, 'second create must conflict');
    const loaded = await storage.getWorkspaceRootKey('ws-1');
    assert(loaded, 'root key loads');
    assertEqual(loaded.extractable, false, 'stored key stays non-extractable');
    assert(await storage.deleteWorkspaceKey('ws-1'), 'delete reports existing key');
    assert(!(await storage.deleteWorkspaceKey('ws-1')), 'second delete is a no-op');
    assertEqual(await storage.getWorkspaceRootKey('ws-1'), null, 'key gone after delete');
  } finally {
    storage.close();
  }
});

defineCase('sealed revision bodies round-trip across a reload', async () => {
  const { storage, reopen } = await openStorage();
  const plaintext = new TextEncoder().encode('hello desk!');
  const rootKey = await storage.createWorkspaceKey('ws-1');
  const sealed = await sealRevisionBody(crypto, rootKey, REVISION_META, plaintext);
  assert(sealed.ciphertext.length === plaintext.length + 16, 'ciphertext carries a tag');
  storage.close();

  const reopened = await reopen();
  try {
    const restored = await reopened.getWorkspaceRootKey('ws-1');
    assert(restored, 'root key survives reload');
    const opened = await openRevisionBody(crypto, restored, REVISION_META, sealed);
    assertEqual(new TextDecoder().decode(opened), 'hello desk!', 'plaintext round-trips');
    opened.fill(0);
  } finally {
    reopened.close();
  }
});

defineCase('every sealing nonce is fresh', async () => {
  const rootKey = await generateWorkspaceRootKey(crypto);
  const plaintext = new TextEncoder().encode('same body');
  const first = await sealRevisionBody(crypto, rootKey, REVISION_META, plaintext);
  const second = await sealRevisionBody(crypto, rootKey, REVISION_META, plaintext);
  assert(first.nonce !== second.nonce, 'nonces must differ');
  assert(hex(first.ciphertext) !== hex(second.ciphertext), 'ciphertexts must differ');
});

defineCase('revision AAD binds routing metadata: any swap fails closed', async () => {
  const rootKey = await generateWorkspaceRootKey(crypto);
  const plaintext = new TextEncoder().encode('hello desk!');
  const sealed = await sealRevisionBody(crypto, rootKey, REVISION_META, plaintext);
  const tampered: Array<[string, RevisionAad]> = [
    ['workspaceId', { ...REVISION_META, workspaceId: 'ws-2' }],
    ['revisionId', { ...REVISION_META, revisionId: 'rev-2' }],
    ['path', { ...REVISION_META, path: 'docs/other.md' }],
    ['clock', { ...REVISION_META, clock: 4 }],
    ['sizeBytes', { ...REVISION_META, sizeBytes: 12 }],
    ['bodyHash', { ...REVISION_META, bodyHash: 'b3RoZXI' }],
  ];
  for (const [label, meta] of tampered) {
    await assertRejectsStorage(
      openRevisionBody(crypto, rootKey, meta, sealed),
      `tampered ${label} must fail`,
    );
  }
  // Bit-flipped ciphertext and truncated tag also fail closed.
  const flipped = new Uint8Array(sealed.ciphertext);
  flipped[0] ^= 1;
  await assertRejectsStorage(
    openRevisionBody(crypto, rootKey, REVISION_META, { ...sealed, ciphertext: flipped }),
    'flipped ciphertext must fail',
  );
  await assertRejectsStorage(
    openRevisionBody(crypto, rootKey, REVISION_META, {
      ...sealed,
      ciphertext: sealed.ciphertext.slice(0, 15),
    }),
    'truncated ciphertext must fail',
  );
  await assertRejectsStorage(
    openRevisionBody(crypto, rootKey, REVISION_META, { ...sealed, nonce: 'AAAA' }),
    'bad nonce must fail',
  );
  // The untampered record still opens — failures above were authentication.
  const opened = await openRevisionBody(crypto, rootKey, REVISION_META, sealed);
  assertEqual(new TextDecoder().decode(opened), 'hello desk!', 'original still opens');
  opened.fill(0);
});

defineCase('wrapped capabilities round-trip and bind their room routing', async () => {
  const rootKey = await generateWorkspaceRootKey(crypto);
  const meta = {
    workspaceId: 'ws-1',
    capId: 'cap-1',
    roomId: 'room-1',
    scopeKind: 'workspace',
  } as const;
  const secret = new TextEncoder().encode('{"roomSecret":"s3cr3t","ttl":86400}');
  const sealed = await sealCapability(crypto, rootKey, meta, secret);
  const opened = await openCapability(crypto, rootKey, meta, sealed);
  assertEqual(new TextDecoder().decode(opened), new TextDecoder().decode(secret), 'cap round-trip');
  opened.fill(0);
  await assertRejectsStorage(
    openCapability(crypto, rootKey, { ...meta, roomId: 'room-2' }, sealed),
    'capability bound to another room must fail',
  );
  await assertRejectsStorage(
    openCapability(crypto, rootKey, { ...meta, scopeKind: 'file' }, sealed),
    'capability scope swap must fail',
  );
  await assertRejectsStorage(
    openCapability(crypto, rootKey, meta, { ...sealed, ciphertext: 'not!base64url' }),
    'malformed ciphertext must fail',
  );
});

defineCase('recovery records round-trip and bind their workspace', async () => {
  const rootKey = await generateWorkspaceRootKey(crypto);
  const meta = { workspaceId: 'ws-1', recoveryId: 'rec-1' } as const;
  const payload = new TextEncoder().encode('{"rooms":["room-1"]}');
  const sealed = await sealRecovery(crypto, rootKey, meta, payload);
  const opened = await openRecovery(crypto, rootKey, meta, sealed);
  assertEqual(new TextDecoder().decode(opened), '{"rooms":["room-1"]}', 'recovery round-trip');
  opened.fill(0);
  await assertRejectsStorage(
    openRecovery(crypto, rootKey, { ...meta, workspaceId: 'ws-2' }, sealed),
    'recovery bound to another workspace must fail',
  );
});

defineCase('crypto-erasure: deleting the root key orphans sealed bytes', async () => {
  const { storage } = await openStorage();
  try {
    const rootKey = await storage.createWorkspaceKey('ws-1');
    const sealed = await sealRevisionBody(
      crypto,
      rootKey,
      REVISION_META,
      new TextEncoder().encode('to be erased'),
    );
    assert(await storage.deleteWorkspaceKey('ws-1'), 'key deleted');
    assertEqual(await storage.getWorkspaceRootKey('ws-1'), null, 'no key remains');
    // A fresh key for the same workspace id cannot open the old bytes.
    const newKey = await storage.createWorkspaceKey('ws-1');
    await assertRejectsStorage(
      openRevisionBody(crypto, newKey, REVISION_META, sealed),
      'old sealed bytes are permanently opaque',
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
  console.log(`browser-workspace-crypto: ${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) process.exit(1);
}

void runAllCases();
