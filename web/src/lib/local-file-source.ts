/* Opening local files when there is no daemon behind the window.
 *
 * App.svelte normally gets its content by asking Rust: `navigate(path)` goes
 * out over the wry IPC bridge and a `setContent` payload comes back. Served
 * from Vite in an ordinary browser tab there is no Rust, so that round trip
 * never completes and the app is stranded on "No file selected" with no way
 * out — the empty state told the user to relaunch with a path, which is not
 * something a web page can do.
 *
 * This module is the browser's stand-in for that half of the daemon. The user
 * picks (or drops) files, we hold them for the session, shape them into the
 * same `TreeNode[]` / `ContentPayload` the daemon would have pushed, and
 * answer the app's later `navigate` messages out of that store. The app itself
 * needs no knowledge of any of this: it sees the payloads it already handles.
 *
 * Deliberately markdown-only. Images, media, and HTML files resolve their
 * sources through the `attn://` custom protocol, which does not exist in a
 * browser, so including them in the tree would produce entries that render
 * broken. Better to leave them out and say so.
 */

import { detectFileType } from './markdown-layer';
import type { ContentPayload, SearchResultItem, TreeNode } from './types';

/** Mirrors `should_skip_dir` in src/files.rs — a picked project folder would
 *  otherwise hand us every file in node_modules before we could filter. */
const SKIPPED_DIRS = new Set([
  'node_modules',
  'target',
  'dist',
  'build',
  'out',
  'coverage',
  '__pycache__',
  'venv',
]);

/** Matches MAX_TREE_NODES in src/files.rs. Folder picks are enumerated by the
 *  browser before we ever see them, so this bounds what we retain, not what it
 *  costs to choose. */
const MAX_FILES = 5_000;

/** A markdown file large enough to lock up ProseMirror is not worth opening. */
const MAX_FILE_BYTES = 8 * 1024 * 1024;

interface AttnContentBridge {
  setContent(data: ContentPayload): void;
}

/** One picked file plus the path it should occupy in the tree. */
export interface PickedPath {
  path: string;
  file: File;
}

/* The subset of the non-standard `webkitGetAsEntry()` tree we touch. It is not
   in lib.dom, and it is the only way to recurse into a DROPPED folder — a
   directory arrives in `dataTransfer.files` as a zero-byte File with no
   children, so a drop handler reading only that silently imports nothing. */
interface DirectoryEntryLike {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  file?: (onSuccess: (file: File) => void, onError?: (error: DOMException) => void) => void;
  createReader?: () => {
    readEntries: (
      onSuccess: (entries: DirectoryEntryLike[]) => void,
      onError?: (error: DOMException) => void,
    ) => void;
  };
}

/** Session store of picked files, keyed by the synthetic path in the tree. */
const store = new Map<string, File>();

/** Indirected so tests can pin it; `File.lastModified` needs a real clock. */
const nowMs = (): number => Date.now();

/**
 * Which of these files the app is currently showing.
 *
 * This module is the one that DELIVERS content, so it is the one that knows.
 * It exists because `edit_save` names no target — the real daemon writes to its
 * own `active_path`, and the browser loop has to answer the same question the
 * same way or a save lands in the wrong file (or, as it did before, nowhere).
 */
let activePath = '';
let storeRootPath = '';

export interface OpenLocalResult {
  /** Markdown files retained and reachable from the sidebar. */
  opened: number;
  /** Files dropped because they were not markdown. */
  skippedKind: number;
  /** Files dropped because of the count or per-file size caps. */
  skippedLimit: number;
  /** The path handed to the app, or '' when nothing was usable. */
  activePath: string;
}

function bridge(): AttnContentBridge | undefined {
  return (window as Window & { __attn__?: AttnContentBridge }).__attn__;
}

/**
 * Adapt an `<input type="file">` result. `webkitdirectory` populates
 * `webkitRelativePath` with the path beneath the chosen folder; a plain file
 * pick leaves it empty and the bare name is the whole path.
 */
export function pickedFromFileList(files: FileList | File[]): PickedPath[] {
  return Array.from(files).map((file) => {
    const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
    return { path: relative && relative.length > 0 ? relative : file.name, file };
  });
}

function entryFile(entry: DirectoryEntryLike): Promise<File | null> {
  return new Promise((resolve) => {
    if (!entry.file) {
      resolve(null);
      return;
    }
    entry.file(resolve, () => resolve(null));
  });
}

/** `readEntries` yields at most ~100 entries per call and signals completion
 *  with an empty batch, so a single call silently truncates large folders. */
function readAllEntries(entry: DirectoryEntryLike): Promise<DirectoryEntryLike[]> {
  const reader = entry.createReader?.();
  if (!reader) return Promise.resolve([]);

  return new Promise((resolve) => {
    const all: DirectoryEntryLike[] = [];
    const readBatch = (): void => {
      reader.readEntries((batch) => {
        if (batch.length === 0) {
          resolve(all);
          return;
        }
        all.push(...batch);
        readBatch();
      }, () => resolve(all));
    };
    readBatch();
  });
}

