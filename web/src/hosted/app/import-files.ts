// File-picker → ImportFileInput mapping (attn-7xl.3.2). Pure and unit-
// testable: browser File objects are narrowed to this structural shape.

import { normalizeEntryPath } from '../../lib/hosted/entry-path';
import type { ImportFileInput, WorkspaceEntryKind } from './types';

export interface PickedFile {
  name: string;
  /** `webkitRelativePath` when a folder was selected; empty otherwise. */
  relativePath?: string;
  type: string;
  bytes: Uint8Array;
}

const MARKDOWN_EXTENSIONS = /\.(?:md|markdown)$/iu;

export function kindForFile(name: string): WorkspaceEntryKind {
  return MARKDOWN_EXTENSIONS.test(name) ? 'markdown' : 'asset';
}

/**
 * Map picked files to import inputs, preserving relative paths (folder
 * selection) and rejecting anything whose path fails canonicalization —
 * traversal or malformed names abort the whole import rather than silently
 * dropping files.
 */
export function toImportFiles(picked: PickedFile[]): ImportFileInput[] {
  return picked.map((file) => {
    const rawPath = file.relativePath && file.relativePath.length > 0 ? file.relativePath : file.name;
    const path = normalizeEntryPath(rawPath);
    const kind = kindForFile(file.name);
    return {
      path,
      bytes: file.bytes,
      kind,
      ...(kind === 'asset' && file.type ? { mediaType: file.type } : {}),
    };
  });
}

/** Derive a workspace name from the imported set. */
export function importName(picked: PickedFile[]): string {
  const first = picked[0];
  if (!first) return 'Imported workspace';
  const folder = first.relativePath?.split('/')[0];
  if (folder && folder.length > 0 && picked.length > 1) return folder;
  return first.name.replace(MARKDOWN_EXTENSIONS, '') || 'Imported workspace';
}
