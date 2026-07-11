import { expect, test, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { assembleBrowserEvent } from '../src/lib/review/browser-envelope';
import { base64UrlEncode, buildAdmissionHeaderV3, deriveReadKeysV3, toCanonicalBytes } from '../src/lib/review/browser-crypto';
import { buildRegisterDeviceBody, buildRegisterDeviceBodyV3, canonicalDeviceGrantV3,
  generateBrowserIdentity } from '../src/lib/review/browser-session';
import { createDeviceHttpProofV3 } from '../src/lib/review/device-proof';
import type { Device, MailboxEnvelope } from '../src/lib/review/browser-ws';
import { canonicalRequest as relayCanonicalRequest } from '../../relay/src/admission';
import { createPowHeader, FIXED_POW_RAND, mintPowForTests } from '../../relay/test/helpers/pow';

const relayOrigin = 'http://127.0.0.1:8799';
const runId = crypto.randomUUID().replaceAll('-', '').slice(0, 12);
const shareId = `share-push-e2e-${runId}`;
const roomId = `room-push-e2e-${runId}`;
const bundleId = base64UrlEncode(new Uint8Array(16).fill(0x21));
const bindingId = `share_${bundleId}_browser-reviewer`;
const fileId = 'plan-file';
const snapshotId = 'plan-snapshot';
const commentCanary = 'PUSH-E2E-THREAD-7319';

interface RelayFixture {
  server: Server;
  root: Uint8Array;
  read: Uint8Array;
  write: Uint8Array;
  owner: Device;
  ownerIdentity: ReturnType<typeof generateBrowserIdentity>;
  reviewerIdentity: ReturnType<typeof generateBrowserIdentity>;
  reviewerRegistration: ReturnType<typeof buildRegisterDeviceBodyV3>;
  authorIdentity: ReturnType<typeof generateBrowserIdentity>;
  authorRegistration: ReturnType<typeof buildRegisterDeviceBodyV3>;
  shareRecord: Record<string, unknown>;
  snapshot: Uint8Array;
  mailbox: Array<Record<string, unknown>>;
  requests: Array<{ method: string; url: string; body: string; headers: Record<string, string | string[] | undefined> }>;
}

let fixture: RelayFixture;

test.beforeAll(async () => { fixture = await startRelayFixture(); });
test.afterAll(async () => {
  if (!fixture) return;
  await new Promise<void>(resolve => fixture.server.close(() => resolve()));
  fixture.root.fill(0); fixture.read.fill(0); fixture.write.fill(0); fixture.snapshot.fill(0);
  fixture.ownerIdentity.signingSecret.fill(0); fixture.ownerIdentity.encryptionSecret.fill(0);
  fixture.reviewerIdentity.signingSecret.fill(0); fixture.reviewerIdentity.encryptionSecret.fill(0);
  fixture.authorIdentity.signingSecret.fill(0); fixture.authorIdentity.encryptionSecret.fill(0);
});

test('payloadless wake decrypts locally, tag-replaces, and fragmentless click restores the thread', async ({ context, page, browserName }) => {
  const input = harnessInput(fixture);
  const browserRequests: string[] = []; page.on('request', request => browserRequests.push(`${request.method()} ${request.url()}`));
  await page.goto('/push-e2e/index.html');
  await page.waitForFunction(() => '__attnPushE2E' in window);
  await page.evaluate(() => navigator.serviceWorker.ready);
  const enabled = await page.evaluate(async value => {
    const harness = (window as unknown as { __attnPushE2E: { enable(input: unknown): Promise<{ status: string }> } }).__attnPushE2E;
    return harness.enable(value);
  }, input);
  expect(enabled.status, JSON.stringify(enabled)).toBe('on');
  expect(browserRequests.some(request => request.startsWith('POST ') && request.includes('/push-subscriptions/'))).toBe(true);
  await postRealRoomOwnerEvent(fixture);
  const roomPush = fixture.requests.filter(request => request.url === '/push/room-reviewer');
  expect(roomPush).toHaveLength(1); expect(roomPush[0]).toMatchObject({ method: 'POST', body: '' });
  expect(roomPush[0]?.headers['content-type']).toBeUndefined(); expect(roomPush[0]?.headers['content-encoding']).toBeUndefined();
  expect(roomPush[0]?.headers.ttl).toBe('300');
  await postOwnerEvent(ownerCommentItem(fixture, 1, commentCanary, 31));
  let clickTarget = new URL(`/s/${bindingId}`, page.url()).href;
  if (browserName === 'chromium') {
    const worker = await activeServiceWorker(context);
    const first = await dispatchPayloadlessPush(worker);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ title: 'attn review', body: '1 comment on plan.md',
      tag: `attn-review-${bindingId}`, path: `/s/${bindingId}` });
    await postOwnerEvent(ownerCommentItem(fixture, 2, 'PUSH-E2E-SECOND-8421', 32));
    const second = await dispatchPayloadlessPush(worker);
    expect(second).toHaveLength(2);
    expect(second[1]?.tag).toBe(first[0]?.tag);
    expect(second[1]?.body).toBe('1 comment on plan.md');
    await page.close();
    clickTarget = await dispatchNotificationClick(worker, `/s/${bindingId}`);
  } else {
    // Playwright does not expose Firefox ServiceWorker Worker handles, so its
    // supported boundary starts at the exact encrypted worker handoff.
    await postOwnerEvent(ownerCommentItem(fixture, 2, 'PUSH-E2E-SECOND-8421', 32));
    fixture.mailbox.splice(0, fixture.mailbox.length, ...await fetchShareMailbox());
    await seedPendingCiphertext(page, fixture.mailbox);
    await page.close();
  }

  const pushServiceRequests = fixture.requests.filter(request => request.url === '/push/browser-reviewer');
  expect(pushServiceRequests).toHaveLength(1);
  expect(pushServiceRequests[0]).toMatchObject({ method: 'POST', body: '' });
  expect(pushServiceRequests[0]?.headers['content-type']).toBeUndefined();
  expect(pushServiceRequests[0]?.headers['content-encoding']).toBeUndefined();
  expect(pushServiceRequests[0]?.headers.ttl).toBe('300');

  const resumed = await context.newPage();
  await resumed.goto(clickTarget);
  await resumed.waitForLoadState('domcontentloaded');
  await expect(resumed).toHaveURL(new RegExp(`/s/${bindingId}/?$`));
  expect(new URL(resumed.url()).hash).toBe('');
  await expect(resumed.locator('[data-slot="browser-review"]')).toHaveAttribute('data-connection', 'mailbox');
  await expect(resumed.getByText(commentCanary, { exact: false })).toBeVisible();
  await expect(resumed.getByText('PUSH-E2E-SECOND-8421', { exact: false })).toBeVisible();

  const audit = await resumed.evaluate(async ({ database, pendingStore }) => {
    const request = indexedDB.open(database, 2);
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    try {
      const tx = db.transaction(pendingStore, 'readonly');
      const get = tx.objectStore(pendingStore).getAll();
      const rows = await new Promise<unknown[]>((resolve, reject) => {
        get.onsuccess = () => resolve(get.result); get.onerror = () => reject(get.error);
      });
      return JSON.stringify(rows);
    } finally { db.close(); }
  }, { database: 'attn-browser-push', pendingStore: 'pending_envelopes' });
  expect(audit).toBe('[]');

  const forgetPage = await context.newPage(); await forgetPage.goto('/push-e2e/index.html');
  await forgetPage.waitForFunction(() => '__attnPushE2E' in window);
  const forgotten = await forgetPage.evaluate(async value => {
    const harness = (window as unknown as { __attnPushE2E: { disable(input: unknown): Promise<{
      state: { status: string; enabled: boolean }; unsubscribed: boolean }> } }).__attnPushE2E;
    return harness.disable(value);
  }, input);
  expect(forgotten).toMatchObject({ state: { status: 'off', enabled: false }, unsubscribed: true });
  const bindingPresent = await forgetPage.evaluate(async key => {
    const open = indexedDB.open('attn-browser-push', 2);
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error);
    });
    try {
      const tx = db.transaction('bindings', 'readonly'); const request = tx.objectStore('bindings').get(key);
      return await new Promise<boolean>((resolve, reject) => {
        request.onsuccess = () => resolve(request.result !== undefined); request.onerror = () => reject(request.error);
      });
    } finally { db.close(); }
  }, bindingId);
  expect(bindingPresent).toBe(false);
  const pingsBeforeForgetEvent = fixture.requests.filter(request => request.url === '/push/browser-reviewer').length;
  await postOwnerEvent(ownerCommentItem(fixture, 3, 'PUSH-E2E-AFTER-FORGET', 33));
  expect(fixture.requests.filter(request => request.url === '/push/browser-reviewer')).toHaveLength(pingsBeforeForgetEvent);
});

