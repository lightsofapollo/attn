// Shared drag-and-drop file import (attn-7xl). The hosted app promised
// "Drop files to import" (OpenPage) but never wired a drop handler; this is
// the one place that converts an OS drag into the existing import pipeline.
// A browser `File` is narrowed to the structural `PickedFile` the import
// mapping (import-files.ts) already consumes, so drop and the file-picker
// share exactly one downstream path.

import type { PickedFile } from './import-files';

/**
 * A dropped file plus the path it had inside a dropped FOLDER.
 *
 * `<input webkitdirectory>` gives every picked file a `webkitRelativePath`, but
 * a file pulled out of a dropped directory entry has none — the path lives on
 * the entry, not the File — so a drop had to carry it alongside. Without this,
 * a dropped folder either failed outright or flattened into a pile of loose
 * files, and "relative paths are preserved exactly as native attn sees them" is
 * the promise the import surfaces make.
 */
export interface DroppedFile {
  file: File;
  relativePath?: string;
}

type PickableFile = File | DroppedFile;

function asDropped(file: PickableFile): DroppedFile {
  return file instanceof File ? { file } : file;
}

/** Read an iterable of browser Files into the structural PickedFile shape. */
export async function filesToPicked(files: Iterable<PickableFile>): Promise<PickedFile[]> {
  const picked: PickedFile[] = [];
  for (const entry of files) {
    const { file, relativePath } = asDropped(entry);
    picked.push({
      name: file.name,
      relativePath:
        relativePath || (file as File & { webkitRelativePath?: string }).webkitRelativePath,
      type: file.type,
      bytes: new Uint8Array(await file.arrayBuffer()),
    });
  }
  return picked;
}

/* Depth and count ceilings for the directory walk. A drop is an untrusted
   shape: a deep tree, or a symlink loop the entries API happens to expose,
   would otherwise recurse until the tab dies. Both are far above any real
   document folder, so hitting one means something is wrong, not that someone
   has an unusually large project. */
export const MAX_DROP_DEPTH = 24;
export const MAX_DROP_FILES = 5000;

/**
 * A drop the walk refused to finish (attn-e9r2.5).
 *
 * Hitting a ceiling used to STOP the walk and return what it had, so the
 * import pipeline ran to completion and reported success over a silently
 * truncated tree — the worst outcome available, because the workspace then
 * looks imported and is missing files nobody can name. A partial walk is not
 * a result; it is a failure with a number attached, and the drop surfaces say
 * so instead of importing anything.
 */
export class DropLimitError extends Error {
  readonly limit: 'files' | 'depth';

  constructor(limit: 'files' | 'depth') {
    super(
      limit === 'files'
        ? `That folder holds more than ${MAX_DROP_FILES.toLocaleString('en-US')} files. Nothing was imported — import it in smaller pieces.`
        : `That folder is nested more than ${MAX_DROP_DEPTH} levels deep. Nothing was imported — import a folder from further inside it.`,
    );
    this.name = 'DropLimitError';
    this.limit = limit;
  }
}

function entryFile(entry: FileSystemFileEntry): Promise<File | null> {
  return new Promise((resolve) => {
    entry.file((file) => resolve(file), () => resolve(null));
  });
}

/** One `readEntries` call returns at most ~100 children; drain it. */
async function readAllEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  const all: FileSystemEntry[] = [];
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve) => {
      reader.readEntries((entries) => resolve(entries), () => resolve([]));
    });
    if (batch.length === 0) return all;
    all.push(...batch);
  }
}

async function walkEntry(
  entry: FileSystemEntry,
  out: DroppedFile[],
  depth: number,
): Promise<void> {
  // Throwing, not returning: a ceiling reached mid-walk means the caller
  // cannot be handed `out` as if it were the whole drop.
  if (depth > MAX_DROP_DEPTH) throw new DropLimitError('depth');
  if (out.length >= MAX_DROP_FILES) throw new DropLimitError('files');
  if (entry.isFile) {
    const file = await entryFile(entry as FileSystemFileEntry);
    // fullPath is rooted at the drop ("/notes/plan.md"); the import pipeline
    // wants it workspace-relative, like webkitRelativePath.
    if (file) out.push({ file, relativePath: entry.fullPath.replace(/^\/+/u, '') });
    return;
  }
  if (!entry.isDirectory) return;
  const children = await readAllEntries((entry as FileSystemDirectoryEntry).createReader());
  for (const child of children) await walkEntry(child, out, depth + 1);
}

/**
 * Everything in a drop, folders expanded.
 *
 * `dataTransfer.files` alone cannot do this: a dropped directory appears there
 * as a single unreadable zero-byte File, so folder drops silently imported
 * nothing. The entries API (`webkitGetAsEntry`) is the only way to see inside
 * one, and it must be called synchronously against the live items list — the
 * DataTransfer is neutered as soon as the drop handler yields — so the entries
 * are collected first and walked afterwards.
 *
 * Throws `DropLimitError` when the tree exceeds `MAX_DROP_FILES` or
 * `MAX_DROP_DEPTH`. Callers must treat that as "imported nothing", never as a
 * short list.
 */
