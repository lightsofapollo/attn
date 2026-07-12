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