async function startRelayFixture(): Promise<RelayFixture> {
  const root = new Uint8Array(32).fill(21);
  const read = new Uint8Array(32).fill(24);
  const write = new Uint8Array(32).fill(25);
  const ownerIdentity = generateBrowserIdentity();
  const owner = buildRegisterDeviceBody(ownerIdentity, 'owner') as Device;
  const reviewerIdentity = { ...generateBrowserIdentity(),
    deviceId: 'browser-reviewer', participantId: 'browser-participant' };
  const reviewerGrant = base64UrlEncode(ed25519.sign(
    canonicalDeviceGrantV3(roomId, 'comment'), ownerIdentity.signingSecret));
  const reviewerRegistration = buildRegisterDeviceBodyV3(reviewerIdentity, 'comment', reviewerGrant);
  const authorIdentity = { ...generateBrowserIdentity(),
    deviceId: 'browser-author', participantId: 'browser-author-participant' };
  const authorRegistration = buildRegisterDeviceBodyV3(authorIdentity, 'comment', reviewerGrant);
  const keys = deriveReadKeysV3(root);
  const aad = toCanonicalBytes({ v: 3, purpose: 'attn durable share snapshot v3', shareId, epoch: 2, fileId, snapshotId });
  const plaintext = toCanonicalBytes({ v: 3, fileId, snapshotId, docType: 'markdown',
    content: '# Push review plan\n\nAsync review content.' });
  const nonce = new Uint8Array(24).fill(22);
  const encrypted = xchacha20poly1305(keys.snapshotKey, nonce, aad).encrypt(plaintext);
  const snapshot = new Uint8Array(nonce.length + encrypted.length); snapshot.set(nonce); snapshot.set(encrypted, nonce.length);
  const mailbox: Array<Record<string, unknown>> = [];
  const requests: RelayFixture['requests'] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      requests.push({ method: request.method ?? 'GET', url: request.url ?? '/', body, headers: request.headers });
      response.writeHead(request.method === 'POST' ? 201 : 405).end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject); server.listen(8800, '127.0.0.1', () => resolve());
  });
  const ownerPrivateKey = await importEd25519Private(ownerIdentity.signingSecret);
  const createUrl = `${relayOrigin}/v3/shares/${shareId}`;
  const createBody = JSON.stringify({ v: 3, ownerSigningKey: owner.publicSigningKey, epoch: 2, revision: 0,
    currentRoomId: roomId,
    bundles: [{ bundleId, tier: 'comment', readAdmissionKey: base64UrlEncode(read),
      writeAdmissionKey: base64UrlEncode(write), sealedBundle: base64UrlEncode(new Uint8Array(80).fill(0x61)) }],
    snapshots: [], placeholders: [] });
  const created = await fetch(createUrl, { method: 'POST', body: createBody, headers: { 'Content-Type': 'application/json',
    'Attn-Owner-Signature': await ownerSignature(createUrl, 'POST', new TextEncoder().encode(createBody), ownerPrivateKey),
    'Attn-PoW': await createPowHeader(shareId, ownerIdentity.signingPublic, `/v3/shares/${shareId}`) } });
  expect(created.status, await created.clone().text()).toBe(201);
  const uploadPath = `/v3/shares/${shareId}/snapshots/${fileId}/${snapshotId}`; const uploadUrl = `${relayOrigin}${uploadPath}`;
  const uploaded = await fetch(uploadUrl, { method: 'PUT', body: snapshot, headers: { 'Attn-Device-Id': shareId,
    'Attn-Owner-Signature': await ownerSignature(uploadUrl, 'PUT', snapshot, ownerPrivateKey),
    'Attn-PoW': await mintPowForTests({ roomId: shareId, deviceId: shareId, method: 'PUT', path: uploadPath,
      difficulty: 12, expiresAt: Date.now() + 300_000, rand: base64UrlEncode(new Uint8Array(16).fill(0x77)) }) } });
  expect(uploaded.status, await uploaded.clone().text()).toBe(201);
  const sharePath = `/v3/shares/${shareId}`;
  const selected = await fetch(`${relayOrigin}${sharePath}`, { headers: { 'Attn-Share-Bundle': bundleId,
    'Attn-Admission': buildAdmissionHeaderV3(read, 'read', 'GET', sharePath, new Uint8Array()) } });
  expect(selected.status, await selected.clone().text()).toBe(200);
  const shareRecord = await selected.json() as Record<string, unknown>;
  aad.fill(0); plaintext.fill(0); keys.eventKey.fill(0); keys.snapshotKey.fill(0); keys.signalingKey.fill(0);
  keys.readAdmissionKey.fill(0);
  return { server, root, read, write, owner, ownerIdentity, reviewerIdentity,
    reviewerRegistration, authorIdentity, authorRegistration, shareRecord, snapshot, mailbox, requests };
}

