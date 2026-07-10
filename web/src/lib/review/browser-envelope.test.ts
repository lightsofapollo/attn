import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { base64UrlDecode, toCanonicalString } from './browser-crypto';
import { assembleBrowserEvent } from './browser-envelope';
import type { ReviewEventBody } from '../types';

interface EnvelopeVector {
  inputs: {
    aeadNonce: string;
    createdAt: number;
    event: {
      meta: {
        roomId: string;
        authorId: string;
        deviceId: string;
        parentEventIds: string[];
        snapshotId?: string;
      };
      body: ReviewEventBody;
    };
    keys: { eventKey: string };
    signingKey: { private: string; public: string };
  };
  expected: {
    eventId: string;
    signature: string;
    envelopeId: string;
    envelope: Record<string, unknown>;
  };
}

const here = dirname(fileURLToPath(import.meta.url));
const corpus = JSON.parse(
  readFileSync(resolve(here, '../../../../planning/collab/test-vectors/envelope.json'), 'utf8'),
) as { vectors: EnvelopeVector[] };

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

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

test('assembles the Rust event envelope corpus byte-for-byte', () => {
  const vector = corpus.vectors[0]!;
  const assembled = assembleBrowserEvent({
    eventKey: base64UrlDecode(vector.inputs.keys.eventKey),
    signingSecret: base64UrlDecode(vector.inputs.signingKey.private),
    signingPublic: base64UrlDecode(vector.inputs.signingKey.public),
    roomId: vector.inputs.event.meta.roomId,
    authorId: vector.inputs.event.meta.authorId,
    deviceId: vector.inputs.event.meta.deviceId,
    createdAt: vector.inputs.createdAt,
    expiresAt: vector.expected.envelope.expiresAt as number,
    parentEventIds: vector.inputs.event.meta.parentEventIds,
    snapshotId: vector.inputs.event.meta.snapshotId,
    body: vector.inputs.event.body,
    nonce: base64UrlDecode(vector.inputs.aeadNonce),
  });

  assertEqual(assembled.event.meta.eventId, vector.expected.eventId, 'event id');
  assertEqual(assembled.event.auth.signature, vector.expected.signature, 'signature');
  assertEqual(assembled.envelope.envelopeId, vector.expected.envelopeId, 'envelope id');
  assertEqual(toCanonicalString(assembled.envelope), toCanonicalString(vector.expected.envelope), 'envelope');
});

test('rejects unsafe timestamps and invalid nonce lengths', () => {
  const vector = corpus.vectors[0]!;
  const base = {
    eventKey: base64UrlDecode(vector.inputs.keys.eventKey),
    signingSecret: base64UrlDecode(vector.inputs.signingKey.private),
    signingPublic: base64UrlDecode(vector.inputs.signingKey.public),
    roomId: vector.inputs.event.meta.roomId,
    authorId: vector.inputs.event.meta.authorId,
    deviceId: vector.inputs.event.meta.deviceId,
    createdAt: vector.inputs.createdAt,
    expiresAt: vector.expected.envelope.expiresAt as number,
    body: vector.inputs.event.body,
  };
  let unsafeRejected = false;
  try {
    assembleBrowserEvent({ ...base, createdAt: Number.MAX_SAFE_INTEGER + 1 });
  } catch {
    unsafeRejected = true;
  }
  let nonceRejected = false;
  try {
    assembleBrowserEvent({ ...base, nonce: new Uint8Array(23) });
  } catch {
    nonceRejected = true;
  }
  assertEqual(unsafeRejected, true, 'unsafe createdAt rejected');
  assertEqual(nonceRejected, true, 'invalid nonce rejected');
});

console.log(`browser-envelope: ${passed} passed, ${failures.length} failed`);
if (failures.length > 0) process.exit(1);
