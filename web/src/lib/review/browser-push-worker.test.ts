import { indexedDB as fakeIndexedDB } from 'fake-indexeddb';
import { ed25519 } from '@noble/curves/ed25519.js';
import { assembleBrowserEvent } from './browser-envelope';
import {
  INFO_EVENT_V3,
  base64UrlEncode,
  signingKeyId,
} from './browser-crypto';
import {
  buildRegisterDeviceBody,
  buildRegisterDeviceBodyV3,
  canonicalDeviceGrantV3,
  generateBrowserIdentity,
} from './browser-session';
import {
  MAX_ENVELOPES_PER_PULL,
  PUSH_BINDING_STORE,
  PUSH_DB_NAME,
  PUSH_DB_VERSION,
  PUSH_PENDING_STORE,
  consumePendingPushEvents,
  forgetPushBinding,
  hasPushBinding,
  pullRememberedPushBindings,
  rememberPushBinding,
} from './browser-push-worker';
import type { Device, WebSocketLike } from './browser-ws';

interface Case { name: string; run: () => void | Promise<void> }
const cases: Case[] = [];
function test(name: string, run: Case['run']): void { cases.push({ name, run }); }
function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }

const SHARE_ID = 'share-push-worker';
const ROOM_ID = 'room-push-worker';
const BUNDLE_ID = 'abcdefghijklmnopqrstuv';
const DEVICE_ID = 'browser-owner';

async function resetDb(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = fakeIndexedDB.deleteDatabase(PUSH_DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

async function deriveEventKey(root: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', root.buffer.slice(root.byteOffset, root.byteOffset + root.byteLength) as ArrayBuffer, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new ArrayBuffer(0), info: INFO_EVENT_V3 }, key, 256,
  ));
}

async function installBinding(root: Uint8Array, read: Uint8Array, devices: Device[]): Promise<void> {
  const owner = devices.find(device => device.kind === 'owner');
  assert(owner, 'test binding requires owner');
  await rememberPushBinding({
    bindingId: 'binding-share',
    kind: 'share',
    resourceId: SHARE_ID,
    roomId: ROOM_ID,
    deviceId: DEVICE_ID,
    relayUrl: 'https://relay.example',
    protocolVersion: 3,
    roomReadCapabilityBytes: root,
    readAdmissionKeyBytes: read,
    bundleId: BUNDLE_ID,
    epoch: 4,
    fileName: 'plan.md',
    deepLinkPath: `/s/${SHARE_ID}`,
    ownerSigningKey: owner.publicSigningKey,
    devices,
  }, { indexedDB: fakeIndexedDB });
}

async function storedBinding(): Promise<Record<string, unknown>> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = fakeIndexedDB.open(PUSH_DB_NAME, PUSH_DB_VERSION);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    const tx = db.transaction(PUSH_BINDING_STORE, 'readonly');
    return await new Promise<Record<string, unknown>>((resolve, reject) => {
      const request = tx.objectStore(PUSH_BINDING_STORE).get('binding-share');
      request.onsuccess = () => resolve(request.result as Record<string, unknown>);
      request.onerror = () => reject(request.error);
    });
  } finally { db.close(); }
}

async function storedPending(): Promise<Record<string, unknown>[]> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = fakeIndexedDB.open(PUSH_DB_NAME, PUSH_DB_VERSION);
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  try {
    const tx = db.transaction(PUSH_PENDING_STORE, 'readonly');
    return await new Promise<Record<string, unknown>[]>((resolve, reject) => {
      const request = tx.objectStore(PUSH_PENDING_STORE).getAll();
      request.onsuccess = () => resolve(request.result as Record<string, unknown>[]);
      request.onerror = () => reject(request.error);
    });
  } finally { db.close(); }
}

async function mutatePushDb(run: (bindings: IDBObjectStore, pending: IDBObjectStore) => Promise<void>): Promise<void> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = fakeIndexedDB.open(PUSH_DB_NAME, PUSH_DB_VERSION);
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  try {
    const tx = db.transaction([PUSH_BINDING_STORE, PUSH_PENDING_STORE], 'readwrite');
    await run(tx.objectStore(PUSH_BINDING_STORE), tx.objectStore(PUSH_PENDING_STORE));
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); tx.onerror = () => undefined;
    });
  } finally { db.close(); }
}

