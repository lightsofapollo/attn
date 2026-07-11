import {
  aeadSeal,
  base64UrlEncode,
  contentHash,
  toCanonicalBytes,
  type EnvelopeAad,
} from './browser-crypto';
import {
  resolveBrowserR2Snapshot,
  sealSnapshotR2Body,
  uploadBrowserR2Snapshot,
  type BrowserSnapshotSealedCache,
  type ResolveBrowserR2SnapshotOptions,
} from './browser-snapshot-r2';
import type { MailboxEnvelope } from './browser-ws';

const NOW = 1_700_000_000_000;
const RELAY = 'https://relay.example.test';
const ROOM = 'room-r2-test';
const SNAPSHOT_KEY = new Uint8Array(32).fill(0x42);
const ADMISSION_KEY = new Uint8Array(32).fill(0x24);
const CAP = 'sensitive-capability-token';

let passed = 0;
const failures: string[] = [];
const cases: Array<{ name: string; run: () => Promise<void> }> = [];

function test(name: string, run: () => Promise<void>): void {
  cases.push({ name, run });
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function equal(actual: unknown, expected: unknown, label: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

interface Vector {
  plaintext: Uint8Array;
  wrapper: MailboxEnvelope;
  sealed: Uint8Array;
}

function makeVector(
  options: {
    envelopeId?: string;
    plaintext?: Uint8Array;
    blobLength?: number;
    blobHash?: string;
    wrapperNonceByte?: number;
    bodyNonceByte?: number;
  } = {},
): Vector {
  const plaintext = options.plaintext ?? new TextEncoder().encode(
    JSON.stringify({ docType: 'markdown', content: '# Native-compatible R2 snapshot' }),
  );
  const envelopeId = options.envelopeId ?? 'env-r2-happy';
  const aad: EnvelopeAad = {
    v: 2,
    roomId: ROOM,
    envelopeId,
    kind: 'snapshot_blob',
    authorId: 'participant-owner',
    deviceId: 'device-native',
    createdAt: NOW - 1_000,
  };
  const blobRef = toCanonicalBytes({
    storage: 'r2',
    blobId: envelopeId,
    byteLength: options.blobLength ?? plaintext.length,
    contentHash: options.blobHash ?? contentHash(plaintext),
  });
  const wrapperNonce = new Uint8Array(24).fill(options.wrapperNonceByte ?? 0x11);
  const wrapperCiphertext = aeadSeal(SNAPSHOT_KEY, wrapperNonce, blobRef, aad);
  const wrapper: MailboxEnvelope = {
    v: 2,
    roomId: ROOM,
    envelopeId,
    authorId: aad.authorId,
    deviceId: aad.deviceId,
    createdAt: aad.createdAt,
    expiresAt: NOW + 60_000,
    kind: 'snapshot_blob',
    nonce: base64UrlEncode(wrapperNonce),
    ciphertext: base64UrlEncode(wrapperCiphertext),
    ciphertextBytes: wrapperCiphertext.length,
  };
  const bodyNonce = new Uint8Array(24).fill(options.bodyNonceByte ?? 0x33);
  const bodyCiphertext = aeadSeal(SNAPSHOT_KEY, bodyNonce, plaintext, aad);
  const sealed = new Uint8Array(bodyNonce.length + bodyCiphertext.length);
  sealed.set(bodyNonce);
  sealed.set(bodyCiphertext, bodyNonce.length);
  blobRef.fill(0);
  wrapperNonce.fill(0);
  wrapperCiphertext.fill(0);
  bodyNonce.fill(0);
  bodyCiphertext.fill(0);
  return { plaintext, wrapper, sealed };
}

function presign(downloadUrl: string, overrides: Record<string, unknown> = {}): Response {
  return Response.json({
    downloadUrl,
    method: 'GET',
    expiresAt: NOW + 5 * 60_000,
    ...overrides,
  });
}

function binaryResponse(bytes: Uint8Array): Response {
  return new Response(bytes.slice().buffer as ArrayBuffer, { status: 200 });
}

function baseOptions(
  vector: Vector,
  fetchImpl: ResolveBrowserR2SnapshotOptions['fetchImpl'],
): ResolveBrowserR2SnapshotOptions {
  return {
    relayUrl: RELAY,
    roomId: ROOM,
    admissionKey: ADMISSION_KEY,
    snapshotKey: SNAPSHOT_KEY,
    wrapper: vector.wrapper,
    fetchImpl,
    now: () => NOW,
  };
}

async function rejectionMessage(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('expected rejection');
}

test('opens a native-compatible happy vector through a same-origin relative capability', async () => {
  const vector = makeVector();
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let cached: Uint8Array | null = null;
  const cache: BrowserSnapshotSealedCache = {
    getSealed: () => null,
    putSealed: (_roomId, _envelopeId, bytes) => {
      cached = bytes;
    },
  };
  const result = await resolveBrowserR2Snapshot({
    ...baseOptions(vector, async (url, init) => {
      calls.push({ url, init });
      if (calls.length === 1) {
        return presign(`/v2/rooms/${ROOM}/blobs/${vector.wrapper.envelopeId}?cap=${CAP}`);
      }
      return binaryResponse(vector.sealed);
    }),
    sealedCache: cache,
  });

  equal([...result], [...vector.plaintext], 'recovered plaintext');
  equal(calls.length, 2, 'presign and download fetch count');
  equal(calls[0]!.url, `${RELAY}/v2/rooms/${ROOM}/blobs/${vector.wrapper.envelopeId}`, 'cap-less presign URL');
  equal(calls[0]!.init.method, 'GET', 'presign method');
  equal(calls[0]!.init.credentials, 'omit', 'presign credentials');
  equal(calls[0]!.init.cache, 'no-store', 'presign cache mode');
  assert(
    typeof (calls[0]!.init.headers as Record<string, string>)['Attn-Admission'] === 'string',
    'authenticated presign header is required',
  );
  equal(calls[1]!.init.method, 'GET', 'download method');
  equal(calls[1]!.init.credentials, 'omit', 'download credentials');
  equal(calls[1]!.init.cache, 'no-store', 'download cache mode');
  equal(calls[1]!.init.redirect, 'error', 'redirects rejected');
  equal(cached === null ? null : [...cached], [...vector.sealed], 'cache receives sealed bytes only');
});

test('v3 snapshot presign uses read-scoped admission and version-bound capability path', async () => {
  const vector = makeVector({ envelopeId: 'env-r2-v3' });
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const result = await resolveBrowserR2Snapshot({
    ...baseOptions(vector, async (url, init) => {
      calls.push({ url, init });
      if (calls.length === 1) {
        return presign(`/v3/rooms/${ROOM}/blobs/${vector.wrapper.envelopeId}?cap=${CAP}`);
      }
      return binaryResponse(vector.sealed);
    }),
    protocolVersion: 3,
  });
  equal([...result], [...vector.plaintext], 'v3 recovered plaintext');
  equal(calls[0]!.url, `${RELAY}/v3/rooms/${ROOM}/blobs/${vector.wrapper.envelopeId}`, 'v3 presign URL');
  assert(
    (calls[0]!.init.headers as Record<string, string>)['Attn-Admission']?.startsWith('v3.read.'),
    'v3 read-scoped presign header',
  );
});

test('reuses a verified sealed cache entry without any network fetch', async () => {
  const vector = makeVector({ envelopeId: 'env-r2-cache' });
  let fetches = 0;
  let puts = 0;
  const result = await resolveBrowserR2Snapshot({
    ...baseOptions(vector, async () => {
      fetches += 1;
      throw new Error('network must not be used');
    }),
    sealedCache: {
      getSealed: () => new Uint8Array(vector.sealed),
      putSealed: () => {
        puts += 1;
      },
    },
  });
  equal([...result], [...vector.plaintext], 'cached plaintext');
  equal(fetches, 0, 'network fetches');
  equal(puts, 0, 'cache rewrites');
});

test('rejects cross-origin, wrong-path, and malformed capability URLs', async () => {
  const vector = makeVector({ envelopeId: 'env-r2-url' });
  const invalid = [
    `https://attacker.example/v2/rooms/${ROOM}/blobs/${vector.wrapper.envelopeId}?cap=${CAP}`,
    `/v2/rooms/${ROOM}/blobs/different-envelope?cap=${CAP}`,
    `/v2/rooms/${ROOM}/blobs/${vector.wrapper.envelopeId}?cap=${CAP}&extra=1`,
    'http://[not-a-url',
  ];
  for (const downloadUrl of invalid) {
    let calls = 0;
    const message = await rejectionMessage(() => resolveBrowserR2Snapshot(
      baseOptions(vector, async () => {
        calls += 1;
        return presign(downloadUrl);
      }),
    ));
    equal(calls, 1, `only presign fetched for ${invalid.indexOf(downloadUrl)}`);
    assert(!message.includes(CAP), 'capability must not appear in URL validation error');
  }
});

test('rejects malformed presign metadata and unbounded expiry', async () => {
  const vector = makeVector({ envelopeId: 'env-r2-presign-shape' });
  const path = `/v2/rooms/${ROOM}/blobs/${vector.wrapper.envelopeId}?cap=${CAP}`;
  for (const overrides of [
    { method: 'PUT' },
    { expiresAt: NOW },
    { expiresAt: NOW + 7 * 60_000 },
    { extra: true },
  ]) {
    const message = await rejectionMessage(() => resolveBrowserR2Snapshot(
      baseOptions(vector, async () => presign(path, overrides)),
    ));
    assert(message.includes('presign response is invalid'), 'invalid presign shape rejected');
    assert(!message.includes(CAP), 'capability must not appear in presign error');
  }
});

test('rejects a body swapped under a different wrapper AAD', async () => {
  const original = makeVector({ envelopeId: 'env-r2-original', bodyNonceByte: 0x51 });
  const other = makeVector({ envelopeId: 'env-r2-other', bodyNonceByte: 0x61 });
  const message = await rejectionMessage(() => resolveBrowserR2Snapshot(
    baseOptions(other, async (_url, init) => {
      if ((init.headers as Record<string, string>)['Attn-Admission']) {
        return presign(`/v2/rooms/${ROOM}/blobs/${other.wrapper.envelopeId}?cap=${CAP}`);
      }
      return binaryResponse(original.sealed);
    }),
  ));
  assert(message.includes('integrity validation'), 'swapped AAD must fail integrity');
});

test('rejects a bad Poly1305 tag', async () => {
  const vector = makeVector({ envelopeId: 'env-r2-tag' });
  const tampered = new Uint8Array(vector.sealed);
  tampered[tampered.length - 1] ^= 0x80;
  const message = await rejectionMessage(() => resolveBrowserR2Snapshot(
    baseOptions(vector, async (_url, init) => {
      if ((init.headers as Record<string, string>)['Attn-Admission']) {
        return presign(`/v2/rooms/${ROOM}/blobs/${vector.wrapper.envelopeId}?cap=${CAP}`);
      }
      return binaryResponse(tampered);
    }),
  ));
  assert(message.includes('integrity validation'), 'bad tag must fail integrity');
});

test('rejects plaintext with a wrong signed length or content hash', async () => {
  const wrongLength = makeVector({ envelopeId: 'env-r2-length', blobLength: 1 });
  const wrongHash = makeVector({
    envelopeId: 'env-r2-hash',
    blobHash: contentHash(new TextEncoder().encode('different plaintext')),
  });
  for (const vector of [wrongLength, wrongHash]) {
    const message = await rejectionMessage(() => resolveBrowserR2Snapshot(
      baseOptions(vector, async (_url, init) => {
        if ((init.headers as Record<string, string>)['Attn-Admission']) {
          return presign(`/v2/rooms/${ROOM}/blobs/${vector.wrapper.envelopeId}?cap=${CAP}`);
        }
        return binaryResponse(vector.sealed);
      }),
    ));
    assert(message.includes('integrity validation'), 'signed BlobRef mismatch must fail');
  }
});

test('never reflects a capability URL from fetch failures', async () => {
  const vector = makeVector({ envelopeId: 'env-r2-secret-error' });
  let calls = 0;
  const message = await rejectionMessage(() => resolveBrowserR2Snapshot(
    baseOptions(vector, async (url) => {
      calls += 1;
      if (calls === 1) {
        return presign(`/v2/rooms/${ROOM}/blobs/${vector.wrapper.envelopeId}?cap=${CAP}`);
      }
      throw new Error(`fetch failed for ${url}`);
    }),
  ));
  equal(message, 'R2 snapshot download failed', 'opaque download error');
  assert(!message.includes(CAP), 'capability must not appear in fetch error');
});

test('publisher seal matches the native R2 body construction', async () => {
  const vector = makeVector({ envelopeId: 'env-r2-seal', bodyNonceByte: 0x55 });
  const sealed = sealSnapshotR2Body({
    snapshotKey: SNAPSHOT_KEY,
    plaintext: vector.plaintext,
    wrapper: vector.wrapper,
    nonce: new Uint8Array(24).fill(0x55),
  });
  equal(base64UrlEncode(sealed), base64UrlEncode(vector.sealed), 'sealed body bytes');
  sealed.fill(0);
});

test('upload presign is authenticated and the capability stays same-origin and opaque', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  await uploadBrowserR2Snapshot({
    relayUrl: RELAY,
    roomId: ROOM,
    admissionKey: ADMISSION_KEY,
    envelopeId: 'env-upload',
    authorId: 'participant-owner',
    deviceId: 'device-owner',
    sealedBody: new Uint8Array(64).fill(9),
    powBits: 12,
    now: () => NOW,
    mintPow: async () => 'pow-token',
    fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} });
      if (calls.length === 1) {
        return Response.json({
          uploadUrl: `/v2/rooms/${ROOM}/blobs/env-upload?cap=${CAP}`,
          method: 'PUT',
          headers: { 'Content-Type': 'application/octet-stream' },
          expiresAt: NOW + 15 * 60_000,
          blobKey: 'opaque-object-key',
          leaseId: 'opaque-lease',
        });
      }
      return new Response(null, { status: 204 });
    }) as typeof fetch,
  });
  equal(calls.length, 2, 'presign then PUT');
  assert(Boolean((calls[0]!.init.headers as Record<string, string>)['Attn-Admission']), 'admission header');
  equal(calls[1]!.url, `${RELAY}/v2/rooms/${ROOM}/blobs/env-upload?cap=${CAP}`, 'same-origin PUT');
});

for (const item of cases) {
  try {
    await item.run();
    passed += 1;
    console.log(`PASS ${item.name}`);
  } catch (error) {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    failures.push(`${item.name}: ${message}`);
    console.error(`FAIL ${item.name}: ${message}`);
  }
}

console.log(`browser-snapshot-r2: ${passed} passed, ${failures.length} failed`);
if (failures.length > 0) process.exit(1);
