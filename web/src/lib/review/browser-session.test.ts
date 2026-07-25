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
  buildRegisterDeviceBodyV3,
  canonicalDeviceGrantV3,
  verifyDeviceGrantV3,
  canonicalRegisterDeviceBytes,
  generateBrowserIdentity,
  ownerCredentialsFromInviteCapability,
  parseBrowserSnapshotPlaintext,
  admissionHeaderValue,
  type BrowserDeviceIdentity,
  type BrowserOwnerCredentials,
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
  deriveRoomIdV3,
  deriveRoomKeyTreeV3,
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
  AnchorIndex,
  EventMeta,
  ReviewEvent,
  ReviewEventBody,
  ReviewSnapshot,
  SnapshotPlaintext,
  FileId,
  SnapshotId,
  RoomId,
} from '../types';
import type { MailboxEnvelope, RoomPolicy, Device, WebSocketLike } from './browser-ws';
import { BrowserStorage, BROWSER_STORAGE_DB_NAME } from './browser-storage';
import { assembleBrowserSignal } from './browser-signaling';
import type { InviteCapability } from './browser-workspace-share';

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

function browserOwnerCredentials(): BrowserOwnerCredentials {
  const signingSecret = new Uint8Array(32).fill(0x51);
  const encryptionSecret = new Uint8Array(32).fill(0x61);
  return {
    roomId: ROOM_ID,
    roomSecret: new Uint8Array(ROOM_SECRET),
    keys: deriveRoomKeys(ROOM_SECRET),
    identity: {
      deviceId: 'browser-owner-device',
      participantId: 'browser-owner-participant',
      signingSecret,
      signingPublic: ed25519.getPublicKey(signingSecret),
      encryptionSecret,
      publicEncryptionKey: x25519.getPublicKey(encryptionSecret),
    },
    policy: structuredClone(POLICY),
  };
}

function browserOwnerCredentialsV3(): BrowserOwnerCredentials {
  const v2 = browserOwnerCredentials();
  const tree = deriveRoomKeyTreeV3(v2.roomSecret);
  return {
    ...v2,
    protocolVersion: 3,
    roomId: deriveRoomIdV3(v2.roomSecret),
    keys: {
      rootKey: tree.rootKey,
      eventKey: tree.readKeys.eventKey,
      snapshotKey: tree.readKeys.snapshotKey,
      signalingKey: tree.readKeys.signalingKey,
      admissionKey: tree.writeAdmissionKey,
    },
    readAdmissionKey: tree.readKeys.readAdmissionKey,
    readCapabilityKey: tree.readKeys.readCapabilityKey,
  };
}

function browserOwnerDevice(credentials: BrowserOwnerCredentials): Device {
  return signedDirectoryDevice({
    deviceId: credentials.identity.deviceId,
    participantId: credentials.identity.participantId,
    publicEncryptionKey: base64UrlEncode(credentials.identity.publicEncryptionKey),
    publicSigningKey: base64UrlEncode(credentials.identity.signingPublic),
    client: 'attn-browser',
    kind: 'owner',
    registeredAt: 1_700_000_000_000,
  }, credentials.identity.signingSecret);
}

function browserReviewerDevice(seed = 0x71): { identity: BrowserDeviceIdentity; device: Device } {
  const signingSecret = new Uint8Array(32).fill(seed);
  const encryptionSecret = new Uint8Array(32).fill(seed + 1);
  const identity: BrowserDeviceIdentity = {
    deviceId: `browser-reviewer-${seed}`,
    participantId: `browser-reviewer-participant-${seed}`,
    signingSecret,
    signingPublic: ed25519.getPublicKey(signingSecret),
    encryptionSecret,
    publicEncryptionKey: x25519.getPublicKey(encryptionSecret),
  };
  return {
    identity,
    device: signedDirectoryDevice({
      deviceId: identity.deviceId,
      participantId: identity.participantId,
      publicEncryptionKey: base64UrlEncode(identity.publicEncryptionKey),
      publicSigningKey: base64UrlEncode(identity.signingPublic),
      client: 'attn-browser',
      kind: 'reviewer',
      registeredAt: 1_700_000_000_001,
    }, signingSecret),
  };
}

function ownerCapability(credentials: BrowserOwnerCredentials): InviteCapability {
  return {
    v: 1,
    roomSecret: base64UrlEncode(credentials.roomSecret),
    ownerSigningSecret: base64UrlEncode(credentials.identity.signingSecret),
    ownerEncryptionSecret: base64UrlEncode(credentials.identity.encryptionSecret),
    ownerDeviceId: credentials.identity.deviceId,
    ownerParticipantId: credentials.identity.participantId,
    policy: structuredClone(credentials.policy),
  };
}