function idbValue<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
}

function mailPage(device: Device, envelope: unknown, seq = 1): unknown {
  return { items: [{
    seq,
    envelopeId: `mail-${seq}`,
    bytes: 400,
    bundleId: BUNDLE_ID,
    tier: 'comment',
    epoch: 4,
    payload: {
      v: 3,
      envelopeId: `outer-${seq}`,
      type: 'review_submission',
      shareId: SHARE_ID,
      epoch: 4,
      roomId: ROOM_ID,
      tier: 'comment',
      deviceRegistration: device,
      envelopes: [envelope],
    },
  }], nextAfter: seq };
}

test('remembered capability is non-extractable and source bytes are zeroized', async () => {
  await resetDb();
  const identity = generateBrowserIdentity();
  const device = buildRegisterDeviceBody(identity, 'owner') as Device;
  const root = new Uint8Array(32).fill(7);
  const read = new Uint8Array(32).fill(8);
  await installBinding(root, read, [device]);
  assert(root.every(byte => byte === 0), 'room root input was not zeroized');
  assert(read.every(byte => byte === 0), 'admission input was not zeroized');
  const stored = await storedBinding();
  const rootKey = stored.roomReadCapability as CryptoKey;
  const admission = stored.readAdmissionKey as CryptoKey;
  assert(rootKey.extractable === false && rootKey.algorithm.name === 'HKDF', 'stored root is extractable');
  assert(admission.extractable === false && admission.algorithm.name === 'HMAC', 'stored admission is extractable');
  assert(!JSON.stringify(stored).includes(base64UrlEncode(new Uint8Array(32).fill(7))), 'raw root leaked to record');
  identity.signingSecret.fill(0); identity.encryptionSecret.fill(0);
});

test('content is decrypted and verified locally, counted, and cursor advances', async () => {
  await resetDb();
  const rootForEnvelope = new Uint8Array(32).fill(11);
  const rootForStore = new Uint8Array(rootForEnvelope);
  const identity = generateBrowserIdentity();
  const device = buildRegisterDeviceBody(identity, 'owner') as Device;
  await installBinding(rootForStore, new Uint8Array(32).fill(12), [device]);
  const eventKey = await deriveEventKey(rootForEnvelope);
  const event = assembleBrowserEvent({
    eventKey,
    signingSecret: identity.signingSecret,
    signingPublic: identity.signingPublic,
    roomId: ROOM_ID,
    authorId: identity.participantId,
    deviceId: identity.deviceId,
    createdAt: 100,
    expiresAt: Date.now() + 60_000,
    nonce: new Uint8Array(24).fill(3),
    body: { type: 'comment_created', threadId: 'thread-1', anchor: {
      v: 2, fileId: 'file-1', snapshotId: 'snapshot-1', baseHash: 'hash-1',
      position: { byteRange: [0, 1], lineRange: [1, 1] },
    }, body: 'plaintext that must never reach fetch' },
  });
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    requests.push({ url: String(input), init });
    return Response.json(mailPage(device, event.envelope));
  };
  const summaries = await pullRememberedPushBindings({ indexedDB: fakeIndexedDB, fetch: fetchImpl as typeof fetch });
  assert(summaries.length === 1 && summaries[0]?.comments === 1, 'verified comment was not counted');
  assert(summaries[0]?.deepLinkPath === `/s/${SHARE_ID}`, 'deep link changed');
  assert(requests.length === 1 && requests[0]!.url.includes(`after=0&limit=${MAX_ENVELOPES_PER_PULL}`), 'pull is not bounded from cursor');
  const requestText = JSON.stringify(requests);
  assert(!requestText.includes('plaintext that must never reach fetch'), 'plaintext reached the network request');
  assert(!requestText.includes(base64UrlEncode(rootForEnvelope)), 'root capability reached the network request');
  const stored = await storedBinding();
  assert(stored.cursor === 1, 'durable cursor did not advance');
  const pending = await storedPending();
  assert(pending.length === 1, 'verified ciphertext was not handed off durably');
  const storageText = JSON.stringify(pending);
  assert(!storageText.includes('plaintext that must never reach fetch'), 'plaintext was persisted in IndexedDB');
  const replayed: Array<Record<string, unknown>> = [];
  await consumePendingPushEvents('binding-share', event => { replayed.push(event as unknown as Record<string, unknown>); },
    { indexedDB: fakeIndexedDB });
  assert(replayed.length === 1 && (replayed[0]!.body as Record<string, unknown>).type === 'comment_created',
    'fragmentless replay did not decrypt and verify the pending comment');
  assert((await storedPending()).length === 0, 'pending ciphertext was not ACK-deleted after apply');
  eventKey.fill(0); rootForEnvelope.fill(0);
  identity.signingSecret.fill(0); identity.encryptionSecret.fill(0);
});

