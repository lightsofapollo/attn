import { base64UrlEncode, contentHash, deriveShareLinkKeys, expandShareLinkKeys } from './browser-crypto';
import { deriveReadKeysV3, toCanonicalBytes } from './browser-crypto';
import { buildShareBundleMutations, EMPTY_SHARE_MANIFEST_DIGEST } from './browser-share-owner';
import { parseAndStripShareInvite } from './browser-share';
import { createBrowserDurableShareResolver, createShareMailboxTransport, decryptDurableShareSnapshot,
  DurableShareBrowserSessionFacade, reviewSnapshotFromDurable, subscribeToDurableShareChanges,
  RememberedPushShareSessionFacade, stageDurableAsset,
  type BrowserDurableSharePersistence } from './browser-share-production';
import { browserAssetRegistry } from './browser-asset-registry';
import { indexedDB as fakeIndexedDB } from 'fake-indexeddb';
import { StaleShareEpochError } from './browser-share-session';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { advancePushBindingFloor, getPushBinding, rememberPushBinding, replacePushBinding } from './browser-push-worker';

function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
const secret = new Uint8Array(32).fill(7);
const shareId = base64UrlEncode(new Uint8Array(16).fill(3));
const inviteUrl = `https://attn.sh/s/${shareId}#key=${base64UrlEncode(secret)}`;

{
  const facade = new RememberedPushShareSessionFacade({ relayUrl: 'https://relay.example',
    bindingId: 'missing-push-binding', indexedDB: fakeIndexedDB,
    fetchImpl: async () => { throw new Error('absent binding must not reach relay'); } });
  await facade.start();
  assert(facade.getState().status === 'error' && facade.getState().error?.kind === 'invite_invalid',
    'fragmentless push click without a local binding did not fail safely');
  console.log('PASS fragmentless push click requires a local non-extractable binding');
}

