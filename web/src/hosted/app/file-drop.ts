// Shared drag-and-drop file import (attn-7xl). The hosted app promised
// "Drop files to import" (OpenPage) but never wired a drop handler; this is
// the one place that converts an OS drag into the existing import pipeline.
// A browser `File` is narrowed to the structural `PickedFile` the import
// mapping (import-files.ts) already consumes, so drop and the file-picker
// share exactly one downstream path.

import type { PickedFile } from './import-files';

/** Read an iterable of browser Files into the structural PickedFile shape. */
export async function filesToPicked(files: Iterable<File>): Promise<PickedFile[]> {
  const picked: PickedFile[] = [];
  for (const file of files) {
    picked.push({
      name: file.name,
      relativePath: (file as File & { webkitRelativePath?: string }).webkitRelativePath,
      type: file.type,
      bytes: new Uint8Array(await file.arrayBuffer()),
    });
  }
  return picked;
}

export interface FileDropOptions {
  /** Called with the dropped files (never empty). */
  onFiles: (files: File[]) => void;
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
    const files = Array.from(event.dataTransfer?.files ?? []);
    if (files.length > 0) opts.onFiles(files);
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