function harnessInput(target: RelayFixture): Record<string, unknown> {
  return { shareId, bundleId, roomId, epoch: 2, revision: 1,
    manifestDigest: String(target.shareRecord.manifestDigest), deviceId: 'browser-reviewer', relayUrl: relayOrigin,
    root: [...target.root], read: [...target.read], write: [...target.write],
    deviceSigningSecret: [...target.reviewerIdentity.signingSecret],
    deviceRegistration: structuredClone(target.reviewerRegistration),
    ownerSigningKey: target.owner.publicSigningKey, devices: [target.owner], fileName: 'plan.md',
    pushEndpoint: 'http://127.0.0.1:8800/push/browser-reviewer' };
}

async function postOwnerEvent(item: Record<string, unknown>): Promise<void> {
  const path = `/v3/shares/${shareId}/mailbox`;
  const deviceId = fixture.authorIdentity.deviceId;
  const body = JSON.stringify({ epoch: 2, deviceId, items: [item] });
  const response = await fetch(`${relayOrigin}${path}`, { method: 'POST', body, headers: {
    'Content-Type': 'application/json', 'Attn-Share-Bundle': bundleId,
    'Attn-Admission': buildAdmissionHeaderV3(fixture.write, 'write', 'POST', path, new TextEncoder().encode(body)),
    'Attn-PoW': await mintPowForTests({ roomId: shareId, deviceId, method: 'POST', path,
      difficulty: 12, expiresAt: Date.now() + 300_000,
      rand: base64UrlEncode(crypto.getRandomValues(new Uint8Array(16))) }) } });
  expect(response.status).toBe(201);
}