test('forget crypto-erases the capability and pending ciphertext together', async () => {
  await resetDb();
  const root = new Uint8Array(32).fill(41); const eventKey = await deriveEventKey(root);
  const identity = generateBrowserIdentity(); const device = buildRegisterDeviceBody(identity, 'owner') as Device;
  await installBinding(new Uint8Array(root), new Uint8Array(32).fill(42), [device]);
  const event = assembleBrowserEvent({ eventKey, signingSecret: identity.signingSecret,
    signingPublic: identity.signingPublic, roomId: ROOM_ID, authorId: identity.participantId,
    deviceId: identity.deviceId, createdAt: 401, expiresAt: Date.now() + 60_000,
    nonce: new Uint8Array(24).fill(12), body: { type: 'comment_created', threadId: 'forget-me',
      anchor: { v: 2, fileId: 'file-1', snapshotId: 'snapshot-1', baseHash: 'hash-1',
        position: { byteRange: [0, 1], lineRange: [1, 1] } }, body: 'FORGET-STORAGE-CANARY' } });
  await pullRememberedPushBindings({ indexedDB: fakeIndexedDB,
    fetch: (async () => Response.json(mailPage(device, event.envelope))) as typeof fetch });
  assert((await storedPending()).length === 1, 'test did not create pending ciphertext');
  await forgetPushBinding('binding-share', fakeIndexedDB);
  assert((await storedPending()).length === 0, 'forget retained pending ciphertext');
  assert(!await hasPushBinding('binding-share', fakeIndexedDB), 'forget retained capability binding');
  eventKey.fill(0); root.fill(0); identity.signingSecret.fill(0); identity.encryptionSecret.fill(0);
});

test('rotation during a wake cannot relabel ciphertext or advance the replacement cursor', async () => {
  await resetDb();
  const root = new Uint8Array(32).fill(43); const eventKey = await deriveEventKey(root);
  const identity = generateBrowserIdentity(); const device = buildRegisterDeviceBody(identity, 'owner') as Device;
  await installBinding(new Uint8Array(root), new Uint8Array(32).fill(44), [device]);
  const event = assembleBrowserEvent({ eventKey, signingSecret: identity.signingSecret,
    signingPublic: identity.signingPublic, roomId: ROOM_ID, authorId: identity.participantId,
    deviceId: identity.deviceId, createdAt: 501, expiresAt: Date.now() + 60_000,
    nonce: new Uint8Array(24).fill(13), body: { type: 'comment_created', threadId: 'rotation-race',
      anchor: { v: 2, fileId: 'file-1', snapshotId: 'snapshot-1', baseHash: 'hash-1',
        position: { byteRange: [0, 1], lineRange: [1, 1] } }, body: 'ROTATION-RACE-CANARY' } });
  const summaries = await pullRememberedPushBindings({ indexedDB: fakeIndexedDB,
    fetch: (async () => {
      await mutatePushDb(async bindings => {
        const current = await idbValue<Record<string, unknown>>(bindings.get('binding-share'));
        bindings.put({ ...current, generation: 'U'.repeat(22), cursor: 0 });
      });
      return Response.json(mailPage(device, event.envelope));
    }) as typeof fetch });
  const current = await storedBinding();
  assert(summaries.length === 0 && current.generation === 'U'.repeat(22) && current.epoch === 4
    && current.roomId === ROOM_ID && current.cursor === 0,
    'old wake advanced or relabeled the replacement binding');
  assert((await storedPending()).length === 0, 'old ciphertext was stored under the replacement generation');
  eventKey.fill(0); root.fill(0); identity.signingSecret.fill(0); identity.encryptionSecret.fill(0);
});