{
  const root = new Uint8Array(32).fill(21); const derived = deriveReadKeysV3(root);
  const fileId = 'push-file'; const snapshotId = 'push-snapshot'; const epoch = 2;
  const aad = toCanonicalBytes({ v: 3, purpose: 'attn durable share snapshot v3', shareId, epoch, fileId, snapshotId });
  const plain = toCanonicalBytes({ v: 3, fileId, snapshotId, docType: 'markdown', content: '# from push' });
  const nonce = new Uint8Array(24).fill(22); const encrypted = xchacha20poly1305(derived.snapshotKey, nonce, aad).encrypt(plain);
  const sealed = new Uint8Array(24 + encrypted.length); sealed.set(nonce); sealed.set(encrypted, 24);
  const hash = base64UrlEncode(sha256(sealed));
  const ref = { fileId, snapshotId, ciphertextBytes: sealed.length, ciphertextSha256: hash, uploadedAt: 10 };
  const manifestDigest = base64UrlEncode(sha256(toCanonicalBytes([ref])));
  const ownerKey = base64UrlEncode(new Uint8Array(32).fill(23)); const bundleId = 'abcdefghijklmnopqrstuv';
  const bindingId = `share_${bundleId}_push-reviewer`;
  await rememberPushBinding({ bindingId, kind: 'share', resourceId: shareId, roomId: 'push-room', deviceId: 'push-reviewer',
    relayUrl: 'https://relay.example', protocolVersion: 3, roomReadCapabilityBytes: new Uint8Array(root),
    readAdmissionKeyBytes: new Uint8Array(32).fill(24), writeAdmissionKeyBytes: new Uint8Array(32).fill(25),
    bundleId, epoch, revision: 4, manifestDigest, fileName: 'push.md', deepLinkPath: `/s/${bindingId}`, ownerSigningKey: ownerKey,
    devices: [{ deviceId: 'owner', participantId: 'owner', publicEncryptionKey: base64UrlEncode(new Uint8Array(32).fill(26)),
      publicSigningKey: ownerKey, client: 'attn-native', kind: 'owner', selfSignature: base64UrlEncode(new Uint8Array(64).fill(27)) }] },
  { indexedDB: fakeIndexedDB });
  const facade = new RememberedPushShareSessionFacade({ relayUrl: 'https://relay.example', bindingId, indexedDB: fakeIndexedDB,
    store: { currentRoomId: null, currentFileId: null, applyEvent: () => undefined, applySnapshot: () => undefined,
      setCurrentFile: () => undefined, setCurrentSnapshot: () => undefined },
    fetchImpl: async (input) => String(input).includes('/snapshots/')
      ? new Response(sealed, { headers: { 'Attn-Share-Bundle': bundleId, 'Attn-Snapshot-Id': snapshotId } })
      : Response.json({ v: 3, shareId, ownerSigningKey: ownerKey, epoch, revision: 4, snapshots: [ref],
          manifestDigest, bundle: { bundleId, tier: 'comment', sealedBundle: 'opaque' } }) });
  await facade.start();
  assert(facade.getState().status === 'connected' && facade.getState().snapshotContent === '# from push',
    `fragmentless notification click did not recover: ${JSON.stringify(facade.getState())}`);
  facade.close();
  const oversizedRecord = new RememberedPushShareSessionFacade({ relayUrl: 'https://relay.example', bindingId,
    indexedDB: fakeIndexedDB, fetchImpl: async () => new Response('{}', { headers: { 'Content-Length': String(512 * 1024 + 1) } }) });
  await oversizedRecord.start();
  assert(oversizedRecord.getState().status === 'error', 'oversized remembered share record was allocated or accepted');
  const overCapRef = { ...ref, ciphertextBytes: 5 * 1024 * 1024 + 1 };
  const overCapDigest = base64UrlEncode(sha256(toCanonicalBytes([overCapRef]))); let overCapSnapshotFetches = 0;
  const oversizedManifest = new RememberedPushShareSessionFacade({ relayUrl: 'https://relay.example', bindingId,
    indexedDB: fakeIndexedDB, fetchImpl: async input => {
      if (String(input).includes('/snapshots/')) { overCapSnapshotFetches += 1; return new Response(); }
      return Response.json({ v: 3, shareId, ownerSigningKey: ownerKey, epoch, revision: 5,
        snapshots: [overCapRef], manifestDigest: overCapDigest, bundle: { bundleId, tier: 'comment', sealedBundle: 'opaque' } });
    } });
  await oversizedManifest.start();
  assert(oversizedManifest.getState().status === 'error' && overCapSnapshotFetches === 0,
    'over-cap manifest snapshot reached the network');
  const largeRef = { ...ref, ciphertextBytes: 5 * 1024 * 1024,
    ciphertextSha256: base64UrlEncode(new Uint8Array(32).fill(33)) };
  const largeDigest = base64UrlEncode(sha256(toCanonicalBytes([largeRef]))); let streamCancelled = false;
  const oversizedSnapshot = new RememberedPushShareSessionFacade({ relayUrl: 'https://relay.example', bindingId,
    indexedDB: fakeIndexedDB, fetchImpl: async input => String(input).includes('/snapshots/')
      ? new Response(new ReadableStream<Uint8Array>({ start(controller) {
          controller.enqueue(new Uint8Array(4 * 1024 * 1024)); controller.enqueue(new Uint8Array(2 * 1024 * 1024));
        }, cancel() { streamCancelled = true; } }),
        { headers: { 'Attn-Share-Bundle': bundleId, 'Attn-Snapshot-Id': snapshotId } })
      : Response.json({ v: 3, shareId, ownerSigningKey: ownerKey, epoch, revision: 5,
          snapshots: [largeRef], manifestDigest: largeDigest, bundle: { bundleId, tier: 'comment', sealedBundle: 'opaque' } }) });
  await oversizedSnapshot.start();
  assert(oversizedSnapshot.getState().status === 'error' && streamCancelled,
    'oversized snapshot stream was not cancelled at the bound');
  let mismatchedFetches = 0;
  const mismatched = new RememberedPushShareSessionFacade({ relayUrl: 'https://other-relay.example', bindingId,
    indexedDB: fakeIndexedDB, fetchImpl: async () => { mismatchedFetches += 1; return new Response(); } });
  await mismatched.start();
  assert(mismatched.getState().status === 'error' && mismatchedFetches === 0,
    'remembered admission was sent to a mismatched configured relay');
  const rollback = new RememberedPushShareSessionFacade({ relayUrl: 'https://relay.example', bindingId,
    indexedDB: fakeIndexedDB, fetchImpl: async () => Response.json({ v: 3, shareId, ownerSigningKey: ownerKey,
      epoch, revision: 3, snapshots: [ref], manifestDigest, bundle: { bundleId, tier: 'comment', sealedBundle: 'opaque' } }) });
  await rollback.start();
  assert(rollback.getState().status === 'error', 'remembered revision rollback was accepted');
  const oldFloor = await getPushBinding(bindingId, fakeIndexedDB);
  assert(oldFloor?.revision === 4, 'test did not capture the rev4 floor');
  const advancedDigest = base64UrlEncode(new Uint8Array(32).fill(28));
  await replacePushBinding({ bindingId, kind: 'share', resourceId: shareId, roomId: 'push-room', deviceId: 'push-reviewer',
    relayUrl: 'https://relay.example', protocolVersion: 3, roomReadCapabilityBytes: new Uint8Array(32).fill(21),
    readAdmissionKeyBytes: new Uint8Array(32).fill(24), writeAdmissionKeyBytes: new Uint8Array(32).fill(25),
    bundleId, epoch, revision: 5, manifestDigest: advancedDigest, fileName: 'push.md', deepLinkPath: `/s/${bindingId}`,
    ownerSigningKey: ownerKey, devices: oldFloor.devices }, { indexedDB: fakeIndexedDB });
  let staleAdvanceRejected = false;
  try { await advancePushBindingFloor(bindingId, { expectedEpoch: epoch, expectedBundleId: bundleId,
    expectedRoomId: 'push-room', expectedRelayUrl: 'https://relay.example', expectedRevision: 4,
    expectedManifestDigest: manifestDigest, candidateRevision: 4, candidateManifestDigest: manifestDigest }, fakeIndexedDB); }
  catch { staleAdvanceRejected = true; }
  assert(staleAdvanceRejected && (await getPushBinding(bindingId, fakeIndexedDB))?.revision === 5,
    'cold rev4 completion overwrote a concurrent rev5 rotation');
  const epochDigest = base64UrlEncode(new Uint8Array(32).fill(29));
  await replacePushBinding({ bindingId, kind: 'share', resourceId: shareId, roomId: 'push-room-new', deviceId: 'push-reviewer',
    relayUrl: 'https://relay.example', protocolVersion: 3, roomReadCapabilityBytes: new Uint8Array(32).fill(30),
    readAdmissionKeyBytes: new Uint8Array(32).fill(31), writeAdmissionKeyBytes: new Uint8Array(32).fill(32),
    bundleId, epoch: 3, revision: 1, manifestDigest: epochDigest, fileName: 'push.md', deepLinkPath: `/s/${bindingId}`,
    ownerSigningKey: ownerKey, devices: oldFloor.devices }, { indexedDB: fakeIndexedDB });
  let oldEpochRejected = false;
  try { await advancePushBindingFloor(bindingId, { expectedEpoch: epoch, expectedBundleId: bundleId,
    expectedRoomId: 'push-room', expectedRelayUrl: 'https://relay.example', expectedRevision: 4,
    expectedManifestDigest: manifestDigest, candidateRevision: 5, candidateManifestDigest: advancedDigest }, fakeIndexedDB); }
  catch { oldEpochRejected = true; }
  assert(oldEpochRejected && (await getPushBinding(bindingId, fakeIndexedDB))?.epoch === 3,
    'old-epoch cold resume overwrote a new-epoch binding');
  aad.fill(0); plain.fill(0); sealed.fill(0); root.fill(0);
  console.log('PASS fragmentless push click recovers without a URL bearer');
  console.log('PASS fragmentless record, manifest, and snapshot reads are allocation-bounded');
  console.log('PASS fragmentless resume pins relay origin and revision/manifest floor');
  console.log('PASS cold-resume floor CAS rejects concurrent revision and epoch rotations');
}

