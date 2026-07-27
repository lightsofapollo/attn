import 'fake-indexeddb/auto';

import { ed25519 } from '@noble/curves/ed25519.js';

import {
  BrowserSession,
  generateBrowserIdentity,
  type BrowserOwnerCredentials,
  type ReviewStoreSink,
} from './browser-session';
import {
  base64UrlEncode,
  deriveRoomId,
  deriveRoomKeys,
  toCanonicalBytes,
} from './browser-crypto';
import type { Device, RoomPolicy } from './browser-ws';

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

function equal(actual: unknown, expected: unknown, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

function policy(expiresAt: number, allowBrowser = true): RoomPolicy {
  return {
    mode: 'hybrid',
    maxPeers: 8,
    maxSnapshotBytes: 5 * 1024 * 1024,
    maxEventBytes: 256 * 1024,
    maxEvents: 500,
    expiresAt,
    powBits: 12,
    deleteEventsAfterOwnerAck: false,
    allowBrowser,
    allowRemoteAgents: true,
  };
}

function ownerFixture(): { credentials: BrowserOwnerCredentials; device: Device } {
  const roomSecret = new Uint8Array(32).fill(0x49);
  const identity = generateBrowserIdentity();
  const credentials: BrowserOwnerCredentials = {
    roomId: deriveRoomId(roomSecret),
    roomSecret,
    keys: deriveRoomKeys(roomSecret),
    identity,
    policy: policy(Date.now() + 60_000),
  };
  const unsigned = {
    deviceId: identity.deviceId,
    participantId: identity.participantId,
    publicEncryptionKey: base64UrlEncode(identity.publicEncryptionKey),
    publicSigningKey: base64UrlEncode(identity.signingPublic),
    client: 'attn-browser' as const,
    kind: 'owner' as const,
  };
  const selfSignature = base64UrlEncode(ed25519.sign(toCanonicalBytes(unsigned), identity.signingSecret));
  return { credentials, device: { ...unsigned, selfSignature } };
}

function store(): ReviewStoreSink {
  return {
    currentRoomId: null,
    currentFileId: null,
    applyEvent: () => undefined,
    applySnapshot: () => undefined,
    setCurrentFile: () => undefined,
    setCurrentSnapshot: () => undefined,
  };
}

async function classify(authoritativePolicy: RoomPolicy): Promise<{
  kind: string | undefined;
  message: string | undefined;
  socketOpened: boolean;
}> {
  const { credentials, device } = ownerFixture();
  let socketOpened = false;
  const session = new BrowserSession({
    owner: credentials,
    relayUrl: 'https://relay.example',
    store: store(),
    fetchImpl: async () => ({
      status: 200,
      text: async () => JSON.stringify({ policy: authoritativePolicy, devices: [device] }),
    }),
    webSocketFactory: () => {
      socketOpened = true;
      throw new Error('rejected policy must not open a socket');
    },
  });
  await session.start();
  const state = session.getState();
  session.close();
  return { kind: state.error?.kind, message: state.error?.message, socketOpened };
}

const expired = await classify(policy(Date.now() - 1));
equal(expired.kind, 'room_expired', 'authenticated expiry keeps the recovery signal');
assert(expired.message?.includes('expired'), 'expiry copy names the actual condition');
equal(expired.socketOpened, false, 'expired room stays off the socket path');

const disabled = await classify(policy(Date.now() + 60_000, false));
equal(disabled.kind, 'device_register', 'browser-disabled policy stays a distinct denial');
assert(disabled.message?.includes('does not permit'), 'browser-disabled copy names policy denial');
equal(disabled.socketOpened, false, 'browser-disabled room stays off the socket path');

console.log('browser-session-expiry: 2 passed, 0 failed');
