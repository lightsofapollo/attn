/// <reference lib="webworker" />

import {
  INFO_EVENT,
  INFO_EVENT_V3,
  INFO_SIGNALING,
  INFO_SIGNALING_V3,
  INFO_SNAPSHOT,
  INFO_SNAPSHOT_V3,
  base64UrlEncode,
} from './browser-crypto';
import {
  BrowserWsClient,
  buildWsUrl,
  type Device,
  type MailboxEnvelope,
  type WebSocketLike,
} from './browser-ws';

export const PUSH_DB_NAME = 'attn-browser-push';
export const PUSH_DB_VERSION = 1;
export const PUSH_BINDING_STORE = 'bindings';
export const MAX_PUSH_BINDINGS_PER_WAKE = 8;
export const MAX_ENVELOPES_PER_PULL = 64;
const MAX_SHARE_RESPONSE_BYTES = 512 * 1024;
const ROOM_PULL_TIMEOUT_MS = 6_000;
const ROOM_QUIET_MS = 200;
const ID = /^[A-Za-z0-9_-]{1,128}$/u;
const BUNDLE_ID = /^[A-Za-z0-9_-]{22}$/u;

export type PushBindingKind = 'room' | 'share';

export interface RememberPushBindingInput {
  bindingId: string;
  kind: PushBindingKind;
  resourceId: string;
  roomId: string;
  deviceId: string;
  relayUrl: string;
  protocolVersion: 2 | 3;
  /** V2 rootKey, or V3 readCapabilityKey (the direct parent of read leaves). */
  roomReadCapabilityBytes: Uint8Array;
  readAdmissionKeyBytes: Uint8Array;
  writeAdmissionKeyBytes?: Uint8Array;
  bundleId?: string;
  epoch?: number;
  fileName: string;
  deepLinkPath: string;
  /** Owner key pinned by the authenticated invite/capability bundle. */
  ownerSigningKey: string;
  devices: Device[];
}

export interface PushBindingRecord {
  bindingId: string;
  kind: PushBindingKind;
  resourceId: string;
  roomId: string;
  deviceId: string;
  relayUrl: string;
  protocolVersion: 2 | 3;
  /** Non-extractable V2 rootKey or V3 readCapabilityKey. */
  roomReadCapability: CryptoKey;
  readAdmissionKey: CryptoKey;
  writeAdmissionKey?: CryptoKey;
  bundleId?: string;
  epoch?: number;
  fileName: string;
  deepLinkPath: string;
  ownerSigningKey: string;
  devices: Device[];
  attestedSigningKeyIds: string[];
  cursor: number;
  updatedAt: number;
}

export interface PushNotificationSummary {
  bindingId: string;
  deepLinkPath: string;
  fileName: string;
  comments: number;
  suggestions: number;
  verdicts: number;
}

export interface PushWorkerDependencies {
  indexedDB?: IDBFactory;
  crypto?: Crypto;
  fetch?: typeof fetch;
  webSocketFactory?: (url: string, protocols: string | string[]) => WebSocketLike;
  now?: () => number;
}

/**
 * Stores only structured-cloned, non-extractable WebCrypto capabilities.
 * Callers must invoke this only after an explicit remember/push consent flow.
 */