test('an old room socket cannot advance a reinstalled binding generation', async () => {
  await resetDb();
  const root = new Uint8Array(32).fill(49); const eventKey = await deriveEventKey(root);
  const identity = generateBrowserIdentity(); const device = buildRegisterDeviceBody(identity, 'owner') as Device;
  await rememberPushBinding({ bindingId: 'binding-room', kind: 'room', resourceId: ROOM_ID, roomId: ROOM_ID,
    deviceId: DEVICE_ID, relayUrl: 'https://relay.example', protocolVersion: 3,
    roomReadCapabilityBytes: new Uint8Array(root), readAdmissionKeyBytes: new Uint8Array(32).fill(50),
    writeAdmissionKeyBytes: new Uint8Array(32).fill(51), fileName: 'room.md', deepLinkPath: `/review/${ROOM_ID}`,
    ownerSigningKey: device.publicSigningKey, devices: [device] }, { indexedDB: fakeIndexedDB });
  const event = assembleBrowserEvent({ eventKey, signingSecret: identity.signingSecret,
    signingPublic: identity.signingPublic, roomId: ROOM_ID, authorId: identity.participantId,
    deviceId: identity.deviceId, createdAt: 801, expiresAt: Date.now() + 60_000,
    nonce: new Uint8Array(24).fill(16), body: { type: 'comment_created', threadId: 'room-generation-race',
      anchor: { v: 2, fileId: 'file-1', snapshotId: 'snapshot-1', baseHash: 'hash-1',
        position: { byteRange: [0, 1], lineRange: [1, 1] } }, body: 'ROOM-RACE-CANARY' } });
  let socket!: WebSocketLike; let sent = false;
  const webSocketFactory = (): WebSocketLike => {
    socket = { readyState: 1, onopen: null, onmessage: null, onclose: null, onerror: null,
      close: () => { socket.readyState = 3; }, send: data => {
        if (sent || !String(data).includes('subscribe')) return; sent = true;
        void (async () => {
          await mutatePushDb(async bindings => {
            const current = await idbValue<Record<string, unknown>>(bindings.get('binding-room'));
            bindings.put({ ...current, generation: 'V'.repeat(22), cursor: 0 });
          });
          socket.onmessage?.({ data: JSON.stringify({ type: 'hello', serverSeq: 1,
            policy: { mode: 'hybrid', maxPeers: 4, maxSnapshotBytes: 1_000_000, maxEventBytes: 8192,
              maxEvents: 100, expiresAt: Date.now() + 60_000, powBits: 16, deleteEventsAfterOwnerAck: false,
              allowBrowser: true, allowRemoteAgents: false }, devices: [device] }) });
          socket.onmessage?.({ data: JSON.stringify({ type: 'envelope', envelope: event.envelope, serverSeq: 1 }) });
          socket.onclose?.({ code: 1000, reason: 'done' });
        })();
      } };
    queueMicrotask(() => socket.onopen?.({})); return socket;
  };
  await pullRememberedPushBindings({ indexedDB: fakeIndexedDB, webSocketFactory });
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = fakeIndexedDB.open(PUSH_DB_NAME, PUSH_DB_VERSION);
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  const tx = db.transaction(PUSH_BINDING_STORE, 'readonly');
  const current = await idbValue<Record<string, unknown>>(tx.objectStore(PUSH_BINDING_STORE).get('binding-room')); db.close();
  assert(current.generation === 'V'.repeat(22) && current.cursor === 0,
    'old room socket advanced the reinstalled binding');
  eventKey.fill(0); root.fill(0); identity.signingSecret.fill(0); identity.encryptionSecret.fill(0);
});