async function fetchShareMailbox(): Promise<Array<Record<string, unknown>>> {
  const path = `/v3/shares/${shareId}/mailbox`; const url = `${relayOrigin}${path}?after=0&limit=64`;
  const response = await fetch(url, { headers: { 'Attn-Share-Bundle': bundleId,
    'Attn-Admission': await admissionWithQuery(fixture.read, 'read', url, path) } });
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json() as { items: Array<Record<string, unknown>> }).items;
}

async function postRealRoomOwnerEvent(target: RelayFixture): Promise<void> {
  const actualRoomId = `room-owner-push-e2e-${runId}`; const ownerPrivate = await importEd25519Private(target.ownerIdentity.signingSecret);
  const roomPath = `/v3/rooms/${actualRoomId}`; const roomUrl = `${relayOrigin}${roomPath}`;
  const createBody = JSON.stringify({ v: 3, policy: { mode: 'hybrid', maxPeers: 4, maxSnapshotBytes: 1_000_000,
    maxEventBytes: 8192, maxEvents: 100, expiresAt: Date.now() + 3_600_000, allowBrowser: true },
    ownerSigningKey: target.owner.publicSigningKey, readAdmissionKey: base64UrlEncode(target.read),
    writeAdmissionKey: base64UrlEncode(target.write) });
  const created = await fetch(roomUrl, { method: 'POST', body: createBody, headers: { 'Content-Type': 'application/json',
    'Attn-Owner-Signature': await ownerSignature(roomUrl, 'POST', new TextEncoder().encode(createBody), ownerPrivate),
    'Attn-PoW': await createPowHeader(actualRoomId, target.ownerIdentity.signingPublic, roomPath) } });
  expect(created.status, await created.clone().text()).toBe(201);
  const targetIdentity = generateBrowserIdentity();
  const grant = base64UrlEncode(ed25519.sign(canonicalDeviceGrantV3(actualRoomId, 'comment'), target.ownerIdentity.signingSecret));
  const targetDevice = buildRegisterDeviceBodyV3(targetIdentity, 'comment', grant) as Device;
  const register = async (device: Device, suffix: number): Promise<void> => {
    const path = `${roomPath}/devices`; const body = JSON.stringify(device);
    const response = await fetch(`${relayOrigin}${path}`, { method: 'POST', body, headers: { 'Content-Type': 'application/json',
      'Attn-Admission': buildAdmissionHeaderV3(target.write, 'write', 'POST', path, new TextEncoder().encode(body)),
      'Attn-PoW': await mintPowForTests({ roomId: actualRoomId, deviceId: device.deviceId, method: 'POST', path,
        difficulty: 16, expiresAt: Date.now() + 300_000, rand: base64UrlEncode(new Uint8Array(16).fill(suffix)) }) } });
    expect(response.status, await response.clone().text()).toBe(204);
  };
  await register(target.owner, 0x41); await register(targetDevice, 0x42);
  const subscriptionPath = `${roomPath}/push-subscriptions/${targetDevice.deviceId}`;
  const subscriptionBody = JSON.stringify({ v: 3, endpoint: 'http://127.0.0.1:8800/push/room-reviewer', expirationTime: null,
    keys: { p256dh: 'BKOaMoQCJMzoFLApwG1J8FvD2rB3JECjlJ_ZU2qhp4tUGJSfB2Z-5OI6wxAVDd2DilYJoXLRkN0bOSDRA32s7HI',
      auth: 'AAAAAAAAAAAAAAAAAAAAAA' } });
  const subscriptionBodyBytes = new TextEncoder().encode(subscriptionBody);
  const subscriptionPow = await mintPowForTests({ roomId: actualRoomId, deviceId: targetDevice.deviceId, method: 'POST',
    path: subscriptionPath, difficulty: 16, expiresAt: Date.now() + 300_000,
    rand: base64UrlEncode(new Uint8Array(16).fill(0x43)) });
  const subscribed = await fetch(`${relayOrigin}${subscriptionPath}`, { method: 'POST', body: subscriptionBody,
    headers: { 'Content-Type': 'application/json', 'Attn-Device-Id': targetDevice.deviceId,
      'Attn-Admission': buildAdmissionHeaderV3(target.write, 'write', 'POST', subscriptionPath,
        subscriptionBodyBytes),
      'Attn-PoW': subscriptionPow,
      'Attn-Device-Proof': await createDeviceHttpProofV3({ resourceKind: 'room', resourceId: actualRoomId,
        deviceId: targetDevice.deviceId, method: 'POST', path: subscriptionPath, body: subscriptionBodyBytes,
        powToken: subscriptionPow, signingSecret: targetIdentity.signingSecret }) } });
  subscriptionBodyBytes.fill(0);
  expect(subscribed.status, await subscribed.clone().text()).toBe(201);
  const eventKey = deriveReadKeysV3(target.root).eventKey;
  const event = assembleBrowserEvent({ eventKey, signingSecret: target.ownerIdentity.signingSecret,
    signingPublic: target.ownerIdentity.signingPublic, roomId: actualRoomId, authorId: target.ownerIdentity.participantId,
    deviceId: target.ownerIdentity.deviceId, createdAt: 900, expiresAt: Date.now() + 60_000,
    nonce: new Uint8Array(24).fill(0x44), body: { type: 'comment_created', threadId: 'owner-room-thread',
      anchor: { v: 2, fileId, snapshotId, baseHash: 'owner-room-hash', position: { byteRange: [0, 4], lineRange: [1, 1] } },
      body: 'REAL-ROOM-OWNER-PUSH' } });
  const envelopesPath = `${roomPath}/envelopes`; const envelopesBody = JSON.stringify({ envelopes: [event.envelope] });
  const accepted = await fetch(`${relayOrigin}${envelopesPath}`, { method: 'POST', body: envelopesBody,
    headers: { 'Content-Type': 'application/json', 'Attn-Admission': buildAdmissionHeaderV3(target.write, 'write', 'POST',
      envelopesPath, new TextEncoder().encode(envelopesBody)),
      'Attn-PoW': await mintPowForTests({ roomId: actualRoomId, deviceId: target.owner.deviceId, method: 'POST',
        path: envelopesPath, difficulty: 16, expiresAt: Date.now() + 300_000,
        rand: base64UrlEncode(new Uint8Array(16).fill(0x45)) }) } });
  expect(accepted.status, await accepted.clone().text()).toBe(201);
  eventKey.fill(0); targetIdentity.signingSecret.fill(0); targetIdentity.encryptionSecret.fill(0);
}