export async function rememberPushBinding(
  input: RememberPushBindingInput,
  dependencies: Pick<PushWorkerDependencies, 'indexedDB' | 'crypto' | 'now'> = {},
): Promise<void> {
  validateRememberInput(input);
  const cryptoImpl = dependencies.crypto ?? globalThis.crypto;
  if (!cryptoImpl?.subtle) throw new Error('WebCrypto is unavailable');
  const rootBytes = new Uint8Array(input.roomReadCapabilityBytes);
  const readBytes = new Uint8Array(input.readAdmissionKeyBytes);
  const writeBytes = input.writeAdmissionKeyBytes === undefined
    ? undefined
    : new Uint8Array(input.writeAdmissionKeyBytes);
  let db: IDBDatabase | null = null;
  try {
    const [roomReadCapability, readAdmissionKey, writeAdmissionKey] = await Promise.all([
      cryptoImpl.subtle.importKey('raw', rootBytes, 'HKDF', false, ['deriveBits']),
      importHmacKey(cryptoImpl, readBytes),
      writeBytes === undefined ? Promise.resolve(undefined) : importHmacKey(cryptoImpl, writeBytes),
    ]);
    db = await openPushDatabase(dependencies.indexedDB ?? globalThis.indexedDB);
    const tx = db.transaction(PUSH_BINDING_STORE, 'readwrite');
    // Never reset a durable cursor by silently replacing a remembered
    // capability. Rotation is an explicit forget + remember operation.
    tx.objectStore(PUSH_BINDING_STORE).add({
      bindingId: input.bindingId,
      kind: input.kind,
      resourceId: input.resourceId,
      roomId: input.roomId,
      deviceId: input.deviceId,
      relayUrl: canonicalRelayUrl(input.relayUrl),
      protocolVersion: input.protocolVersion,
      roomReadCapability,
      readAdmissionKey,
      ...(writeAdmissionKey === undefined ? {} : { writeAdmissionKey }),
      ...(input.bundleId === undefined ? {} : { bundleId: input.bundleId }),
      ...(input.epoch === undefined ? {} : { epoch: input.epoch }),
      fileName: input.fileName,
      deepLinkPath: input.deepLinkPath,
      ownerSigningKey: input.ownerSigningKey,
      devices: structuredClone(input.devices),
      attestedSigningKeyIds: [],
      cursor: 0,
      updatedAt: (dependencies.now ?? Date.now)(),
    } satisfies PushBindingRecord);
    await transactionDone(tx);
  } finally {
    rootBytes.fill(0);
    readBytes.fill(0);
    writeBytes?.fill(0);
    input.roomReadCapabilityBytes.fill(0);
    input.readAdmissionKeyBytes.fill(0);
    input.writeAdmissionKeyBytes?.fill(0);
    db?.close();
  }
}

export async function forgetPushBinding(
  bindingId: string,
  indexedDBImpl: IDBFactory = globalThis.indexedDB,
): Promise<void> {
  requireId(bindingId, 'bindingId');
  const db = await openPushDatabase(indexedDBImpl);
  try {
    const tx = db.transaction(PUSH_BINDING_STORE, 'readwrite');
    tx.objectStore(PUSH_BINDING_STORE).delete(bindingId);
    await transactionDone(tx);
  } finally {
    db.close();
  }
}

/** One content-free wake checks a bounded number of locally remembered bindings. */
export async function pullRememberedPushBindings(
  dependencies: PushWorkerDependencies = {},
): Promise<PushNotificationSummary[]> {
  const db = await openPushDatabase(dependencies.indexedDB ?? globalThis.indexedDB);
  try {
    const bindings = (await readAllBindings(db))
      .filter(isValidStoredBinding)
      .sort((a, b) => a.updatedAt - b.updatedAt || a.bindingId.localeCompare(b.bindingId))
      .slice(0, MAX_PUSH_BINDINGS_PER_WAKE);
    const summaries: PushNotificationSummary[] = [];
    for (const binding of bindings) {
      try {
        const summary = binding.kind === 'room'
          ? await pullRoomBinding(db, binding, dependencies)
          : await pullShareBinding(db, binding, dependencies);
        if (summary.comments + summary.suggestions + summary.verdicts > 0) summaries.push(summary);
      } catch {
        // A push wake is best-effort. Never log network errors or capability-adjacent state.
      } finally {
        // Fairly rotate the bounded scan even when one remembered resource is
        // empty or temporarily unavailable, so later bindings cannot starve.
        await touchBinding(db, binding.bindingId, dependencies.now ?? Date.now).catch(() => undefined);
      }
    }
    return summaries;
  } finally {
    db.close();
  }
}

