// Workspace-relative path rules (attn-7xl.3.2), shared by the storage schema
// (src/lib/review/browser-workspace-schema.ts wraps errors into its own type)
// and the app entry's import mapping. Deliberately dependency-free so the
// hosted app bundle can use it without pulling the storage/crypto graph.

export const MAX_ENTRY_PATH_BYTES = 1024;
export const MAX_ENTRY_PATH_SEGMENTS = 64;

export class EntryPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EntryPathError';
  }
}

// Control characters, DEL, and backslash are never valid in a segment.
const PATH_SEGMENT_FORBIDDEN = /[\u0000-\u001f\u007f\\]/u;

/**
 * Normalize and validate a workspace-relative path. Paths are NFC-normalized,
 * '/'-separated, and never absolute or escaping. Throws EntryPathError on any
 * violation; returns the canonical form used as the store key.
 */
export function normalizeEntryPath(raw: string): string {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new EntryPathError('entry path is required');
  }
  const normalized = raw.normalize('NFC');
  const bytes = new TextEncoder().encode(normalized);
  if (bytes.length > MAX_ENTRY_PATH_BYTES) {
    throw new EntryPathError(`entry path exceeds ${MAX_ENTRY_PATH_BYTES} bytes`);
  }
  const segments = normalized.split('/');
  if (segments.length > MAX_ENTRY_PATH_SEGMENTS) {
    throw new EntryPathError('entry path has too many segments');
  }
  for (const segment of segments) {
    if (segment.length === 0) {
      throw new EntryPathError('entry path must be relative with non-empty segments');
    }
    if (segment === '.' || segment === '..') {
      throw new EntryPathError('entry path must not contain dot segments');
    }
    if (PATH_SEGMENT_FORBIDDEN.test(segment)) {
      throw new EntryPathError('entry path contains forbidden characters');
    }
  }
  return normalized;
}
