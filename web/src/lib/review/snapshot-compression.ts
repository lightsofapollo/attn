/**
 * Transparent snapshot compression (gzip) applied between canonical-JSON
 * encoding and AEAD sealing. Encrypted bytes are incompressible to every
 * layer downstream, so the only place compression can happen in an E2E
 * pipeline is client-side, before the seal.
 *
 * Wire rule (shared with the native client — src/review/compression.rs):
 *   - Encode: gzip the plaintext; keep it ONLY if strictly smaller.
 *     Markdown/HTML/manifest JSON shrink 4-6x; already-compressed media
 *     (PNG/JPEG/WebP asset payloads) stays raw automatically — no
 *     per-media-type policy needed.
 *   - Decode: sniff the two-byte gzip magic (0x1f 0x8b) after decrypt.
 *     Every snapshot plaintext is canonical JSON and therefore begins with
 *     `{` (0x7b) or `[` (0x5b), so the sniff is unambiguous.
 *
 * Integrity stays logical: BlobRef byteLength/contentHash (and the signed
 * baseHash) are computed over the UNCOMPRESSED plaintext on both ends, so
 * compression is invisible above the transport boundary.
 */

const GZIP_MAGIC_0 = 0x1f;
const GZIP_MAGIC_1 = 0x8b;

/**
 * Decompression ceiling. The relay caps sealed snapshots at 5 MiB; honest
 * text compresses ~4-6x, so 64 MiB leaves generous headroom while bounding
 * a malicious sender's expansion (zip bomb) to a fixed allocation.
 */
export const MAX_DECOMPRESSED_SNAPSHOT_BYTES = 64 * 1024 * 1024;

export function isGzipCompressed(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === GZIP_MAGIC_0 && bytes[1] === GZIP_MAGIC_1;
}

async function pipeThrough(
  bytes: Uint8Array,
  transform: CompressionStream | DecompressionStream,
  maxBytes: number,
): Promise<Uint8Array> {
  // Copy into a fresh buffer so the stream never retains a reference to a
  // caller-owned buffer that will be zeroed.
  const source = new Blob([new Uint8Array(bytes)]);
  const reader = source.stream().pipeThrough(transform).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      for (const chunk of chunks) chunk.fill(0);
      throw new Error(`snapshot payload exceeds the ${maxBytes}-byte decompression ceiling`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
    chunk.fill(0);
  }
  return out;
}

/**
 * Gzip `plaintext` and return the compressed bytes when strictly smaller,
 * otherwise return the ORIGINAL reference. Callers that zero buffers must
 * zero the return value AND the input when they differ.
 */
export async function compressSnapshotIfSmaller(plaintext: Uint8Array): Promise<Uint8Array> {
  if (plaintext.length < 64) return plaintext; // header overhead always loses
  const compressed = await pipeThrough(
    plaintext,
    new CompressionStream('gzip'),
    plaintext.length + 1024,
  ).catch(() => null);
  if (compressed === null || compressed.length >= plaintext.length) {
    compressed?.fill(0);
    return plaintext;
  }
  return compressed;
}

/**
 * Inflate gzip-compressed snapshot bytes; pass non-gzip bytes through as
 * the SAME reference. Throws when the payload is corrupt or exceeds
 * `maxBytes` — callers treat that exactly like a failed plaintext parse.
 */
export async function decompressSnapshotIfNeeded(
  bytes: Uint8Array,
  maxBytes: number = MAX_DECOMPRESSED_SNAPSHOT_BYTES,
): Promise<Uint8Array> {
  if (!isGzipCompressed(bytes)) return bytes;
  return pipeThrough(bytes, new DecompressionStream('gzip'), maxBytes);
}