{
  const mapped = reviewSnapshotFromDurable({ fileId: 'file-a', snapshotId: 'snapshot-a', docType: 'markdown', content: '# x' }, 'resolved-room');
  assert(mapped.roomId === 'resolved-room', 'durable snapshot lost its resolved room binding');
  console.log('PASS durable snapshot installation binds resolved room before state patch');
}

{
  const raw = new Uint8Array(24);
  raw.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  raw.set([0, 0, 0, 2, 0, 0, 0, 2], 16);
  const fileId = 'durable-image-file'; const snapshotId = 'durable-image-snapshot';
  const hash = contentHash(raw);
  stageDurableAsset({
    fileId, snapshotId, docType: 'asset', content: base64UrlEncode(raw), mediaType: 'image/png',
    metadata: { baseHash: hash, manifestEntry: {
      fileId, snapshotId, path: 'assets/diagram.png', kind: 'asset', mediaType: 'image/png',
      byteLength: raw.length, contentHash: hash,
    } },
  }, 'durable-image-room');
  assert(browserAssetRegistry.urlFor('durable-image-room', snapshotId)?.startsWith('blob:'),
    'offline durable image did not activate a verified Blob URL');
  const mapped = reviewSnapshotFromDurable({ fileId, snapshotId, docType: 'asset', content: base64UrlEncode(raw), mediaType: 'image/png' }, 'durable-image-room');
  assert(mapped.assetContent === undefined && mapped.content === undefined, 'durable raw image entered review store');
  browserAssetRegistry.clearRoom('durable-image-room'); raw.fill(0);
  console.log('PASS durable image snapshot activates Blob-only renderer state');
}