test('pending handoff backpressures before cursor advance and never evicts unconsumed ciphertext', async () => {
  await resetDb();
  const root = new Uint8Array(32).fill(45); const eventKey = await deriveEventKey(root);
  const identity = generateBrowserIdentity(); const device = buildRegisterDeviceBody(identity, 'owner') as Device;
  await installBinding(new Uint8Array(root), new Uint8Array(32).fill(46), [device]);
  const event = assembleBrowserEvent({ eventKey, signingSecret: identity.signingSecret,
    signingPublic: identity.signingPublic, roomId: ROOM_ID, authorId: identity.participantId,
    deviceId: identity.deviceId, createdAt: 601, expiresAt: Date.now() + 60_000,
    nonce: new Uint8Array(24).fill(14), body: { type: 'comment_created', threadId: 'capacity',
      anchor: { v: 2, fileId: 'file-1', snapshotId: 'snapshot-1', baseHash: 'hash-1',
        position: { byteRange: [0, 1], lineRange: [1, 1] } }, body: 'CAPACITY-CANARY' } });
  const pages = Array.from({ length: 64 }, (_, index) => {
    const page = mailPage(device, event.envelope, index + 1) as { items: Record<string, unknown>[] };
    return page.items[0]!;
  });
  let wake = 0;
  const fetchImpl = (async () => {
    wake += 1;
    if (wake === 1) return Response.json({ items: pages, nextAfter: 64 });
    return Response.json(mailPage(device, event.envelope, 65));
  }) as typeof fetch;
  await pullRememberedPushBindings({ indexedDB: fakeIndexedDB, fetch: fetchImpl });
  assert((await storedBinding()).cursor === 64 && (await storedPending()).length === 64,
    'first bounded wake did not durably hand off all 64 items');
  await pullRememberedPushBindings({ indexedDB: fakeIndexedDB, fetch: fetchImpl });
  assert((await storedBinding()).cursor === 64 && (await storedPending()).length === 64,
    'capacity pressure advanced the cursor or evicted unconsumed ciphertext');
  eventKey.fill(0); root.fill(0); identity.signingSecret.fill(0); identity.encryptionSecret.fill(0);
});

test('an old consumer cannot delete a new-generation record at the same sequence', async () => {
  await resetDb();
  const root = new Uint8Array(32).fill(47); const eventKey = await deriveEventKey(root);
  const identity = generateBrowserIdentity(); const device = buildRegisterDeviceBody(identity, 'owner') as Device;
  await installBinding(new Uint8Array(root), new Uint8Array(32).fill(48), [device]);
  const event = assembleBrowserEvent({ eventKey, signingSecret: identity.signingSecret,
    signingPublic: identity.signingPublic, roomId: ROOM_ID, authorId: identity.participantId,
    deviceId: identity.deviceId, createdAt: 701, expiresAt: Date.now() + 60_000,
    nonce: new Uint8Array(24).fill(15), body: { type: 'comment_created', threadId: 'delete-cas',
      anchor: { v: 2, fileId: 'file-1', snapshotId: 'snapshot-1', baseHash: 'hash-1',
        position: { byteRange: [0, 1], lineRange: [1, 1] } }, body: 'DELETE-CAS-CANARY' } });
  await pullRememberedPushBindings({ indexedDB: fakeIndexedDB,
    fetch: (async () => Response.json(mailPage(device, event.envelope))) as typeof fetch });
  const oldPending = (await storedPending())[0]!;
  let rotated = false;
  await consumePendingPushEvents('binding-share', async () => {
    await mutatePushDb(async (bindings, pending) => {
      const current = await idbValue<Record<string, unknown>>(bindings.get('binding-share'));
      const generation = 'T'.repeat(22);
      bindings.put({ ...current, generation, epoch: 5, revision: 0, manifestDigest: 'S'.repeat(43), roomId: 'room-new', cursor: 1 });
      const next = { ...oldPending, key: `binding-share:${generation}:0000000000000001:${'N'.repeat(43)}`,
        generation, contentHash: 'N'.repeat(43), epoch: 5, roomId: 'room-new' };
      pending.add(next); rotated = true;
    });
  }, { indexedDB: fakeIndexedDB });
  const remaining = await storedPending();
  assert(rotated && remaining.length === 1 && remaining[0]?.generation === 'T'.repeat(22),
    'old consumer deleted the new same-sequence generation');
  eventKey.fill(0); root.fill(0); identity.signingSecret.fill(0); identity.encryptionSecret.fill(0);
});

