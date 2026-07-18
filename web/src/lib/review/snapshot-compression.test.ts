import {
  MAX_DECOMPRESSED_SNAPSHOT_BYTES,
  compressSnapshotIfSmaller,
  decompressSnapshotIfNeeded,
  isGzipCompressed,
} from './snapshot-compression';

let passed = 0;
const failures: string[] = [];
const cases: Array<{ name: string; run: () => Promise<void> }> = [];

function test(name: string, run: () => Promise<void>): void {
  cases.push({ name, run });
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const encoder = new TextEncoder();

test('compressible JSON round-trips through gzip and shrinks', async () => {
  const plaintext = encoder.encode(
    JSON.stringify({ docType: 'markdown', content: 'lorem ipsum dolor sit amet. '.repeat(4000) }),
  );
  const wire = await compressSnapshotIfSmaller(new Uint8Array(plaintext));
  assert(isGzipCompressed(wire), 'large repetitive JSON must compress');
  assert(wire.length < plaintext.length / 4, `expected >4x shrink, got ${plaintext.length} -> ${wire.length}`);
  const restored = await decompressSnapshotIfNeeded(wire);
  assert(restored.length === plaintext.length, 'round-trip length');
  assert(restored.every((byte, index) => byte === plaintext[index]), 'round-trip bytes');
});

test('incompressible bytes pass through unchanged (images stay raw)', async () => {
  const random = new Uint8Array(8192);
  crypto.getRandomValues(random);
  const wire = await compressSnapshotIfSmaller(random);
  assert(wire === random, 'random bytes must return the original reference');
  const restored = await decompressSnapshotIfNeeded(wire);
  assert(restored === wire, 'non-gzip bytes must pass through decode as the same reference');
});

test('tiny payloads skip compression', async () => {
  const tiny = encoder.encode('{"a":1}');
  const wire = await compressSnapshotIfSmaller(tiny);
  assert(wire === tiny, 'tiny payloads must not pay the gzip header tax');
});

test('JSON plaintext can never be mistaken for gzip', async () => {
  assert(!isGzipCompressed(encoder.encode('{"docType":"markdown"}')), 'JSON starts 0x7b, not 0x1f8b');
  assert(!isGzipCompressed(encoder.encode('[]')), 'array JSON');
  assert(!isGzipCompressed(new Uint8Array(0)), 'empty');
});

test('native-produced (flate2) gzip vector opens in the browser client', async () => {
  // Cross-client conformance: this base64 payload was gzipped by the NATIVE
  // client's flate2/miniz_oxide stack. DecompressionStream must open it.
  const wire = Uint8Array.from(atob('H4sIAAAAAAAA/53LwQ2AIAwAwFWavtXEr3O4gEKjRGkJFIgad5cZ/F5yDxacxg6tmPkKhBP6JR5WKmOHRliJtSEv6gr1IYrNhixstwvgc1KQQAyOQXeCNUpNFMGcrrUBfi18P1T3/iaUAAAA'), (c) => c.charCodeAt(0));
  assert(isGzipCompressed(wire), 'vector is gzip');
  const restored = await decompressSnapshotIfNeeded(wire);
  assert(restored.length === 148, `expected 148 plaintext bytes, got ${restored.length}`);
  const value = JSON.parse(new TextDecoder().decode(restored)) as { docType?: string };
  assert(value.docType === 'markdown', 'vector parses as canonical JSON');
});

test('corrupt gzip payload throws (treated as failed parse)', async () => {
  const corrupt = new Uint8Array([0x1f, 0x8b, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05]);
  let threw = false;
  try {
    await decompressSnapshotIfNeeded(corrupt);
  } catch {
    threw = true;
  }
  assert(threw, 'corrupt gzip must throw');
});

test('zip bomb hits the decompression ceiling', async () => {
  // 1 MiB of zeros compresses to ~1 KiB; a tiny ceiling must reject it on
  // expansion, proving the cap bounds allocation for hostile payloads.
  const zeros = new Uint8Array(1024 * 1024);
  const wire = await compressSnapshotIfSmaller(zeros);
  assert(isGzipCompressed(wire) && wire.length < 8192, 'zeros must compress hard');
  let threw = false;
  try {
    await decompressSnapshotIfNeeded(wire, 64 * 1024);
  } catch (error) {
    threw = true;
    assert(
      error instanceof Error && error.message.includes('decompression ceiling'),
      'ceiling error names itself',
    );
  }
  assert(threw, 'expansion past the ceiling must throw');
  const restored = await decompressSnapshotIfNeeded(wire, MAX_DECOMPRESSED_SNAPSHOT_BYTES);
  assert(restored.length === zeros.length, 'default ceiling admits honest payloads');
});

async function main(): Promise<void> {
  for (const item of cases) {
    try {
      await item.run();
      passed += 1;
    } catch (error) {
      failures.push(`${item.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (failures.length > 0) {
    console.error(`snapshot-compression: ${failures.length} failed`);
    for (const failure of failures) console.error(`  FAIL ${failure}`);
    process.exit(1);
  }
  console.log(`snapshot-compression: ${passed} passed`);
}

void main();
