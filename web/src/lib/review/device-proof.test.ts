import { ed25519 } from '@noble/curves/ed25519.js';
import { base64UrlDecode } from './browser-crypto';
import {
  canonicalDeviceSignalProofV3,
  canonicalDeviceWebSocketProofV3,
  createDeviceWebSocketProofV3,
  signDeviceSignalProofV3,
} from './device-proof';

let failures = 0;

function test(name: string, run: () => void): void {
  try {
    run();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${name}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

test('browser and native pin the same v3 websocket device proof', () => {
  const signingSecret = new Uint8Array(32).fill(0x11);
  const nonceBytes = new Uint8Array(16).fill(0x22);
  const proof = createDeviceWebSocketProofV3({
    roomId: 'room-vector',
    deviceId: 'device-vector',
    path: '/v3/rooms/room-vector/socket',
    signingSecret,
    now: 1_700_000_000_000,
    nonceBytes,
  });
  assert(proof.expiresAt === 1_700_000_060_000, 'expiry mismatch');
  assert(proof.nonce === 'IiIiIiIiIiIiIiIiIiIiIg', 'nonce mismatch');
  assert(
    proof.signature === 'WoSwnColLautRZzjGUU2M9h0Fj2Tjz1uS2d2kqEISDfl-xLs8YpjBBQZG5ddK4EsRdCblGiio6QlT8qjMDMcCQ',
    'native/browser signature vector mismatch',
  );
  const canonical = canonicalDeviceWebSocketProofV3({
    roomId: 'room-vector',
    deviceId: 'device-vector',
    path: '/v3/rooms/room-vector/socket',
    expiresAt: proof.expiresAt,
    nonce: proof.nonce,
  });
  assert(
    ed25519.verify(base64UrlDecode(proof.signature), canonical, ed25519.getPublicKey(signingSecret)),
    'device proof did not verify',
  );
  canonical.fill(0);
  signingSecret.fill(0);
});

test('device proof signature binds room, device, path, expiry, and nonce', () => {
  const secret = new Uint8Array(32).fill(7);
  const proof = createDeviceWebSocketProofV3({
    roomId: 'room-a',
    deviceId: 'device-a',
    path: '/v3/rooms/room-a/socket',
    signingSecret: secret,
    now: 1_700_000_000_000,
    nonceBytes: new Uint8Array(16).fill(9),
  });
  const rewritten = canonicalDeviceWebSocketProofV3({
    roomId: 'room-a',
    deviceId: 'device-b',
    path: '/v3/rooms/room-a/socket',
    expiresAt: proof.expiresAt,
    nonce: proof.nonce,
  });
  assert(
    !ed25519.verify(base64UrlDecode(proof.signature), rewritten, ed25519.getPublicKey(secret)),
    'target device rewrite retained a valid signature',
  );
  rewritten.fill(0);
  secret.fill(0);
});

test('browser and native pin the same complete v3 signal proof', () => {
  const secret = new Uint8Array(32).fill(0x11);
  const input = {
    roomId: 'room-vector', envelopeId: 'envelope-vector', authorId: 'author-vector',
    deviceId: 'device-vector', targetDeviceId: 'target-vector', generation: 7,
    createdAt: 1_700_000_000_000, expiresAt: 1_700_003_600_000,
    nonce: 'IiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIi',
    ciphertext: 'MzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzM', ciphertextBytes: 32,
  } as const;
  const signature = signDeviceSignalProofV3(input, secret);
  assert(
    signature === 'PbzT2GYKbUkXTMr8VdpNa-cGkfLXk8vZPOLF4C3fDZJij83iE7Aea4lQbhA1BFJlZGg-tRI2Fr_IgbNK4jzXAQ',
    'native/browser signal signature vector mismatch',
  );
  const canonical = canonicalDeviceSignalProofV3({ ...input, targetDeviceId: 'rewritten' });
  assert(
    !ed25519.verify(base64UrlDecode(signature), canonical, ed25519.getPublicKey(secret)),
    'target rewrite retained a valid signal proof',
  );
  const wrongKey = ed25519.getPublicKey(new Uint8Array(32).fill(0x44));
  assert(!ed25519.verify(base64UrlDecode(signature), canonicalDeviceSignalProofV3(input), wrongKey), 'wrong key verified');
});

test('v3 signal proof binds the replaceable presence class', () => {
  const secret = new Uint8Array(32).fill(0x21);
  const input = {
    roomId: 'room-presence', envelopeId: 'envelope-presence', authorId: 'author-presence',
    deviceId: 'device-presence', targetDeviceId: null, signalClass: 'presence' as const,
    generation: 9, createdAt: 1_700_000_000_009, expiresAt: 1_700_003_600_009,
    nonce: 'IiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIi',
    ciphertext: 'MzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzM', ciphertextBytes: 32,
  };
  const signature = signDeviceSignalProofV3(input, secret);
  assert(
    signature === 'abvJIj3s-e19-N7f0ZH9B7skWw1YbrDGePpkeiOxr-aTSts2jRoiltjAmigTlV57HlLL6QGsWCGnIjuJh3TpDA',
    'native/browser presence signature vector mismatch',
  );
  const publicKey = ed25519.getPublicKey(secret);
  assert(
    ed25519.verify(base64UrlDecode(signature), canonicalDeviceSignalProofV3(input), publicKey),
    'presence proof did not verify',
  );
  const withoutClass = { ...input };
  delete (withoutClass as { signalClass?: 'presence' }).signalClass;
  assert(
    !ed25519.verify(base64UrlDecode(signature), canonicalDeviceSignalProofV3(withoutClass), publicKey),
    'presence class removal retained a valid proof',
  );
});

if (failures > 0) process.exit(1);
