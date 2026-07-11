// File-picker → ImportFileInput mapping (attn-7xl.3.2). Pure and unit-
// testable: browser File objects are narrowed to this structural shape.

import { normalizeEntryPath } from '../../lib/hosted/entry-path';
import { MANIFEST_PATH, parseManifest } from './export-zip';
import type { ImportFileInput, WorkspaceEntryKind } from './types';

export interface PickedFile {
  name: string;
  /** `webkitRelativePath` when a folder was selected; empty otherwise. */
  relativePath?: string;
  type: string;
  bytes: Uint8Array;
}

const MARKDOWN_EXTENSIONS = /\.(?:md|markdown)$/iu;
const ZIP_EXTENSION = /\.zip$/iu;
/** Per-file input cap: larger inputs are rejected, never silently truncated. */
export const MAX_IMPORT_FILE_BYTES = 64 * 1024 * 1024;

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
    if (file.bytes.length > MAX_IMPORT_FILE_BYTES) {
      throw new EntryPathSafeError(
        `${file.name} is larger than the ${Math.round(MAX_IMPORT_FILE_BYTES / (1024 * 1024))} MB import limit`,
      );
    }
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

export class EntryPathSafeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EntryPathSafeError';
  }
}

export function isZipFile(name: string): boolean {
  return ZIP_EXTENSION.test(name);
}

const MEDIA_BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  json: 'application/json',
  txt: 'text/plain',
  html: 'text/html',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
};

export function mediaTypeForName(name: string): string | undefined {
  const extension = name.split('.').pop()?.toLowerCase();
  return extension ? MEDIA_BY_EXTENSION[extension] : undefined;
}

/**
 * Expand a picked `.zip` into individual files — the iOS-compatible folder
 * path. Directory entries are skipped; any invalid path aborts the whole
 * import rather than silently dropping content. fflate is loaded on demand.
 */
export async function expandZip(zip: PickedFile): Promise<PickedFile[]> {
  const { unzipSync } = await import('fflate');
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(zip.bytes);
  } catch {
    throw new EntryPathSafeError(`${zip.name} is not a readable zip archive`);
  }
  const files: PickedFile[] = [];
  for (const [rawPath, bytes] of Object.entries(entries)) {
    if (rawPath.endsWith('/')) continue; // directory marker
    if (rawPath.startsWith('__MACOSX/') || rawPath.split('/').pop() === '.DS_Store') continue;
    const name = rawPath.split('/').pop() ?? rawPath;
    files.push({
      name,
      relativePath: rawPath,
      type: mediaTypeForName(name) ?? '',
      bytes,
    });
  }
  if (files.length === 0) {
    throw new EntryPathSafeError(`${zip.name} contains no files`);
  }
  return files;
}

/** Expand zips (each into its files) and pass everything else through. */
export async function expandPicked(picked: PickedFile[]): Promise<PickedFile[]> {
  const out: PickedFile[] = [];
  for (const file of picked) {
    if (isZipFile(file.name)) out.push(...(await expandZip(file)));
    else out.push(file);
  }
  return out;
}

export interface PreparedImport {
  name: string;
  files: ImportFileInput[];
}

/**
 * Manifest-aware import preparation: strips `attn-manifest.json`, prefers its
 * (non-secret) workspace name, and never carries room state — imports always
 * create a fresh local workspace.
 */
export function prepareImport(picked: PickedFile[]): PreparedImport {
  const manifestFile = picked.find(
    (file) => (file.relativePath || file.name) === MANIFEST_PATH,
  );
  const manifest = manifestFile ? parseManifest(manifestFile.bytes) : null;
  const contentFiles = picked.filter((file) => file !== manifestFile);
  const files = toImportFiles(contentFiles);
  if (files.length === 0) {
    throw new EntryPathSafeError('Nothing to import: the selection contained only metadata.');
  }
  return { name: manifest?.name ?? importName(contentFiles), files };
}

/** Pick a non-conflicting workspace name ("Name", "Name 2", "Name 3", …). */
export function dedupeWorkspaceName(name: string, existing: string[]): string {
  const taken = new Set(existing);
  if (!taken.has(name)) return name;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${name} ${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Derive a workspace name from the imported set. */
export function importName(picked: PickedFile[]): string {
  const first = picked[0];
  if (!first) return 'Imported workspace';
  const folder = first.relativePath?.split('/')[0];
  if (folder && folder.length > 0 && picked.length > 1) return folder;
  return first.name.replace(MARKDOWN_EXTENSIONS, '') || 'Imported workspace';
}