/** Subscription primitive for the explicit consent UI; never requests permission itself. */
export async function ensurePushSubscription(
  registration: ServiceWorkerRegistration,
  vapidPublicKey: Uint8Array,
): Promise<PushSubscription> {
  if (Notification.permission !== 'granted') throw new Error('notification permission is not granted');
  if (!(vapidPublicKey instanceof Uint8Array) || vapidPublicKey.byteLength !== 65 || vapidPublicKey[0] !== 4) {
    throw new Error('VAPID public key must be an uncompressed P-256 point');
  }
  const existing = await registration.pushManager.getSubscription();
  if (existing) return existing;
  return registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: vapidPublicKey.buffer.slice(
      vapidPublicKey.byteOffset,
      vapidPublicKey.byteOffset + vapidPublicKey.byteLength,
    ) as ArrayBuffer,
  });
}

export function subscriptionWireValue(subscription: PushSubscription): {
  v: 3;
  endpoint: string;
  expirationTime: number | null;
  keys: { p256dh: string; auth: string };
} {
  const value = subscription.toJSON();
  if (!value.endpoint || !value.keys?.p256dh || !value.keys.auth) {
    throw new Error('push subscription is incomplete');
  }
  return {
    v: 3,
    endpoint: value.endpoint,
    expirationTime: value.expirationTime ?? null,
    keys: { p256dh: value.keys.p256dh, auth: value.keys.auth },
  };
}

async function pullRoomBinding(
  db: IDBDatabase,
  binding: PushBindingRecord,
  dependencies: PushWorkerDependencies,
): Promise<PushNotificationSummary> {
  const cryptoImpl = dependencies.crypto ?? globalThis.crypto;
  const [eventKey, snapshotKey, signalingKey] = await deriveRoomKeys(binding, cryptoImpl);
  const path = `/v${binding.protocolVersion}/rooms/${binding.roomId}/socket`;
  const query: Array<[string, string]> = [['device_id', binding.deviceId]];
  const subprotocol = await admissionSubprotocol(binding, path, query, cryptoImpl);
  const summary = emptySummary(binding);
  let client: BrowserWsClient | null = null;
  let frames = 0;
  let quietTimer: ReturnType<typeof setTimeout> | undefined;
  let hardTimer: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  const done = new Promise<void>((resolve) => {
    const finish = (): void => {
      if (settled) return;
      settled = true;
      if (quietTimer !== undefined) clearTimeout(quietTimer);
      if (hardTimer !== undefined) clearTimeout(hardTimer);
      client?.close(1000, 'bounded push pull complete');
      resolve();
    };
    const armQuiet = (): void => {
      if (quietTimer !== undefined) clearTimeout(quietTimer);
      quietTimer = setTimeout(finish, ROOM_QUIET_MS);
    };
    hardTimer = setTimeout(finish, ROOM_PULL_TIMEOUT_MS);
    client = new BrowserWsClient({
      roomId: binding.roomId,
      localDeviceId: binding.deviceId,
      url: buildWsUrl(binding.relayUrl, binding.roomId, binding.deviceId, binding.protocolVersion),
      subprotocol,
      afterSeq: binding.cursor,
      eventKey,
      snapshotKey,
      signalingKey,
      initialDevices: new Map(binding.devices.map((device, index) => [`stored-${index}`, device])),
      initialAttestedSigningKeyIds: binding.attestedSigningKeyIds,
      webSocketFactory: dependencies.webSocketFactory,
      callbacks: {
        onHello: () => armQuiet(),
        onEnvelope: async (decoded) => {
          try {
            countEventPlaintext(decoded.envelope, decoded.plaintext, summary);
            await advanceState(db, binding.bindingId, decoded.serverSeq,
              client?.getAttestedSigningKeyIds() ?? [], dependencies.now ?? Date.now);
            frames += 1;
          } finally {
            decoded.plaintext.fill(0);
          }
          if (frames >= MAX_ENVELOPES_PER_PULL) finish(); else armQuiet();
        },
        onTerminal: () => finish(),
        onClose: () => { if (!settled) armQuiet(); },
      },
    });
    client.start();
  });
  try {
    await done;
    return summary;
  } finally {
    (client as BrowserWsClient | null)?.close();
    eventKey.fill(0);
    snapshotKey.fill(0);
    signalingKey.fill(0);
  }
}

