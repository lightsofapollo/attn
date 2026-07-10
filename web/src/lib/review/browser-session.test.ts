// Manual test harness for `browser-session.ts` (planning issue attn-nnj.9.4).
//
// Spins up an in-process WS mock server, builds a `BrowserSession` with a
// stubbed `fetch` + `webSocketFactory`, and drives the orchestrator through:
//
//   - happy path: valid invite → POST /devices → WS hello → SnapshotCreated
//     event surfaces markdown via the reactive state.
//   - bad invite: no fragment → status: 'invalid_invite' (`invite_invalid`).
//   - device register failure: fetch returns 403 → status: 'error'.
//   - snapshot pipeline: SnapshotCreated event populates state and
//     reviewStore.snapshots so the read-only editor can render it.
//
// Run with:
//
//   cd web && npx tsx src/lib/review/browser-session.test.ts

import { WebSocket as NodeWebSocket, WebSocketServer, type WebSocket } from 'ws';
import 'fake-indexeddb/auto';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import {
  BrowserSession,
  buildRegisterDeviceBody,
  canonicalRegisterDeviceBytes,
  generateBrowserIdentity,
  admissionHeaderValue,
  type BrowserDeviceIdentity,
  type BrowserSessionState,
  type FetchLikeInit,
  type FetchLikeResponse,
  type ReviewStoreSink,
} from './browser-session';
import {
  aeadSeal,
  aeadOpen,
  base64UrlDecode,
  base64UrlEncode,
  contentHash,
  deriveEventId,
  deriveRoomId,
  deriveRoomKeys,
  signingKeyId,
  toCanonicalBytes,
  type EnvelopeAad,
  type SignableMetaShape,
  verifyEventSignature,
} from './browser-crypto';
import { composeInviteUrl } from './browser-invite';
import type {
  Anchor,
  ReviewEvent,
  ReviewSnapshot,
  FileId,
  SnapshotId,
  RoomId,
} from '../types';
import type { MailboxEnvelope, RoomPolicy, Device, WebSocketLike } from './browser-ws';
import { BrowserStorage, BROWSER_STORAGE_DB_NAME } from './browser-storage';

// ---------------------------------------------------------------------------
// In-test stand-in for the runes-backed reviewStore. Matches the
// `ReviewStoreSink` interface so we can swap it via `opts.store` without
// loading the `.svelte.ts` runes module under `tsx`.
// ---------------------------------------------------------------------------

interface StubStore extends ReviewStoreSink {
  events: ReviewEvent[];
  snapshots: ReviewSnapshot[];
  currentFileId: FileId | null;
  currentSnapshotId: SnapshotId | null;
}

function makeStubStore(): StubStore {
  const s: StubStore = {
    events: [],
    snapshots: [],
    currentFileId: null,
    currentSnapshotId: null,
    currentRoomId: null,
    applyEvent(event: ReviewEvent) {
      if (s.events.some((existing) => existing.meta.eventId === event.meta.eventId)) return;
      s.events = [...s.events, event];
    },
    applySnapshot(snapshot: ReviewSnapshot) {
      if (
        s.snapshots.some(
          (existing) =>
            existing.roomId === snapshot.roomId && existing.snapshotId === snapshot.snapshotId,
        )
      ) return;
      s.snapshots = [...s.snapshots, snapshot];
    },
    setCurrentFile(fileId: FileId | null) {
      s.currentFileId = fileId;
      s.currentSnapshotId = null;
    },
    setCurrentSnapshot(snapshotId: SnapshotId | null) {
      if (s.currentFileId === null) return;
      s.currentSnapshotId = snapshotId;
    },
    leaveRoom(roomId: RoomId) {
      s.events = s.events.filter((event) => event.meta.roomId !== roomId);
      s.snapshots = s.snapshots.filter((snapshot) => snapshot.roomId !== roomId);
      s.currentRoomId = null;
      s.currentFileId = null;
      s.currentSnapshotId = null;
    },
  };
  return s;
}

// ---------------------------------------------------------------------------
// Tiny harness
// ---------------------------------------------------------------------------

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
    } catch (err) {
      const message = err instanceof Error ? err.stack ?? err.message : String(err);
      return { name, ok: false, detail: message };
    }
  });
}

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

