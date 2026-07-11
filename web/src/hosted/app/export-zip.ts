// Workspace export utilities (attn-7xl.3.4). fflate loads on demand so the
// app entry's static graph stays lean.

import type { ImportFileInput } from './types';

/** Build a zip preserving relative paths and exact bytes. */
export async function buildWorkspaceZip(files: ImportFileInput[]): Promise<Uint8Array> {
  const { zipSync } = await import('fflate');
  const tree: Record<string, Uint8Array> = {};
  for (const file of files) {
    tree[file.path] = file.bytes;
  }
  return zipSync(tree, { level: 6 });
}

/** Trigger a browser download from in-memory bytes. */
export function triggerDownload(
  documentRef: Document,
  name: string,
  bytes: Uint8Array,
  mediaType = 'application/octet-stream',
): void {
  const copy = new Uint8Array(bytes);
  const blob = new Blob([copy.buffer as ArrayBuffer], { type: mediaType });
  const url = URL.createObjectURL(blob);
  const anchor = documentRef.createElement('a');
  anchor.href = url;
  anchor.download = name;
  documentRef.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Give the click a tick to start the download before revoking.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Safe filename for a workspace zip. */
export function zipFileName(workspaceName: string): string {
  const base = workspaceName
    .normalize('NFC')
    .replace(/[^\p{L}\p{N} _.-]/gu, '')
    .trim()
    .replace(/\s+/gu, '-');
  return `${base.length > 0 ? base : 'workspace'}.zip`;
}
