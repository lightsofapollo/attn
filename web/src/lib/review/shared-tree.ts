// shared-tree.ts — pure helpers that turn a reviewer's flat snapshot list into
// a navigable folder tree of the shared room's files.
//
// A folder-share publishes one snapshot per *.md file, each carrying the
// owner's ABSOLUTE `ownerDisplayPath` (e.g.
// `/Users/me/project/docs/deep/nested.md`). To present these as a tree we
// strip the longest common directory prefix (the shared root) and group the
// remaining relative paths into folders. Kept free of the runes store so it is
// trivially unit-testable.

import type { FileId, RoomId, ReviewSnapshot } from '../types';

/** A single shared file, resolved to its latest snapshot. */
export interface SharedFile {
  fileId: FileId;
  /** Display name — first markdown heading, else the file's basename. */
  name: string;
  /** The owner's absolute path, as published on the snapshot. */
  displayPath: string;
  /** Path relative to the shared root, e.g. `deep/nested.md`. */
  relPath: string;
  /** Relative folder containing the file, e.g. `deep` (empty = root). */
  dir: string;
}

export interface SharedFolderNode {
  kind: 'folder';
  /** Folder basename, e.g. `deep`. */
  name: string;
  /** Folder path relative to the shared root, e.g. `deep` or `deep/sub`. */
  path: string;
  children: SharedTreeNode[];
}

export interface SharedFileNode extends SharedFile {
  kind: 'file';
}

export type SharedTreeNode = SharedFolderNode | SharedFileNode;

const HEADING_RE = /^#{1,6}[^\S\r\n]+(.+)$/m;

function headingName(markdown: string | undefined): string | null {
  if (!markdown) return null;
  const match = HEADING_RE.exec(markdown);
  const text = match?.[1]?.trim();
  return text && text.length > 0 ? text : null;
}

/** Split a path on `/` (and `\`), dropping empty segments. */
function segments(path: string): string[] {
  return path.replace(/\\/g, '/').split('/').filter((s) => s.length > 0);
}

function basename(path: string): string {
  const segs = segments(path);
  return segs.at(-1) ?? path;
}

/**
 * Longest common DIRECTORY prefix of a set of absolute file paths, returned as
 * a `/`-joined string with no trailing slash. The directory of each path (its
 * segments minus the filename) is considered, so two files in the same folder
 * share that folder as the root.
 */
export function commonRootDir(paths: string[]): string {
  if (paths.length === 0) return '';
  const dirSegs = paths.map((p) => {
    const segs = segments(p);
    return segs.slice(0, -1); // drop the filename
  });
  let common = dirSegs[0] ?? [];
  for (const segs of dirSegs.slice(1)) {
    let i = 0;
    while (i < common.length && i < segs.length && common[i] === segs[i]) i += 1;
    common = common.slice(0, i);
  }
  return common.join('/');
}

/** Path relative to `root` (a `/`-joined dir prefix). */
export function relativeToRoot(path: string, root: string): string {
  const pathSegs = segments(path);
  const rootSegs = segments(root);
  let i = 0;
  while (i < rootSegs.length && i < pathSegs.length && pathSegs[i] === rootSegs[i]) i += 1;
  return pathSegs.slice(i).join('/');
}

/**
 * Latest snapshot per fileId for `roomId`, resolved to {@link SharedFile}
 * with a folder-relative path. Empty when `roomId` is null or no snapshot
 * matches. Sorted by `relPath` so folders/files render deterministically.
 */
export function deriveSharedFiles(
  snapshots: ReviewSnapshot[],
  roomId: RoomId | null,
): SharedFile[] {
  if (roomId === null) return [];

  const latestByFile = new Map<FileId, ReviewSnapshot>();
  for (const snap of snapshots) {
    if (snap.roomId !== roomId) continue;
    const existing = latestByFile.get(snap.fileId);
    if (existing === undefined || snap.createdAt > existing.createdAt) {
      latestByFile.set(snap.fileId, snap);
    }
  }
  if (latestByFile.size === 0) return [];

  const withPaths = [...latestByFile.values()].filter(
    (s) => typeof s.ownerDisplayPath === 'string' && s.ownerDisplayPath.length > 0,
  );
  const paths = withPaths.map((s) => s.ownerDisplayPath as string);
  const root = commonRootDir(paths);

  const files: SharedFile[] = [];
  let headinglessCount = 0;
  for (const snap of latestByFile.values()) {
    const displayPath = snap.ownerDisplayPath ?? '';
    const relPath = displayPath ? relativeToRoot(displayPath, root) : '';
    const dirSegs = segments(relPath).slice(0, -1);
    const dir = dirSegs.join('/');
    const fallback = displayPath ? basename(displayPath) : `Document ${++headinglessCount}`;
    files.push({
      fileId: snap.fileId,
      // HTML docs have no markdown heading — use the filename fallback.
      name: snap.docType === 'html' ? fallback : (headingName(snap.content) ?? fallback),
      displayPath,
      relPath: relPath || basename(displayPath),
      dir,
    });
  }
  files.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return files;
}

/**
 * Build a nested folder tree from the shared files. Folders sort before files
 * within each level; both are alphabetical. Single-folder roots collapse
 * naturally because the common root is stripped first.
 */
export function deriveSharedTree(
  snapshots: ReviewSnapshot[],
  roomId: RoomId | null,
): SharedTreeNode[] {
  const files = deriveSharedFiles(snapshots, roomId);

  const root: SharedFolderNode = { kind: 'folder', name: '', path: '', children: [] };
  const folderByPath = new Map<string, SharedFolderNode>([['', root]]);

  function ensureFolder(path: string): SharedFolderNode {
    const existing = folderByPath.get(path);
    if (existing) return existing;
    const segs = segments(path);
    const name = segs.at(-1) ?? '';
    const parentPath = segs.slice(0, -1).join('/');
    const parent = ensureFolder(parentPath);
    const node: SharedFolderNode = { kind: 'folder', name, path, children: [] };
    folderByPath.set(path, node);
    parent.children.push(node);
    return node;
  }

  for (const file of files) {
    const parent = ensureFolder(file.dir);
    parent.children.push({ kind: 'file', ...file });
  }

  const sortLevel = (nodes: SharedTreeNode[]): SharedTreeNode[] => {
    nodes.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const n of nodes) if (n.kind === 'folder') sortLevel(n.children);
    return nodes;
  };

  return sortLevel(root.children);
}