function assertEq<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)} got ${JSON.stringify(actual)}`);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function registrationAndOutboxFetch(
  url: string,
  init: FetchLikeInit,
): Promise<FetchLikeResponse> {
  if (init.method === 'GET') {
    return {
      status: 200,
      text: async () => JSON.stringify({ policy: POLICY, devices: [OWNER_DEVICE] }),
    };
  }
  if (url.endsWith('/envelopes')) {
    const parsed = JSON.parse(init.body ?? '{}') as {
      envelopes?: Array<{ envelopeId: string }>;
    };
    return {
      status: 201,
      text: async () =>
        JSON.stringify({
          accepted: (parsed.envelopes ?? []).map((item, index) => ({
            envelopeId: item.envelopeId,
            serverSeq: index + 1,
          })),
        }),
    };
  }
  return { status: 204, text: async () => '' };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ROOM_SECRET = new Uint8Array(32).fill(0x99);
const ROOM_ID = deriveRoomId(ROOM_SECRET);
const KEYS = deriveRoomKeys(ROOM_SECRET);

const OWNER_SIGNING_SEED = new Uint8Array(32).fill(0x33);
const OWNER_KEYPAIR = (() => {
  const { secretKey, publicKey } = ed25519.keygen(OWNER_SIGNING_SEED);
  return { secret: secretKey, publicKey };
})();
const OWNER_SIGNING_KEY_ID = base64UrlEncode(sha256(OWNER_KEYPAIR.publicKey));

function signedDirectoryDevice(
  unsigned: Omit<Device, 'selfSignature'>,
  signingSecret: Uint8Array,
): Device {
  const canonical = toCanonicalBytes({
    client: unsigned.client,
    deviceId: unsigned.deviceId,
    kind: unsigned.kind,
    participantId: unsigned.participantId,
    publicEncryptionKey: unsigned.publicEncryptionKey,
    publicSigningKey: unsigned.publicSigningKey,
  });
  return { ...unsigned, selfSignature: base64UrlEncode(ed25519.sign(canonical, signingSecret)) };
}

const OWNER_DEVICE: Device = signedDirectoryDevice({
  deviceId: 'd-owner-01',
  participantId: 'p-owner-01',
  publicEncryptionKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  publicSigningKey: base64UrlEncode(OWNER_KEYPAIR.publicKey),
  client: 'attn-native',
  kind: 'owner',
  registeredAt: 1_700_000_000_000,
}, OWNER_KEYPAIR.secret);

const POLICY: RoomPolicy = {
  mode: 'live',
  maxPeers: 8,
  maxSnapshotBytes: 5 * 1024 * 1024,
  maxEventBytes: 256 * 1024,
  maxEvents: 1000,
  expiresAt: 1_900_000_000_000,
  powBits: 12,
  deleteEventsAfterOwnerAck: false,
  allowBrowser: true,
  allowRemoteAgents: false,
};

interface MockServer {
  port: number;
  onClient: (handler: (ws: WebSocket, subprotocol: string) => void) => void;
  close: () => Promise<void>;
}

async function startMockServer(): Promise<MockServer> {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const addr = server.address();
  if (typeof addr === 'string' || addr === null) {
    throw new Error('mock server returned unexpected address');
  }
  const port = addr.port;
  const handlers: Array<(ws: WebSocket, sub: string) => void> = [];
  server.on('connection', (ws, req) => {
    const protoHeader: string | string[] | undefined = req.headers['sec-websocket-protocol'];
    const sub =
      typeof protoHeader === 'string'
        ? protoHeader
        : Array.isArray(protoHeader)
          ? (protoHeader as string[]).join(', ')
          : '';
    for (const h of handlers) {
      try {
        h(ws, sub);
      } catch (err) {
        console.error('mock handler threw:', err);
      }
    }
  });
  return {
    port,
    onClient: (h) => handlers.push(h),
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        for (const c of server.clients) {
          try {
            c.terminate();
          } catch {
            // ignore
          }
        }
      }),
  };
}

function nodeFactory(url: string, protocols: string | string[]): WebSocketLike {
  const sock = new NodeWebSocket(url, protocols);
  const wrapped: WebSocketLike = {
    get readyState() {
      return sock.readyState;
    },
    send(data: string) {
      sock.send(data);
    },
    close(code?: number, reason?: string) {
      sock.close(code, reason);
    },
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
  };
  sock.on('open', () => {
    wrapped.onopen?.({});
  });
  sock.on('message', (data: unknown, _isBinary: boolean) => {
    let str: string;
    if (typeof data === 'string') {
      str = data;
    } else if (data instanceof Buffer) {
      str = data.toString('utf8');
    } else if (data instanceof ArrayBuffer) {
      str = Buffer.from(data).toString('utf8');
    } else if (Array.isArray(data)) {
      str = Buffer.concat(data as Buffer[]).toString('utf8');
    } else {
      str = String(data);
    }
    wrapped.onmessage?.({ data: str });
  });
  sock.on('close', (code: number, reasonBuf: Buffer) => {
    wrapped.onclose?.({ code, reason: reasonBuf.toString('utf8') });
  });
  sock.on('error', () => {
    wrapped.onerror?.({});
  });
  return wrapped;
}

/**
 * Build a SnapshotCreated event envelope signed by `OWNER_KEYPAIR` and sealed
 * under `KEYS.eventKey`. Mirrors the shape `browser-ws.test.ts::mintEventEnvelope`
 * produces but for the snapshot_created body.
 */
function mintSnapshotEnvelope(
  roomId: string,
  envelopeId: string,
  createdAt: number,
  content: string,
  fileId: string,
  snapshotId: string,
  docType: 'markdown' | 'html' = 'markdown',
  mailboxBlobId?: string,
  blobRefOverride?: { byteLength?: number; contentHash?: string },
  blobStorage: 'mailbox' | 'r2' = 'mailbox',
): MailboxEnvelope {
  const meta: SignableMetaShape = {
    v: 2,
    eventId: '',
    roomId,
    authorId: OWNER_DEVICE.participantId,
    deviceId: OWNER_DEVICE.deviceId,
    createdAt,
    parentEventIds: [],
  };
  // Minimal but valid AnchorIndex — the snapshot path doesn't render the
  // index in the editor (read-only) but the type demands it.
  const anchorIndex = {
    docHash: 'hash-' + snapshotId,
    canonicalEncoding: 'utf8-bytes' as const,
    lineCount: content.split('\n').length,
    blocks: [],
    headings: [],
  };
  const blobBytes = snapshotPlaintextBytes(content, snapshotId, docType);
  const body = {
    type: 'snapshot_created',
    fileId,
    snapshotId,
    baseHash: 'hash-' + snapshotId,
    // HTML docs are read-only and carry no anchor index.
    ...(mailboxBlobId
      ? {
          encryptedBlobRef: {
            storage: blobStorage,
            blobId: mailboxBlobId,
            byteLength: blobRefOverride?.byteLength ?? blobBytes.length,
            contentHash: blobRefOverride?.contentHash ?? contentHash(blobBytes),
          },
          inlineSnapshot: null,
        }
      : {
          inlineSnapshot:
            docType === 'html'
              ? { docType, content }
              : { docType, content, anchorIndex },
        }),
  };
  meta.eventId = deriveEventId(meta, body);
  const parents = (meta.parentEventIds ?? []).slice().sort();
  const signableMeta: Record<string, unknown> = {
    v: meta.v,
    roomId: meta.roomId,
    authorId: meta.authorId,
    deviceId: meta.deviceId,
    createdAt: meta.createdAt,
    parentEventIds: parents,
  };
  const signed = toCanonicalBytes({ body, meta: signableMeta });
  const sig = ed25519.sign(signed, OWNER_KEYPAIR.secret);
  const auth = { signature: base64UrlEncode(sig), signingKeyId: OWNER_SIGNING_KEY_ID };
  const wireMeta = { ...meta };
  const plaintextBytes = toCanonicalBytes({ auth, body, meta: wireMeta });
  const nonce = new Uint8Array(24);
  for (let i = 0; i < nonce.length; i++) nonce[i] = 0x40 + i;
  const aad: EnvelopeAad = {
    v: 2,
    roomId,
    envelopeId,
    kind: 'event',
    authorId: OWNER_DEVICE.participantId,
    deviceId: OWNER_DEVICE.deviceId,
    createdAt,
  };
  const ct = aeadSeal(KEYS.eventKey, nonce, plaintextBytes, aad);
  return {
    v: 2,
    roomId,
    envelopeId,
    authorId: OWNER_DEVICE.participantId,
    deviceId: OWNER_DEVICE.deviceId,
    createdAt,
    expiresAt: createdAt + 7 * 24 * 60 * 60 * 1000,
    kind: 'event',
    nonce: base64UrlEncode(nonce),
    ciphertext: base64UrlEncode(ct),
    ciphertextBytes: ct.length,
  };
}

function mintSnapshotBlobEnvelope(
  roomId: string,
  envelopeId: string,
  createdAt: number,
  content: string,
  snapshotId: string,
): MailboxEnvelope {
  const plaintext = snapshotPlaintextBytes(content, snapshotId, 'markdown');
  const nonce = new Uint8Array(24);
  for (let i = 0; i < nonce.length; i++) nonce[i] = 0x70 + i;
  const aad: EnvelopeAad = {
    v: 2,
    roomId,
    envelopeId,
    kind: 'snapshot_blob',
    authorId: OWNER_DEVICE.participantId,
    deviceId: OWNER_DEVICE.deviceId,
    createdAt,
  };
  const ct = aeadSeal(KEYS.snapshotKey, nonce, plaintext, aad);
  return {
    v: 2,
    roomId,
    envelopeId,
    authorId: OWNER_DEVICE.participantId,
    deviceId: OWNER_DEVICE.deviceId,
    createdAt,
    expiresAt: createdAt + 7 * 24 * 60 * 60 * 1000,
    kind: 'snapshot_blob',
    nonce: base64UrlEncode(nonce),
    ciphertext: base64UrlEncode(ct),
    ciphertextBytes: ct.length,
  };
}

function mintR2SnapshotBlobEnvelope(
  roomId: string,
  envelopeId: string,
  createdAt: number,
  content: string,
  snapshotId: string,
): { wrapper: MailboxEnvelope; sealedBody: Uint8Array } {
  const snapshotBytes = snapshotPlaintextBytes(content, snapshotId, 'markdown');
  const aad: EnvelopeAad = {
    v: 2,
    roomId,
    envelopeId,
    kind: 'snapshot_blob',
    authorId: OWNER_DEVICE.participantId,
    deviceId: OWNER_DEVICE.deviceId,
    createdAt,
  };
  const blobRef = toCanonicalBytes({
    storage: 'r2',
    blobId: envelopeId,
    byteLength: snapshotBytes.length,
    contentHash: contentHash(snapshotBytes),
  });
  const wrapperNonce = new Uint8Array(24).fill(0x91);
  const wrapperCiphertext = aeadSeal(KEYS.snapshotKey, wrapperNonce, blobRef, aad);
  const r2Nonce = new Uint8Array(24).fill(0xa2);
  const r2Ciphertext = aeadSeal(KEYS.snapshotKey, r2Nonce, snapshotBytes, aad);
  const sealedBody = new Uint8Array(r2Nonce.length + r2Ciphertext.length);
  sealedBody.set(r2Nonce, 0);
  sealedBody.set(r2Ciphertext, r2Nonce.length);
  const wrapper: MailboxEnvelope = {
    v: 2,
    roomId,
    envelopeId,
    authorId: OWNER_DEVICE.participantId,
    deviceId: OWNER_DEVICE.deviceId,
    createdAt,
    expiresAt: createdAt + 7 * 24 * 60 * 60 * 1000,
    kind: 'snapshot_blob',
    nonce: base64UrlEncode(wrapperNonce),
    ciphertext: base64UrlEncode(wrapperCiphertext),
    ciphertextBytes: wrapperCiphertext.length,
  };
  snapshotBytes.fill(0);
  blobRef.fill(0);
  wrapperNonce.fill(0);
  wrapperCiphertext.fill(0);
  r2Nonce.fill(0);
  r2Ciphertext.fill(0);
  return { wrapper, sealedBody };
}

function snapshotPlaintextBytes(
  content: string,
  snapshotId: string,
  docType: 'markdown' | 'html',
): Uint8Array {
  return toCanonicalBytes({
    docType,
    content,
    ...(docType === 'markdown'
      ? {
          anchorIndex: {
            docHash: 'hash-' + snapshotId,
            canonicalEncoding: 'utf8-bytes',
            lineCount: content.split('\n').length,
            blocks: [],
            headings: [],
          },
        }
      : {}),
  });
}

async function assertInvalidBlobRefRejected(
  override: { byteLength?: number; contentHash?: string },
): Promise<void> {
  const store = makeStubStore();
  const server = await startMockServer();
  try {
    const markdown = '# Integrity failure\n';
    const blobId = 'env-invalid-blob';
    server.onClient((ws) => {
      ws.on('message', (raw) => {
        const msg = JSON.parse(String(raw));
        if (msg.type !== 'subscribe') return;
        ws.send(
          JSON.stringify({
            type: 'hello',
            serverSeq: 0,
            policy: POLICY,
            devices: [OWNER_DEVICE],
            missedSignalEnvelopeIds: [],
          }),
        );
        ws.send(
          JSON.stringify({
            type: 'envelope',
            envelope: mintSnapshotBlobEnvelope(
              ROOM_ID,
              blobId,
              1_700_000_610_000,
              markdown,
              'snap-invalid',
            ),
            serverSeq: 20,
          }),
        );
        ws.send(
          JSON.stringify({
            type: 'envelope',
            envelope: mintSnapshotEnvelope(
              ROOM_ID,
              'env-invalid-pointer',
              1_700_000_610_001,
              markdown,
              'file-invalid',
              'snap-invalid',
              'markdown',
              blobId,
              override,
            ),
            serverSeq: 21,
          }),
        );
      });
    });
    const session = new BrowserSession({
      inviteUrl: composeInviteUrl('http://example.com/review', ROOM_ID, ROOM_SECRET),
      relayUrl: `http://127.0.0.1:${server.port}`,
      identity: deterministicIdentity(),
      powToken: 'test-pow-token',
      store,
      fetchImpl: registrationAndOutboxFetch,
      webSocketFactory: nodeFactory,
      reconnectInitialMs: 50,
      reconnectMaxMs: 200,
    });
    await session.start();
    for (let i = 0; i < 100 && session.getState().status !== 'error'; i++) await delay(20);
    assertEq(session.getState().status, 'error', 'signed BlobRef mismatch is terminal');
    assertEq(session.getState().snapshotContent, null, 'mismatched plaintext is not retained');
    assertEq(store.snapshots.length, 0, 'mismatched snapshot is not stored');
    session.close();
  } finally {
    await server.close();
  }
}