async function pullShareBinding(
  db: IDBDatabase,
  binding: PushBindingRecord,
  dependencies: PushWorkerDependencies,
): Promise<PushNotificationSummary> {
  if (!binding.bundleId || binding.epoch === undefined) throw new Error('share binding is incomplete');
  const cryptoImpl = dependencies.crypto ?? globalThis.crypto;
  const fetchImpl = dependencies.fetch ?? fetch;
  const path = `/v3/shares/${encodeURIComponent(binding.resourceId)}/mailbox`;
  const query = new URLSearchParams({ after: String(binding.cursor), limit: String(MAX_ENVELOPES_PER_PULL) });
  const admission = await admissionHeader(binding.readAdmissionKey, 'read', 'GET', path, query, cryptoImpl);
  const response = await fetchImpl(`${binding.relayUrl}${path}?${query.toString()}`, {
    method: 'GET',
    cache: 'no-store',
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
    headers: { 'Attn-Admission': admission, 'Attn-Share-Bundle': binding.bundleId },
  });
  if (!response.ok || response.type === 'opaque') throw new Error('share mailbox pull failed');
  const parsed = JSON.parse(new TextDecoder().decode(await readBoundedBody(response, MAX_SHARE_RESPONSE_BYTES))) as unknown;
  const page = parseSharePage(parsed, binding);
  const [eventKey, snapshotKey, signalingKey] = await deriveRoomKeys(binding, cryptoImpl);
  const summary = emptySummary(binding);
  const client = new BrowserWsClient({
    roomId: binding.roomId,
    localDeviceId: binding.deviceId,
    url: 'wss://invalid.local/',
    subprotocol: 'attn.v3, read-hmac.invalid',
    afterSeq: 0,
    eventKey,
    snapshotKey,
    signalingKey,
    initialDevices: new Map(binding.devices.map((device, index) => [`stored-${index}`, device])),
    initialAttestedSigningKeyIds: binding.attestedSigningKeyIds,
    callbacks: { onEnvelope: decoded => {
      try { countEventPlaintext(decoded.envelope, decoded.plaintext, summary); }
      finally { decoded.plaintext.fill(0); }
    } },
  });
  try {
    let operations = 0;
    for (const item of page) {
      if (operations + item.envelopes.length > MAX_ENVELOPES_PER_PULL) break;
      client.mergeDevices([item.deviceRegistration]);
      for (const envelope of item.envelopes) await client.replayEnvelope(envelope, item.seq);
      operations += item.envelopes.length;
      await advanceState(db, binding.bindingId, item.seq, client.getAttestedSigningKeyIds(), dependencies.now ?? Date.now);
    }
    return summary;
  } finally {
    client.close();
    eventKey.fill(0);
    snapshotKey.fill(0);
    signalingKey.fill(0);
  }
}

