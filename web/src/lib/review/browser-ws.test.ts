// Manual test harness for `browser-ws.ts` (planning issue attn-nnj.9.3).
//
// Spins up an in-process `ws` server on 127.0.0.1, points the
// `BrowserWsClient` at it via an injected factory that returns a Node
// `WebSocket`, and drives the protocol end to end.
//
// Run with:
//
//   cd web && npx tsx src/lib/review/browser-ws.test.ts

import { WebSocket as NodeWebSocket, WebSocketServer, type WebSocket } from 'ws';
import {
  BrowserWsClient,
  CLOSE_ADMISSION_INVALID,
  CLOSE_CURSOR_TOO_OLD,
  CLOSE_ROOM_DELETED,
  CLOSE_ROOM_EXPIRED,
  WsTerminalError,
  buildWsUrl,
  type DecodedEnvelope,
  type Device,
  type MailboxEnvelope,
  type RoomPolicy,
  type WebSocketLike,
} from './browser-ws';
import {
  aeadSeal,
  base64UrlDecode,
  base64UrlEncode,
  deriveEventId,
  deriveRoomKeys,
  signingKeyId,
  toCanonicalBytes,
  type EnvelopeAad,
  type SignableMetaShape,
} from './browser-crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { assembleBrowserSignal } from './browser-signaling';

// ---------------------------------------------------------------------------
// Tiny async test harness — runs each case sequentially, prints results,
// exits non-zero on the first failure (so order of failures stays readable).
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
// Mock server helpers.
// ---------------------------------------------------------------------------