async function admissionWithQuery(keyBytes: Uint8Array, scope: 'read' | 'write', url: string, path: string): Promise<string> {
  const canonical = await relayCanonicalRequest(new Request(url), path);
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  try { return `v3.${scope}.${base64UrlEncode(new Uint8Array(await crypto.subtle.sign('HMAC', key, canonical)))}`; }
  finally { canonical.fill(0); }
}

async function importEd25519Private(seed: Uint8Array): Promise<CryptoKey> {
  const prefix = Uint8Array.from([0x30,0x2e,0x02,0x01,0x00,0x30,0x05,0x06,0x03,0x2b,0x65,0x70,0x04,0x22,0x04,0x20]);
  const pkcs8 = new Uint8Array(prefix.length + seed.length); pkcs8.set(prefix); pkcs8.set(seed, prefix.length);
  try { return await crypto.subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, false, ['sign']); }
  finally { pkcs8.fill(0); }
}

async function ownerSignature(url: string, method: string, body: Uint8Array, privateKey: CryptoKey): Promise<string> {
  const canonical = await relayCanonicalRequest(new Request(url, { method, body }), new URL(url).pathname);
  try { return base64UrlEncode(new Uint8Array(await crypto.subtle.sign('Ed25519', privateKey, canonical))); }
  finally { canonical.fill(0); }
}