// (stub store is reset per-case via makeStubStore())

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

defineCase('canonicalRegisterDeviceBytes is deterministic and excludes selfSignature', () => {
  const identity = deterministicIdentity();
  const body = buildRegisterDeviceBody(identity);
  // selfSignature should be a valid base64url-no-pad of 64 bytes.
  assert(body.selfSignature.length > 0, 'selfSignature filled');
  // Canonical bytes must NOT include selfSignature key.
  const bytes = canonicalRegisterDeviceBytes(body);
  const str = new TextDecoder().decode(bytes);
  assert(!str.includes('selfSignature'), 'canonical bytes must omit selfSignature');
  assert(str.includes('"client":"attn-browser"'), 'client field present');
  assert(str.includes('"kind":"reviewer"'), 'kind field is reviewer');
});

defineCase('admissionHeaderValue prefixes with v2. and base64url-encodes the tag', () => {
  const key = new Uint8Array(32).fill(0x11);
  const value = admissionHeaderValue(key, 'POST', '/v2/rooms/r/devices', new Uint8Array(0));
  assert(value.startsWith('v2.'), `expected v2. prefix, got ${value.slice(0, 8)}`);
  const tag = value.slice(3);
  // base64url-no-pad of HMAC-SHA-256 is 43 chars.
  assertEq(tag.length, 43, 'tag length 43 chars (32 bytes base64url-no-pad)');
});

defineCase('happy path: invite → POST /devices → WS hello → connected', async () => {
  const store = makeStubStore();
  const server = await startMockServer();
  try {
    let devicePosts = 0;
    server.onClient((ws) => {
      ws.on('message', (raw) => {
        const msg = JSON.parse(String(raw));
        if (msg.type === 'subscribe') {
          ws.send(
            JSON.stringify({
              type: 'hello',
              serverSeq: 0,
              policy: POLICY,
              devices: [OWNER_DEVICE],
              missedSignalEnvelopeIds: [],
            }),
          );
        }
      });
    });

    const inviteUrl = composeInviteUrl('http://example.com/review', ROOM_ID, ROOM_SECRET);
    const states: BrowserSessionState[] = [];
    const identity = deterministicIdentity();
    const session = new BrowserSession({
      inviteUrl,
      relayUrl: `http://127.0.0.1:${server.port}`,
      identity,
      powToken: 'test-pow-token',
      store,
      fetchImpl: async (url: string, init: FetchLikeInit): Promise<FetchLikeResponse> => {
        if (init.method === 'GET') return registrationAndOutboxFetch(url, init);
        if (url.endsWith('/envelopes')) return registrationAndOutboxFetch(url, init);
        devicePosts += 1;
        assert(
          url.endsWith(`/v2/rooms/${ROOM_ID}/devices`),
          `expected POST /devices URL, got ${url}`,
        );
        assertEq(init.headers?.['Attn-PoW'], 'test-pow-token', 'injected PoW header');
        return { status: 204, text: async () => '' };
      },
      webSocketFactory: nodeFactory,
      onState: (s) => {
        states.push({ ...s });
      },
      reconnectInitialMs: 50,
      reconnectMaxMs: 200,
    });

    await session.start();
    // Poll until connected
    for (let i = 0; i < 80 && session.getState().status !== 'connected'; i++) await delay(20);
    assertEq(session.getState().status, 'connected', 'reaches connected after hello');
    for (let i = 0; i < 80 && !session.getState().authoringReady; i++) await delay(20);
    assertEq(session.getState().authoringReady, true, 'ParticipantJoined acknowledged');
    assertEq(devicePosts, 1, 'POST /devices called exactly once');
    const orderedStatuses = states.map((s) => s.status);
    assert(
      orderedStatuses.includes('parsing_invite'),
      `should pass through parsing_invite; got ${orderedStatuses.join(',')}`,
    );
    assert(
      orderedStatuses.includes('registering_device'),
      `should pass through registering_device; got ${orderedStatuses.join(',')}`,
    );
    assert(
      orderedStatuses.includes('connecting'),
      `should pass through connecting; got ${orderedStatuses.join(',')}`,
    );
    assertEq(store.currentRoomId, ROOM_ID as unknown as RoomId, 'store.currentRoomId set');
    const internalKeys = (session as unknown as { keys: typeof KEYS | null }).keys;
    assert(internalKeys !== null, 'derived room keys retained while connected');
    session.close();
    for (const [label, bytes] of Object.entries({
      rootKey: internalKeys.rootKey,
      eventKey: internalKeys.eventKey,
      snapshotKey: internalKeys.snapshotKey,
      signalingKey: internalKeys.signalingKey,
      admissionKey: internalKeys.admissionKey,
      signingSecret: identity.signingSecret,
      encryptionSecret: identity.encryptionSecret,
    })) {
      assert(bytes.every((byte) => byte === 0), `${label} zeroed on close`);
    }
  } finally {
    await server.close();
  }
});