interface MockServer {
  port: number;
  /** Fires once per client connection. */
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
    // The browser sends the subprotocol in `Sec-WebSocket-Protocol`; the
    // server picks one to respond with. For our admission HMAC the
    // protocol value is comma-separated (`attn.v2, hmac.<…>`) and the
    // `ws` server presents it as `req.headers['sec-websocket-protocol']`.
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

/**
 * Factory matching `BrowserWsOptions.webSocketFactory` — wraps the Node `ws`
 * client in the minimal `WebSocketLike` interface. We need this because the
 * `ws` package's API is event-emitter-style; the browser API uses `onfoo`
 * properties.
 */
function nodeFactory(url: string, protocols: string | string[]): WebSocketLike {
  // Note: the `ws` package's constructor takes either a single string or an
  // array of strings for protocols, matching the browser API.
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

// ---------------------------------------------------------------------------
// Deterministic fixtures — derived once and reused across cases.
// ---------------------------------------------------------------------------

const ROOM_SECRET = new Uint8Array(32).fill(0x11);
const KEYS = deriveRoomKeys(ROOM_SECRET);
const SIGNING_SEED = new Uint8Array(32).fill(0x22);
const SIGNING_KEYPAIR = (() => {
  const { secretKey, publicKey } = ed25519.keygen(SIGNING_SEED);
  return { secret: secretKey, publicKey };
})();
const SIGNING_KEY_ID = base64UrlEncode(sha256(SIGNING_KEYPAIR.publicKey));

const TEST_DEVICE_UNSIGNED: Omit<Device, 'selfSignature'> = {
  deviceId: 'd-author-01',
  participantId: 'p-author-01',
  publicEncryptionKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  publicSigningKey: base64UrlEncode(SIGNING_KEYPAIR.publicKey),
  client: 'attn-native',
  kind: 'reviewer',
  registeredAt: 1_700_000_000_000,
};
const TEST_DEVICE: Device = {
  ...TEST_DEVICE_UNSIGNED,
  selfSignature: base64UrlEncode(
    ed25519.sign(
      toCanonicalBytes({
        client: TEST_DEVICE_UNSIGNED.client,
        deviceId: TEST_DEVICE_UNSIGNED.deviceId,
        kind: TEST_DEVICE_UNSIGNED.kind,
        participantId: TEST_DEVICE_UNSIGNED.participantId,
        publicEncryptionKey: TEST_DEVICE_UNSIGNED.publicEncryptionKey,
        publicSigningKey: TEST_DEVICE_UNSIGNED.publicSigningKey,
      }),
      SIGNING_KEYPAIR.secret,
    ),
  ),
};

function signedDevice(unsigned: Omit<Device, 'selfSignature'>, secretKey: Uint8Array): Device {
  return {
    ...unsigned,
    selfSignature: base64UrlEncode(
      ed25519.sign(
        toCanonicalBytes({
          client: unsigned.client,
          deviceId: unsigned.deviceId,
          kind: unsigned.kind,
          participantId: unsigned.participantId,
          publicEncryptionKey: unsigned.publicEncryptionKey,
          publicSigningKey: unsigned.publicSigningKey,
          ...(unsigned.grantTier === undefined ? {} : { grantTier: unsigned.grantTier }),
          ...(unsigned.grantSignature === undefined ? {} : { grantSignature: unsigned.grantSignature }),
        }),
        secretKey,
      ),
    ),
  };
}

const TEST_POLICY: RoomPolicy = {
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

/**
 * Build a signed+encrypted Event envelope identical to what the Rust mailbox
 * pipeline would produce. The plaintext is canonical JSON of `{meta, body, auth}`.
 */
function mintEventEnvelope(
  roomId: string,
  envelopeId: string,
  createdAt: number,
  overrides: { eventId?: string; metaAuthorId?: string; body?: Record<string, unknown> } = {},
): MailboxEnvelope {
  const meta: SignableMetaShape = {
    v: 2,
    eventId: envelopeId, // not signed; just present on the wire
    roomId,
    authorId: overrides.metaAuthorId ?? TEST_DEVICE.participantId,
    deviceId: TEST_DEVICE.deviceId,
    createdAt,
    parentEventIds: [],
  };
  const body = overrides.body ?? {
    type: 'comment_created',
    threadId: 'thr-test-1',
    anchor: {
      v: 2,
      fileId: 'file-test',
      snapshotId: 'snap-test',
      baseHash: 'hash-test',
      position: { byteRange: [0, 5] as [number, number], lineRange: [1, 1] as [number, number] },
    },
    body: 'hello from mock server',
  };
  meta.eventId = overrides.eventId ?? deriveEventId(meta, body);
  // Build canonical signed bytes manually (matches Rust signing.rs).
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
  const sig = ed25519.sign(signed, SIGNING_KEYPAIR.secret);
  const auth = { signature: base64UrlEncode(sig), signingKeyId: SIGNING_KEY_ID };

  // Wire plaintext: { meta, body, auth }. We canonicalise so a Rust receiver
  // would produce the same bytes (consistency, not required).
  const wireMeta = { ...meta };
  const plaintextBytes = toCanonicalBytes({ auth, body, meta: wireMeta });

  // Seal with a fixed nonce (deterministic test) under eventKey.
  const nonce = new Uint8Array(24);
  for (let i = 0; i < nonce.length; i++) nonce[i] = 0x30 + i;
  const aad: EnvelopeAad = {
    v: 2,
    roomId,
    envelopeId,
    kind: 'event',
    authorId: TEST_DEVICE.participantId,
    deviceId: TEST_DEVICE.deviceId,
    createdAt,
  };
  const ct = aeadSeal(KEYS.eventKey, nonce, plaintextBytes, aad);

  const env: MailboxEnvelope = {
    v: 2,
    roomId,
    envelopeId,
    authorId: TEST_DEVICE.participantId,
    deviceId: TEST_DEVICE.deviceId,
    createdAt,
    expiresAt: createdAt + 7 * 24 * 60 * 60 * 1000,
    kind: 'event',
    nonce: base64UrlEncode(nonce),
    ciphertext: base64UrlEncode(ct),
    ciphertextBytes: ct.length,
  };
  return env;
}

function mintParticipantJoinedEnvelope(envelopeId: string, createdAt: number): MailboxEnvelope {
  return mintEventEnvelope('room-test', envelopeId, createdAt, {
    body: {
      type: 'participant_joined',
      participant: {
        participantId: TEST_DEVICE.participantId,
        displayName: 'Test reviewer',
        kind: TEST_DEVICE.kind,
        publicSigningKey: TEST_DEVICE.publicSigningKey,
        capabilities: ['read_snapshot', 'write_comment', 'write_suggestion', 'resolve_comment'],
      },
      device: {
        deviceId: TEST_DEVICE.deviceId,
        participantId: TEST_DEVICE.participantId,
        publicEncryptionKey: TEST_DEVICE.publicEncryptionKey,
        publicSigningKey: TEST_DEVICE.publicSigningKey,
        client: TEST_DEVICE.client,
        createdAt,
      },
    },
  });
}

function clientOptions(port: number) {
  const url = `ws://127.0.0.1:${port}/v2/rooms/room-test/socket?device_id=d-test`;
  return {
    roomId: 'room-test',
    localDeviceId: 'd-test',
    url,
    subprotocol: 'attn.v2, hmac.dGVzdA',
    afterSeq: 0,
    eventKey: KEYS.eventKey,
    snapshotKey: KEYS.snapshotKey,
    signalingKey: KEYS.signalingKey,
    webSocketFactory: nodeFactory,
    reconnectInitialMs: 50,
    reconnectMaxMs: 200,
  };
}

// ---------------------------------------------------------------------------
// Test: hello → envelope flow
// ---------------------------------------------------------------------------

defineCase('v3 directory grants are rooted in the unique room owner key', () => {
  const ownerKeys = ed25519.keygen(new Uint8Array(32).fill(0x44));
  const owner = signedDevice({
    deviceId: 'd-owner',
    participantId: 'p-owner',
    publicEncryptionKey: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
    publicSigningKey: base64UrlEncode(ownerKeys.publicKey),
    client: 'attn-native',
    kind: 'owner',
  }, ownerKeys.secretKey);
  const grantBytes = toCanonicalBytes({
    grantTier: 'comment',
    purpose: 'attn device grant v3',
    roomId: 'room-test',
    v: 3,
  });
  const reviewerBase = { ...TEST_DEVICE_UNSIGNED, grantTier: 'comment' as const };
  const forged = signedDevice({
    ...reviewerBase,
    grantSignature: base64UrlEncode(ed25519.sign(grantBytes, SIGNING_KEYPAIR.secret)),
  }, SIGNING_KEYPAIR.secret);
  const errors: string[] = [];
  const client = new BrowserWsClient({
    ...clientOptions(1),
    callbacks: { onError: (_code, message) => errors.push(message) },
  });
  client.mergeDevices([owner, forged]);
  assertEq(client.getDevices().size, 1, 'forged reviewer is not cached');
  assert(errors.some((message) => message.includes('owner grant signature')), 'forgery rejected');

  const valid = signedDevice({
    ...reviewerBase,
    grantSignature: base64UrlEncode(ed25519.sign(grantBytes, ownerKeys.secretKey)),
  }, SIGNING_KEYPAIR.secret);
  client.mergeDevices([valid]);
  assertEq(client.getDevices().size, 2, 'owner-authorized reviewer is cached');
  const cached = [...client.getDevices().values()].find((device) => device.kind === 'reviewer');
  assertEq(cached?.grantTier, 'comment', 'verified tier is retained for event authorization');
  client.close();
});

defineCase('hello frame populates device cache and onHello fires', async () => {
  const server = await startMockServer();
  try {
    server.onClient((ws) => {
      ws.on('message', (raw) => {
        const msg = JSON.parse(String(raw));
        if (msg.type === 'subscribe') {
          ws.send(
            JSON.stringify({
              type: 'hello',
              serverSeq: 42,
              policy: TEST_POLICY,
              devices: [TEST_DEVICE],
              missedSignalEnvelopeIds: [],
            }),
          );
        }
      });
    });

    let helloFired = false;
    let cachedDevices: ReadonlyMap<string, Device> | null = null;
    let terminal: WsTerminalError | null = null;
    const client = new BrowserWsClient({
      ...clientOptions(server.port),
      callbacks: {
        onHello: (_frame, devices) => {
          helloFired = true;
          cachedDevices = new Map(devices);
        },
        onTerminal: (e) => {
          terminal = e;
        },
      },
    });
    client.start();
    // Poll until hello arrives.
    for (let i = 0; i < 50 && !helloFired; i++) await delay(20);
    assert(helloFired, 'onHello should fire');
    assert(cachedDevices !== null, 'devices map captured');
    const c = cachedDevices as unknown as Map<string, Device>;
    assertEq(c.size, 1, 'one device cached');
    assert(c.has(SIGNING_KEY_ID), 'cached keyed by signingKeyId');
    assert(terminal === null, 'no terminal error');
    client.close();
  } finally {
    await server.close();
  }
});

defineCase('envelope frame decrypts + verifies + dispatches to onEnvelope', async () => {
  const server = await startMockServer();
  try {
    server.onClient((ws) => {
      ws.on('message', (raw) => {
        const msg = JSON.parse(String(raw));
        if (msg.type === 'subscribe') {
          ws.send(
            JSON.stringify({
              type: 'hello',
              serverSeq: 0,
              policy: TEST_POLICY,
              devices: [TEST_DEVICE],
              missedSignalEnvelopeIds: [],
            }),
          );
          ws.send(JSON.stringify({
            type: 'envelope',
            envelope: mintParticipantJoinedEnvelope('env-attest-happy', 1_700_000_099_000),
            serverSeq: 6,
          }));
          const env = mintEventEnvelope('room-test', 'env-001', 1_700_000_100_000);
          ws.send(JSON.stringify({ type: 'envelope', envelope: env, serverSeq: 7 }));
        }
      });
    });

    const inbound: DecodedEnvelope[] = [];
    const errors: Array<[string, string]> = [];
    const client = new BrowserWsClient({
      ...clientOptions(server.port),
      callbacks: {
        onEnvelope: (d) => { if (!d.envelope.envelopeId.startsWith('env-attest')) inbound.push(d); },
        onError: (code, msg) => errors.push([code, msg]),
      },
    });
    client.start();
    for (let i = 0; i < 60 && inbound.length === 0; i++) await delay(20);
    assert(inbound.length === 1, `expected 1 envelope, got ${inbound.length} (errors: ${JSON.stringify(errors)})`);
    const d = inbound[0]!;
    assertEq(d.serverSeq, 7, 'serverSeq forwarded');
    assertEq(d.envelope.envelopeId, 'env-001', 'envelopeId echoed');
    // Plaintext is canonical JSON of {auth, body, meta} — sanity check it
    // contains the comment body.
    const pt = new TextDecoder().decode(d.plaintext);
    assert(pt.includes('"hello from mock server"'), `plaintext recovered: ${pt}`);
    assertEq(errors.length, 0, 'no errors during happy path');
    client.close();
  } finally {
    await server.close();
  }
});

defineCase('cursor advances only after the async durable consumer commit resolves', async () => {
  const server = await startMockServer();
  try {
    server.onClient((ws) => {
      ws.on('message', (raw) => {
        const msg = JSON.parse(String(raw));
        if (msg.type !== 'subscribe') return;
        ws.send(JSON.stringify({
          type: 'hello',
          serverSeq: 0,
          policy: TEST_POLICY,
          devices: [TEST_DEVICE],
          missedSignalEnvelopeIds: [],
        }));
        ws.send(JSON.stringify({
          type: 'envelope',
          envelope: mintParticipantJoinedEnvelope('env-attest-commit-order', 1_700_000_120_000),
          serverSeq: 6,
        }));
        ws.send(JSON.stringify({
          type: 'envelope',
          envelope: mintEventEnvelope('room-test', 'env-commit-order', 1_700_000_120_001),
          serverSeq: 7,
        }));
      });
    });

    let releaseCommit!: () => void;
    let commitStarted = false;
    const commitGate = new Promise<void>((resolve) => { releaseCommit = resolve; });
    const client = new BrowserWsClient({
      ...clientOptions(server.port),
      callbacks: {
        onEnvelope: async (decoded) => {
          if (decoded.envelope.envelopeId !== 'env-commit-order') return;
          commitStarted = true;
          await commitGate;
        },
      },
    });
    client.start();
    for (let i = 0; i < 60 && !commitStarted; i++) await delay(20);
    assert(commitStarted, 'event reached durable consumer');
    assertEq(client.getAfterSeq(), 6, 'cursor remains at prior committed attestation');
    releaseCommit();
    for (let i = 0; i < 60 && client.getAfterSeq() !== 7; i++) await delay(20);
    assertEq(client.getAfterSeq(), 7, 'cursor advances after commit resolves');
    client.close();
  } finally {
    await server.close();
  }
});

defineCase('sealed replay rebuilds authorization without raising the network cursor', async () => {
  const server = await startMockServer();
  try {
    const subscribeAfter: number[] = [];
    server.onClient((ws) => {
      ws.on('message', (raw) => {
        const msg = JSON.parse(String(raw));
        if (msg.type !== 'subscribe') return;
        subscribeAfter.push(msg.after as number);
        ws.send(JSON.stringify({
          type: 'hello',
          serverSeq: 9,
          policy: TEST_POLICY,
          devices: [TEST_DEVICE],
          missedSignalEnvelopeIds: [],
        }));
      });
    });
    const replayed: DecodedEnvelope[] = [];
    const client = new BrowserWsClient({
      ...clientOptions(server.port),
      afterSeq: 4,
      initialDevices: new Map([['stored-device', TEST_DEVICE]]),
      callbacks: { onEnvelope: (decoded) => { replayed.push(decoded); } },
    });
    await client.replayEnvelope(
      mintParticipantJoinedEnvelope('env-attest-stored', 1_700_000_125_000),
      8,
    );
    await client.replayEnvelope(
      mintEventEnvelope('room-test', 'env-event-stored', 1_700_000_125_001),
      9,
    );
    assert(replayed.every((item) => item.source === 'replay'), 'replay source is explicit');
    assertEq(client.getAfterSeq(), 4, 'stored history does not widen contiguous cursor');
    client.start();
    for (let i = 0; i < 50 && subscribeAfter.length === 0; i++) await delay(20);
    assertEq(subscribeAfter.length, 1, 'one subscribe sent');
    assertEq(subscribeAfter[0], 4, 'subscribe uses separately persisted cursor');
    client.close();
  } finally {
    await server.close();
  }
});

defineCase('relay envelope without implicit v or roomId decrypts with subscription AAD', async () => {
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
            policy: TEST_POLICY,
            devices: [TEST_DEVICE],
            missedSignalEnvelopeIds: [],
          }),
        );
        ws.send(JSON.stringify({
          type: 'envelope',
          envelope: mintParticipantJoinedEnvelope('env-attest-wire', 1_700_000_149_000),
          serverSeq: 7,
        }));
        const envelope = mintEventEnvelope('room-test', 'env-relay-wire', 1_700_000_150_000);
        delete envelope.v;
        delete envelope.roomId;
        ws.send(JSON.stringify({ type: 'envelope', envelope, serverSeq: 8 }));
      });
    });

    const inbound: DecodedEnvelope[] = [];
    const errors: Array<[string, string]> = [];
    const client = new BrowserWsClient({
      ...clientOptions(server.port),
      callbacks: {
        onEnvelope: (decoded) => { if (!decoded.envelope.envelopeId.startsWith('env-attest')) inbound.push(decoded); },
        onError: (code, message) => errors.push([code, message]),
      },
    });
    client.start();
    for (let i = 0; i < 60 && inbound.length === 0; i++) await delay(20);
    assertEq(inbound.length, 1, `relay-shaped envelope should decrypt; errors=${JSON.stringify(errors)}`);
    assertEq(errors.length, 0, 'relay-shaped envelope should not emit errors');
    client.close();
  } finally {
    await server.close();
  }
});