test('forged ciphertext is not notified but is cursor-bounded against replay DoS', async () => {
  await resetDb();
  const wrongKey = new Uint8Array(32).fill(23);
  const identity = generateBrowserIdentity();
  const device = buildRegisterDeviceBody(identity, 'owner') as Device;
  await installBinding(new Uint8Array(32).fill(21), new Uint8Array(32).fill(22), [device]);
  const forged = assembleBrowserEvent({
    eventKey: wrongKey,
    signingSecret: identity.signingSecret,
    signingPublic: identity.signingPublic,
    roomId: ROOM_ID,
    authorId: identity.participantId,
    deviceId: identity.deviceId,
    createdAt: 101,
    expiresAt: Date.now() + 60_000,
    nonce: new Uint8Array(24).fill(4),
    body: { type: 'suggestion_created', suggestionId: 's1', anchor: {
      v: 2, fileId: 'file-1', snapshotId: 'snapshot-1', baseHash: 'hash-1',
      position: { byteRange: [0, 1], lineRange: [1, 1] },
    }, operation: { kind: 'replace', expectedText: 'a', replacement: 'b' } },
  });
  const summaries = await pullRememberedPushBindings({
    indexedDB: fakeIndexedDB,
    fetch: (async () => Response.json(mailPage(device, forged.envelope))) as typeof fetch,
  });
  assert(summaries.length === 0, 'forged event produced a notification');
  assert((await storedBinding()).cursor === 1, 'invalid item can replay forever');
  wrongKey.fill(0);
  identity.signingSecret.fill(0); identity.encryptionSecret.fill(0);
});

test('mailbox cannot bootstrap a conflicting self-declared owner', async () => {
  await resetDb();
  const root = new Uint8Array(32).fill(26);
  const eventKey = await deriveEventKey(root);
  const trusted = generateBrowserIdentity();
  const attacker = generateBrowserIdentity();
  const trustedDevice = buildRegisterDeviceBody(trusted, 'owner') as Device;
  const attackerDevice = buildRegisterDeviceBody(attacker, 'owner') as Device;
  await installBinding(new Uint8Array(root), new Uint8Array(32).fill(27), [trustedDevice]);
  const forged = assembleBrowserEvent({ eventKey, signingSecret: attacker.signingSecret,
    signingPublic: attacker.signingPublic, roomId: ROOM_ID, authorId: attacker.participantId,
    deviceId: attacker.deviceId, createdAt: 150, expiresAt: Date.now() + 60_000,
    nonce: new Uint8Array(24).fill(8), body: { type: 'comment_created', threadId: 'forged-owner',
      anchor: { v: 2, fileId: 'file-1', snapshotId: 'snapshot-1', baseHash: 'hash-1',
        position: { byteRange: [0, 1], lineRange: [1, 1] } }, body: 'forged' } });
  const summaries = await pullRememberedPushBindings({ indexedDB: fakeIndexedDB,
    fetch: (async () => Response.json(mailPage(attackerDevice, forged.envelope))) as typeof fetch });
  assert(summaries.length === 0, 'conflicting self-declared owner was trusted');
  assert((await storedBinding()).cursor === 1, 'forged owner item can replay forever');
  eventKey.fill(0); root.fill(0); trusted.signingSecret.fill(0); attacker.signingSecret.fill(0);
  trusted.encryptionSecret.fill(0); attacker.encryptionSecret.fill(0);
});