async function walkEntry(
  entry: DirectoryEntryLike,
  prefix: string,
  out: PickedPath[],
): Promise<void> {
  if (out.length >= MAX_FILES) return;
  const path = prefix ? `${prefix}/${entry.name}` : entry.name;

  if (entry.isFile) {
    const file = await entryFile(entry);
    if (file) out.push({ path, file });
    return;
  }
  if (!entry.isDirectory) return;
  if (SKIPPED_DIRS.has(entry.name) || entry.name.startsWith('.')) return;

  for (const child of await readAllEntries(entry)) {
    await walkEntry(child, path, out);
    if (out.length >= MAX_FILES) return;
  }
}

/**
 * Adapt a drop. Walks `webkitGetAsEntry()` so dropped FOLDERS recurse; falls
 * back to the flat `dataTransfer.files` when the browser withholds entries.
 */
export async function pickedFromDataTransfer(transfer: DataTransfer): Promise<PickedPath[]> {
  const entries: DirectoryEntryLike[] = [];
  for (const item of Array.from(transfer.items ?? [])) {
    if (item.kind !== 'file') continue;
    const entry = (
      item as DataTransferItem & { webkitGetAsEntry?: () => DirectoryEntryLike | null }
    ).webkitGetAsEntry?.();
    if (entry) entries.push(entry);
  }

  if (entries.length === 0) return pickedFromFileList(transfer.files ?? []);

  const out: PickedPath[] = [];
  for (const entry of entries) await walkEntry(entry, '', out);
  return out;
}

function isHidden(path: string): boolean {
  return path.split('/').some((segment) => segment.startsWith('.'));
}

function isSkipped(path: string): boolean {
  return path.split('/').some((segment) => SKIPPED_DIRS.has(segment));
}

/**
 * Build the nested tree the sidebar renders. Unlike the daemon — which sends a
 * shallow snapshot and fills subdirectories in on `load_children` — everything
 * here is already in memory, so the whole tree is built once and `load_children`
 * has nothing left to do.
 *
 * `paths` are relative and include the root folder as their first segment; the
 * returned nodes are that root's CHILDREN, matching `read_tree_root_snapshot`.
 */
export function buildTree(paths: string[], rootPath: string): TreeNode[] {
  const rootPrefix = rootPath ? `${rootPath}/` : '';
  const root: TreeNode[] = [];

  for (const path of paths) {
    if (rootPrefix && !path.startsWith(rootPrefix)) continue;
    const segments = path.slice(rootPrefix.length).split('/').filter(Boolean);
    if (segments.length === 0) continue;

    let level = root;
    let walked = rootPath;

    for (let i = 0; i < segments.length; i += 1) {
      const name = segments[i];
      walked = walked ? `${walked}/${name}` : name;
      const leaf = i === segments.length - 1;

      let node = level.find((candidate) => candidate.name === name);
      if (!node) {
        node = leaf
          ? { name, path: walked, isDir: false, fileType: 'markdown' }
          : { name, path: walked, isDir: true, fileType: 'directory', children: [] };
        level.push(node);
      }
      if (leaf) break;
      node.children ??= [];
      level = node.children;
    }
  }

  sortTree(root);
  return root;
}

/** Directories first, then files, each alphabetical — the order the sidebar
 *  expects from the daemon. */
function sortTree(nodes: TreeNode[]): void {
  nodes.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (const node of nodes) {
    if (node.children) sortTree(node.children);
  }
}

/**
 * Longest common directory prefix across the picked paths. A folder pick gives
 * every file the chosen folder as its first segment, so this recovers it; a
 * multi-file pick from one directory has no shared segment and yields ''.
 */
function commonRoot(paths: string[]): string {
  const withDirs = paths.filter((path) => path.includes('/'));
  if (withDirs.length === 0 || withDirs.length !== paths.length) return '';

  let prefix = withDirs[0].split('/').slice(0, -1);
  for (const path of withDirs.slice(1)) {
    const segments = path.split('/').slice(0, -1);
    let shared = 0;
    while (shared < prefix.length && shared < segments.length && prefix[shared] === segments[shared]) {
      shared += 1;
    }
    prefix = prefix.slice(0, shared);
    if (prefix.length === 0) return '';
  }
  return prefix.join('/');
}

export function hasLocalFiles(): boolean {
  return store.size > 0;
}

export function localRootPath(): string {
  return storeRootPath;
}

/**
 * Everything held this session, shaped as the daemon's shareable-file list.
 *
 * The native picker gets this from `files::list_shareable_files` walking the
 * real filesystem; here the session store IS the filesystem, so the store is
 * the answer. Every entry is markdown by construction — `openLocalFiles`
 * keeps nothing else — but the type is read off the path rather than assumed,
 * so this stays correct if the store ever widens.
 *
 * Insertion order is the sorted order `openLocalFiles` stored them in, which
 * is the order the sidebar tree shows.
 */