defineCase('event id and plaintext metadata must remain bound to signed envelope routing', async () => {
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
            policy: TEST_POLICY,
            devices: [TEST_DEVICE],
            missedSignalEnvelopeIds: [],
          }),
        );
        ws.send(JSON.stringify({
          type: 'envelope',
          envelope: mintParticipantJoinedEnvelope('env-attest-binding', 1_700_000_159_000),
          serverSeq: 8,
        }));
        ws.send(
          JSON.stringify({
            type: 'envelope',
            envelope: mintEventEnvelope('room-test', 'env-bad-id', 1_700_000_160_000, {
              eventId: 'forged-event-id',
            }),
            serverSeq: 9,
          }),
        );
        ws.send(
          JSON.stringify({
            type: 'envelope',
            envelope: mintEventEnvelope('room-test', 'env-bad-meta', 1_700_000_170_000, {
              metaAuthorId: 'p-spoofed-author',
            }),
            serverSeq: 10,
          }),
        );
        ws.send(
          JSON.stringify({
            type: 'envelope',
            envelope: mintEventEnvelope('room-test', 'env-after-rejects', 1_700_000_180_000),
            serverSeq: 11,
          }),
        );
      });
    });

    const inbound: DecodedEnvelope[] = [];
    const errors: string[] = [];
    const client = new BrowserWsClient({
      ...clientOptions(server.port),
      callbacks: {
        onEnvelope: (decoded) => { if (!decoded.envelope.envelopeId.startsWith('env-attest')) inbound.push(decoded); },
        onError: (_code, message) => errors.push(message),
      },
    });
    client.start();
    for (let i = 0; i < 80 && inbound.length === 0; i++) await delay(20);
    assertEq(inbound.length, 1, 'only the valid event is dispatched');
    assertEq(inbound[0]!.envelope.envelopeId, 'env-after-rejects', 'valid event survives rejects');
    assert(errors.some((message) => message.includes('event id mismatch')), 'event id reject surfaced');
    assert(
      errors.some((message) => message.includes('metadata binding failed')),
      'metadata binding reject surfaced',
    );
    client.close();
  } finally {
    await server.close();
  }
});