function ownerCommentItem(target: RelayFixture, seq: number, body: string, nonceByte: number): Record<string, unknown> {
  const eventKey = deriveReadKeysV3(target.root).eventKey;
  const identity = target.authorIdentity;
  const joined = assembleBrowserEvent({ eventKey, signingSecret: identity.signingSecret,
    signingPublic: identity.signingPublic, roomId, authorId: identity.participantId,
    deviceId: identity.deviceId, createdAt: 900 + seq, expiresAt: Date.now() + 60_000,
    nonce: new Uint8Array(24).fill(nonceByte + 64), body: { type: 'participant_joined', participant: {
      participantId: identity.participantId, displayName: 'Browser reviewer', kind: 'reviewer',
      publicSigningKey: base64UrlEncode(identity.signingPublic),
      capabilities: ['read_snapshot', 'write_comment', 'resolve_comment'],
    }, device: { deviceId: identity.deviceId, participantId: identity.participantId,
      publicEncryptionKey: base64UrlEncode(identity.publicEncryptionKey),
      publicSigningKey: base64UrlEncode(identity.signingPublic), client: 'attn-browser', createdAt: 900 + seq } } });
  const assembled = assembleBrowserEvent({ eventKey, signingSecret: identity.signingSecret,
    signingPublic: identity.signingPublic, roomId, authorId: identity.participantId,
    deviceId: identity.deviceId, createdAt: 1_000 + seq, expiresAt: Date.now() + 60_000,
    nonce: new Uint8Array(24).fill(nonceByte), body: { type: 'comment_created', threadId: `thread-${seq}`,
      anchor: { v: 2, fileId, snapshotId, baseHash: 'hash-push-e2e',
        position: { byteRange: [0, 4], lineRange: [1, 1] } }, body } });
  const envelope = assembled.envelope as MailboxEnvelope;
  const item = { v: 3, envelopeId: `outer-${seq}`, type: 'review_submission', shareId, epoch: 2,
    roomId, tier: 'comment', bundleId, deviceRegistration: target.authorRegistration,
    envelopes: [joined.envelope, envelope] };
  eventKey.fill(0);
  return item;
}

