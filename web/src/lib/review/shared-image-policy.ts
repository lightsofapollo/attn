// Shared-image policy kept deliberately below the encrypted transport limits.
// Assets are represented as canonical base64url inside snapshot JSON, so the
// 5 MiB relay ciphertext ceiling cannot safely admit an 8 MiB raw image.

export const MAX_SHARED_IMAGE_BYTES = 3 * 1024 * 1024;
export const MAX_SHARED_IMAGE_COUNT = 64;
export const MAX_SHARED_IMAGE_TOTAL_BYTES = 16 * 1024 * 1024;
export const MAX_SHARED_IMAGE_PIXELS = 40_000_000;

/** A local, deliberately non-decodable image source. Renderers use this when
 * a share resolver cannot bind an authored src to verified asset bytes: it
 * produces the existing image fallback without giving untrusted HTML or
 * Markdown an ambient network request capability. */
export const UNRESOLVED_SHARED_IMAGE_SRC = 'data:;base64,';

const IMAGE_MEDIA_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/bmp',
  'image/x-icon',
  'image/svg+xml',
]);

export function isSupportedSharedImageMediaType(mediaType: string | undefined): boolean {
  return mediaType !== undefined && IMAGE_MEDIA_TYPES.has(mediaType.toLowerCase());
}

/** Lightweight content checks before encrypted publication. Rendering remains
 * in an image context; SVG never receives a script-capable document context. */
export function bytesMatchSharedImageMediaType(bytes: Uint8Array, mediaType: string): boolean {
  switch (mediaType.toLowerCase()) {
    case 'image/png':
      return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case 'image/jpeg':
      return startsWith(bytes, [0xff, 0xd8, 0xff]);
    case 'image/gif':
      return startsWith(bytes, text('GIF87a')) || startsWith(bytes, text('GIF89a'));
    case 'image/webp':
      return startsWith(bytes, text('RIFF')) && startsWith(bytes.subarray(8), text('WEBP'));
    case 'image/avif':
      return bytes.length >= 12 && startsWith(bytes.subarray(4), text('ftyp'))
        && ['avif', 'avis'].includes(new TextDecoder().decode(bytes.subarray(8, 12)));
    case 'image/bmp':
      return startsWith(bytes, text('BM'));
    case 'image/x-icon':
      return startsWith(bytes, [0, 0, 1, 0]);
    case 'image/svg+xml':
      return new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, 1024))
        .replace(/^\uFEFF?\s*/u, '').startsWith('<svg');
    default:
      return false;
  }
}

/** Refuse a tiny decompression bomb before it can reach an image decoder. SVG
 * remains a vector image in a sandboxed image context, so the byte cap is its
 * relevant resource bound. Unknown raster dimensions fail closed. */
export function hasSafeSharedImageDimensions(bytes: Uint8Array, mediaType: string): boolean {
  if (mediaType.toLowerCase() === 'image/svg+xml') return true;
  const dimensions = rasterDimensions(bytes, mediaType.toLowerCase());
  return dimensions !== null
    && dimensions[0] > 0
    && dimensions[1] > 0
    && dimensions[0] * dimensions[1] <= MAX_SHARED_IMAGE_PIXELS;
}

function rasterDimensions(bytes: Uint8Array, mediaType: string): [number, number] | null {
  switch (mediaType) {
    case 'image/png':
      return bytes.length >= 24 ? [u32be(bytes, 16), u32be(bytes, 20)] : null;
    case 'image/gif':
      return bytes.length >= 10 ? [u16le(bytes, 6), u16le(bytes, 8)] : null;
    case 'image/jpeg':
      return jpegDimensions(bytes);
    case 'image/webp':
      return webpDimensions(bytes);
    case 'image/avif':
      return ispeDimensions(bytes);
    case 'image/bmp':
      return bytes.length >= 26 ? [i32le(bytes, 18), Math.abs(i32le(bytes, 22))] : null;
    case 'image/x-icon':
      return bytes.length >= 8
        ? [bytes[6] === 0 ? 256 : bytes[6]!, bytes[7] === 0 ? 256 : bytes[7]!]
        : null;
    default:
      return null;
  }
}

function jpegDimensions(bytes: Uint8Array): [number, number] | null {
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++]!;
    if (marker === 0xd8 || marker === 0xd9) continue;
    if (offset + 1 >= bytes.length) return null;
    const length = u16be(bytes, offset);
    if (length < 2 || offset + length > bytes.length) return null;
    // Start-of-frame markers except the non-frame DHT/DAC/JPG markers.
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return offset + 7 < bytes.length ? [u16be(bytes, offset + 5), u16be(bytes, offset + 3)] : null;
    }
    offset += length;
  }
  return null;
}

function webpDimensions(bytes: Uint8Array): [number, number] | null {
  if (bytes.length < 30) return null;
  const chunk = decodeAscii(bytes.subarray(12, 16));
  if (chunk === 'VP8X') {
    return [u24le(bytes, 24) + 1, u24le(bytes, 27) + 1];
  }
  if (chunk === 'VP8 ') {
    return [u16le(bytes, 26) & 0x3fff, u16le(bytes, 28) & 0x3fff];
  }
  if (chunk === 'VP8L' && bytes.length >= 25 && bytes[20] === 0x2f) {
    const packed = bytes[21]! | (bytes[22]! << 8) | (bytes[23]! << 16) | (bytes[24]! << 24);
    return [(packed & 0x3fff) + 1, ((packed >>> 14) & 0x3fff) + 1];
  }
  return null;
}

function ispeDimensions(bytes: Uint8Array): [number, number] | null {
  // `ispe` carries a FullBox (version+flags) followed by width and height.
  for (let index = 4; index + 16 <= bytes.length && index < 64 * 1024; index += 1) {
    if (decodeAscii(bytes.subarray(index, index + 4)) === 'ispe') {
      return [u32be(bytes, index + 8), u32be(bytes, index + 12)];
    }
  }
  return null;
}

function u16be(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! << 8) | bytes[offset + 1]!;
}

function u16le(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

function u24le(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16);
}

function i32le(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16) | (bytes[offset + 3]! << 24));
}

function u32be(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset]! * 0x1_0000_00) + (bytes[offset + 1]! << 16) + (bytes[offset + 2]! << 8) + bytes[offset + 3]!) >>> 0;
}

function decodeAscii(bytes: Uint8Array): string {
  return String.fromCharCode(...bytes);
}

function startsWith(bytes: Uint8Array, prefix: ArrayLike<number>): boolean {
  if (bytes.length < prefix.length) return false;
  for (let index = 0; index < prefix.length; index += 1) {
    if (bytes[index] !== prefix[index]) return false;
  }
  return true;
}

function text(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}