defineCase('unknown signer can refresh the device cache and retry the ciphertext once', async () => {
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
            policy: TEST_POLICY,
            devices: [],
            missedSignalEnvelopeIds: [],
          }),
        );
        ws.send(
          JSON.stringify({
            type: 'envelope',
            envelope: mintParticipantJoinedEnvelope('env-late-signer', 1_700_000_190_000),
            serverSeq: 12,
          }),
        );
        ws.send(
          JSON.stringify({
            type: 'envelope',
            envelope: mintEventEnvelope('room-test', 'env-after-late-signer', 1_700_000_191_000),
            serverSeq: 13,
          }),
        );
      });
    });

    const inbound: DecodedEnvelope[] = [];
    let refreshes = 0;
    let client!: BrowserWsClient;
    client = new BrowserWsClient({
      ...clientOptions(server.port),
      callbacks: {
        onEnvelope: (decoded) => { inbound.push(decoded); },
        onUnknownSigner: async () => {
          refreshes += 1;
          await delay(40);
          client.mergeDevices([TEST_DEVICE]);
        },
      },
    });
    client.start();
    for (let i = 0; i < 80 && inbound.length < 2; i++) await delay(20);
    assertEq(refreshes, 1, 'one directory refresh requested');
    assert(
      JSON.stringify(inbound.map((item) => item.envelope.envelopeId)) ===
        JSON.stringify(['env-late-signer', 'env-after-late-signer']),
      'refresh blocks later cursor commits and preserves order',
    );
    assertEq(client.getAfterSeq(), 13, 'cursor advances contiguously after refresh');
    client.close();
  } finally {
    await server.close();
  }
});