{
  const invite = { shareId, linkSecret: new Uint8Array(secret) };
  const persistence = { atomicMax: async ({ candidate }: { candidate: { epoch: number; revision: number; manifestDigest: string } }) => candidate,
    hydrate: async () => [], transition: async () => undefined, dispose: () => undefined } as unknown as BrowserDurableSharePersistence;
  await createBrowserDurableShareResolver({ relayUrl: 'https://relay.example', invite, tier: 'view', persistence });
  assert(invite.linkSecret.every(byte => byte === 0), 'original parsed link secret survived successful expansion');
  console.log('PASS resolver zeroes original parsed link secret after expansion');
}

{
  // attn-hh9r: a TTL-wiped room's 404 carries no stored policy, so cross-origin
  // it is CORS-untagged and the browser fetch rejects opaquely. The resolver
  // must read that as room-gone (degrade to the durable snapshots) whenever the
  // always-tagged share record route proves the relay reachable — and keep the
  // genuine network failure when it does not.
  const shareSecret = new Uint8Array(32).fill(50);
  const viewKeys = deriveShareLinkKeys(shareSecret, 'view');
  const roomId = base64UrlEncode(new Uint8Array(16).fill(56));
  const mutation = buildShareBundleMutations({
    shareId, shareSecret, epoch: 0, revision: 0, manifestDigest: EMPTY_SHARE_MANIFEST_DIGEST, roomId,
    ownerSigningKey: base64UrlEncode(new Uint8Array(32).fill(51)),
    readCapabilityKey: new Uint8Array(32).fill(52), writeAdmissionKey: new Uint8Array(32).fill(53),
    commentGrantSignature: base64UrlEncode(new Uint8Array(64).fill(54)),
    suggestGrantSignature: base64UrlEncode(new Uint8Array(64).fill(55)),
  }).find(candidate => candidate.tier === 'view')!;
  assert(mutation.bundleId === viewKeys.bundleId, 'sealed view bearer does not match the derived link keys');
  const recordJson = { v: 3, shareId, epoch: 0, revision: 0, currentRoomId: roomId, snapshots: [],
    manifestDigest: EMPTY_SHARE_MANIFEST_DIGEST,
    bundle: { bundleId: mutation.bundleId, tier: 'view', sealedBundle: mutation.sealedBundle },
    updatedAt: 1, expiresAt: 2 };
  const persistence = { atomicMax: async ({ candidate }: { candidate: { epoch: number; revision: number; manifestDigest: string } }) => candidate,
    hydrate: async () => [], transition: async () => undefined, dispose: () => undefined } as unknown as BrowserDurableSharePersistence;
  const probeCounts = { share: 0, room: 0 };
  const reachable = await createBrowserDurableShareResolver({ relayUrl: 'https://relay.example',
    invite: { shareId, linkSecret: new Uint8Array(viewKeys.linkSecret) }, tier: 'view', persistence,
    fetchImpl: async url => {
      if (url.includes('/v3/rooms/')) { probeCounts.room += 1; throw new TypeError('Failed to fetch'); }
      probeCounts.share += 1;
      return Response.json(recordJson);
    } });
  const resolution = await reachable.resolver.resolve();
  assert(resolution.source === 'share_snapshot' && probeCounts.room === 1 && probeCounts.share >= 2,
    'CORS-untagged room failure with a reachable relay did not degrade to snapshots');
  let fetches = 0;
  const unreachable = await createBrowserDurableShareResolver({ relayUrl: 'https://relay.example',
    invite: { shareId, linkSecret: new Uint8Array(viewKeys.linkSecret) }, tier: 'view', persistence,
    fetchImpl: async url => {
      fetches += 1;
      if (fetches === 1 && !url.includes('/v3/rooms/')) return Response.json(recordJson);
      throw new TypeError('Failed to fetch');
    } });
  let surfaced: unknown = null;
  try { await unreachable.resolver.resolve(); } catch (error) { surfaced = error; }
  assert(surfaced instanceof TypeError, 'genuinely unreachable relay did not keep its network failure');
  console.log('PASS room liveness probe separates CORS-untagged room-gone from a dead relay (attn-hh9r)');
}

