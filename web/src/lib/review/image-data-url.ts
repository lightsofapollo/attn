// A safe, in-memory rendering URL for verified image bytes.
//
// Blob URLs are preferable for normal document rendering: they avoid holding a
// second encoded copy of an image and can be revoked deterministically. An
// opaque sandboxed iframe is the exception. It has a unique origin and cannot
// read a Blob URL minted by its parent, so verified images need a data URL
// there. This helper is deliberately small and dependency-free so the hosted
// owner surface does not pull the browser cryptography bundle just to render a
// local HTML preview.

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  // Avoid applying a multi-megabyte typed array as one function call.
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Build an image `data:` URL without retaining the caller's mutable bytes.
 *
 * The caller must still zero its buffer once it has created any Blob it needs.
 * This string is runtime-only: it never enters a workspace or review snapshot.
 */
export function sharedImageDataUrl(mediaType: string, bytes: Uint8Array): string {
  const base64url = base64UrlEncode(bytes);
  const standard = base64url.replace(/-/g, '+').replace(/_/g, '/');
  const padding = standard.length % 4 === 0 ? '' : '='.repeat(4 - (standard.length % 4));
  return `data:${mediaType};base64,${standard}${padding}`;
}