test('v3 ungranted reviewer cannot escalate into accepted events', async () => {
  await resetDb();
  const root = new Uint8Array(32).fill(28);
  const eventKey = await deriveEventKey(root);
  const owner = generateBrowserIdentity();
  const reviewer = generateBrowserIdentity();
  const ownerDevice = buildRegisterDeviceBody(owner, 'owner') as Device;
  const ungranted = buildRegisterDeviceBody(reviewer, 'reviewer') as Device;
  await installBinding(new Uint8Array(root), new Uint8Array(32).fill(29), [ownerDevice]);
  const joined = assembleBrowserEvent({ eventKey, signingSecret: reviewer.signingSecret,
    signingPublic: reviewer.signingPublic, roomId: ROOM_ID, authorId: reviewer.participantId,
    deviceId: reviewer.deviceId, createdAt: 160, expiresAt: Date.now() + 60_000,
    nonce: new Uint8Array(24).fill(9), body: { type: 'participant_joined', participant: {
      participantId: reviewer.participantId, displayName: 'Ungrant', kind: 'reviewer',
      publicSigningKey: base64UrlEncode(reviewer.signingPublic),
      capabilities: ['read_snapshot', 'write_comment', 'resolve_comment', 'write_suggestion'],
    }, device: { deviceId: reviewer.deviceId, participantId: reviewer.participantId,
      publicEncryptionKey: base64UrlEncode(reviewer.publicEncryptionKey),
      publicSigningKey: base64UrlEncode(reviewer.signingPublic), client: 'attn-browser', createdAt: 160 } } });
  const comment = assembleBrowserEvent({ eventKey, signingSecret: reviewer.signingSecret,
    signingPublic: reviewer.signingPublic, roomId: ROOM_ID, authorId: reviewer.participantId,
    deviceId: reviewer.deviceId, createdAt: 161, expiresAt: Date.now() + 60_000,
    nonce: new Uint8Array(24).fill(10), body: { type: 'comment_created', threadId: 'ungranted',
      anchor: { v: 2, fileId: 'file-1', snapshotId: 'snapshot-1', baseHash: 'hash-1',
        position: { byteRange: [0, 1], lineRange: [1, 1] } }, body: 'must reject' } });
  const page = mailPage(ungranted, joined.envelope) as { items: Array<{ payload: Record<string, unknown> }>; nextAfter: number };
  page.items[0]!.payload.envelopes = [joined.envelope, comment.envelope];
  const summaries = await pullRememberedPushBindings({ indexedDB: fakeIndexedDB,
    fetch: (async () => Response.json(page)) as typeof fetch });
  assert(summaries.length === 0, 'ungranted v3 reviewer authored a notification event');
  eventKey.fill(0); root.fill(0); owner.signingSecret.fill(0); reviewer.signingSecret.fill(0);
  owner.encryptionSecret.fill(0); reviewer.encryptionSecret.fill(0);
});

test('verified reviewer attestation survives a later bounded wake', async () => {
  await resetDb();
  const root = new Uint8Array(32).fill(24);
  const eventKey = await deriveEventKey(root);
  const owner = generateBrowserIdentity();
  const reviewer = generateBrowserIdentity();
  const ownerDevice = buildRegisterDeviceBody(owner, 'owner') as Device;
  const grant = base64UrlEncode(ed25519.sign(canonicalDeviceGrantV3(ROOM_ID, 'comment'), owner.signingSecret));
  const reviewerDevice = buildRegisterDeviceBodyV3(reviewer, 'comment', grant) as Device;
  await installBinding(new Uint8Array(root), new Uint8Array(32).fill(25), [ownerDevice]);
  const joined = assembleBrowserEvent({ eventKey, signingSecret: reviewer.signingSecret,
    signingPublic: reviewer.signingPublic, roomId: ROOM_ID, authorId: reviewer.participantId,
    deviceId: reviewer.deviceId, createdAt: 200, expiresAt: Date.now() + 60_000,
    nonce: new Uint8Array(24).fill(5), body: { type: 'participant_joined', participant: {
      participantId: reviewer.participantId, displayName: 'Reviewer', kind: 'reviewer',
      publicSigningKey: base64UrlEncode(reviewer.signingPublic),
      capabilities: ['read_snapshot', 'write_comment', 'resolve_comment'],
    }, device: { deviceId: reviewer.deviceId, participantId: reviewer.participantId,
      publicEncryptionKey: base64UrlEncode(reviewer.publicEncryptionKey),
      publicSigningKey: base64UrlEncode(reviewer.signingPublic), client: 'attn-browser', createdAt: 200 } } });
  const comment = (createdAt: number, nonceByte: number) => assembleBrowserEvent({ eventKey,
    signingSecret: reviewer.signingSecret, signingPublic: reviewer.signingPublic, roomId: ROOM_ID,
    authorId: reviewer.participantId, deviceId: reviewer.deviceId, createdAt,
    expiresAt: Date.now() + 60_000, nonce: new Uint8Array(24).fill(nonceByte), body: {
      type: 'comment_created', threadId: `thread-${createdAt}`, anchor: { v: 2, fileId: 'file-1',
        snapshotId: 'snapshot-1', baseHash: 'hash-1', position: { byteRange: [0, 1], lineRange: [1, 1] } },
      body: 'reviewer comment',
    } });
  const firstComment = comment(201, 6);
  const secondComment = comment(202, 7);
  let wake = 0;
  const fetchImpl = (async () => {
    wake += 1;
    return Response.json(wake === 1
      ? { ...(mailPage(reviewerDevice, joined.envelope) as Record<string, unknown>), items: [{
          ...((mailPage(reviewerDevice, joined.envelope) as { items: Record<string, unknown>[] }).items[0]),
          payload: { ...(((mailPage(reviewerDevice, joined.envelope) as { items: Array<{ payload: Record<string, unknown> }> }).items[0]).payload),
            envelopes: [joined.envelope, firstComment.envelope] },
        }] }
      : mailPage(reviewerDevice, secondComment.envelope, 2));
  }) as typeof fetch;
  const first = await pullRememberedPushBindings({ indexedDB: fakeIndexedDB, fetch: fetchImpl });
  const second = await pullRememberedPushBindings({ indexedDB: fakeIndexedDB, fetch: fetchImpl });
  assert(first[0]?.comments === 1 && second[0]?.comments === 1,
    `later reviewer event lost durable attestation: ${JSON.stringify({ first, second })}`);
  const stored = await storedBinding();
  assert((stored.attestedSigningKeyIds as string[]).includes(signingKeyId(reviewer.signingPublic)), 'attestation was not checkpointed');
  eventKey.fill(0); root.fill(0); owner.signingSecret.fill(0); reviewer.signingSecret.fill(0);
  owner.encryptionSecret.fill(0); reviewer.encryptionSecret.fill(0);
});

