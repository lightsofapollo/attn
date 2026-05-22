// file-nav.ts — pure helpers for the reviewer's multi-file switcher.
//
// A folder-share publishes one snapshot per *.md file into a single review
// room, and republishes a snapshot whenever a file is created or edited. So a
// reviewer's `reviewStore.snapshots` can hold many snapshots spanning multiple
// `fileId`s (and multiple versions of the same file). `deriveFileEntries`
// collapses that list into the per-file switcher model the nav UI renders:
// one entry per fileId, keyed to the LATEST snapshot, with a display name
// derived from the document's first markdown heading.
//
// Kept free of the runes store so it is trivially unit-testable (see
// `file-nav.test.ts`).

import type { FileId, RoomId, ReviewSnapshot } from '../types';
import { commonRootDir, relativeToRoot } from './shared-tree';

/** One row in the reviewer's file switcher. */
export interface ReviewFileEntry {
  fileId: FileId;
  name: string;
  /** Folder containing the file, relative to the shared root ('' = root). */
  dir?: string;
}

/**
 * Match the first ATX markdown heading (`#`..`######`) on any line. The
 * spec's pattern is `/^#{1,6}\s+(.+)$/m`, but `\s` also matches newlines,
 * which would let a bare `#` marker swallow following blank lines and capture
 * body text. We restrict the gap after the marker to horizontal whitespace
 * (`[^\S\r\n]`) so a heading with no text on its own line correctly yields no
 * match (and the caller falls back to `Document N`).
 */
const HEADING_RE = /^#{1,6}[^\S\r\n]+(.+)$/m;

/**
 * Pull a display name from a document's first markdown heading. Returns the
 * trimmed heading text, or `null` when the doc has no heading (or no markdown
 * at all) so the caller can apply a deterministic fallback.
 */
function headingName(markdown: string | undefined): string | null {
  if (!markdown) return null;
  const match = HEADING_RE.exec(markdown);
  if (!match) return null;
  const text = match[1]?.trim();
  return text && text.length > 0 ? text : null;
}

/**
 * Collapse a flat snapshot list into one entry per file for the reviewer's
 * file switcher.
 *
 * - Only snapshots whose `roomId === currentRoomId` are considered. When
 *   `currentRoomId` is `null` the result is empty (no room → nothing to show).
 * - For each `fileId`, the snapshot with the greatest `createdAt` wins (the
 *   latest version of that file).
 * - The display `name` comes from the latest snapshot's first markdown
 *   heading. Files without a heading get a deterministic `Document N`
 *   fallback, where N counts (1-based) only the headingless entries, ordered
 *   by first-seen fileId.
 * - The returned list is sorted by `name.localeCompare`.
 */
export function deriveFileEntries(
  snapshots: ReviewSnapshot[],
  currentRoomId: RoomId | null,
): ReviewFileEntry[] {
  if (currentRoomId === null) return [];

  // Latest snapshot per fileId, preserving first-seen order of fileIds so the
  // headingless fallback numbering is deterministic.
  const latestByFile = new Map<FileId, ReviewSnapshot>();
  for (const snap of snapshots) {
    if (snap.roomId !== currentRoomId) continue;
    const existing = latestByFile.get(snap.fileId);
    if (existing === undefined || snap.createdAt > existing.createdAt) {
      latestByFile.set(snap.fileId, snap);
    }
  }

  // Shared root across all display paths so the strip can show a folder hint
  // for files nested in subfolders (without it, two `nested.md` in different
  // folders are indistinguishable).
  const paths: string[] = [];
  for (const snap of latestByFile.values()) {
    if (typeof snap.ownerDisplayPath === 'string' && snap.ownerDisplayPath.length > 0) {
      paths.push(snap.ownerDisplayPath);
    }
  }
  const root = commonRootDir(paths);

  // Build entries in first-seen fileId order so `Document N` numbering is
  // stable regardless of the final name sort.
  const entries: ReviewFileEntry[] = [];
  let headinglessCount = 0;
  for (const [fileId, snap] of latestByFile) {
    const heading = headingName(snap.markdown);
    const name = heading ?? `Document ${++headinglessCount}`;
    let dir = '';
    if (typeof snap.ownerDisplayPath === 'string' && snap.ownerDisplayPath.length > 0) {
      const rel = relativeToRoot(snap.ownerDisplayPath, root);
      dir = rel.replace(/\\/g, '/').split('/').slice(0, -1).join('/');
    }
    entries.push({ fileId, name, dir });
  }

  entries.sort((a, b) => a.name.localeCompare(b.name));
  return entries;
}