interface MockServer {
  port: number;
  onClient: (handler: (ws: WebSocket, subprotocol: string, requestUrl: string) => void) => void;
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
  const handlers: Array<(ws: WebSocket, sub: string, requestUrl: string) => void> = [];
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
        h(ws, sub, req.url ?? '');
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
  const blobBytes = snapshotPlaintextBytes(content, docType);
  const body = {
    type: 'snapshot_created',
    fileId,
    snapshotId,
    baseHash: contentHash(new TextEncoder().encode(content)),
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
              : { docType, content },
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
  const plaintext = snapshotPlaintextBytes(content, 'markdown');
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
  const snapshotBytes = snapshotPlaintextBytes(content, 'markdown');
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
  docType: 'markdown' | 'html',
): Uint8Array {
  return toCanonicalBytes({
    docType,
    content,
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
      inviteUrl: composeInviteUrl('https://example.com/review', ROOM_ID, ROOM_SECRET),
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

defineCase('v3 registration self-signature binds owner grant fields', () => {
  const identity = deterministicIdentity();
  const body = buildRegisterDeviceBodyV3(identity, 'comment', 'owner-grant-signature');
  const canonical = new TextDecoder().decode(canonicalRegisterDeviceBytes(body));
  assert(canonical.includes('"grantTier":"comment"'), 'tier is self-signed');
  assert(canonical.includes('"grantSignature":"owner-grant-signature"'), 'grant signature is self-signed');
  assertEq(
    new TextDecoder().decode(canonicalDeviceGrantV3('room-1', 'comment')),
    '{"grantTier":"comment","purpose":"attn device grant v3","roomId":"room-1","v":3}',
    'exact owner grant canonical JSON',
  );
});

defineCase('v3 owner grant verification binds tier, room, and owner key', () => {
  const owner = ed25519.keygen(new Uint8Array(32).fill(0x61));
  const other = ed25519.keygen(new Uint8Array(32).fill(0x62));
  const signature = base64UrlEncode(
    ed25519.sign(canonicalDeviceGrantV3('room-grant', 'comment'), owner.secretKey),
  );
  const ownerKey = base64UrlEncode(owner.publicKey);
  assert(verifyDeviceGrantV3('room-grant', 'comment', signature, ownerKey), 'valid grant');
  assert(!verifyDeviceGrantV3('room-grant', 'suggest', signature, ownerKey), 'wrong tier');
  assert(!verifyDeviceGrantV3('other-room', 'comment', signature, ownerKey), 'wrong room');
  assert(!verifyDeviceGrantV3('room-grant', 'comment', signature, base64UrlEncode(other.publicKey)), 'wrong owner');
  assert(!verifyDeviceGrantV3('room-grant', 'comment', '', ownerKey), 'incomplete proof');
});

defineCase('comment-tier session hard-blocks direct suggestion authoring', async () => {
  const session = new BrowserSession({ store: makeStubStore() });
  (session as unknown as { state: BrowserSessionState }).state.grantTier = 'comment';
  let rejected = false;
  try {
    await session.createSuggestion({
      anchor: {
        v: 2,
        fileId: 'file-tier',
        snapshotId: 'snapshot-tier',
        baseHash: 'hash-tier',
        position: { byteRange: [0, 1], lineRange: [1, 1] },
      },
      operation: { kind: 'replace', expectedText: 'a', replacement: 'b' },
    });
  } catch (error) {
    rejected = error instanceof Error && error.message.includes('suggest grant');
  }
  assert(rejected, 'direct createSuggestion must reject comment tier');
  session.close();
});

defineCase('admissionHeaderValue prefixes with v2. and base64url-encodes the tag', () => {
  const key = new Uint8Array(32).fill(0x11);
  const value = admissionHeaderValue(key, 'POST', '/v2/rooms/r/devices', new Uint8Array(0));
  assert(value.startsWith('v2.'), `expected v2. prefix, got ${value.slice(0, 8)}`);
  const tag = value.slice(3);
  // base64url-no-pad of HMAC-SHA-256 is 43 chars.
  assertEq(tag.length, 43, 'tag length 43 chars (32 bytes base64url-no-pad)');
});

defineCase('sealed owner capability reconstructs and cross-checks every secret', () => {
  const original = browserOwnerCredentials();
  const rebuilt = ownerCredentialsFromInviteCapability(ownerCapability(original), ROOM_ID);
  assertEq(rebuilt.roomId, ROOM_ID, 'derived owner room id');
  assert(
    rebuilt.keys.eventKey.every((byte, index) => byte === original.keys.eventKey[index]),
    'event key reconstruction',
  );
  assert(
    rebuilt.identity.signingPublic.every(
      (byte, index) => byte === original.identity.signingPublic[index],
    ),
    'Ed25519 public reconstruction',
  );
  assert(
    rebuilt.identity.publicEncryptionKey.every(
      (byte, index) => byte === original.identity.publicEncryptionKey[index],
    ),
    'X25519 public reconstruction',
  );
  let roomMismatch = false;
  try { ownerCredentialsFromInviteCapability(ownerCapability(original), 'wrong-room'); }
  catch { roomMismatch = true; }
  assert(roomMismatch, 'room binding mismatch accepted');
  let secretMismatch = false;
  try {
    ownerCredentialsFromInviteCapability(
      { ...ownerCapability(original), ownerSigningSecret: base64UrlEncode(new Uint8Array(31)) },
      ROOM_ID,
    );
  } catch { secretMismatch = true; }
  assert(secretMismatch, 'short owner secret accepted');
  let policyMismatch = false;
  try {
    ownerCredentialsFromInviteCapability(
      { ...ownerCapability(original), policy: { ...POLICY, powBits: 2 } },
      ROOM_ID,
    );
  } catch { policyMismatch = true; }
  assert(policyMismatch, 'invalid sealed policy accepted');
});

defineCase('owner principal verifies GET directory and never registers or joins as reviewer', async () => {
  const credentials = browserOwnerCredentials();
  const device = browserOwnerDevice(credentials);
  const callerSigning = new Uint8Array(credentials.identity.signingSecret);
  const callerRoomSecret = new Uint8Array(credentials.roomSecret);
  const methods: string[] = [];
  const store = makeStubStore();
  const server = await startMockServer();
  try {
    server.onClient((ws) => {
      ws.on('message', (raw) => {
        const frame = JSON.parse(String(raw));
        if (frame.type !== 'subscribe') return;
        ws.send(JSON.stringify({
          type: 'hello',
          serverSeq: 0,
          policy: POLICY,
          devices: [device],
          onlineDeviceIds: [device.deviceId],
          missedSignalEnvelopeIds: [],
        }));
      });
    });
    const session = new BrowserSession({
      owner: credentials,
      relayUrl: `http://127.0.0.1:${server.port}`,
      disableWebRtc: true,
      store,
      powToken: 'unused-owner-pow',
      fetchImpl: async (_url, init) => {
        methods.push(init.method ?? 'GET');
        if (init.method !== 'GET') throw new Error('owner startup attempted a POST');
        return { status: 200, text: async () => JSON.stringify({ policy: POLICY, devices: [device] }) };
      },
      webSocketFactory: nodeFactory,
      reconnectInitialMs: 50,
      reconnectMaxMs: 200,
    });
    await session.start();
    for (let index = 0; index < 80 && !session.getState().authoringReady; index += 1) await delay(20);
    assertEq(session.getState().status, 'connected', 'owner connected');
    assertEq(session.getState().principal, 'owner', 'owner principal');
    assertEq(session.getState().ownerOnline, true, 'owner online');
    assertEq(session.getState().liveEditingAvailable, true, 'owner live authority');
    assertEq(session.getState().authoringReady, true, 'owner durable authoring ready');
    assertEq(methods.join(','), 'GET', 'only authenticated GET issued');
    assertEq(store.events.length, 0, 'no reviewer ParticipantJoined emitted');
    const internals = session as unknown as {
      keys: typeof KEYS;
      identity: BrowserDeviceIdentity;
      ownerRoomSecret: Uint8Array;
    };
    const keyRef = internals.keys.eventKey;
    const secretRef = internals.identity.signingSecret;
    const roomSecretRef = internals.ownerRoomSecret;
    session.close();
    assert(keyRef.every((byte) => byte === 0), 'session event key zeroed');
    assert(secretRef.every((byte) => byte === 0), 'session signing secret zeroed');
    assert(roomSecretRef.every((byte) => byte === 0), 'session room secret zeroed');
    assert(
      credentials.identity.signingSecret.every((byte, index) => byte === callerSigning[index]),
      'caller signing secret was aliased',
    );
    assert(
      credentials.roomSecret.every((byte, index) => byte === callerRoomSecret[index]),
      'caller room secret was aliased',
    );
  } finally {
    await server.close();
  }
});

defineCase('owner startup rejects a mismatched or downgraded directory registration', async () => {
  for (const mutate of [
    (device: Device): Device => ({ ...device, kind: 'reviewer' }),
    (device: Device): Device => ({ ...device, participantId: 'wrong-participant' }),
    (device: Device): Device => ({ ...device, publicSigningKey: base64UrlEncode(new Uint8Array(32)) }),
  ]) {
    const credentials = browserOwnerCredentials();
    const device = mutate(browserOwnerDevice(credentials));
    let socketOpened = false;
    const session = new BrowserSession({
      owner: credentials,
      relayUrl: 'http://127.0.0.1:9',
      store: makeStubStore(),
      fetchImpl: async () => ({
        status: 200,
        text: async () => JSON.stringify({ policy: POLICY, devices: [device] }),
      }),
      webSocketFactory: () => {
        socketOpened = true;
        throw new Error('mismatched owner must not open WS');
      },
    });
    await session.start();
    assertEq(session.getState().status, 'error', 'mismatch is terminal');
    assertEq(socketOpened, false, 'WS stayed closed');
    session.close();
  }
});

defineCase('owner hello fully validates policy and reasserts its authoritative registration', async () => {
  const scenarios: Array<{
    name: string;
    policy: RoomPolicy;
    helloDevices?: Device[];
    errorKind: NonNullable<BrowserSessionState['error']>['kind'];
  }> = [
    { name: 'invalid maxPeers', policy: { ...POLICY, maxPeers: 9 }, errorKind: 'network' },
    { name: 'browser authority revoked', policy: { ...POLICY, allowBrowser: false }, errorKind: 'network' },
    { name: 'expired', policy: { ...POLICY, expiresAt: Date.now() - 1 }, errorKind: 'room_expired' },
    { name: 'owner omitted', policy: POLICY, helloDevices: [], errorKind: 'network' },
  ];
  for (const scenario of scenarios) {
    const credentials = browserOwnerCredentials();
    const device = browserOwnerDevice(credentials);
    const server = await startMockServer();
    try {
      server.onClient((ws) => {
        ws.on('message', (raw) => {
          if (JSON.parse(String(raw)).type !== 'subscribe') return;
          ws.send(JSON.stringify({
            type: 'hello',
            serverSeq: 0,
            policy: scenario.policy,
            devices: scenario.helloDevices ?? [device],
            onlineDeviceIds: [device.deviceId],
            missedSignalEnvelopeIds: [],
          }));
        });
      });
      const session = new BrowserSession({
        owner: credentials,
        relayUrl: `http://127.0.0.1:${server.port}`,
        disableWebRtc: true,
        store: makeStubStore(),
        fetchImpl: async () => ({
          status: 200,
          text: async () => JSON.stringify({ policy: POLICY, devices: [device] }),
        }),
        webSocketFactory: nodeFactory,
        reconnectInitialMs: 50,
        reconnectMaxMs: 200,
      });
      await session.start();
      for (let index = 0; index < 80 && session.getState().status !== 'error'; index += 1) {
        await delay(10);
      }
      assertEq(session.getState().status, 'error', `${scenario.name} rejected`);
      assertEq(session.getState().error?.kind, scenario.errorKind, `${scenario.name} error kind`);
      assertEq(session.getState().liveEditingAvailable, false, `${scenario.name} live editing closed`);
      session.close();
    } finally {
      await server.close();
    }
  }
});

defineCase('owner policy changes are fully validated and revoke live authority fail closed', async () => {
  for (const scenario of [
    { name: 'invalid maxPeers', policy: { ...POLICY, maxPeers: 9 }, errorKind: 'network' },
    { name: 'browser authority revoked', policy: { ...POLICY, allowBrowser: false }, errorKind: 'network' },
    { name: 'expired', policy: { ...POLICY, expiresAt: Date.now() - 1 }, errorKind: 'room_expired' },
  ] as const) {
    const credentials = browserOwnerCredentials();
    const device = browserOwnerDevice(credentials);
    let socket: WebSocket | null = null;
    const server = await startMockServer();
    try {
      server.onClient((ws) => {
        socket = ws;
        ws.on('message', (raw) => {
          if (JSON.parse(String(raw)).type !== 'subscribe') return;
          ws.send(JSON.stringify({
            type: 'hello', serverSeq: 0, policy: POLICY, devices: [device],
            onlineDeviceIds: [device.deviceId], missedSignalEnvelopeIds: [],
          }));
        });
      });
      const session = new BrowserSession({
        owner: credentials,
        relayUrl: `http://127.0.0.1:${server.port}`,
        disableWebRtc: true,
        store: makeStubStore(),
        fetchImpl: async () => ({
          status: 200,
          text: async () => JSON.stringify({ policy: POLICY, devices: [device] }),
        }),
        webSocketFactory: nodeFactory,
        reconnectInitialMs: 50,
        reconnectMaxMs: 200,
      });
      await session.start();
      for (let index = 0; index < 80 && session.getState().status !== 'connected'; index += 1) {
        await delay(10);
      }
      assertEq(session.getState().liveEditingAvailable, true, `${scenario.name} starts live`);
      socket!.send(JSON.stringify({ type: 'policy_changed', policy: scenario.policy }));
      for (let index = 0; index < 80 && session.getState().status !== 'error'; index += 1) {
        await delay(10);
      }
      assertEq(session.getState().status, 'error', `${scenario.name} rejected`);
      assertEq(session.getState().error?.kind, scenario.errorKind, `${scenario.name} error kind`);
      assertEq(session.getState().liveEditingAvailable, false, `${scenario.name} live editing closed`);
      session.close();
    } finally {
      await server.close();
    }
  }
});

defineCase('owner cursor presence is WebRTC-only while document collab remains direct-first plus relay', async () => {
  const credentials = browserOwnerCredentialsV3();
  const device = browserOwnerDevice(credentials);
  let socket: WebSocket | null = null;
  const direct: MailboxEnvelope[] = [];
  const posted: Array<Record<string, unknown>> = [];
  let stateNotifications = 0;
  let failRelay = false;
  const server = await startMockServer();
  try {
    server.onClient((ws) => {
      socket = ws;
      ws.on('message', (raw) => {
        const frame = JSON.parse(String(raw));
        if (frame.type !== 'subscribe') return;
        ws.send(JSON.stringify({
          type: 'hello', serverSeq: 0, policy: POLICY, devices: [device],
          onlineDeviceIds: [device.deviceId], missedSignalEnvelopeIds: [],
        }));
      });
    });
    const session = new BrowserSession({
      owner: credentials,
      relayUrl: `http://127.0.0.1:${server.port}`,
      disableWebRtc: true,
      store: makeStubStore(),
      powToken: 'owner-outbox-pow',
      fetchImpl: async (_url, init) => {
        if (init.method === 'GET') {
          return { status: 200, text: async () => JSON.stringify({ policy: POLICY, devices: [device] }) };
        }
        const body = JSON.parse(init.body ?? '{}') as { envelopes?: Array<Record<string, unknown>> };
        posted.push(...(body.envelopes ?? []));
        if (failRelay) {
          return { status: 503, text: async () => 'relay unavailable' };
        }
        return {
          status: 201,
          text: async () => JSON.stringify({
            accepted: (body.envelopes ?? []).map((envelope, index) => ({
              envelopeId: envelope.envelopeId,
              serverSeq: index + 1,
            })),
          }),
        };
      },
      webSocketFactory: nodeFactory,
      onState: () => { stateNotifications += 1; },
      reconnectInitialMs: 50,
      reconnectMaxMs: 200,
    });
    await session.start();
    for (let index = 0; index < 80 && !session.getState().authoringReady; index += 1) await delay(20);
    (session as unknown as { peerMesh: {
      broadcastEnvelope(envelope: MailboxEnvelope): void;
      broadcastPresenceEnvelope(envelope: MailboxEnvelope): void;
      close(): void;
      removePeer(deviceId: string): void;
      syncDevices(devices: Iterable<Device>): void;
    } }).peerMesh = {
      broadcastEnvelope: (envelope) => direct.push(structuredClone(envelope)),
      broadcastPresenceEnvelope: (envelope) => direct.push(structuredClone(envelope)),
      close: () => undefined,
      removePeer: () => undefined,
      syncDevices: () => undefined,
    };
    await session.sendCollab(JSON.stringify({
      kind: 'broadcast', fileId: 'file-owner', epoch: 'snap',
      broadcast: { startVersion: 0, steps: [], clientIDs: [] },
    }));
    assertEq(direct.length, 1, 'direct fanout happened synchronously');
    for (let index = 0; index < 80 && posted.length === 0; index += 1) await delay(20);
    assertEq(posted.length, 1, 'same collab envelope relayed once');
    assertEq(direct[0]!.target, null, 'direct collab target is null');
    assertEq(posted[0]!.target, null, 'relay collab target is null');
    for (const field of ['envelopeId', 'nonce', 'ciphertext', 'ciphertextBytes'] as const) {
      assertEq(posted[0]![field], direct[0]![field], `direct/relay ${field}`);
    }
    const stateNotificationsBeforeCursor = stateNotifications;
    await session.sendCollab(JSON.stringify({
      kind: 'cursor',
      cursor: { clientID: 'owner-client', head: 0, label: 'Owner', color: 'currentColor' },
    }));
    assertEq(direct[1]!.signalClass, 'presence', 'direct cursor was not replaceable presence');
    assertEq(posted.length, 1, 'cursor presence leaked into the relay outbox');
    assertEq(direct[0]!.signalClass, undefined, 'document broadcast became replaceable');
    assertEq(session.getState().outboxPending, 0, 'cursor presence entered durable browser state');
    assertEq(
      stateNotifications,
      stateNotificationsBeforeCursor,
      'cursor presence republished unchanged session state',
    );

    failRelay = true;
    let relayFailureSurfaced = false;
    try {
      await session.sendCollab(JSON.stringify({
        kind: 'broadcast', fileId: 'file-owner', epoch: 'next',
        broadcast: { startVersion: 0, steps: [], clientIDs: [] },
      }));
    }
    catch { relayFailureSurfaced = true; }
    assert(relayFailureSurfaced, 'relay failure did not reject sendCollab');
    assertEq(direct.length, 3, 'failed relay still used direct transport once');
    assertEq(session.getState().outboxPending, 1, 'failed relay retained the exact envelope');

    socket!.send(JSON.stringify({
      type: 'presence', event: 'leave', deviceId: device.deviceId, participantId: 'spoofed',
    }));
    await delay(20);
    assertEq(session.getState().ownerOnline, true, 'spoofed presence ignored');
    socket!.send(JSON.stringify({
      type: 'presence', event: 'leave', deviceId: device.deviceId, participantId: device.participantId,
    }));
    for (let index = 0; index < 40 && session.getState().ownerOnline; index += 1) await delay(10);
    assertEq(session.getState().ownerOnline, false, 'authenticated owner leave');
    assertEq(session.getState().liveEditingAvailable, false, 'live editing paused');
    assertEq(session.getState().authoringReady, true, 'durable review remains ready');
    let collabPaused = false;
    try { await session.sendCollab('{}'); } catch { collabPaused = true; }
    assert(collabPaused, 'collab authored while owner offline');
    socket!.send(JSON.stringify({
      type: 'presence', event: 'join', deviceId: device.deviceId, participantId: device.participantId,
    }));
    for (let index = 0; index < 40 && !session.getState().ownerOnline; index += 1) await delay(10);
    assertEq(session.getState().liveEditingAvailable, true, 'owner join resumes live editing');
    const terminal = session.prepareTerminalEvent({
      type: 'suggestion_rejected', suggestionId: 'suggestion-owner-terminal',
    });
    const beforeAdopt = posted.length;
    failRelay = false;
    await session.adoptDurableEnvelope(terminal.envelope);
    assert(
      posted.slice(beforeAdopt).some((item) => item.envelopeId === terminal.envelope.envelopeId),
      'prepared exact terminal envelope was not adopted and flushed',
    );
    let wrongOwnerRejected = false;
    try {
      await session.adoptDurableEnvelope({ ...terminal.envelope, deviceId: 'wrong-owner' });
    } catch { wrongOwnerRejected = true; }
    assert(wrongOwnerRejected, 'terminal envelope from another device was adopted');
    session.close();
  } finally {
    await server.close();
  }
});

defineCase('view comment and suggest browser reviewers cannot emit ProseMirror submits', async () => {
  const submit = JSON.stringify({
    kind: 'submit', fileId: 'file-reviewer', epoch: 'snapshot-reviewer',
    submission: {
      clientID: 'reviewer-client', version: 0,
      steps: [{ stepType: 'replace', from: 1, to: 1 }],
    },
  });
  for (const tier of ['view', 'comment', 'suggest'] as const) {
    const session = new BrowserSession({ relayUrl: 'http://127.0.0.1:8787' });
    (session as unknown as { state: BrowserSessionState }).state = {
      ...session.getState(),
      grantTier: tier,
      status: 'connected',
      connection: 'mailbox',
      ownerOnline: true,
      liveEditingAvailable: true,
    };
    let rejected = false;
    try { await session.sendCollab(submit); }
    catch (error) {
      rejected = error instanceof Error && error.message.includes('durable suggestion');
    }
    assert(rejected, `${tier} reviewer submit was not rejected at the session boundary`);
    session.close();
  }
});

defineCase('direct-first and relay collab delivery dispatch once with authenticated sender context', async () => {
  const credentials = browserOwnerCredentials();
  const owner = browserOwnerDevice(credentials);
  const reviewer = browserReviewerDevice();
  let socket: WebSocket | null = null;
  const deliveries: Array<{ source: string; sender: Device; payload: string }> = [];
  const server = await startMockServer();
  try {
    server.onClient((ws) => {
      socket = ws;
      ws.on('message', (raw) => {
        const frame = JSON.parse(String(raw));
        if (frame.type !== 'subscribe') return;
        ws.send(JSON.stringify({
          type: 'hello', serverSeq: 0, policy: POLICY, devices: [owner, reviewer.device],
          onlineDeviceIds: [owner.deviceId, reviewer.device.deviceId], missedSignalEnvelopeIds: [],
        }));
      });
    });
    const session = new BrowserSession({
      owner: credentials,
      relayUrl: `http://127.0.0.1:${server.port}`,
      disableWebRtc: true,
      store: makeStubStore(),
      fetchImpl: async () => ({
        status: 200,
        text: async () => JSON.stringify({ policy: POLICY, devices: [owner, reviewer.device] }),
      }),
      webSocketFactory: nodeFactory,
      onCollab: (delivery) => {
        deliveries.push({
          source: delivery.source,
          sender: delivery.sender,
          payload: delivery.payload,
        });
      },
      reconnectInitialMs: 50,
      reconnectMaxMs: 200,
    });
    await session.start();
    for (let index = 0; index < 80 && !session.getState().authoringReady; index += 1) await delay(20);
    const envelope = assembleBrowserSignal({
      signalingKey: KEYS.signalingKey,
      roomId: ROOM_ID,
      authorId: reviewer.identity.participantId,
      deviceId: reviewer.identity.deviceId,
      createdAt: 1_700_000_700_000,
      expiresAt: POLICY.expiresAt,
      payload: { kind: 'collab', from: reviewer.identity.deviceId, payload: JSON.stringify({
        kind: 'resync', fileId: 'file-owner', epoch: 'snapshot-owner',
      }) },
      clientNonce: new Uint8Array(16).fill(0x22),
      aeadNonce: new Uint8Array(24).fill(0x23),
    });
    const client = (session as unknown as { wsClient: { ingestDirectEnvelope(envelope: MailboxEnvelope): Promise<void> } }).wsClient;
    await client.ingestDirectEnvelope(envelope);
    socket!.send(JSON.stringify({ type: 'envelope', envelope, serverSeq: 1 }));
    await delay(40);
    assertEq(deliveries.length, 1, 'direct/network duplicate dispatched once');
    assertEq(deliveries[0]!.source, 'direct', 'direct won delivery race');
    assertEq(deliveries[0]!.sender.kind, 'reviewer', 'authenticated sender kind surfaced');
    assertEq(deliveries[0]!.sender.deviceId, reviewer.identity.deviceId, 'sender device surfaced');
    assertEq(deliveries[0]!.payload, JSON.stringify({
      kind: 'resync', fileId: 'file-owner', epoch: 'snapshot-owner',
    }), 'collab payload surfaced');
    session.close();
  } finally {
    await server.close();
  }
});

defineCase('browser owner drops authenticated remote submits on direct and mailbox paths', async () => {
  const credentials = browserOwnerCredentials();
  const owner = browserOwnerDevice(credentials);
  const reviewer = browserReviewerDevice();
  let socket: WebSocket | null = null;
  let dispatches = 0;
  const server = await startMockServer();
  try {
    server.onClient((ws) => {
      socket = ws;
      ws.on('message', (raw) => {
        if (JSON.parse(String(raw)).type !== 'subscribe') return;
        ws.send(JSON.stringify({
          type: 'hello', serverSeq: 0, policy: POLICY, devices: [owner, reviewer.device],
          onlineDeviceIds: [owner.deviceId, reviewer.device.deviceId], missedSignalEnvelopeIds: [],
        }));
      });
    });
    const session = new BrowserSession({
      owner: credentials,
      relayUrl: `http://127.0.0.1:${server.port}`,
      disableWebRtc: true,
      store: makeStubStore(),
      fetchImpl: async () => ({
        status: 200,
        text: async () => JSON.stringify({ policy: POLICY, devices: [owner, reviewer.device] }),
      }),
      webSocketFactory: nodeFactory,
      onCollab: () => { dispatches += 1; },
      reconnectInitialMs: 50,
      reconnectMaxMs: 200,
    });
    await session.start();
    for (let index = 0; index < 80 && !session.getState().authoringReady; index += 1) await delay(20);
    const submit = JSON.stringify({
      kind: 'submit', fileId: 'file-owner', epoch: 'snapshot-owner',
      submission: {
        clientID: 'forged-reviewer', version: 0,
        steps: [{ stepType: 'replace', from: 1, to: 1 }],
      },
    });
    const envelope = assembleBrowserSignal({
      signalingKey: KEYS.signalingKey,
      roomId: ROOM_ID,
      authorId: reviewer.identity.participantId,
      deviceId: reviewer.identity.deviceId,
      createdAt: 1_700_000_705_000,
      expiresAt: POLICY.expiresAt,
      payload: { kind: 'collab', from: reviewer.identity.deviceId, payload: submit },
      clientNonce: new Uint8Array(16).fill(0x2a),
      aeadNonce: new Uint8Array(24).fill(0x2b),
    });
    const client = (
      session as unknown as { wsClient: { ingestDirectEnvelope(item: MailboxEnvelope): Promise<void> } }
    ).wsClient;
    await client.ingestDirectEnvelope(envelope);
    socket!.send(JSON.stringify({ type: 'envelope', envelope, serverSeq: 1 }));
    await delay(40);
    assertEq(dispatches, 0, 'remote submit reached browser owner authority callback');
    session.close();
  } finally {
    await server.close();
  }
});

defineCase('rejected direct collab callback retries from durable network delivery', async () => {
  const credentials = browserOwnerCredentials();
  const owner = browserOwnerDevice(credentials);
  const reviewer = browserReviewerDevice();
  let socket: WebSocket | null = null;
  let session!: BrowserSession;
  const attempts: string[] = [];
  let networkWasCommitted = false;
  const server = await startMockServer();
  try {
    server.onClient((ws) => {
      socket = ws;
      ws.on('message', (raw) => {
        if (JSON.parse(String(raw)).type !== 'subscribe') return;
        ws.send(JSON.stringify({
          type: 'hello', serverSeq: 0, policy: POLICY, devices: [owner, reviewer.device],
          onlineDeviceIds: [owner.deviceId, reviewer.device.deviceId], missedSignalEnvelopeIds: [],
        }));
      });
    });
    session = new BrowserSession({
      owner: credentials,
      relayUrl: `http://127.0.0.1:${server.port}`,
      disableWebRtc: true,
      store: makeStubStore(),
      fetchImpl: async () => ({
        status: 200,
        text: async () => JSON.stringify({ policy: POLICY, devices: [owner, reviewer.device] }),
      }),
      webSocketFactory: nodeFactory,
      onCollab: (delivery) => {
        attempts.push(delivery.source);
        if (delivery.source === 'direct') throw new Error('transient direct consumer failure');
        networkWasCommitted = (
          session as unknown as { volatileInbound: Map<string, unknown> }
        ).volatileInbound.has(delivery.envelopeId);
      },
      reconnectInitialMs: 50,
      reconnectMaxMs: 200,
    });
    await session.start();
    for (let index = 0; index < 80 && !session.getState().authoringReady; index += 1) await delay(20);
    const envelope = assembleBrowserSignal({
      signalingKey: KEYS.signalingKey,
      roomId: ROOM_ID,
      authorId: reviewer.identity.participantId,
      deviceId: reviewer.identity.deviceId,
      createdAt: 1_700_000_710_000,
      expiresAt: POLICY.expiresAt,
      payload: { kind: 'collab', from: reviewer.identity.deviceId, payload: JSON.stringify({
        kind: 'resync', fileId: 'file-owner', epoch: 'snapshot-owner',
      }) },
      clientNonce: new Uint8Array(16).fill(0x24),
      aeadNonce: new Uint8Array(24).fill(0x25),
    });
    const client = (
      session as unknown as { wsClient: { ingestDirectEnvelope(item: MailboxEnvelope): Promise<void> } }
    ).wsClient;
    let directRejected = false;
    try { await client.ingestDirectEnvelope(envelope); }
    catch { directRejected = true; }
    assert(directRejected, 'direct callback rejection did not surface');
    socket!.send(JSON.stringify({ type: 'envelope', envelope, serverSeq: 1 }));
    for (let index = 0; index < 80 && attempts.length < 2; index += 1) await delay(10);
    assertEq(attempts.join(','), 'direct,network', 'network delivery retried rejected direct callback');
    assert(networkWasCommitted, 'network durability commit did not precede callback retry');
    socket!.send(JSON.stringify({ type: 'envelope', envelope, serverSeq: 2 }));
    await delay(30);
    assertEq(attempts.length, 2, 'successful network retry was not deduplicated');
    session.close();
  } finally {
    await server.close();
  }
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

    const inviteUrl = composeInviteUrl('https://example.com/review', ROOM_ID, ROOM_SECRET);
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
    const internalKeys = (session as unknown as {
      keys: (typeof KEYS & { readAdmissionKey: Uint8Array; writeAdmissionKey?: Uint8Array }) | null;
    }).keys;
    assert(internalKeys !== null, 'derived room keys retained while connected');
    session.close();
    for (const [label, bytes] of Object.entries({
      rootKey: internalKeys.rootKey,
      eventKey: internalKeys.eventKey,
      snapshotKey: internalKeys.snapshotKey,
      signalingKey: internalKeys.signalingKey,
      readAdmissionKey: internalKeys.readAdmissionKey,
      writeAdmissionKey: internalKeys.writeAdmissionKey!,
      signingSecret: identity.signingSecret,
      encryptionSecret: identity.encryptionSecret,
    })) {
      assert(bytes.every((byte) => byte === 0), `${label} zeroed on close`);
    }
  } finally {
    await server.close();
  }
});

defineCase('v3 view uses anonymous read socket and performs zero mutations', async () => {
  const server = await startMockServer();
  try {
    let requestCount = 0;
    let socketProtocol = '';
    let socketUrl = '';
    server.onClient((ws, protocol) => {
      socketProtocol = protocol;
      ws.on('message', (raw) => {
        if (JSON.parse(String(raw)).type !== 'subscribe') return;
        ws.send(JSON.stringify({
          type: 'hello',
          serverSeq: 0,
          policy: POLICY,
          devices: [OWNER_DEVICE],
          onlineDeviceIds: [OWNER_DEVICE.deviceId],
          missedSignalEnvelopeIds: [],
        }));
      });
    });
    const session = new BrowserSession({
      parsedInvite: {
        version: 3,
        tier: 'view',
        roomId: ROOM_ID,
        readCapabilityKey: new Uint8Array(32).fill(0x41),
      },
      relayUrl: `http://127.0.0.1:${server.port}`,
      store: makeStubStore(),
      fetchImpl: async (url, init) => {
        requestCount += 1;
        assertEq(init.method, 'GET', 'view performs GET only');
        assert(url.endsWith(`/v3/rooms/${ROOM_ID}/devices`), 'view reads v3 directory');
        assert(init.headers?.['Attn-Admission']?.startsWith('v3.read.'), 'read-scoped admission');
        return { status: 200, text: async () => JSON.stringify({ policy: POLICY, devices: [OWNER_DEVICE] }) };
      },
      webSocketFactory: (url, protocols) => {
        socketUrl = url;
        return nodeFactory(url, protocols);
      },
      reconnectInitialMs: 50,
      reconnectMaxMs: 100,
    });
    await session.start();
    for (let i = 0; i < 50 && session.getState().status !== 'connected'; i++) await delay(10);
    assertEq(session.getState().status, 'connected', 'view connects');
    assertEq(session.getState().grantTier, 'view', 'view tier retained');
    assertEq(session.getState().authoringReady, false, 'view never authors');
    assertEq(requestCount, 1, 'no registration/outbox mutation');
    assert(/\/v3\/rooms\/[^/]+\/socket\?viewer_id=[A-Za-z0-9_-]{22}$/u.test(socketUrl), 'canonical anonymous viewer URL');
    assert(socketProtocol.includes('attn.v3') && socketProtocol.includes('read-hmac.'), 'v3 read socket');
    session.close();
  } finally {
    await server.close();
  }
});

defineCase('v3 comment registration binds URL grant and uses write admission', async () => {
  const server = await startMockServer();
  try {
    const grantSignature = base64UrlEncode(
      ed25519.sign(canonicalDeviceGrantV3(ROOM_ID, 'comment'), OWNER_KEYPAIR.secret),
    );
    const captured: { registration: Record<string, unknown> | null } = { registration: null };
    let socketProtocol = '';
    server.onClient((ws, protocol) => {
      socketProtocol = protocol;
      ws.on('message', (raw) => {
        if (JSON.parse(String(raw)).type !== 'subscribe') return;
        ws.send(JSON.stringify({
          type: 'hello',
          serverSeq: 0,
          policy: POLICY,
          devices: [OWNER_DEVICE],
          missedSignalEnvelopeIds: [],
        }));
      });
    });
    const session = new BrowserSession({
      parsedInvite: {
        version: 3,
        tier: 'comment',
        roomId: ROOM_ID,
        readCapabilityKey: new Uint8Array(32).fill(0x42),
        writeAdmissionKey: new Uint8Array(32).fill(0x43),
        grantSignature,
      },
      relayUrl: `http://127.0.0.1:${server.port}`,
      identity: deterministicIdentity(),
      powToken: 'test-pow-token',
      store: makeStubStore(),
      fetchImpl: async (url, init) => {
        if (init.method === 'GET') {
          assert(init.headers?.['Attn-Admission']?.startsWith('v3.read.'), 'directory uses read scope');
          return { status: 200, text: async () => JSON.stringify({ policy: POLICY, devices: [OWNER_DEVICE] }) };
        }
        if (url.endsWith('/devices')) {
          assert(init.headers?.['Attn-Admission']?.startsWith('v3.write.'), 'registration uses write scope');
          captured.registration = JSON.parse(init.body ?? '{}');
          return { status: 204, text: async () => '' };
        }
        return { status: 200, text: async () => JSON.stringify({ accepted: [] }) };
      },
      webSocketFactory: nodeFactory,
      reconnectInitialMs: 50,
      reconnectMaxMs: 100,
    });
    await session.start();
    assert(captured.registration !== null, 'v3 device registration captured');
    const registration = captured.registration;
    assertEq(registration?.grantTier, 'comment', 'registration tier');
    assertEq(registration?.grantSignature, grantSignature, 'registration owner grant');
    assert(typeof registration?.selfSignature === 'string', 'device binds grant in self signature');
    for (let i = 0; i < 50 && socketProtocol.length === 0; i++) await delay(10);
    assert(socketProtocol.includes('read-hmac.'), 'device socket proves read capability');
    assert(socketProtocol.includes('write-hmac.'), 'device socket proves write capability');
    let rejected = false;
    try {
      await session.createSuggestion({
        anchor: {
          v: 2,
          fileId: 'file-tier',
          snapshotId: 'snapshot-tier',
          baseHash: 'hash-tier',
          position: { byteRange: [0, 1], lineRange: [1, 1] },
        },
        operation: { kind: 'replace', expectedText: 'a', replacement: 'b' },
      });
    } catch {
      rejected = true;
    }
    assert(rejected, 'comment session hard-blocks suggestion');
    session.close();
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
      inviteUrl: composeInviteUrl('https://example.com/review', ROOM_ID, ROOM_SECRET),
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
    const inviteUrl = composeInviteUrl('https://example.com/review', ROOM_ID, ROOM_SECRET);
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
      inviteUrl: composeInviteUrl('https://example.com/review', ROOM_ID, ROOM_SECRET),
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

    const inviteUrl = composeInviteUrl('https://example.com/review', ROOM_ID, ROOM_SECRET);
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
      inviteUrl: composeInviteUrl('https://example.com/review', ROOM_ID, ROOM_SECRET),
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
    assertEq(store.snapshots[0]!.anchorIndex, undefined, 'legacy omitted anchor index remains accepted');
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
      inviteUrl: composeInviteUrl('https://example.com/review', ROOM_ID, ROOM_SECRET),
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
      inviteUrl: composeInviteUrl('https://example.com/review', ROOM_ID, ROOM_SECRET),
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

    const inviteUrl = composeInviteUrl('https://example.com/review', ROOM_ID, ROOM_SECRET);
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
      inviteUrl: composeInviteUrl('https://example.com/review', ROOM_ID, ROOM_SECRET),
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
    const inviteUrl = composeInviteUrl('https://example.com/review', ROOM_ID, ROOM_SECRET);
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
  const subscribeAfterByDevice = new Map<string, number[]>();
  let subscriptions = 0;
  try {
    server.onClient((ws, _subprotocol, requestUrl) => {
      const deviceId = new URL(requestUrl, 'http://127.0.0.1').searchParams.get('device_id') ?? 'unknown';
      ws.on('message', (raw) => {
        const msg = JSON.parse(String(raw));
        if (msg.type !== 'subscribe') return;
        subscriptions += 1;
        const deviceSubscriptions = subscribeAfterByDevice.get(deviceId) ?? [];
        deviceSubscriptions.push(msg.after as number);
        subscribeAfterByDevice.set(deviceId, deviceSubscriptions);
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
      inviteUrl: composeInviteUrl('https://example.com/review', ROOM_ID, ROOM_SECRET),
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
      inviteUrl: composeInviteUrl('https://example.com/review', ROOM_ID, ROOM_SECRET),
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
    for (
      let i = 0;
      i < 50 && (subscribeAfterByDevice.get('br-test-device')?.length ?? 0) < 3;
      i += 1
    ) {
      await delay(10);
    }
    const rememberedSubscriptions = subscribeAfterByDevice.get('br-test-device') ?? [];
    assertEq(rememberedSubscriptions[0], 0, 'first invite starts from an empty cursor');
    assert(
      rememberedSubscriptions.length >= 3
        && rememberedSubscriptions.slice(1).every((after) => after === 11),
      `remembered device reloads subscribe from committed cursor: ${JSON.stringify(rememberedSubscriptions)}`,
    );
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

defineCase('snapshot parser accepts inert binary/manifest metadata and rejects active or tampered shapes', () => {
  const asset = parseBrowserSnapshotPlaintext(toCanonicalBytes({
    docType: 'asset', content: 'AP8AQQ', encoding: 'base64url', mediaType: 'application/octet-stream',
  }));
  assertEq(asset?.docType, 'asset', 'binary asset accepted without UTF-8 decoding');
  assert(
    parseBrowserSnapshotPlaintext(toCanonicalBytes({
      docType: 'asset', content: 'AP8AQQ', encoding: 'base64url', mediaType: 'text/html; charset=utf-8',
    })) === null,
    'parameterized/active asset metadata rejected',
  );
  const id = (length: number, fill: number) => base64UrlEncode(new Uint8Array(length).fill(fill));
  const manifest = parseBrowserSnapshotPlaintext(toCanonicalBytes({
    docType: 'workspace_manifest',
    manifest: {
      v: 1, kind: 'attn_workspace_snapshot', scope: 'file',
      entries: [{
        fileId: id(16, 1), snapshotId: id(16, 2), path: 'safe/file.bin', kind: 'asset',
        mediaType: 'application/octet-stream', byteLength: 5, contentHash: id(32, 3),
      }],
    },
  }));
  assertEq(manifest?.docType, 'workspace_manifest', 'strict inert manifest accepted');
  assert(
    parseBrowserSnapshotPlaintext(toCanonicalBytes({ docType: 'html', content: '<script>x</script>', executable: true })) === null,
    'extra active-content flag rejected',
  );
});

type SnapshotCreatedBody = Extract<ReviewEventBody, { type: 'snapshot_created' }>;
interface HydrationTestSession {
  hydrateSnapshot(
    store: ReviewStoreSink,
    meta: EventMeta,
    body: SnapshotCreatedBody,
    inline: SnapshotPlaintext,
  ): Promise<void>;
  hydrateSnapshotBlob(
    store: ReviewStoreSink,
    meta: EventMeta,
    body: SnapshotCreatedBody,
    cached: { snapshot: SnapshotPlaintext; byteLength: number; contentHash: string },
  ): Promise<void>;
}

function hydrationMeta(createdAt: number): EventMeta {
  return {
    v: 2,
    eventId: `evt-hydration-${createdAt}`,
    roomId: ROOM_ID,
    authorId: OWNER_DEVICE.participantId,
    deviceId: OWNER_DEVICE.deviceId,
    createdAt,
    parentEventIds: [],
  };
}

defineCase('asset-first hydration remains inert and absent from current selection', async () => {
  const store = makeStubStore();
  store.currentRoomId = ROOM_ID as RoomId;
  const session = new BrowserSession({ store });
  const raw = new Uint8Array([0, 255, 7, 42]);
  const asset: SnapshotPlaintext = {
    docType: 'asset',
    content: base64UrlEncode(raw),
    encoding: 'base64url',
    mediaType: 'application/octet-stream',
  };
  const body: SnapshotCreatedBody = {
    type: 'snapshot_created',
    fileId: base64UrlEncode(new Uint8Array(16).fill(1)),
    snapshotId: base64UrlEncode(new Uint8Array(16).fill(2)),
    ownerDisplayPath: 'assets/first.bin',
    baseHash: contentHash(raw),
    inlineSnapshot: asset,
  };
  await (session as unknown as HydrationTestSession).hydrateSnapshot(
    store,
    hydrationMeta(1),
    body,
    asset,
  );
  assertEq(store.snapshots.length, 1, 'asset metadata retained');
  assertEq(store.snapshots[0]?.docType, 'asset', 'asset remains tagged inert');
  assertEq(store.currentFileId, null, 'asset never becomes current file');
  assertEq(store.currentSnapshotId, null, 'asset never becomes current snapshot');
  assertEq(session.getState().snapshotContent, null, 'asset never reaches renderer state');
  session.close();
});

defineCase('manifest waits for an out-of-order recovered R2 entry, then validates and hydrates', async () => {
  const store = makeStubStore();
  store.currentRoomId = ROOM_ID as RoomId;
  const session = new BrowserSession({ store });
  const ids = (length: number, fill: number) => base64UrlEncode(new Uint8Array(length).fill(fill));
  const raw = new Uint8Array([0, 1, 255, 9]);
  const assetSnapshotId = ids(16, 12);
  const assetFileId = ids(16, 11);
  const asset: SnapshotPlaintext = {
    docType: 'asset',
    content: base64UrlEncode(raw),
    encoding: 'base64url',
    mediaType: 'application/octet-stream',
  };
  const manifest: SnapshotPlaintext = {
    docType: 'workspace_manifest',
    manifest: {
      v: 1,
      kind: 'attn_workspace_snapshot',
      scope: 'file',
      entries: [{
        fileId: assetFileId,
        snapshotId: assetSnapshotId,
        path: 'assets/deferred.bin',
        kind: 'asset',
        mediaType: 'application/octet-stream',
        byteLength: raw.length,
        contentHash: contentHash(raw),
      }],
    },
  };
  const manifestBody: SnapshotCreatedBody = {
    type: 'snapshot_created',
    fileId: ids(16, 13),
    snapshotId: ids(16, 14),
    baseHash: contentHash(toCanonicalBytes(manifest.manifest)),
    inlineSnapshot: manifest,
  };
  const hydrate = session as unknown as HydrationTestSession;
  await hydrate.hydrateSnapshot(store, hydrationMeta(2), manifestBody, manifest);
  assertEq(store.snapshots.length, 0, 'unbound manifest is deferred, not accepted');

  const assetBytes = toCanonicalBytes(asset);
  const assetBody: SnapshotCreatedBody = {
    type: 'snapshot_created',
    fileId: assetFileId,
    snapshotId: assetSnapshotId,
    ownerDisplayPath: 'assets/deferred.bin',
    baseHash: contentHash(raw),
    encryptedBlobRef: {
      storage: 'r2',
      blobId: 'r2-deferred-asset',
      byteLength: assetBytes.length,
      contentHash: contentHash(assetBytes),
    },
  };
  await hydrate.hydrateSnapshotBlob(store, hydrationMeta(3), assetBody, {
    snapshot: asset,
    byteLength: assetBytes.length,
    contentHash: contentHash(assetBytes),
  });
  assertEq(store.snapshots.length, 2, 'asset then validated manifest hydrate exactly once');
  assertEq(store.snapshots[0]?.docType, 'asset', 'recovered entry retained as inert asset');
  assertEq(store.snapshots[1]?.docType, 'workspace_manifest', 'manifest accepted after binding');
  assertEq(store.currentFileId, null, 'deferred inert records never alter file selection');
  assertEq(store.currentSnapshotId, null, 'deferred inert records never alter snapshot selection');
  session.close();
});

defineCase('manifest rejects a hydrated entry whose signed binding differs', async () => {
  const store = makeStubStore();
  store.currentRoomId = ROOM_ID as RoomId;
  const session = new BrowserSession({ store });
  const ids = (length: number, fill: number) => base64UrlEncode(new Uint8Array(length).fill(fill));
  const raw = new Uint8Array([4, 5, 6]);
  const assetSnapshotId = ids(16, 22);
  const assetFileId = ids(16, 21);
  const asset: SnapshotPlaintext = {
    docType: 'asset', content: base64UrlEncode(raw), encoding: 'base64url', mediaType: 'image/png',
  };
  const hydrate = session as unknown as HydrationTestSession;
  await hydrate.hydrateSnapshot(store, hydrationMeta(4), {
    type: 'snapshot_created', fileId: assetFileId, snapshotId: assetSnapshotId,
    ownerDisplayPath: 'actual.png', baseHash: contentHash(raw), inlineSnapshot: asset,
  }, asset);
  const manifest: Extract<SnapshotPlaintext, { docType: 'workspace_manifest' }> = {
    docType: 'workspace_manifest',
    manifest: {
      v: 1, kind: 'attn_workspace_snapshot', scope: 'file', entries: [{
        fileId: assetFileId, snapshotId: assetSnapshotId, path: 'forged.png', kind: 'asset',
        mediaType: 'image/png', byteLength: raw.length, contentHash: contentHash(raw),
      }],
    },
  };
  await hydrate.hydrateSnapshot(store, hydrationMeta(5), {
    type: 'snapshot_created', fileId: ids(16, 23), snapshotId: ids(16, 24),
    baseHash: contentHash(toCanonicalBytes(manifest.manifest)), inlineSnapshot: manifest,
  }, manifest);
  assertEq(session.getState().error?.kind, 'network', 'binding mismatch fails closed');
  assert(!store.snapshots.some((snapshot) => snapshot.docType === 'workspace_manifest'), 'bad manifest never accepted');
});

defineCase('inbound markdown verifies a present anchor index against the lazy canonical builder', async () => {
  const canonical: AnchorIndex = {
    docHash: 'canonical-doc-hash', canonicalEncoding: 'utf8-bytes', lineCount: 2,
    blocks: [], headings: [],
  };
  const markdown = '# Verified\n';
  const body: SnapshotCreatedBody = {
    type: 'snapshot_created', fileId: 'file-anchor', snapshotId: 'snap-anchor',
    baseHash: contentHash(new TextEncoder().encode(markdown)),
    inlineSnapshot: { docType: 'markdown', content: markdown, anchorIndex: canonical },
  };
  const accepted = makeStubStore();
  const good = new BrowserSession({
    store: accepted,
    anchorIndexBuilder: async () => structuredClone(canonical),
  });
  await (good as unknown as HydrationTestSession).hydrateSnapshot(
    accepted, hydrationMeta(6), body, body.inlineSnapshot!,
  );
  assertEq(accepted.snapshots.length, 1, 'matching canonical anchor index accepted');
  assertEq(accepted.currentSnapshotId, 'snap-anchor' as SnapshotId, 'verified document selected');
  good.close();

  const rejected = makeStubStore();
  const bad = new BrowserSession({
    store: rejected,
    anchorIndexBuilder: async () => ({ ...canonical, lineCount: 99 }),
  });
  await (bad as unknown as HydrationTestSession).hydrateSnapshot(
    rejected, hydrationMeta(7), body, body.inlineSnapshot!,
  );
  assertEq(bad.getState().error?.kind, 'network', 'mismatched canonical anchor index rejected');
  assertEq(rejected.snapshots.length, 0, 'tampered document never reaches store');
});

// ---------------------------------------------------------------------------
// attn-dgya: a reopened owner tab replays the durable review log.
// ---------------------------------------------------------------------------

function mintBrowserOwnerCommentEnvelope(
  credentials: BrowserOwnerCredentials,
  envelopeId: string,
  createdAt: number,
  commentBody: string,
  threadId: string,
): MailboxEnvelope {
  const meta: SignableMetaShape = {
    v: 2,
    eventId: '',
    roomId: ROOM_ID,
    authorId: credentials.identity.participantId,
    deviceId: credentials.identity.deviceId,
    createdAt,
    parentEventIds: [],
  };
  const body = {
    type: 'comment_created',
    threadId,
    anchor: {
      v: 2,
      fileId: 'file-dgya',
      snapshotId: 'snap-dgya',
      baseHash: 'hash-dgya',
      position: { byteRange: [0, 5], lineRange: [1, 1], pmRange: [1, 6] },
    },
    body: commentBody,
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
  const auth = {
    signature: base64UrlEncode(ed25519.sign(signed, credentials.identity.signingSecret)),
    signingKeyId: base64UrlEncode(sha256(credentials.identity.signingPublic)),
  };
  const plaintextBytes = toCanonicalBytes({ auth, body, meta: { ...meta } });
  const nonce = new Uint8Array(24);
  for (let i = 0; i < nonce.length; i++) nonce[i] = 0x2a + i;
  const aad: EnvelopeAad = {
    v: 2,
    roomId: ROOM_ID,
    envelopeId,
    kind: 'event',
    authorId: credentials.identity.participantId,
    deviceId: credentials.identity.deviceId,
    createdAt,
  };
  const ct = aeadSeal(KEYS.eventKey, nonce, plaintextBytes, aad);
  return {
    v: 2,
    roomId: ROOM_ID,
    envelopeId,
    authorId: credentials.identity.participantId,
    deviceId: credentials.identity.deviceId,
    createdAt,
    expiresAt: createdAt + 7 * 24 * 60 * 60 * 1000,
    kind: 'event',
    nonce: base64UrlEncode(nonce),
    ciphertext: base64UrlEncode(ct),
    ciphertextBytes: ct.length,
  };
}

defineCase('reopened owner replays the durable review log and resubscribes from its cursor (attn-dgya)', async () => {
  const databaseName = `${BROWSER_STORAGE_DB_NAME}-dgya-${Date.now()}`;
  const openStorage = (createIfMissing: boolean) => BrowserStorage.open({
    createIfMissing,
    databaseName,
    indexedDB,
    filesystem: null,
    navigator: { storage: { persist: async () => true, estimate: async () => ({}) } },
  });
  const credentials = browserOwnerCredentials();
  const device = browserOwnerDevice(credentials);
  const envelope = mintBrowserOwnerCommentEnvelope(
    credentials,
    'env-dgya-comment',
    1_700_002_000_000,
    'DGYA-REOPENED-THREAD',
    'thread-dgya',
  );
  // Previous page lifetime durably committed the inbound comment at seq 7.
  const seeded = await openStorage(true);
  await seeded.commitInbound(ROOM_ID, credentials.identity.deviceId, envelope, 7);
  seeded.close();

  const server = await startMockServer();
  const subscribeAfter: number[] = [];
  try {
    server.onClient((ws) => {
      ws.on('message', (raw) => {
        const frame = JSON.parse(String(raw));
        if (frame.type !== 'subscribe') return;
        subscribeAfter.push(frame.after as number);
        ws.send(JSON.stringify({
          type: 'hello',
          serverSeq: 7,
          policy: POLICY,
          devices: [device],
          onlineDeviceIds: [device.deviceId],
          missedSignalEnvelopeIds: [],
        }));
        // A relay may re-broadcast an already-committed envelope after a
        // reconnect: the reopened owner must keep exactly one copy.
        ws.send(JSON.stringify({ type: 'envelope', envelope, serverSeq: 7 }));
      });
    });
    const store = makeStubStore();
    const session = new BrowserSession({
      owner: credentials,
      relayUrl: `http://127.0.0.1:${server.port}`,
      disableWebRtc: true,
      store,
      storageFactory: openStorage,
      powToken: 'unused-owner-pow',
      fetchImpl: async (_url, init) => {
        if (init.method !== 'GET') throw new Error('owner reopen attempted a POST');
        return { status: 200, text: async () => JSON.stringify({ policy: POLICY, devices: [device] }) };
      },
      webSocketFactory: nodeFactory,
      reconnectInitialMs: 50,
      reconnectMaxMs: 200,
    });
    await session.start();
    // Replay completes before the socket subscribes — the thread must be
    // visible even if the relay retained nothing.
    assert(
      store.events.some(
        (event) => event.body.type === 'comment_created' && event.body.body === 'DGYA-REOPENED-THREAD',
      ),
      'durable comment thread rehydrated from the local log at startOwner',
    );
    for (let i = 0; i < 80 && subscribeAfter.length === 0; i += 1) await delay(20);
    assertEq(subscribeAfter[0], 7, 'owner resubscribes from the persisted cursor, not 0');
    // Let the echoed serverSeq-7 envelope drain through the inbound queue.
    await delay(200);
    assertEq(
      store.events.filter((event) => event.body.type === 'comment_created').length,
      1,
      'live re-delivery of a replayed envelope stays deduplicated',
    );
    session.close();
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