function parseSharePage(value: unknown, binding: PushBindingRecord): Array<{
  seq: number; deviceRegistration: Device; envelopes: MailboxEnvelope[];
}> {
  if (!isRecord(value) || !Array.isArray(value.items) || value.items.length > MAX_ENVELOPES_PER_PULL) {
    throw new Error('share mailbox page is invalid');
  }
  const result: Array<{ seq: number; deviceRegistration: Device; envelopes: MailboxEnvelope[] }> = [];
  let previous = binding.cursor;
  for (const raw of value.items) {
    if (!isRecord(raw) || !Number.isSafeInteger(raw.seq) || (raw.seq as number) <= previous
      || raw.bundleId !== binding.bundleId || raw.epoch !== binding.epoch || !isRecord(raw.payload)) {
      throw new Error('share mailbox item is invalid');
    }
    const payload = raw.payload;
    if (payload.v !== 3 || payload.type !== 'review_submission' || payload.shareId !== binding.resourceId
      || payload.epoch !== binding.epoch || payload.roomId !== binding.roomId
      || !isRecord(payload.deviceRegistration) || !Array.isArray(payload.envelopes)
      || payload.envelopes.length < 1 || payload.envelopes.length > 8) {
      throw new Error('share mailbox payload binding is invalid');
    }
    const seq = raw.seq as number;
    result.push({
      seq,
      deviceRegistration: structuredClone(payload.deviceRegistration) as unknown as Device,
      envelopes: structuredClone(payload.envelopes) as MailboxEnvelope[],
    });
    previous = seq;
  }
  return result;
}

function countEventPlaintext(
  envelope: MailboxEnvelope,
  plaintext: Uint8Array,
  summary: PushNotificationSummary,
): void {
  if (envelope.kind !== 'event' || plaintext.byteLength > 256 * 1024) return;
  let value: unknown;
  try { value = JSON.parse(new TextDecoder().decode(plaintext)); } catch { return; }
  if (!isRecord(value) || !isRecord(value.body) || typeof value.body.type !== 'string') return;
  switch (value.body.type) {
    case 'comment_created': summary.comments += 1; break;
    case 'suggestion_created': summary.suggestions += 1; break;
    case 'suggestion_accepted':
    case 'suggestion_rejected': summary.verdicts += 1; break;
  }
}

async function deriveRoomKeys(binding: PushBindingRecord, cryptoImpl: Crypto): Promise<[Uint8Array, Uint8Array, Uint8Array]> {
  validateCryptoKey(binding.roomReadCapability, 'HKDF', 'deriveBits');
  const v3 = binding.protocolVersion === 3;
  return Promise.all([
    deriveBits(cryptoImpl, binding.roomReadCapability, v3 ? INFO_EVENT_V3 : INFO_EVENT),
    deriveBits(cryptoImpl, binding.roomReadCapability, v3 ? INFO_SNAPSHOT_V3 : INFO_SNAPSHOT),
    deriveBits(cryptoImpl, binding.roomReadCapability, v3 ? INFO_SIGNALING_V3 : INFO_SIGNALING),
  ]);
}

async function deriveBits(cryptoImpl: Crypto, root: CryptoKey, info: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await cryptoImpl.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new ArrayBuffer(0), info: ownedBuffer(info) },
    root,
    256,
  ));
}

async function admissionSubprotocol(
  binding: PushBindingRecord,
  path: string,
  query: Array<[string, string]>,
  cryptoImpl: Crypto,
): Promise<string> {
  const canonical = await canonicalRequest('GET', path, new URLSearchParams(query), new Uint8Array(), cryptoImpl);
  try {
    const read = base64UrlEncode(new Uint8Array(await cryptoImpl.subtle.sign('HMAC', binding.readAdmissionKey, ownedBuffer(canonical))));
    if (binding.protocolVersion === 2) return `attn.v2, hmac.${read}`;
    if (!binding.writeAdmissionKey) return `attn.v3, read-hmac.${read}`;
    const write = base64UrlEncode(new Uint8Array(await cryptoImpl.subtle.sign('HMAC', binding.writeAdmissionKey, ownedBuffer(canonical))));
    return `attn.v3, read-hmac.${read}, write-hmac.${write}`;
  } finally {
    canonical.fill(0);
  }
}