defineCase('tampered ciphertext is dropped via ATTN_INBOUND, socket stays up', async () => {
  const server = await startMockServer();
  try {
    server.onClient((ws) => {
      ws.on('message', (raw) => {
        const msg = JSON.parse(String(raw));
        if (msg.type === 'subscribe') {
          ws.send(
            JSON.stringify({
              type: 'hello',
              serverSeq: 0,
              policy: TEST_POLICY,
              devices: [TEST_DEVICE],
              missedSignalEnvelopeIds: [],
            }),
          );
          ws.send(JSON.stringify({
            type: 'envelope',
            envelope: mintParticipantJoinedEnvelope('env-attest-tamper', 1_700_000_199_000),
            serverSeq: 7,
          }));
          const env = mintEventEnvelope('room-test', 'env-bad', 1_700_000_200_000);
          // Flip a byte in the ciphertext base64url.
          const ct = base64UrlDecode(env.ciphertext);
          ct[0] ^= 0x01;
          env.ciphertext = base64UrlEncode(ct);
          ws.send(JSON.stringify({ type: 'envelope', envelope: env, serverSeq: 8 }));
          // Then send a good one to prove the socket is still up.
          const ok = mintEventEnvelope('room-test', 'env-good', 1_700_000_300_000);
          ws.send(JSON.stringify({ type: 'envelope', envelope: ok, serverSeq: 9 }));
        }
      });
    });

    const inbound: DecodedEnvelope[] = [];
    const errors: Array<[string, string]> = [];
    const client = new BrowserWsClient({
      ...clientOptions(server.port),
      callbacks: {
        onEnvelope: (d) => { if (!d.envelope.envelopeId.startsWith('env-attest')) inbound.push(d); },
        onError: (code, msg) => errors.push([code, msg]),
      },
    });
    client.start();
    for (let i = 0; i < 80 && inbound.length === 0; i++) await delay(20);
    assert(inbound.length === 1, `expected 1 good envelope, got ${inbound.length}`);
    assertEq(inbound[0]!.envelope.envelopeId, 'env-good', 'good envelope passed through');
    assert(errors.some(([c]) => c === 'ATTN_INBOUND'), `expected ATTN_INBOUND error, got ${JSON.stringify(errors)}`);
    client.close();
  } finally {
    await server.close();
  }
});