defineCase('browser authoring posts signed ciphertext, echoes locally, and preserves event order', async () => {
  const store = makeStubStore();
  const server = await startMockServer();
  const identity = deterministicIdentity();
  const browserDevice: Device = signedDirectoryDevice({
    deviceId: identity.deviceId,
    participantId: identity.participantId,
    publicEncryptionKey: base64UrlEncode(identity.publicEncryptionKey),
    publicSigningKey: base64UrlEncode(identity.signingPublic),
    client: 'attn-browser',
    kind: 'reviewer',
    registeredAt: 1_700_000_000_100,
  }, identity.signingSecret);
  const postedEvents: ReviewEvent[] = [];
  const rawBodies: string[] = [];
  let connected: WebSocket | null = null;
  let serverSeq = 30;
  try {
    server.onClient((ws) => {
      connected = ws;
      ws.on('message', (raw) => {
        const msg = JSON.parse(String(raw));
        if (msg.type !== 'subscribe') return;
        ws.send(
          JSON.stringify({
            type: 'hello',
            serverSeq: 0,
            policy: POLICY,
            devices: [OWNER_DEVICE, browserDevice],
            missedSignalEnvelopeIds: [],
          }),
        );
      });
    });
    const session = new BrowserSession({
      inviteUrl: composeInviteUrl('http://example.com/review', ROOM_ID, ROOM_SECRET),
      relayUrl: `http://127.0.0.1:${server.port}`,
      identity,
      powToken: 'test-registration-pow',
      outboxMintPow: async () => `test-event-pow-${postedEvents.length + 1}`,
      store,
      fetchImpl: async (url, init) => {
        if (init.method === 'GET') {
          return {
            status: 200,
            text: async () => JSON.stringify({ policy: POLICY, devices: [OWNER_DEVICE] }),
          };
        }
        if (!url.endsWith('/envelopes')) return { status: 204, text: async () => '' };
        const rawBody = init.body ?? '';
        rawBodies.push(rawBody);
        const parsed = JSON.parse(rawBody) as { envelopes: MailboxEnvelope[] };
        const accepted: Array<{ envelopeId: string; serverSeq: number }> = [];
        for (const envelope of parsed.envelopes) {
          const aad: EnvelopeAad = {
            v: 2,
            roomId: ROOM_ID,
            envelopeId: envelope.envelopeId,
            kind: 'event',
            authorId: envelope.authorId,
            deviceId: envelope.deviceId,
            createdAt: envelope.createdAt,
          };
          const plaintext = aeadOpen(
            KEYS.eventKey,
            base64UrlDecode(envelope.nonce),
            base64UrlDecode(envelope.ciphertext),
            aad,
          );
          const event = JSON.parse(new TextDecoder().decode(plaintext)) as ReviewEvent;
          plaintext.fill(0);
          verifyEventSignature(event.meta, event.body, event.auth, identity.signingPublic);
          postedEvents.push(event);
          serverSeq += 1;
          accepted.push({ envelopeId: envelope.envelopeId, serverSeq });
          connected?.send(
            JSON.stringify({ type: 'envelope', envelope, serverSeq }),
          );
        }
        return { status: 201, text: async () => JSON.stringify({ accepted }) };
      },
      webSocketFactory: nodeFactory,
      reconnectInitialMs: 50,
      reconnectMaxMs: 200,
    });

    await session.start();
    for (let i = 0; i < 100 && !session.getState().authoringReady; i++) await delay(20);
    assertEq(session.getState().authoringReady, true, 'join acknowledged before authoring');
    const anchor: Anchor = {
      v: 2,
      fileId: 'file-browser-authoring',
      snapshotId: 'snapshot-browser-authoring',
      baseHash: 'hash-browser-authoring',
      position: { byteRange: [0, 5], lineRange: [1, 1], pmRange: [1, 6] },
    };
    const root = await session.createComment(anchor, 'comment alpha');
    assertEq(root.body.type, 'comment_created', 'root comment body');
    const threadId = root.body.type === 'comment_created' ? root.body.threadId : '';
    await session.replyToComment(anchor, 'reply beta', threadId);
    await session.resolveComment(threadId);
    await session.createSuggestion({
      anchor,
      operation: { kind: 'replace', expectedText: 'alpha', replacement: 'gamma' },
      note: 'suggestion delta',
    });
    for (let i = 0; i < 100 && (postedEvents.length < 5 || session.getState().outboxPending > 0); i++) {
      await delay(20);
    }

    const eventTypes = postedEvents.map((event) => event.body.type);
    assertEq(
      JSON.stringify(eventTypes),
      JSON.stringify([
        'participant_joined',
        'comment_created',
        'comment_created',
        'comment_resolved',
        'suggestion_created',
      ]),
      'native-compatible event order',
    );
    const joined = postedEvents[0]?.body;
    assert(joined?.type === 'participant_joined', 'first event is ParticipantJoined');
    assert(
      joined.device.publicEncryptionKey !== 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      'ParticipantJoined publishes a real X25519 key',
    );
    const wire = rawBodies.join('\n');
    for (const secret of ['comment alpha', 'reply beta', 'gamma', 'suggestion delta']) {
      assert(!wire.includes(secret), `relay body does not expose ${secret}`);
    }
    assertEq(store.events.length, 5, 'optimistic and WebSocket echoes dedupe by eventId');
    assert(store.events.every((event) => event.auth.signature.length > 0), 'store keeps real auth');
    assertEq(session.getState().outboxPending, 0, 'outbox fully acknowledged');
    session.close();
  } finally {
    await server.close();
  }
});

defineCase('invalid invite → error UI with invite_invalid', async () => {
  const store = makeStubStore();
  const session = new BrowserSession({
    inviteUrl: 'https://example.com/review/badroom#key=notbase64',
    store,
  });
  await session.start();
  assertEq(session.getState().status, 'error', 'enters error state');
  assertEq(session.getState().error?.kind, 'invite_invalid', 'tagged invite_invalid');
});

