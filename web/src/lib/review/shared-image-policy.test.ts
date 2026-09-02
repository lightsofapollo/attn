import {
  bytesMatchSharedImageMediaType,
  hasSafeSharedImageDimensions,
  isSupportedSharedImageMediaType,
  MAX_SHARED_IMAGE_BYTES,
  MAX_SHARED_IMAGE_COUNT,
  MAX_SHARED_IMAGE_TOTAL_BYTES,
  UNRESOLVED_SHARED_IMAGE_SRC,
} from './shared-image-policy';

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

assert(isSupportedSharedImageMediaType('image/png'), 'PNG is allowlisted');
assert(isSupportedSharedImageMediaType('IMAGE/AVIF'), 'media type comparison is case-insensitive');
assert(!isSupportedSharedImageMediaType('image/tiff'), 'unsupported image types cannot enter a share');
assert(!isSupportedSharedImageMediaType('text/html'), 'document media cannot enter a share as an image');
assert(bytesMatchSharedImageMediaType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), 'image/png'), 'PNG signature is checked');
assert(!bytesMatchSharedImageMediaType(new Uint8Array([0, 1, 2, 3]), 'image/png'), 'mismatched bytes are rejected');
assert(bytesMatchSharedImageMediaType(new TextEncoder().encode('  <svg viewBox="0 0 1 1"/>'), 'image/svg+xml'), 'SVG accepts leading whitespace');
const png = new Uint8Array(24);
png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
png.set([0, 0, 0, 100, 0, 0, 0, 200], 16);
assert(hasSafeSharedImageDimensions(png, 'image/png'), 'bounded PNG dimensions are accepted');
png.set([0, 0, 0x27, 0x10, 0, 0, 0x27, 0x10], 16);
assert(!hasSafeSharedImageDimensions(png, 'image/png'), 'oversized raster dimensions are refused before decoding');
assert(!hasSafeSharedImageDimensions(new Uint8Array(8), 'image/png'), 'unknown raster dimensions fail closed');
assert(MAX_SHARED_IMAGE_BYTES === 3 * 1024 * 1024, 'single-image cap preserves encrypted-envelope headroom');
assert(MAX_SHARED_IMAGE_COUNT === 64 && MAX_SHARED_IMAGE_TOTAL_BYTES === 16 * 1024 * 1024, 'aggregate image budgets are bounded');
assert(UNRESOLVED_SHARED_IMAGE_SRC === 'data:;base64,', 'rejected image sources remain local and non-decodable');

console.log('shared-image-policy: 12 passed, 0 failed');