export function localShareableFiles(): SearchResultItem[] {
  return [...store.keys()].map((path) => ({ path, fileType: detectFileType(path) }));
}

/**
 * Read one stored file's markdown without delivering it to the editor.
 *
 * The mock share pipeline needs the real bytes of every file it publishes a
 * snapshot for (attn-64iy.1): a snapshot carrying invented content would
 * produce anchors that resolve against a document nobody is looking at, so
 * comments would land in the wrong place — or nowhere. `deliverLocalPath`
 * cannot serve that job because it also pushes the content into the active
 * editor, which would yank the user's view to whichever file was shared last.
 *
 * `null` when the path is not held this session (never picked, or dropped by
 * `resetLocalFiles`), which callers must treat as "cannot share this", not as
 * an empty document.
 */
export async function localMarkdown(path: string): Promise<string | null> {
  const file = store.get(path);
  if (!file) return null;
  return file.text();
}

/** Read one stored file and push it to the app as the daemon would. */
/**
 * Record an edit against a file the user picked this session.
 *
 * The store holds `File` objects, which are IMMUTABLE — the bytes belong to
 * the user's disk, and the browser will not let us write back to them. So the
 * session copy is replaced with a new `File` carrying the edited text. That is
 * the honest model for this loop: the edits live for as long as the tab does,
 * and they are what every subsequent read of this path returns.
 *
 * Without this, `edit_save` was accepted and dropped: the app reported a
 * successful save, then switching tabs or sharing re-read the ORIGINAL bytes
 * and the edits were gone with no error anywhere (Codex review, 2026-08-10).
 *
 * `lastModified` is advanced past the previous value so the app's
 * external-change detection reads this as a newer version of the file rather
 * than as a conflicting write by someone else.
 */
export function writeLocalMarkdown(path: string, text: string): boolean {
  const existing = store.get(path);
  if (!existing) return false;
  const name = path.split('/').pop() || existing.name;
  store.set(
    path,
    new File([text], name, {
      type: existing.type || 'text/markdown',
      lastModified: Math.max(existing.lastModified + 1, nowMs()),
    }),
  );
  return true;
}

export async function deliverLocalPath(path: string): Promise<boolean> {
  const file = store.get(path);
  if (!file) return false;
  activePath = path;

  const markdown = await file.text();
  bridge()?.setContent({
    filePath: path,
    markdown,
    contentMtimeMs: file.lastModified,
    contentBytes: file.size,
  });
  return true;
}

/**
 * Take the files the user picked or dropped, keep the markdown, and hand the
 * app its first document plus a sidebar tree.
 *
 * A single file is delivered without a tree so the window stays chromeless —
 * `hasSidebar` is driven by `fileTree.length`, and one file does not deserve a
 * file browser.
 */
export async function openLocalFiles(input: Iterable<PickedPath>): Promise<OpenLocalResult> {
  const result: OpenLocalResult = { opened: 0, skippedKind: 0, skippedLimit: 0, activePath: '' };

  const candidates: PickedPath[] = [];
  for (const { path, file } of input) {
    if (isHidden(path) || isSkipped(path)) continue;
    if (detectFileType(path) !== 'markdown') {
      result.skippedKind += 1;
      continue;
    }
    if (file.size > MAX_FILE_BYTES) {
      result.skippedLimit += 1;
      continue;
    }
    if (candidates.length >= MAX_FILES) {
      result.skippedLimit += 1;
      continue;
    }
    candidates.push({ path, file });
  }

  if (candidates.length === 0) return result;

  candidates.sort((a, b) => a.path.localeCompare(b.path));

  store.clear();
  for (const { path, file } of candidates) store.set(path, file);

  const paths = candidates.map((candidate) => candidate.path);
  storeRootPath = commonRoot(paths);
  result.opened = candidates.length;

  const first = paths[0];
  result.activePath = first;
  activePath = first;

  const markdown = await store.get(first)!.text();
  const single = candidates.length === 1;

  bridge()?.setContent({
    filePath: first,
    markdown,
    contentMtimeMs: store.get(first)!.lastModified,
    contentBytes: store.get(first)!.size,
    ...(single
      ? {}
      : {
          fileTree: buildTree(paths, storeRootPath),
          rootPath: storeRootPath,
          knownProjects: storeRootPath ? [storeRootPath] : [],
          activeProjectPath: storeRootPath,
        }),
  });

  return result;
}

/** Test seam: drop everything picked this session. */
export function resetLocalFiles(): void {
  store.clear();
  storeRootPath = '';
  activePath = '';
}

/** The path `edit_save` resolves against — see `activePath`. */
export function activeLocalPath(): string {
  return activePath;
}