defineCase('missing invite (no override + no fragment) → invite_invalid', async () => {
  const store = makeStubStore();
  const session = new BrowserSession({
    window: { location: { hash: '', origin: 'https://x', pathname: '/review/r' } },
    store,
  });
  await session.start();
  assertEq(session.getState().status, 'error', 'enters error state');
  assertEq(session.getState().error?.kind, 'invite_invalid', 'tagged invite_invalid');
});

defineCase('POST /devices 403 → status=error, kind=device_register', async () => {
  const store = makeStubStore();
  const server = await startMockServer();
  try {
    server.onClient(() => {
      // never reached — fetch fails first
    });
    const inviteUrl = composeInviteUrl('http://example.com/review', ROOM_ID, ROOM_SECRET);
    const session = new BrowserSession({
      inviteUrl,
      relayUrl: `http://127.0.0.1:${server.port}`,
      identity: deterministicIdentity(),
      powToken: 'test-pow-token',
      store,
      fetchImpl: async (_url, init) =>
        init.method === 'GET'
          ? {
              status: 200,
              text: async () => JSON.stringify({ policy: POLICY, devices: [OWNER_DEVICE] }),
            }
          : {
              status: 403,
              text: async () => '{"error":{"code":"ATTN_POW_REQUIRED"}}',
            },
      webSocketFactory: nodeFactory,
    });
    await session.start();
    assertEq(session.getState().status, 'error', 'error state');
    assertEq(session.getState().error?.kind, 'device_register', 'device_register tag');
  } finally {
    await server.close();
  }
});

defineCase('registration PoW uses authenticated room policy difficulty', async () => {
  const store = makeStubStore();
  const server = await startMockServer();
  let difficulty = 0;
  try {
    server.onClient(() => undefined);
    const highPowPolicy = { ...POLICY, powBits: 19 };
    const session = new BrowserSession({
      inviteUrl: composeInviteUrl('http://example.com/review', ROOM_ID, ROOM_SECRET),
      relayUrl: `http://127.0.0.1:${server.port}`,
      identity: deterministicIdentity(),
      store,
      registrationMintPow: async (input) => {
        difficulty = input.difficulty;
        return 'policy-registration-pow';
      },
      fetchImpl: async (_url, init) =>
        init.method === 'GET'
          ? {
              status: 200,
              text: async () => JSON.stringify({ policy: highPowPolicy, devices: [OWNER_DEVICE] }),
            }
          : { status: 204, text: async () => '' },
      webSocketFactory: nodeFactory,
    });
    await session.start();
    assertEq(difficulty, 19, 'registration difficulty');
    session.close();
  } finally {
    await server.close();
  }
});

defineCase('SnapshotCreated event populates state.snapshotContent + store', async () => {
  const store = makeStubStore();
  const server = await startMockServer();
  try {
    const markdown = '# Hello reviewer\n\nThis is the snapshot under review.\n';
    server.onClient((ws) => {
      ws.on('message', (raw) => {
        const msg = JSON.parse(String(raw));
        if (msg.type === 'subscribe') {
          ws.send(
            JSON.stringify({
              type: 'hello',
              serverSeq: 0,
              policy: POLICY,
              devices: [OWNER_DEVICE],
              missedSignalEnvelopeIds: [],
            }),
          );
          const env = mintSnapshotEnvelope(
            ROOM_ID,
            'env-snap-1',
            1_700_000_500_000,
            markdown,
            'file-1',
            'snap-1',
          );
          ws.send(JSON.stringify({ type: 'envelope', envelope: env, serverSeq: 10 }));
        }
      });
    });

    const inviteUrl = composeInviteUrl('http://example.com/review', ROOM_ID, ROOM_SECRET);
    const session = new BrowserSession({
      inviteUrl,
      relayUrl: `http://127.0.0.1:${server.port}`,
      identity: deterministicIdentity(),
      powToken: 'test-pow-token',
      store,
      fetchImpl: registrationAndOutboxFetch,
      webSocketFactory: nodeFactory,
      reconnectInitialMs: 50,
      reconnectMaxMs: 200,
    });

    await session.start();
    // Poll until content is populated.
    for (let i = 0; i < 100 && session.getState().snapshotContent === null; i++) {
      await delay(20);
    }
    assertEq(
      session.getState().snapshotContent,
      markdown,
      'snapshotContent populated from event',
    );
    assertEq(
      session.getState().snapshotDocType,
      'markdown',
      'snapshotDocType defaults to markdown',
    );
    assertEq(session.getState().snapshotId, 'snap-1' as unknown as SnapshotId, 'snapshotId tracked');
    assertEq(session.getState().fileId, 'file-1' as unknown as FileId, 'fileId tracked');
    // Store-side: snapshots should have the snapshot, and the
    // current file/snapshot pointers should be set so the existing
    // ReviewMargin / threadsForCurrentFile selectors see it.
    assertEq(store.snapshots.length, 1, 'one snapshot imported');
    assertEq(store.snapshots[0]!.snapshotId, 'snap-1' as unknown as SnapshotId, 'snapshot id mirror');
    assertEq(store.currentFileId, 'file-1' as unknown as FileId, 'currentFileId set');
    assertEq(store.currentSnapshotId, 'snap-1' as unknown as SnapshotId, 'currentSnapshotId set');
    // The event itself should also be in the append-only log so any
    // downstream selectors (threads, decorations) see it.
    assertEq(store.events.length, 2, 'ParticipantJoined and snapshot appended');
    assertEq(store.events[0]?.body.type, 'participant_joined', 'join is first browser event');
    assertEq(store.events[1]?.body.type, 'snapshot_created', 'snapshot follows join');
    session.close();
  } finally {
    await server.close();
  }
});

defineCase('mailbox snapshot_blob rehydrates a native SnapshotCreated pointer', async () => {
  const store = makeStubStore();
  const server = await startMockServer();
  try {
    const markdown = '# Native mailbox snapshot\n\nDecrypted in the browser.\n';
    const blobId = 'env-native-blob-1';
    server.onClient((ws) => {
      ws.on('message', (raw) => {
        const msg = JSON.parse(String(raw));
        if (msg.type !== 'subscribe') return;
        ws.send(
          JSON.stringify({
            type: 'hello',
            serverSeq: 0,
            policy: POLICY,
            devices: [OWNER_DEVICE],
            missedSignalEnvelopeIds: [],
          }),
        );
        ws.send(
          JSON.stringify({
            type: 'envelope',
            envelope: mintSnapshotBlobEnvelope(
              ROOM_ID,
              blobId,
              1_700_000_600_000,
              markdown,
              'snap-mailbox-1',
            ),
            serverSeq: 10,
          }),
        );
        ws.send(
          JSON.stringify({
            type: 'envelope',
            envelope: mintSnapshotEnvelope(
              ROOM_ID,
              'env-snapshot-pointer-1',
              1_700_000_600_001,
              markdown,
              'file-mailbox-1',
              'snap-mailbox-1',
              'markdown',
              blobId,
            ),
            serverSeq: 11,
          }),
        );
      });
    });

    const session = new BrowserSession({
      inviteUrl: composeInviteUrl('http://example.com/review', ROOM_ID, ROOM_SECRET),
      relayUrl: `http://127.0.0.1:${server.port}`,
      identity: deterministicIdentity(),
      powToken: 'test-pow-token',
      store,
      fetchImpl: registrationAndOutboxFetch,
      webSocketFactory: nodeFactory,
      reconnectInitialMs: 50,
      reconnectMaxMs: 200,
    });

    await session.start();
    for (let i = 0; i < 100 && session.getState().snapshotContent === null; i++) {
      await delay(20);
    }
    assertEq(session.getState().snapshotContent, markdown, 'mailbox content rehydrated');
    assertEq(session.getState().snapshotId, 'snap-mailbox-1' as SnapshotId, 'snapshot pointer');
    assertEq(store.snapshots.length, 1, 'rehydrated snapshot imported once');
    assertEq(store.snapshots[0]!.anchorIndex?.lineCount, 4, 'anchor index imported');
    assertEq(store.events.length, 2, 'join and pointer remain in event log');
    assertEq(store.events[0]?.body.type, 'participant_joined', 'join precedes pointer');
    session.close();
  } finally {
    await server.close();
  }
});