export async function readDroppedFiles(
  dataTransfer: DataTransfer | null,
): Promise<DroppedFile[]> {
  const items = dataTransfer?.items;
  const entries: FileSystemEntry[] = [];
  if (items) {
    for (const item of Array.from(items)) {
      if (item.kind !== 'file') continue;
      const entry = item.webkitGetAsEntry?.();
      if (entry) entries.push(entry);
    }
  }
  if (entries.length === 0) {
    // No entries API (or a synthetic drop): plain files are still correct.
    return Array.from(dataTransfer?.files ?? []).map((file) => ({ file }));
  }
  const out: DroppedFile[] = [];
  for (const entry of entries) await walkEntry(entry, out, 0);
  return out;
}

export interface FileDropOptions {
  /** Called with the dropped files, folders expanded (never empty). */
  onFiles: (files: DroppedFile[]) => void;
  /**
   * Called instead of `onFiles` when the drop could not be read whole — a
   * folder over the traversal ceilings, or an entries API that failed. Not
   * optional: a swallowed read error is exactly the silent-truncation failure
   * this pair of callbacks exists to prevent, so every drop surface has to say
   * where the message goes.
   */
  onError: (message: string) => void;
  /** When false, the node ignores drops (e.g. read-only view). Default true. */
  enabled?: boolean;
}

/** True when a drag carries OS files (not text/element drags). */
function dragHasFiles(event: DragEvent): boolean {
  const types = event.dataTransfer?.types;
  return types ? Array.from(types).includes('Files') : false;
}

/**
 * Watch the whole window for a file drag, reporting only transitions.
 *
 * Backs the sidebar's drop hint (attn-08fa.12). That hint used to be permanent
 * chrome — a dashed box standing in the rail every second of every session for
 * an action taken rarely, which for a daily user is a fixture that reads as
 * unfinished. Showing it exactly while a file is over the window keeps the
 * affordance where it is useful and returns the space the rest of the time.
 *
 * The same depth counter as `fileDrop`: `dragleave` fires on every child
 * boundary crossed, so a naive listener flickers the hint. `dragover` refreshes
 * the depth because a drag that ends outside the window (dropped on another
 * app, or cancelled) never sends a final `dragleave` at all.
 */
export function watchFileDrag(onChange: (dragging: boolean) => void): () => void {
  let depth = 0;
  let dragging = false;

  const set = (next: boolean): void => {
    if (next === dragging) return;
    dragging = next;
    onChange(next);
  };

  const onEnter = (event: DragEvent): void => {
    if (!dragHasFiles(event)) return;
    depth += 1;
    set(true);
  };
  const onLeave = (event: DragEvent): void => {
    if (!dragHasFiles(event)) return;
    depth = Math.max(0, depth - 1);
    if (depth === 0) set(false);
  };
  const onOver = (event: DragEvent): void => {
    if (!dragHasFiles(event)) return;
    if (depth === 0) depth = 1;
    set(true);
  };
  const onEnd = (): void => {
    depth = 0;
    set(false);
  };

  window.addEventListener('dragenter', onEnter);
  window.addEventListener('dragleave', onLeave);
  window.addEventListener('dragover', onOver);
  window.addEventListener('drop', onEnd);
  window.addEventListener('dragend', onEnd);
  return () => {
    window.removeEventListener('dragenter', onEnter);
    window.removeEventListener('dragleave', onLeave);
    window.removeEventListener('dragover', onOver);
    window.removeEventListener('drop', onEnd);
    window.removeEventListener('dragend', onEnd);
  };
}

/**
 * Svelte action: accept dropped files on `node`. Reflects an active drag as
 * `data-drag-over` on the node (style hook) and only reacts to file drags, so
 * dragging selected text or a link never triggers an import. A depth counter
 * keeps the state stable as the pointer crosses child elements.
 */
export function fileDrop(node: HTMLElement, options: FileDropOptions) {
  let opts = options;
  let depth = 0;

  const clear = () => {
    depth = 0;
    node.removeAttribute('data-drag-over');
  };

  const onDragEnter = (event: DragEvent) => {
    if (opts.enabled === false || !dragHasFiles(event)) return;
    event.preventDefault();
    depth += 1;
    node.setAttribute('data-drag-over', '');
  };

  const onDragOver = (event: DragEvent) => {
    if (opts.enabled === false || !dragHasFiles(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  };

  const onDragLeave = (event: DragEvent) => {
    if (opts.enabled === false || !dragHasFiles(event)) return;
    depth = Math.max(0, depth - 1);
    if (depth === 0) node.removeAttribute('data-drag-over');
  };

  const onDrop = (event: DragEvent) => {
    if (opts.enabled === false || !dragHasFiles(event)) return;
    event.preventDefault();
    clear();
    // Read the entries synchronously inside the handler (readDroppedFiles does
    // this before its first await): the DataTransfer is neutered the moment
    // this returns, so an `await` before touching `items` loses the drop.
    void readDroppedFiles(event.dataTransfer).then(
      (files) => {
        if (files.length > 0) opts.onFiles(files);
      },
      (error: unknown) => {
        opts.onError(error instanceof Error ? error.message : String(error));
      },
    );
  };

  node.addEventListener('dragenter', onDragEnter);
  node.addEventListener('dragover', onDragOver);
  node.addEventListener('dragleave', onDragLeave);
  node.addEventListener('drop', onDrop);

  return {
    update(next: FileDropOptions) {
      opts = next;
      if (next.enabled === false) clear();
    },
    destroy() {
      node.removeEventListener('dragenter', onDragEnter);
      node.removeEventListener('dragover', onDragOver);
      node.removeEventListener('dragleave', onDragLeave);
      node.removeEventListener('drop', onDrop);
    },
  };
}
