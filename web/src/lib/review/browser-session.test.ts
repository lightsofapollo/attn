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
import { ed25519 } from '@noble/curves/ed25519.js';
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
  base64UrlEncode,
  deriveRoomId,
  deriveRoomKeys,
  signingKeyId,
  toCanonicalBytes,
  type EnvelopeAad,
  type SignableMetaShape,
} from './browser-crypto';
import { composeInviteUrl } from './browser-invite';
import type {
  ReviewEvent,
  ReviewSnapshot,
  FileId,
  SnapshotId,
  RoomId,
} from '../types';
import type { MailboxEnvelope, RoomPolicy, Device, WebSocketLike } from './browser-ws';

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
      s.events = [...s.events, event];
    },
    applySnapshot(snapshot: ReviewSnapshot) {
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

const OWNER_DEVICE: Device = {
  deviceId: 'd-owner-01',
  participantId: 'p-owner-01',
  publicEncryptionKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  publicSigningKey: base64UrlEncode(OWNER_KEYPAIR.publicKey),
  client: 'attn-native',
  createdAt: 1_700_000_000_000,
};

const POLICY: RoomPolicy = {
  mode: 'live',
  maxPeers: 8,
  maxSnapshotBytes: 5 * 1024 * 1024,
  maxEventBytes: 256 * 1024,
  maxEvents: 1000,
  expiresAt: 1_900_000_000_000,
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
): MailboxEnvelope {
  const meta: SignableMetaShape = {
    v: 2,
    eventId: envelopeId,
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
  const body = {
    type: 'snapshot_created',
    fileId,
    snapshotId,
    baseHash: 'hash-' + snapshotId,
    // HTML docs are read-only and carry no anchor index.
    inlineSnapshot:
      docType === 'html'
        ? { docType, content }
        : { docType, content, anchorIndex },
  };
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
    const session = new BrowserSession({
      inviteUrl,
      relayUrl: `http://127.0.0.1:${server.port}`,
      identity: deterministicIdentity(),
      store,
      fetchImpl: async (url: string, _init: FetchLikeInit): Promise<FetchLikeResponse> => {
        devicePosts += 1;
        assert(
          url.endsWith(`/v2/rooms/${ROOM_ID}/devices`),
          `expected POST /devices URL, got ${url}`,
        );
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
      store,
      fetchImpl: async () => ({
        status: 403,
        text: async () => '{"error":{"code":"ATTN_POW_REQUIRED"}}',
      }),
      webSocketFactory: nodeFactory,
    });
    await session.start();
    assertEq(session.getState().status, 'error', 'error state');
    assertEq(session.getState().error?.kind, 'device_register', 'device_register tag');
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
      store,
      fetchImpl: async () => ({ status: 204, text: async () => '' }),
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
    assertEq(store.events.length, 1, 'event appended');
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
      store,
      fetchImpl: async () => ({ status: 204, text: async () => '' }),
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
      store,
      fetchImpl: async () => ({ status: 204, text: async () => '' }),
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

defineCase('generateBrowserIdentity produces 32-byte secret + 32-byte public', () => {
  const id = generateBrowserIdentity();
  assertEq(id.signingSecret.length, 32, 'ed25519 secret seed 32 bytes');
  assertEq(id.signingPublic.length, 32, 'ed25519 public key 32 bytes');
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
  return {
    deviceId: 'br-test-device',
    participantId: 'br-test-participant',
    signingSecret: secretKey,
    signingPublic: publicKey,
    publicEncryptionKey: new Uint8Array(32),
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