defineCase('R2 snapshot_blob downloads, authenticates, and rehydrates a native pointer', async () => {
  const store = makeStubStore();
  const server = await startMockServer();
  try {
    const markdown = '# Native R2 snapshot\n\nEncrypted spillover rendered in browser.\n';
    const blobId = 'env-native-r2-blob-1';
    const createdAt = 1_700_000_605_000;
    const r2 = mintR2SnapshotBlobEnvelope(
      ROOM_ID,
      blobId,
      createdAt,
      markdown,
      'snap-r2-1',
    );
    server.onClient((ws) => {
      ws.on('message', (raw) => {
        const msg = JSON.parse(String(raw));
        if (msg.type !== 'subscribe') return;
        ws.send(JSON.stringify({
          type: 'hello',
          serverSeq: 0,
          policy: POLICY,
          devices: [OWNER_DEVICE],
          missedSignalEnvelopeIds: [],
        }));
        ws.send(JSON.stringify({ type: 'envelope', envelope: r2.wrapper, serverSeq: 12 }));
        ws.send(JSON.stringify({
          type: 'envelope',
          envelope: mintSnapshotEnvelope(
            ROOM_ID,
            'env-r2-pointer-1',
            createdAt + 1,
            markdown,
            'file-r2-1',
            'snap-r2-1',
            'markdown',
            blobId,
            undefined,
            'r2',
          ),
          serverSeq: 13,
        }));
      });
    });
    const relayUrl = `http://127.0.0.1:${server.port}`;
    const requested: string[] = [];
    const session = new BrowserSession({
      inviteUrl: composeInviteUrl('http://example.com/review', ROOM_ID, ROOM_SECRET),
      relayUrl,
      identity: deterministicIdentity(),
      powToken: 'test-pow-token',
      store,
      fetchImpl: registrationAndOutboxFetch,
      r2FetchImpl: async (url) => {
        requested.push(url);
        if (!url.includes('?cap=')) {
          return Response.json({
            downloadUrl: `/v2/rooms/${ROOM_ID}/blobs/${blobId}?cap=opaque-test-cap`,
            method: 'GET',
            expiresAt: Date.now() + 5 * 60_000,
          });
        }
        return new Response(new Uint8Array(r2.sealedBody), {
          status: 200,
          headers: { 'Content-Type': 'application/octet-stream' },
        });
      },
      webSocketFactory: nodeFactory,
      reconnectInitialMs: 50,
      reconnectMaxMs: 200,
    });
    await session.start();
    for (let i = 0; i < 100 && session.getState().snapshotContent === null; i++) await delay(20);
    assertEq(session.getState().snapshotContent, markdown, 'R2 plaintext renders only after verification');
    assertEq(store.snapshots.length, 1, 'R2 snapshot imported once');
    assertEq(requested.length, 2, 'presign and sealed-body GET executed');
    assert(!requested[0]!.includes('cap='), 'presign request carries no capability');
    session.close();
    r2.sealedBody.fill(0);
  } finally {
    await server.close();
  }
});

defineCase('mailbox SnapshotCreated rejects wrong signed BlobRef length and hash', async () => {
  await assertInvalidBlobRefRejected({ byteLength: 1 });
  await assertInvalidBlobRefRejected({ contentHash: 'wrong-content-hash' });
});

defineCase('unknown snapshot signer refreshes GET /devices and retries once', async () => {
  const store = makeStubStore();
  const server = await startMockServer();
  try {
    const markdown = '# Late signer snapshot\n';
    server.onClient((ws) => {
      ws.on('message', (raw) => {
        const msg = JSON.parse(String(raw));
        if (msg.type !== 'subscribe') return;
        ws.send(
          JSON.stringify({
            type: 'hello',
            serverSeq: 0,
            policy: POLICY,
            devices: [],
            missedSignalEnvelopeIds: [],
          }),
        );
        ws.send(
          JSON.stringify({
            type: 'envelope',
            envelope: mintSnapshotEnvelope(
              ROOM_ID,
              'env-late-signer-snapshot',
              1_700_000_620_000,
              markdown,
              'file-late',
              'snap-late',
            ),
            serverSeq: 22,
          }),
        );
      });
    });
    let deviceGets = 0;
    const session = new BrowserSession({
      inviteUrl: composeInviteUrl('http://example.com/review', ROOM_ID, ROOM_SECRET),
      relayUrl: `http://127.0.0.1:${server.port}`,
      identity: deterministicIdentity(),
      powToken: 'test-pow-token',
      store,
      fetchImpl: async (_url, init) => {
        if (init.method === 'GET') {
          deviceGets += 1;
          return {
            status: 200,
            text: async () => JSON.stringify({
              policy: POLICY,
              devices: deviceGets === 1 ? [] : [OWNER_DEVICE],
            }),
          };
        }
        return registrationAndOutboxFetch(_url, init);
      },
      webSocketFactory: nodeFactory,
      reconnectInitialMs: 50,
      reconnectMaxMs: 200,
    });
    await session.start();
    for (let i = 0; i < 100 && session.getState().snapshotContent === null; i++) await delay(20);
    assertEq(deviceGets, 2, 'bootstrap plus one authenticated directory refresh');
    assertEq(session.getState().snapshotContent, markdown, 'retried snapshot renders');
    session.close();
  } finally {
    await server.close();
  }
});

defineCase('HTML SnapshotCreated populates content + docType=html (read-only)', async () => {
  const store = makeStubStore();
  const server = await startMockServer();
  try {
    const html = '<!doctype html><h1>Shared page</h1>';
    server.onClient((ws) => {
      ws.on('message', (raw) => {
        const msg = JSON.parse(String(raw));
        if (msg.type === 'subscribe') {
          ws.send(
            JSON.stringify({
              type: 'hello',
              serverSeq: 0,
              policy: POLICY,
              devices: [OWNER_DEVICE],
              missedSignalEnvelopeIds: [],
            }),
          );
          const env = mintSnapshotEnvelope(
            ROOM_ID,
            'env-snap-html',
            1_700_000_500_000,
            html,
            'file-html',
            'snap-html',
            'html',
          );
          ws.send(JSON.stringify({ type: 'envelope', envelope: env, serverSeq: 10 }));
        }
      });
    });

    const inviteUrl = composeInviteUrl('http://example.com/review', ROOM_ID, ROOM_SECRET);
    const session = new BrowserSession({
      inviteUrl,
      relayUrl: `http://127.0.0.1:${server.port}`,
      identity: deterministicIdentity(),
      powToken: 'test-pow-token',
      store,
      fetchImpl: registrationAndOutboxFetch,
      webSocketFactory: nodeFactory,
      reconnectInitialMs: 50,
      reconnectMaxMs: 200,
    });

    await session.start();
    for (let i = 0; i < 100 && session.getState().snapshotContent === null; i++) {
      await delay(20);
    }
    assertEq(session.getState().snapshotContent, html, 'html content populated');
    assertEq(session.getState().snapshotDocType, 'html', 'docType is html');
    assertEq(store.snapshots[0]!.docType, 'html', 'snapshot mirror records html docType');
    session.close();
  } finally {
    await server.close();
  }
});