{
  const invite = { shareId, linkSecret: new Uint8Array(secret) };
  const facade = new DurableShareBrowserSessionFacade({ relayUrl: 'https://relay.example', invite,
    fetchImpl: async (_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    }) });
  const starting = facade.start(); facade.close();
  try { await starting; } catch { /* expected abort */ }
  assert(invite.linkSecret.every(byte => byte === 0) && facade.getState().status === 'idle',
    'close-before-start retained secret or resurrected facade');
  console.log('PASS facade close cancels tier discovery and prevents late resurrection');
}

{
  const readCapabilityKey = new Uint8Array(32).fill(11);
  const roomKeys = deriveReadKeysV3(readCapabilityKey);
  const aad = toCanonicalBytes({ v: 3, purpose: 'attn durable share snapshot v3', shareId, epoch: 4,
    fileId: 'file-a', snapshotId: 'snapshot-a' });
  const plaintext = toCanonicalBytes({ v: 3, fileId: 'file-a', snapshotId: 'snapshot-a', docType: 'markdown',
    content: '# exact', metadata: { baseHash: 'H'.repeat(43) } });
  const nonce = new Uint8Array(24).fill(9);
  const ciphertext = xchacha20poly1305(roomKeys.snapshotKey, nonce, aad).encrypt(plaintext);
  const sealed = new Uint8Array(nonce.length + ciphertext.length); sealed.set(nonce); sealed.set(ciphertext, nonce.length);
  const bundle = { v: 3 as const, shareId, bundleId: 'B'.repeat(22), epoch: 4, revision: 1,
    manifestDigest: 'M'.repeat(43), roomId: 'room-a', tier: 'view' as const,
    roomCapability: { ownerSigningKey: 'O'.repeat(43), readCapabilityKey, roomKeys } };
  const opened = await decryptDurableShareSnapshot(shareId, 4, bundle, 'file-a', 'snapshot-a', sealed);
  assert(opened.content === '# exact' && (opened.metadata as { baseHash?: string }).baseHash === 'H'.repeat(43),
    'pinned durable snapshot did not open');
  let rejected = false;
  try { await decryptDurableShareSnapshot(shareId, 5, bundle, 'file-a', 'snapshot-a', sealed); } catch { rejected = true; }
  assert(rejected, 'durable snapshot AAD did not bind epoch');
  console.log('PASS durable snapshot pins nonce||XChaCha AAD and exact plaintext');
}

{
  let replacement = '';
  const invite = parseAndStripShareInvite({ location: { href: inviteUrl, pathname: `/s/${shareId}`, search: '', hash: `#key=${base64UrlEncode(secret)}` },
    history: { state: { retained: true }, replaceState: (_data, _unused, url) => { replacement = String(url); } } });
  assert(invite.shareId === shareId && replacement === `/s/${shareId}`, 'share invite was not synchronously parsed and stripped');
  invite.linkSecret.fill(0);
  console.log('PASS durable /s invite parses and strips synchronously');
}

{
  const keys = expandShareLinkKeys(secret, 'comment');
  let sentBody = ''; let sentHeaders: HeadersInit | undefined;
  const transport = createShareMailboxTransport({ relayUrl: 'https://relay.example', linkKeys: keys, deviceId: 'device-a',
    mintPow: async () => 'pow-token', fetchImpl: async (_url, init) => {
      sentBody = String(init?.body); sentHeaders = init?.headers;
      return Response.json({ results: [{ envelopeId: 'outer-a', seq: 9, status: 'accepted' }] }, { status: 201 });
    } });
  await transport.submit({ shareId, bundleId: keys.bundleId, epoch: 4, revision: 8, tier: 'comment', roomId: 'room-a',
    capability: {}, capabilityFingerprint: 'F'.repeat(43), envelopeId: 'outer-a', wireHash: 'W'.repeat(43),
    canonicalWireBytes: new TextEncoder().encode('{"v":3,"envelopeId":"outer-a"}') });
  const body = JSON.parse(sentBody) as Record<string, unknown>;
  assert(JSON.stringify(Object.keys(body)) === JSON.stringify(['epoch','deviceId','items']) && body.epoch === 4 &&
    (body.items as Array<Record<string, unknown>>)[0]?.envelopeId === 'outer-a', 'mailbox body was not exact');
  const headers = new Headers(sentHeaders);
  assert(headers.get('Attn-Share-Bundle') === keys.bundleId && headers.get('Attn-PoW') === 'pow-token' &&
    headers.get('Attn-Admission')?.startsWith('v3.write.'), 'mailbox authentication headers are invalid');
  console.log('PASS share mailbox uses exact body and selected write admission');
}