async function admissionHeader(
  key: CryptoKey,
  scope: 'read' | 'write',
  method: string,
  path: string,
  query: URLSearchParams,
  cryptoImpl: Crypto,
): Promise<string> {
  validateCryptoKey(key, 'HMAC', 'sign');
  const canonical = await canonicalRequest(method, path, query, new Uint8Array(), cryptoImpl);
  try {
    const mac = new Uint8Array(await cryptoImpl.subtle.sign('HMAC', key, ownedBuffer(canonical)));
    return `v3.${scope}.${base64UrlEncode(mac)}`;
  } finally {
    canonical.fill(0);
  }
}

async function canonicalRequest(
  method: string,
  path: string,
  query: URLSearchParams,
  body: Uint8Array,
  cryptoImpl: Crypto,
): Promise<Uint8Array> {
  const pairs = [...query.entries()].sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
  const canonicalQuery = pairs.map(([key, value]) => `${rfc3986(key)}=${rfc3986(value)}`).join('&');
  const bodyHash = new Uint8Array(await cryptoImpl.subtle.digest('SHA-256', ownedBuffer(body)));
  const prefix = new TextEncoder().encode(`${method.toUpperCase()}\n${path}\n${canonicalQuery}\n`);
  const result = new Uint8Array(prefix.byteLength + bodyHash.byteLength);
  result.set(prefix); result.set(bodyHash, prefix.byteLength);
  prefix.fill(0); bodyHash.fill(0);
  return result;
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error('response exceeds worker bound');
      chunks.push(value);
    }
    const result = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
    return result;
  } finally {
    if (total > maxBytes) await reader.cancel().catch(() => undefined);
  }
}

async function advanceState(
  db: IDBDatabase,
  bindingId: string,
  candidate: number,
  attestedSigningKeyIds: readonly string[],
  now: () => number,
): Promise<void> {
  if (!Number.isSafeInteger(candidate) || candidate < 1) throw new Error('push cursor is invalid');
  const tx = db.transaction(PUSH_BINDING_STORE, 'readwrite');
  const store = tx.objectStore(PUSH_BINDING_STORE);
  const record = await requestValue<PushBindingRecord | undefined>(store.get(bindingId));
  if (!record) { tx.abort(); throw new Error('push binding disappeared'); }
  const attestations = [...new Set(attestedSigningKeyIds)].filter(value => /^[A-Za-z0-9_-]{43}$/u.test(value)).sort();
  if (candidate > record.cursor) store.put({ ...record, cursor: candidate, attestedSigningKeyIds: attestations, updatedAt: now() });
  await transactionDone(tx);
}

async function touchBinding(db: IDBDatabase, bindingId: string, now: () => number): Promise<void> {
  const tx = db.transaction(PUSH_BINDING_STORE, 'readwrite');
  const store = tx.objectStore(PUSH_BINDING_STORE);
  const record = await requestValue<PushBindingRecord | undefined>(store.get(bindingId));
  if (record) store.put({ ...record, updatedAt: now() });
  await transactionDone(tx);
}

async function readAllBindings(db: IDBDatabase): Promise<PushBindingRecord[]> {
  const tx = db.transaction(PUSH_BINDING_STORE, 'readonly');
  const records = await requestValue<PushBindingRecord[]>(tx.objectStore(PUSH_BINDING_STORE).getAll());
  await transactionDone(tx);
  return records;
}

function openPushDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  if (!factory) return Promise.reject(new Error('IndexedDB is unavailable'));
  return new Promise((resolve, reject) => {
    const request = factory.open(PUSH_DB_NAME, PUSH_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(PUSH_BINDING_STORE)) {
        db.createObjectStore(PUSH_BINDING_STORE, { keyPath: 'bindingId' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('push database open failed'));
    request.onblocked = () => reject(new Error('push database upgrade blocked'));
  });
}

function requestValue<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    tx.onerror = () => undefined;
  });
}