defineCase('registered reviewer cannot inject owner-only snapshot events', async () => {
  const server = await startMockServer();
  try {
    server.onClient((ws) => {
      ws.on('message', (raw) => {
        if (JSON.parse(String(raw)).type !== 'subscribe') return;
        ws.send(JSON.stringify({
          type: 'hello',
          serverSeq: 0,
          policy: TEST_POLICY,
          devices: [TEST_DEVICE],
          missedSignalEnvelopeIds: [],
        }));
        ws.send(JSON.stringify({
          type: 'envelope',
          envelope: mintParticipantJoinedEnvelope('env-attest-forged-snapshot', 1_700_000_390_000),
          serverSeq: 1,
        }));
        ws.send(JSON.stringify({
          type: 'envelope',
          envelope: mintEventEnvelope('room-test', 'env-forged-snapshot', 1_700_000_400_000, {
            body: {
              type: 'snapshot_created',
              fileId: 'file-forged',
              snapshotId: 'snapshot-forged',
              baseHash: 'hash-forged',
              inlineSnapshot: {
                docType: 'markdown',
                content: '# forged',
                anchorIndex: {
                  docHash: 'hash-forged',
                  canonicalEncoding: 'utf8-bytes',
                  lineCount: 1,
                  blocks: [],
                  headings: [],
                },
              },
            },
          }),
          serverSeq: 2,
        }));
      });
    });

    const inbound: DecodedEnvelope[] = [];
    const errors: string[] = [];
    const client = new BrowserWsClient({
      ...clientOptions(server.port),
      callbacks: {
        onEnvelope: (decoded) => {
          if (decoded.envelope.envelopeId === 'env-forged-snapshot') inbound.push(decoded);
        },
        onError: (_code, message) => errors.push(message),
      },
    });
    client.start();
    for (let i = 0; i < 40 && errors.length === 0; i++) await delay(20);
    assertEq(inbound.length, 0, 'owner-only event never reaches the consumer');
    assert(
      errors.some((message) => message.includes('capability authorization failed')),
      `capability reject surfaced: ${JSON.stringify(errors)}`,
    );
    client.close();
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// Close codes 4000-4005 — map to typed errors, no reconnect.
// ---------------------------------------------------------------------------

async function runTerminalCloseCase(
  closeCode: number,
  expectedKind: WsTerminalError['kind'],
): Promise<void> {
  const server = await startMockServer();
  try {
    server.onClient((ws) => {
      ws.on('message', () => {
        ws.close(closeCode, 'test');
      });
    });

    let terminal: WsTerminalError | null = null;
    let connectAttempts = 0;
    const opts = clientOptions(server.port);
    const factoryOriginal = nodeFactory;
    const wrapped: typeof factoryOriginal = (url, protocols) => {
      connectAttempts += 1;
      return factoryOriginal(url, protocols);
    };
    const client = new BrowserWsClient({
      ...opts,
      webSocketFactory: wrapped,
      callbacks: {
        onTerminal: (e) => {
          terminal = e;
        },
      },
    });
    client.start();
    for (let i = 0; i < 50 && terminal === null; i++) await delay(20);
    assert(terminal !== null, `terminal should fire for ${closeCode}`);
    const t = terminal as unknown as WsTerminalError;
    assertEq(t.kind, expectedKind, 'terminal kind');
    assertEq(t.closeCode, closeCode, 'closeCode echoed');
    // Wait a touch longer to confirm no reconnect attempt.
    await delay(150);
    assertEq(connectAttempts, 1, 'must not reconnect on terminal close');
    client.close();
  } finally {
    await server.close();
  }
}

defineCase('close 4000 → AdmissionRejected; no reconnect', async () => {
  await runTerminalCloseCase(CLOSE_ADMISSION_INVALID, 'admission_rejected');
});

defineCase('close 4001 → RoomDeleted; no reconnect', async () => {
  await runTerminalCloseCase(CLOSE_ROOM_DELETED, 'room_deleted');
});

defineCase('close 4002 → RoomExpired; no reconnect', async () => {
  await runTerminalCloseCase(CLOSE_ROOM_EXPIRED, 'room_expired');
});

defineCase('error frame ATTN_CURSOR_TOO_OLD → CursorTooOld; close 4005; no reconnect', async () => {
  const server = await startMockServer();
  try {
    server.onClient((ws) => {
      ws.on('message', () => {
        ws.send(
          JSON.stringify({
            type: 'error',
            code: 'ATTN_CURSOR_TOO_OLD',
            message: 'cursor too old',
            resyncFromSeq: 99,
          }),
        );
      });
    });
    let terminal: WsTerminalError | null = null;
    let attempts = 0;
    const wrapped = (url: string, protocols: string | string[]) => {
      attempts += 1;
      return nodeFactory(url, protocols);
    };
    const client = new BrowserWsClient({
      ...clientOptions(server.port),
      webSocketFactory: wrapped,
      callbacks: {
        onTerminal: (e) => {
          terminal = e;
        },
      },
    });
    client.start();
    for (let i = 0; i < 50 && terminal === null; i++) await delay(20);
    assert(terminal !== null, 'terminal fires');
    const t = terminal as unknown as WsTerminalError;
    assertEq(t.kind, 'cursor_too_old', 'kind');
    assertEq(t.closeCode, CLOSE_CURSOR_TOO_OLD, 'closeCode');
    assertEq(t.resyncFromSeq, 99, 'resyncFromSeq passes through');
    await delay(150);
    assertEq(attempts, 1, 'no reconnect on cursor-too-old');
    client.close();
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// Reconnect on 1xxx close — exponential backoff observable.
// ---------------------------------------------------------------------------

defineCase('reconnects with backoff on close 1001 transient', async () => {
  const server = await startMockServer();
  let connectionsSeen = 0;
  try {
    server.onClient((ws) => {
      connectionsSeen += 1;
      const myAttempt = connectionsSeen;
      ws.on('message', () => {
        if (myAttempt === 1) {
          // Drop the first connection with a transient code.
          ws.close(1001, 'going away');
        } else {
          // Second connection: send hello then keep alive.
          ws.send(
            JSON.stringify({
              type: 'hello',
              serverSeq: 0,
              policy: TEST_POLICY,
              devices: [],
              missedSignalEnvelopeIds: [],
            }),
          );
        }
      });
    });

    let attempts = 0;
    let refreshes = 0;
    const offeredProofs: string[] = [];
    let helloFired = false;
    let terminal: WsTerminalError | null = null;
    const wrapped = (url: string, protocols: string | string[]) => {
      attempts += 1;
      offeredProofs.push(Array.isArray(protocols) ? protocols.join(', ') : protocols);
      return nodeFactory(url, protocols);
    };
    const client = new BrowserWsClient({
      ...clientOptions(server.port),
      refreshConnection: () => {
        refreshes += 1;
        return {
          url: `ws://127.0.0.1:${server.port}/v3/rooms/room-1/socket?device_id=d-local&proof_nonce=${refreshes}`,
          subprotocol: `attn.v2, hmac.fresh-${refreshes}`,
        };
      },
      webSocketFactory: wrapped,
      callbacks: {
        onHello: () => {
          helloFired = true;
        },
        onTerminal: (e) => {
          terminal = e;
        },
      },
    });
    client.start();
    for (let i = 0; i < 100 && !helloFired; i++) await delay(20);
    assert(helloFired, 'must reconnect and receive hello on second attempt');
    assert(attempts >= 2, `expected >=2 connect attempts, got ${attempts}`);
    assert(refreshes >= 2, `expected a fresh proof per connect, got ${refreshes}`);
    assert(offeredProofs[0] !== offeredProofs[1], 'reconnect reused its admission/device proof');
    assert(terminal === null, 'no terminal error on transient drop');
    // A complete authenticated reconnect resets the next drop to the short
    // initial delay instead of accumulating lifetime backoff.
    assertEq(client._currentBackoffMs(), 50, 'successful hello resets reconnect backoff');
    client.close();
  } finally {
    await server.close();
  }
});

defineCase('responds to ping with pong frame', async () => {
  const server = await startMockServer();
  try {
    const pongs: number[] = [];
    server.onClient((ws) => {
      ws.on('message', (raw) => {
        const msg = JSON.parse(String(raw));
        if (msg.type === 'subscribe') {
          ws.send(
            JSON.stringify({
              type: 'hello',
              serverSeq: 0,
              policy: TEST_POLICY,
              devices: [],
              missedSignalEnvelopeIds: [],
            }),
          );
          ws.send(JSON.stringify({ type: 'ping', ts: 123456 }));
        } else if (msg.type === 'pong') {
          pongs.push(msg.ts);
        }
      });
    });
    let helloFired = false;
    const client = new BrowserWsClient({
      ...clientOptions(server.port),
      callbacks: {
        onHello: () => {
          helloFired = true;
        },
      },
    });
    client.start();
    for (let i = 0; i < 60 && (!helloFired || pongs.length === 0); i++) await delay(20);
    assert(helloFired, 'hello fires');
    assertEq(pongs.length, 1, 'one pong sent');
    assertEq(pongs[0]!, 123456, 'pong echoes ts');
    client.close();
  } finally {
    await server.close();
  }
});

defineCase('presence + policy_changed frames surface via callbacks', async () => {
  const server = await startMockServer();
  try {
    server.onClient((ws) => {
      ws.on('message', (raw) => {
        const msg = JSON.parse(String(raw));
        if (msg.type === 'subscribe') {
          ws.send(
            JSON.stringify({
              type: 'hello',
              serverSeq: 0,
              policy: TEST_POLICY,
              devices: [],
              missedSignalEnvelopeIds: [],
            }),
          );
          ws.send(
            JSON.stringify({ type: 'presence', event: 'join', deviceId: 'd-x', participantId: 'p-x' }),
          );
          ws.send(
            JSON.stringify({ type: 'policy_changed', policy: { ...TEST_POLICY, maxPeers: 16 } }),
          );
        }
      });
    });
    const presence: Array<[string, string, string]> = [];
    const policies: RoomPolicy[] = [];
    const client = new BrowserWsClient({
      ...clientOptions(server.port),
      callbacks: {
        onPresence: (e, d, p) => presence.push([e, d, p]),
        onPolicyChanged: (p) => policies.push(p),
      },
    });
    client.start();
    for (let i = 0; i < 80 && (presence.length === 0 || policies.length === 0); i++) await delay(20);
    assertEq(presence.length, 1, 'presence fired');
    assertEq(presence[0]![0], 'join', 'presence kind');
    assertEq(presence[0]![1], 'd-x', 'presence deviceId');
    assertEq(policies.length, 1, 'policy_changed fired');
    assertEq(policies[0]!.maxPeers, 16, 'policy patched');
    client.close();
  } finally {
    await server.close();
  }
});

defineCase('buildWsUrl + scheme translation', () => {
  assertEq(
    buildWsUrl('https://relay.attn.dev', 'rid', 'did'),
    'wss://relay.attn.dev/v2/rooms/rid/socket?device_id=did',
    'https → wss',
  );
  assertEq(
    buildWsUrl('http://localhost:8787/', 'rid', 'd!d'),
    'ws://localhost:8787/v2/rooms/rid/socket?device_id=d%21d',
    'http → ws + url-encode deviceId',
  );
  assertEq(
    buildWsUrl('ws://127.0.0.1:9999', 'rid', 'did'),
    'ws://127.0.0.1:9999/v2/rooms/rid/socket?device_id=did',
    'preserves explicit ws://',
  );
});

defineCase('v3 first offer waits for the authenticated device-directory refresh', async () => {
  const lateKeys = ed25519.keygen(new Uint8Array(32).fill(0x6a));
  const lateDevice = signedDevice({
    deviceId: 'd-late-signal',
    participantId: 'p-late-signal',
    publicEncryptionKey: 'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC',
    publicSigningKey: base64UrlEncode(lateKeys.publicKey),
    client: 'attn-browser',
    kind: 'owner',
    registeredAt: 1_700_000_000_100,
  }, lateKeys.secretKey);
  const inbound: DecodedEnvelope[] = [];
  let refreshes = 0;
  let client!: BrowserWsClient;
  client = new BrowserWsClient({
    ...clientOptions(0),
    protocolVersion: 3,
    subprotocol: 'attn.v3, read.test',
    callbacks: {
      onEnvelope: (decoded) => { inbound.push(decoded); },
      onUnknownSigner: async () => {
        refreshes += 1;
        client.mergeDevices([lateDevice]);
      },
    },
  });
  const payload = { kind: 'offer' as const, sdp: 'v=0\r\n', from: lateDevice.deviceId };
  const envelope = assembleBrowserSignal({
    signalingKey: KEYS.signalingKey,
    roomId: 'room-test',
    authorId: lateDevice.participantId,
    deviceId: lateDevice.deviceId,
    targetDeviceId: 'd-test',
    createdAt: 1_700_000_000_100,
    expiresAt: 1_700_086_400_000,
    payload,
    protocolVersion: 3,
    signalGeneration: 1_700_000_000_100,
    signingSecret: lateKeys.secretKey,
    clientNonce: new Uint8Array(16).fill(0x61),
    aeadNonce: new Uint8Array(24).fill(0x62),
  });

  await client.replayEnvelope(envelope, 1);

  assertEq(refreshes, 1, 'unknown signaling sender did not refresh once');
  assertEq(inbound.length, 1, 'first offer was dropped before its directory refresh completed');
  assertEq(inbound[0]!.envelope.deviceId, lateDevice.deviceId, 'wrong signal dispatched');
  inbound[0]!.plaintext.fill(0);
  client.close();
});

defineCase('signal target is rejected before ciphertext decode and matching target dispatches', async () => {
  const errors: string[] = [];
  const inbound: DecodedEnvelope[] = [];
  const client = new BrowserWsClient({
    ...clientOptions(0),
    callbacks: {
      onEnvelope: (decoded) => { inbound.push(decoded); },
      onError: (_code, message) => { errors.push(message); },
    },
  });
  const base = {
    signalingKey: KEYS.signalingKey,
    roomId: 'room-test',
    authorId: TEST_DEVICE.participantId,
    deviceId: TEST_DEVICE.deviceId,
    createdAt: 1_700_000_000_000,
    expiresAt: 1_700_086_400_000,
    payload: { kind: 'offer', sdp: 'v=0', from: TEST_DEVICE.deviceId } as const,
    clientNonce: new Uint8Array(16).fill(1),
    aeadNonce: new Uint8Array(24).fill(2),
  };
  const redirected = assembleBrowserSignal({ ...base, targetDeviceId: 'some-other-device' });
  redirected.nonce = '!not-base64';
  redirected.ciphertext = '!not-base64';
  await client.replayEnvelope(redirected, 1);
  assertEq(inbound.length, 0, 'redirected signal dropped');
  assert(errors.some((message) => message.includes('target')), 'target failure reported before decode');

  const matching = assembleBrowserSignal({
    ...base,
    targetDeviceId: 'd-test',
    clientNonce: new Uint8Array(16).fill(3),
  });
  await client.replayEnvelope(matching, 2);
  assertEq(inbound.length, 1, 'matching signal dispatched');
  assertEq(inbound[0]!.source, 'replay', 'source preserved');
  inbound[0]!.plaintext.fill(0);
  client.close();
});

defineCase('constructor rejects bad-length keys', () => {
  const baseOpts = clientOptions(0);
  try {
    new BrowserWsClient({ ...baseOpts, eventKey: new Uint8Array(31) });
    throw new Error('should have thrown');
  } catch (err) {
    assert(err instanceof Error && err.message.includes('32 bytes'), `${(err as Error).message}`);
  }
});

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
