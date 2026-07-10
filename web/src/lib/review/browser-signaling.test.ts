import {
  aeadOpen,
  base64UrlDecode,
  deriveNonceEnvelopeId,
  type EnvelopeAad,
} from './browser-crypto';
import {
  assembleBrowserSignal,
  parseBrowserSignalingPayload,
  validateSignalTarget,
  type BrowserSignalingPayload,
} from './browser-signaling';

let passed = 0;
const failures: string[] = [];

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    failures.push(`${name}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    console.error(`FAIL ${failures.at(-1)}`);
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const key = new Uint8Array(32).fill(7);
const clientNonce = new Uint8Array(16).fill(11);
const aeadNonce = new Uint8Array(24).fill(13);

for (const payload of [
  { kind: 'offer', sdp: 'v=0\r\na=ice-ufrag:secret\r\n', from: 'device-a' },
  { kind: 'answer', sdp: 'v=0\r\na=setup:active\r\n', from: 'device-a' },
  { kind: 'ice', candidates: ['candidate:1 1 UDP 1 192.0.2.1 5000 typ host'], from: 'device-a' },
  { kind: 'request_snapshot', file_id: 'file-a', since_snapshot_id: 'snap-a', from: 'device-a' },
  { kind: 'collab', from: 'device-a', payload: '{"version":1}' },
] satisfies BrowserSignalingPayload[]) {
  test(`round-trips native signaling shape ${payload.kind}`, () => {
    const envelope = assembleBrowserSignal({
      signalingKey: key,
      roomId: 'room-a',
      authorId: 'participant-a',
      deviceId: 'device-a',
      targetDeviceId: 'device-b',
      createdAt: 1_700_000_000_000,
      expiresAt: 1_700_086_400_000,
      payload,
      clientNonce,
      aeadNonce,
    });
    const aad: EnvelopeAad = {
      v: 2,
      roomId: 'room-a',
      envelopeId: envelope.envelopeId,
      kind: 'signal',
      authorId: 'participant-a',
      deviceId: 'device-a',
      createdAt: envelope.createdAt,
    };
    const plaintext = aeadOpen(
      key,
      base64UrlDecode(envelope.nonce),
      base64UrlDecode(envelope.ciphertext),
      aad,
    );
    const parsed = parseBrowserSignalingPayload(plaintext, 'device-a');
    plaintext.fill(0);
    assert(JSON.stringify(parsed) === JSON.stringify(payload), 'payload round-trip mismatch');
    assert(validateSignalTarget(envelope, 'device-b'), 'matching signal target rejected');
    assert(!validateSignalTarget(envelope, 'device-c'), 'wrong signal target accepted');
    assert(validateSignalTarget({ ...envelope, target: null }, 'device-b'), 'broadcast signal rejected before decrypt');
    const wire = JSON.stringify(envelope);
    assert(!wire.includes('v=0'), 'SDP leaked into relay envelope');
    assert(!wire.includes('candidate:'), 'ICE candidate leaked into relay envelope');
  });
}

test('nonce-form envelope id is stable and device-bound', () => {
  const first = deriveNonceEnvelopeId('room-a', 'device-a', clientNonce);
  assert(first === deriveNonceEnvelopeId('room-a', 'device-a', clientNonce), 'id was not stable');
  assert(first !== deriveNonceEnvelopeId('room-a', 'device-b', clientNonce), 'id was not device-bound');
});

test('strict parser rejects sender mismatch and extra fields', () => {
  const mismatch = new TextEncoder().encode('{"kind":"offer","sdp":"v=0","from":"other"}');
  let mismatchRejected = false;
  try { parseBrowserSignalingPayload(mismatch, 'device-a'); } catch { mismatchRejected = true; }
  const extra = new TextEncoder().encode(
    '{"kind":"ice","candidates":["candidate:x"],"from":"device-a","turn":"forbidden"}',
  );
  let extraRejected = false;
  try { parseBrowserSignalingPayload(extra, 'device-a'); } catch { extraRejected = true; }
  assert(mismatchRejected, 'sender mismatch was accepted');
  assert(extraRejected, 'extra signaling field was accepted');
});

console.log(`browser-signaling: ${passed} passed, ${failures.length} failed`);
if (failures.length > 0) process.exit(1);