function validateRememberInput(input: RememberPushBindingInput): void {
  requireId(input.bindingId, 'bindingId'); requireId(input.resourceId, 'resourceId');
  requireId(input.roomId, 'roomId'); requireId(input.deviceId, 'deviceId');
  if (input.roomReadCapabilityBytes.byteLength !== 32 || input.readAdmissionKeyBytes.byteLength !== 32
    || (input.writeAdmissionKeyBytes !== undefined && input.writeAdmissionKeyBytes.byteLength !== 32)) {
    throw new Error('push capability keys must be 32 bytes');
  }
  canonicalRelayUrl(input.relayUrl);
  validateFileName(input.fileName);
  validateDeepLink(input.deepLinkPath, input.kind, input.resourceId);
  if (!/^[A-Za-z0-9_-]{43}$/u.test(input.ownerSigningKey) || !Array.isArray(input.devices)) {
    throw new Error('push owner directory is invalid');
  }
  const owners = input.devices.filter(device => device.kind === 'owner');
  if (owners.length !== 1 || owners[0]?.publicSigningKey !== input.ownerSigningKey) {
    throw new Error('push binding requires exactly one capability-pinned owner');
  }
  if (input.kind === 'share') {
    if (input.protocolVersion !== 3 || !input.bundleId || !BUNDLE_ID.test(input.bundleId)
      || !Number.isSafeInteger(input.epoch) || (input.epoch ?? -1) < 0) throw new Error('share binding is incomplete');
  } else if (input.bundleId !== undefined || input.epoch !== undefined) {
    throw new Error('room binding must not carry share routing');
  }
}

function isValidStoredBinding(value: PushBindingRecord): boolean {
  try {
    validateRememberInput({ ...value,
      roomReadCapabilityBytes: new Uint8Array(32), readAdmissionKeyBytes: new Uint8Array(32),
      ...(value.writeAdmissionKey ? { writeAdmissionKeyBytes: new Uint8Array(32) } : {}),
    });
    validateCryptoKey(value.roomReadCapability, 'HKDF', 'deriveBits');
    validateCryptoKey(value.readAdmissionKey, 'HMAC', 'sign');
    if (value.writeAdmissionKey) validateCryptoKey(value.writeAdmissionKey, 'HMAC', 'sign');
    return Number.isSafeInteger(value.cursor) && value.cursor >= 0 && Array.isArray(value.devices)
      && Array.isArray(value.attestedSigningKeyIds)
      && value.attestedSigningKeyIds.every(keyId => typeof keyId === 'string' && /^[A-Za-z0-9_-]{43}$/u.test(keyId));
  } catch { return false; }
}

function validateCryptoKey(key: CryptoKey, algorithm: string, usage: KeyUsage): void {
  if (!key || key.type !== 'secret' || key.extractable || key.algorithm.name !== algorithm || !key.usages.includes(usage)) {
    throw new Error('stored push capability is not a non-extractable key');
  }
}

function validateDeepLink(path: string, kind: PushBindingKind, id: string): void {
  const expected = kind === 'share' ? `/s/${encodeURIComponent(id)}` : `/review/${encodeURIComponent(id)}`;
  if (path !== expected || path.includes('?') || path.includes('#')) throw new Error('push deep link is not canonical');
}

function validateFileName(value: string): void {
  if (value.length < 1 || value.length > 160 || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error('push file name is invalid');
}

function canonicalRelayUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1'))) {
    throw new Error('push relay URL must be HTTPS');
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new Error('push relay URL must be an origin');
  }
  return url.origin;
}

function requireId(value: string, label: string): void {
  if (typeof value !== 'string' || !ID.test(value)) throw new Error(`${label} is invalid`);
}

function emptySummary(binding: PushBindingRecord): PushNotificationSummary {
  return { bindingId: binding.bindingId, deepLinkPath: binding.deepLinkPath,
    fileName: binding.fileName, comments: 0, suggestions: 0, verdicts: 0 };
}

function importHmacKey(cryptoImpl: Crypto, bytes: Uint8Array): Promise<CryptoKey> {
  return cryptoImpl.subtle.importKey('raw', ownedBuffer(bytes), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

function ownedBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function rfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!*'()]/gu, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