defineCase('terminal close after hydration clears session and store plaintext', async () => {
  const store = makeStubStore();
  const server = await startMockServer();
  try {
    server.onClient((ws) => {
      ws.on('message', (raw) => {
        const msg = JSON.parse(String(raw));
        if (msg.type !== 'subscribe') return;
        ws.send(
          JSON.stringify({
            type: 'hello',
            serverSeq: 0,
            policy: POLICY,
            devices: [OWNER_DEVICE],
            missedSignalEnvelopeIds: [],
          }),
        );
        ws.send(
          JSON.stringify({
            type: 'envelope',
            envelope: mintSnapshotEnvelope(
              ROOM_ID,
              'env-before-delete',
              1_700_000_630_000,
              '# Deleted room plaintext\n',
              'file-delete',
              'snap-delete',
            ),
            serverSeq: 23,
          }),
        );
        setTimeout(() => ws.close(4001, 'room deleted'), 40);
      });
    });
    const session = new BrowserSession({
      inviteUrl: composeInviteUrl('http://example.com/review', ROOM_ID, ROOM_SECRET),
      relayUrl: `http://127.0.0.1:${server.port}`,
      identity: deterministicIdentity(),
      powToken: 'test-pow-token',
      store,
      fetchImpl: registrationAndOutboxFetch,
      webSocketFactory: nodeFactory,
      reconnectInitialMs: 50,
      reconnectMaxMs: 200,
    });
    await session.start();
    for (let i = 0; i < 100 && session.getState().status !== 'error'; i++) await delay(20);
    assertEq(session.getState().error?.kind, 'room_deleted', 'terminal error surfaced');
    assertEq(session.getState().snapshotContent, null, 'session plaintext reference cleared');
    assertEq(store.snapshots.length, 0, 'store snapshots cleared');
    assertEq(store.events.length, 0, 'store events cleared');
    assertEq(store.currentRoomId, null, 'store room selection cleared');
    session.close();
  } finally {
    await server.close();
  }
});

defineCase('Admission rejected (WS close 4000) → kind=admission_rejected', async () => {
  const store = makeStubStore();
  const server = await startMockServer();
  try {
    server.onClient((ws) => {
      // Drop the connection with the admission-invalid close code as soon as
      // we see the subscribe frame (simulating the relay rejecting the
      // HMAC-bearing subprotocol).
      ws.on('message', () => {
        ws.close(4000, 'admission rejected');
      });
    });
    const inviteUrl = composeInviteUrl('http://example.com/review', ROOM_ID, ROOM_SECRET);
    const session = new BrowserSession({
      inviteUrl,
      relayUrl: `http://127.0.0.1:${server.port}`,
      identity: deterministicIdentity(),
      powToken: 'test-pow-token',
      store,
      fetchImpl: registrationAndOutboxFetch,
      webSocketFactory: nodeFactory,
      reconnectInitialMs: 30,
      reconnectMaxMs: 60,
    });
    await session.start();
    for (let i = 0; i < 80 && session.getState().status !== 'error'; i++) await delay(20);
    assertEq(session.getState().status, 'error', 'error after WS close');
    assertEq(
      session.getState().error?.kind,
      'admission_rejected',
      'mapped to admission_rejected',
    );
    session.close();
  } finally {
    await server.close();
  }
});

defineCase('remembered room restores two files, cursor, identity, and sealed offline comment', async () => {
  const databaseName = `${BROWSER_STORAGE_DB_NAME}-session-${Date.now()}`;
  const openStorage = (createIfMissing: boolean) => BrowserStorage.open({
    createIfMissing,
    databaseName,
    indexedDB,
    filesystem: null,
    navigator: { storage: { persist: async () => true, estimate: async () => ({}) } },
  });
  const server = await startMockServer();
  const subscribeAfter: number[] = [];
  let subscriptions = 0;
  try {
    server.onClient((ws) => {
      ws.on('message', (raw) => {
        const msg = JSON.parse(String(raw));
        if (msg.type !== 'subscribe') return;
        subscriptions += 1;
        subscribeAfter.push(msg.after as number);
        ws.send(JSON.stringify({
          type: 'hello',
          serverSeq: 11,
          policy: POLICY,
          devices: [OWNER_DEVICE],
          missedSignalEnvelopeIds: [],
        }));
        if (subscriptions !== 1) return;
        ws.send(JSON.stringify({
          type: 'envelope',
          envelope: mintSnapshotEnvelope(
            ROOM_ID,
            'env-remember-file-a',
            1_700_001_000_000,
            '# Remembered file A\n\nSEALED-FILE-A\n',
            'file-remember-a',
            'snap-remember-a',
          ),
          serverSeq: 10,
        }));
        ws.send(JSON.stringify({
          type: 'envelope',
          envelope: mintSnapshotEnvelope(
            ROOM_ID,
            'env-remember-file-b',
            1_700_001_000_001,
            '# Remembered file B\n\nSEALED-FILE-B\n',
            'file-remember-b',
            'snap-remember-b',
          ),
          serverSeq: 11,
        }));
      });
    });

    const firstStore = makeStubStore();
    const first = new BrowserSession({
      inviteUrl: composeInviteUrl('http://example.com/review', ROOM_ID, ROOM_SECRET),
      relayUrl: `http://127.0.0.1:${server.port}`,
      identity: deterministicIdentity(),
      powToken: 'test-pow-token',
      store: firstStore,
      storageFactory: openStorage,
      fetchImpl: registrationAndOutboxFetch,
      webSocketFactory: nodeFactory,
      reconnectInitialMs: 50,
      reconnectMaxMs: 200,
    });
    await first.start();
    for (let i = 0; i < 100 && (firstStore.snapshots.length < 2 || !first.getState().authoringReady); i++) {
      await delay(20);
    }
    assertEq(firstStore.snapshots.length, 2, 'two native files arrived before remember');
    await first.rememberRoom();
    assertEq(first.getState().persistence, 'remembered', 'explicit remember succeeds');

    const duplicate = new BrowserSession({
      inviteUrl: composeInviteUrl('http://example.com/review', ROOM_ID, ROOM_SECRET),
      relayUrl: `http://127.0.0.1:${server.port}`,
      identity: generateBrowserIdentity(),
      powToken: 'test-pow-token',
      store: makeStubStore(),
      storageFactory: openStorage,
      fetchImpl: registrationAndOutboxFetch,
      webSocketFactory: nodeFactory,
      reconnectInitialMs: 50,
      reconnectMaxMs: 200,
    });
    await duplicate.start();
    let duplicateRejected = false;
    try {
      await duplicate.rememberRoom();
    } catch {
      duplicateRejected = true;
    }
    assert(duplicateRejected, 'a second invite identity cannot replace remembered recovery');
    duplicate.close();

    const inspector = await openStorage(false);
    const rootKey = await inspector.getRoomRootKey(ROOM_ID);
    assert(rootKey !== null, 'non-extractable root capability stored');
    assertEq(rootKey.extractable, false, 'stored root is non-extractable');
    let exportRejected = false;
    try {
      await crypto.subtle.exportKey('raw', rootKey);
    } catch {
      exportRejected = true;
    }
    assert(exportRejected, 'stored root cannot be exported');
    assertEq(await inspector.getCursor(ROOM_ID, 'br-test-device'), 11, 'cursor committed with ciphertext');
    inspector.close();
    first.close();

    const offlineFetch = async (url: string, init: FetchLikeInit): Promise<FetchLikeResponse> => {
      if (url.endsWith('/envelopes')) throw new Error('offline after reload');
      return registrationAndOutboxFetch(url, init);
    };
    const secondStore = makeStubStore();
    const second = new BrowserSession({
      rememberedRoomId: ROOM_ID,
      relayUrl: `http://127.0.0.1:${server.port}`,
      powToken: 'test-pow-token',
      store: secondStore,
      storageFactory: openStorage,
      fetchImpl: offlineFetch,
      webSocketFactory: nodeFactory,
      reconnectInitialMs: 50,
      reconnectMaxMs: 200,
    });
    await second.start();
    assertEq(secondStore.snapshots.length, 2, 'both files recovered from sealed local history');
    assertEq(second.getState().authoringReady, true, 'durable offline authoring is available');
    const anchor: Anchor = {
      v: 2,
      fileId: 'file-remember-a',
      snapshotId: 'snap-remember-a',
      baseHash: 'hash-remember-a',
      position: { byteRange: [0, 5], lineRange: [1, 1], pmRange: [1, 6] },
    };
    await second.createComment(anchor, 'SEALED-OFFLINE-COMMENT');
    assert(secondStore.events.some(
      (event) => event.body.type === 'comment_created' && event.body.body === 'SEALED-OFFLINE-COMMENT',
    ), 'offline comment is optimistically visible after durable enqueue');
    second.close();

    const pendingInspector = await openStorage(false);
    const pending = await pendingInspector.listOutbox(ROOM_ID, 'br-test-device');
    assert(pending.length >= 2, 'restored join and offline comment remain durably queued');
    assert(pending.every((envelope) => envelope.deviceId === 'br-test-device'), 'device identity is stable');
    const storageText = JSON.stringify([
      await pendingInspector.getRoom(ROOM_ID),
      await pendingInspector.replayInbound(ROOM_ID),
      pending,
    ]);
    for (const plaintext of ['SEALED-FILE-A', 'SEALED-FILE-B', 'SEALED-OFFLINE-COMMENT']) {
      assert(!storageText.includes(plaintext), `IndexedDB records omit plaintext ${plaintext}`);
    }
    pendingInspector.close();

    const thirdStore = makeStubStore();
    const third = new BrowserSession({
      rememberedRoomId: ROOM_ID,
      relayUrl: `http://127.0.0.1:${server.port}`,
      powToken: 'test-pow-token',
      store: thirdStore,
      storageFactory: openStorage,
      fetchImpl: offlineFetch,
      webSocketFactory: nodeFactory,
      reconnectInitialMs: 50,
      reconnectMaxMs: 200,
    });
    await third.start();
    assertEq(thirdStore.snapshots.length, 2, 'snapshot replay remains idempotent');
    assert(thirdStore.events.some(
      (event) => event.body.type === 'comment_created' && event.body.body === 'SEALED-OFFLINE-COMMENT',
    ), 'sealed pending comment decrypts after another reload');
    assert(subscribeAfter.slice(1).every((after) => after === 11), 'reload subscribes from committed cursor');
    await third.forgetRoom();
    third.close();
    const forgotten = await openStorage(false);
    assertEq(await forgotten.getRoom(ROOM_ID), null, 'forget removes remembered room');
    assertEq(await forgotten.getRoomRootKey(ROOM_ID), null, 'forget removes key first');
    forgotten.close();
  } finally {
    await server.close();
    await new Promise<void>((resolve) => {
      const request = indexedDB.deleteDatabase(databaseName);
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
      request.onblocked = () => resolve();
    });
  }
});