{
  const keys = expandShareLinkKeys(secret, 'comment');
  const transport = createShareMailboxTransport({ relayUrl: 'https://relay.example', linkKeys: keys, deviceId: 'device-a',
    mintPow: async () => 'pow-token', fetchImpl: async () => Response.json({
      error: { code: 'ATTN_SHARE_EPOCH_STALE', currentEpoch: 5 }, currentEpoch: 5 }, { status: 409 }) });
  let stale = false;
  try { await transport.submit({ shareId, bundleId: keys.bundleId, epoch: 4, revision: 8, tier: 'comment', roomId: 'room-a',
    capability: {}, capabilityFingerprint: 'F'.repeat(43), envelopeId: 'outer-a', wireHash: 'W'.repeat(43),
    canonicalWireBytes: new TextEncoder().encode('{"v":3,"envelopeId":"outer-a"}') }); }
  catch (error) { stale = error instanceof StaleShareEpochError && error.currentEpoch === 5; }
  assert(stale, 'stale share epoch was not mapped');
  console.log('PASS share mailbox maps stale epoch 409');
}

{
  const keys = expandShareLinkKeys(secret, 'view');
  class FakeSocket {
    protocol = 'attn.v3'; onopen: (() => void) | null = null; onmessage: ((event: { data: string }) => void) | null = null;
    onerror: (() => void) | null = null; onclose: ((event: { code: number }) => void) | null = null; sent: string[] = [];
    send(value: string): void { this.sent.push(value); } close(): void {}
  }
  const sockets: FakeSocket[] = []; let protocols: string[] = []; const changes = { value: 0 };
  const changeCount = (): number => changes.value;
  const socketCount = (): number => sockets.length;
  const subscription = subscribeToDurableShareChanges({ relayUrl: 'https://relay.example', shareId, linkKeys: keys,
    onChange: () => { changes.value += 1; }, onError: error => { throw error; },
    reconnectInitialMs: 0, reconnectMaxMs: 1,
    webSocketFactory: (_url, requested) => { protocols = requested; const socket = new FakeSocket(); sockets.push(socket); return socket as unknown as WebSocket; } });
  assert(protocols.length === 3 && protocols[0] === 'attn.v3' && protocols[1] === `bundle.${keys.bundleId}` &&
    /^read-hmac\.[A-Za-z0-9_-]{43}$/u.test(protocols[2]!), 'watch subprotocol list/order is invalid');
  const socket = sockets[0]!;
  assert(changeCount() === 0, 'watch refetched before delayed open');
  socket.onopen?.();
  assert(changeCount() === 1, 'watch open did not fence the subscribe/resolve gap');
  socket.onmessage?.({ data: JSON.stringify({ type: 'ping', ts: 7 }) });
  socket.onmessage?.({ data: JSON.stringify({ type: 'share_changed', epoch: 2, revision: 3 }) });
  assert(socket.sent[0] === '{"type":"pong","ts":7}' && changeCount() === 2, 'watch frame handling is invalid');
  socket.onclose?.({ code: 1006 });
  await new Promise(resolve => setTimeout(resolve, 5));
  assert(socketCount() === 2, 'transient watch close did not reconnect');
  sockets[1]!.onopen?.();
  assert(changeCount() === 3, 'reconnected watch did not refence state');
  sockets[1]!.onclose?.({ code: 1000 });
  await new Promise(resolve => setTimeout(resolve, 5));
  assert(socketCount() === 3, 'unsolicited clean watch close did not reconnect');
  subscription.close();
  console.log('PASS share watch fences delayed open and reconnects transient or unsolicited clean closes');
}
