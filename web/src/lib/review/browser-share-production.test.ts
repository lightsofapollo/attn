import { base64UrlEncode, expandShareLinkKeys } from './browser-crypto';
import { deriveReadKeysV3, toCanonicalBytes } from './browser-crypto';
import { parseAndStripShareInvite } from './browser-share';
import { createBrowserDurableShareResolver, createShareMailboxTransport, decryptDurableShareSnapshot,
  DurableShareBrowserSessionFacade, reviewSnapshotFromDurable, subscribeToDurableShareChanges,
  type BrowserDurableSharePersistence } from './browser-share-production';
import { StaleShareEpochError } from './browser-share-session';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';

function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
const secret = new Uint8Array(32).fill(7);
const shareId = base64UrlEncode(new Uint8Array(16).fill(3));
const inviteUrl = `https://attn.sh/s/${shareId}#key=${base64UrlEncode(secret)}`;

{
  const mapped = reviewSnapshotFromDurable({ fileId: 'file-a', snapshotId: 'snapshot-a', docType: 'markdown', content: '# x' }, 'resolved-room');
  assert(mapped.roomId === 'resolved-room', 'durable snapshot lost its resolved room binding');
  console.log('PASS durable snapshot installation binds resolved room before state patch');
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
  const opened = decryptDurableShareSnapshot(shareId, 4, bundle, 'file-a', 'snapshot-a', sealed);
  assert(opened.content === '# exact' && (opened.metadata as { baseHash?: string }).baseHash === 'H'.repeat(43),
    'pinned durable snapshot did not open');
  let rejected = false;
  try { decryptDurableShareSnapshot(shareId, 5, bundle, 'file-a', 'snapshot-a', sealed); } catch { rejected = true; }
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
