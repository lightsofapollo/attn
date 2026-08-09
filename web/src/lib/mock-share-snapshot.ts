/* Pure decisions behind the mock share's snapshot publishing (attn-64iy.1).
 *
 * `mock-ipc.ts` owns the effectful half — reading the session store, hashing,
 * building the canonical anchor index, pushing through the bridge. What is
 * decidable without any of that lives here so it can be tested directly, the
 * same split `share-dialog-state.ts` and `share-chip-model.ts` already use.
 */

import type { FileId, SnapshotId } from './types';

/** The subset of `ReviewShareMessage` these decisions read. */
export interface MockShareTarget {
  /** Project root the share is anchored at. */
  path: string;
  /** Exact selection, when the picker made one. */
  selectedPaths?: string[];
  /** File the reviewer should open first. */
  primaryPath?: string;
}

/** One shareable file as the session store reports it. */
export interface ShareableEntry {
  path: string;
  fileType: string;
}

/**
 * Mirrors the containment test the Rust scan gets for free from walking.
 * An empty root contains everything — that is a share of "whatever is open",
 * not a share of nothing.
 */
export function pathWithinRoot(path: string, root: string): boolean {
  const normalizedRoot = root.replace(/\/+$/u, '');
  if (normalizedRoot.length === 0) return true;
  return path === normalizedRoot || path.startsWith(`${normalizedRoot}/`);
}

/**
 * Which files does this share cover?
 *
 * Precedence mirrors the daemon's: an explicit selection wins outright, then
 * every markdown file the session holds under the shared root, then — when the
 * store holds nothing at all — whatever the message itself names, so a share of
 * the mock sample document still produces one snapshot.
 *
 * Non-markdown entries are dropped rather than snapshotted empty: the browser
 * file source is markdown-only by construction, but the share message can name
 * anything, and a snapshot with no content is worse than no snapshot.
 */
export function sharedMarkdownPaths(
  msg: MockShareTarget,
  shareable: readonly ShareableEntry[],
): string[] {
  const selected = (msg.selectedPaths ?? []).filter((p) => p.length > 0);
  if (selected.length > 0) return [...new Set(selected)];

  const underRoot = shareable
    .filter((item) => item.fileType === 'markdown')
    .map((item) => item.path)
    .filter((path) => pathWithinRoot(path, msg.path));
  if (underRoot.length > 0) return underRoot;

  const single = msg.primaryPath || msg.path;
  return single ? [single] : [];
}

/**
 * Stable per-path file id.
 *
 * Stability is the whole point: re-sharing the same file must land on the same
 * FileId, or the store treats the second share as a different document and
 * every comment authored against the first is stranded on an id nothing
 * resolves any more.
 */
export function mockFileIdFor(path: string): FileId {
  const slug = path.replace(/[^A-Za-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '');
  return `mock-file-${slug.length > 0 ? slug : 'untitled'}`;
}

/**
 * Content-addressed snapshot id, so editing a file yields a genuinely new
 * snapshot while re-sharing an unchanged one is idempotent.
 */
export function mockSnapshotIdFor(fileId: FileId, baseHash: string): SnapshotId {
  return `mock-snapshot-${fileId}-${baseHash.slice(0, 8)}`;
}