async function seedPendingCiphertext(page: Page, items: Array<Record<string, unknown>>): Promise<void> {
  const values = items.map(raw => {
    const item = raw as { seq: number; payload: { deviceRegistration: unknown; envelopes: unknown[] } };
    const contentHash = base64UrlEncode(sha256(toCanonicalBytes({ seq: item.seq,
      deviceRegistration: item.payload.deviceRegistration, envelopes: item.payload.envelopes })));
    return { ...raw, contentHash };
  });
  await page.evaluate(async input => {
    const { binding, values } = input;
    const open = indexedDB.open('attn-browser-push', 2);
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error);
    });
    try {
      const tx = db.transaction(['bindings', 'pending_envelopes'], 'readwrite');
      const bindings = tx.objectStore('bindings');
      const currentRequest = bindings.get(binding);
      const current = await new Promise<Record<string, unknown>>((resolve, reject) => {
        currentRequest.onsuccess = () => resolve(currentRequest.result as Record<string, unknown>);
        currentRequest.onerror = () => reject(currentRequest.error);
      });
      const generation = String(current.generation);
      const pending = tx.objectStore('pending_envelopes');
      for (const raw of values) {
        const item = raw as { seq: number; contentHash: string;
          payload: { deviceRegistration: unknown; envelopes: unknown[] } };
        pending.put({ key: `${binding}:${generation}:${String(item.seq).padStart(16, '0')}:${item.contentHash}`, bindingId: binding,
          bundleId: input.bundleId, epoch: 2, roomId: input.roomId, seq: item.seq, deviceRegistration: item.payload.deviceRegistration,
          generation, contentHash: item.contentHash, envelopes: item.payload.envelopes, storedAt: Date.now() });
      }
      bindings.put({ ...current, cursor: values.length, updatedAt: Date.now() });
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); tx.onerror = () => undefined;
      });
    } finally { db.close(); }
  }, { binding: bindingId, bundleId, roomId, values });
}

async function activeServiceWorker(context: BrowserContext): Promise<Worker> {
  const existing = context.serviceWorkers()[0];
  return existing ?? context.waitForEvent('serviceworker');
}

async function dispatchPayloadlessPush(worker: Worker): Promise<Array<{ title: string; body: string; tag: string; path: string }>> {
  return worker.evaluate(async () => {
    const scope = globalThis as unknown as ServiceWorkerGlobalScope & {
      __attnCaptured?: Array<{ title: string; body: string; tag: string; path: string }>;
    };
    scope.__attnCaptured ??= [];
    Object.defineProperty(scope.registration, 'showNotification', { configurable: true,
      value: async (title: string, options?: NotificationOptions) => {
        scope.__attnCaptured!.push({ title, body: options?.body ?? '', tag: options?.tag ?? '',
          path: (options?.data as { path?: string } | undefined)?.path ?? '' });
      } });
    const waits: Promise<unknown>[] = [];
    const event = new Event('push');
    Object.defineProperties(event, { data: { value: null }, waitUntil: { value: (promise: Promise<unknown>) => waits.push(promise) } });
    scope.dispatchEvent(event);
    await Promise.all(waits);
    return structuredClone(scope.__attnCaptured);
  });
}

async function dispatchNotificationClick(worker: Worker, path: string): Promise<string> {
  return worker.evaluate(async target => {
    const scope = globalThis as unknown as ServiceWorkerGlobalScope & { __attnClickTarget?: string };
    const waits: Promise<unknown>[] = [];
    // Synthetic notificationclick events do not carry the browser's internal
    // user-activation bit. Capture the production openWindow target at that
    // boundary, then let Playwright perform the equivalent navigation.
    Object.defineProperty(scope.clients, 'openWindow', { configurable: true,
      value: async (url: string) => { scope.__attnClickTarget = url; return null; } });
    const event = new Event('notificationclick');
    Object.defineProperties(event, {
      notification: { value: { data: { path: target }, close: () => undefined } },
      waitUntil: { value: (promise: Promise<unknown>) => waits.push(promise) },
    });
    scope.dispatchEvent(event);
    await Promise.all(waits);
    if (!scope.__attnClickTarget) throw new Error('notification click did not request a window');
    return scope.__attnClickTarget;
  }, path);
}

function json(response: import('node:http').ServerResponse, value: unknown): void {
  response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(value));
}