test('share wake never performs more than 64 inner-envelope crypto operations', async () => {
  await resetDb();
  const root = new Uint8Array(32).fill(33);
  const eventKey = await deriveEventKey(root);
  const owner = generateBrowserIdentity();
  const ownerDevice = buildRegisterDeviceBody(owner, 'owner') as Device;
  await installBinding(new Uint8Array(root), new Uint8Array(32).fill(34), [ownerDevice]);
  const envelope = assembleBrowserEvent({ eventKey, signingSecret: owner.signingSecret,
    signingPublic: owner.signingPublic, roomId: ROOM_ID, authorId: owner.participantId,
    deviceId: owner.deviceId, createdAt: 300, expiresAt: Date.now() + 60_000,
    nonce: new Uint8Array(24).fill(11), body: { type: 'comment_created', threadId: 'bounded',
      anchor: { v: 2, fileId: 'file-1', snapshotId: 'snapshot-1', baseHash: 'hash-1',
        position: { byteRange: [0, 1], lineRange: [1, 1] } }, body: 'bounded' } }).envelope;
  const items = Array.from({ length: 9 }, (_, index) => {
    const page = mailPage(ownerDevice, envelope, index + 1) as { items: Record<string, unknown>[] };
    const item = page.items[0]!;
    (item.payload as Record<string, unknown>).envelopes = Array.from({ length: 8 }, () => envelope);
    return item;
  });
  await pullRememberedPushBindings({ indexedDB: fakeIndexedDB,
    fetch: (async () => Response.json({ items, nextAfter: 9 })) as typeof fetch });
  assert((await storedBinding()).cursor === 8, 'worker crossed the 64-operation wake bound');
  eventKey.fill(0); root.fill(0); owner.signingSecret.fill(0); owner.encryptionSecret.fill(0);
});

test('oversized mailbox response fails closed without advancing cursor', async () => {
  await resetDb();
  const identity = generateBrowserIdentity();
  const device = buildRegisterDeviceBody(identity, 'owner') as Device;
  await installBinding(new Uint8Array(32).fill(31), new Uint8Array(32).fill(32), [device]);
  const oversized = JSON.stringify({ items: [], padding: 'x'.repeat(513 * 1024) });
  const summaries = await pullRememberedPushBindings({
    indexedDB: fakeIndexedDB,
    fetch: (async () => new Response(oversized, { headers: { 'content-type': 'application/json' } })) as typeof fetch,
  });
  assert(summaries.length === 0, 'oversized response produced a notification');
  assert((await storedBinding()).cursor === 0, 'oversized response advanced cursor');
  identity.signingSecret.fill(0); identity.encryptionSecret.fill(0);
});

let failures = 0;
for (const item of cases) {
  try { await item.run(); console.log(`PASS ${item.name}`); }
  catch (error) { failures += 1; console.error(`FAIL ${item.name}:`, error); }
}
if (failures > 0) process.exit(1);