defineCase('expired remembered rooms are crypto-erased before fragmentless resume', async () => {
  const databaseName = `${BROWSER_STORAGE_DB_NAME}-expired-${Date.now()}`;
  const openStorage = (createIfMissing: boolean) => BrowserStorage.open({
    createIfMissing,
    databaseName,
    indexedDB,
    filesystem: null,
  });
  try {
    const storage = await openStorage(true);
    const roomKeys = deriveRoomKeys(ROOM_SECRET);
    await storage.putRoom({
      roomId: ROOM_ID,
      policy: { ...POLICY, expiresAt: Date.now() - 1 },
      lastCreatedAt: Date.now() - 10_000,
      storagePersisted: false,
    });
    await storage.installRoomKey(ROOM_ID, roomKeys.rootKey);
    await storage.saveIdentity(ROOM_ID, deterministicIdentity());
    storage.close();
    roomKeys.rootKey.fill(0);

    const session = new BrowserSession({
      rememberedRoomId: ROOM_ID,
      relayUrl: 'https://relay.example.test',
      store: makeStubStore(),
      storageFactory: openStorage,
    });
    await session.start();
    assertEq(session.getState().error?.kind, 'invite_invalid', 'expired recovery fails closed');
    const inspector = await openStorage(false);
    assertEq(await inspector.getRoom(ROOM_ID), null, 'expired room metadata erased');
    assertEq(await inspector.getRoomRootKey(ROOM_ID), null, 'expired root capability erased');
    inspector.close();
    session.close();
  } finally {
    await new Promise<void>((resolve) => {
      const request = indexedDB.deleteDatabase(databaseName);
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
      request.onblocked = () => resolve();
    });
  }
});

defineCase('generateBrowserIdentity produces 32-byte secret + 32-byte public', () => {
  const id = generateBrowserIdentity();
  assertEq(id.signingSecret.length, 32, 'ed25519 secret seed 32 bytes');
  assertEq(id.signingPublic.length, 32, 'ed25519 public key 32 bytes');
  assertEq(id.encryptionSecret.length, 32, 'x25519 secret key 32 bytes');
  assertEq(id.publicEncryptionKey.length, 32, 'x25519 public key 32 bytes');
  assert(id.publicEncryptionKey.some((byte) => byte !== 0), 'x25519 public key is not a placeholder');
  assert(id.deviceId.startsWith('br-'), `deviceId has br- prefix: ${id.deviceId}`);
  assert(id.participantId.startsWith('br-'), `participantId has br- prefix`);
  // signingKeyId should match the SHA-256 of the public key.
  const expectedKid = signingKeyId(id.signingPublic);
  assert(expectedKid.length > 0, 'signingKeyId derives without throwing');
});

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function deterministicIdentity(): BrowserDeviceIdentity {
  const seed = new Uint8Array(32).fill(0x77);
  const { secretKey, publicKey } = ed25519.keygen(seed);
  const encryption = x25519.keygen(new Uint8Array(32).fill(0x55));
  return {
    deviceId: 'br-test-device',
    participantId: 'br-test-participant',
    signingSecret: secretKey,
    signingPublic: publicKey,
    encryptionSecret: encryption.secretKey,
    publicEncryptionKey: encryption.publicKey,
  };
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

(async () => {
  let passed = 0;
  let failed = 0;
  for (const run of cases) {
    const r = await run();
    if (r.ok) {
      passed += 1;
      console.log(`  ok  ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
    } else {
      failed += 1;
      console.error(`  FAIL ${r.name}\n        ${r.detail ?? '(no detail)'}`);
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  interface NodeProcessShape {
    exit?: (code: number) => void;
  }
  const nodeProcess: NodeProcessShape | undefined = (globalThis as unknown as { process?: NodeProcessShape }).process;
  if (failed > 0) nodeProcess?.exit?.(1);
})().catch((err) => {
  console.error(err);
  interface NodeProcessShape {
    exit?: (code: number) => void;
  }
  const nodeProcess: NodeProcessShape | undefined = (globalThis as unknown as { process?: NodeProcessShape }).process;
  nodeProcess?.exit?.(1);
});
