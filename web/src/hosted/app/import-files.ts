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

interface DroppedFileEntry {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  file?: (success: (file: File) => void, failure?: (error: DOMException) => void) => void;
  createReader?: () => {
    readEntries: (
      success: (entries: DroppedFileEntry[]) => void,
      failure?: (error: DOMException) => void,
    ) => void;
  };
}

const MARKDOWN_EXTENSIONS = /\.(?:md|markdown)$/iu;
const ZIP_EXTENSION = /\.zip$/iu;
/** Per-file input cap: larger inputs are rejected, never silently truncated. */
export const MAX_IMPORT_FILE_BYTES = 64 * 1024 * 1024;
export const MAX_IMPORT_ARCHIVE_BYTES = 64 * 1024 * 1024;
export const MAX_IMPORT_EXPANDED_BYTES = 128 * 1024 * 1024;
export const MAX_IMPORT_ARCHIVE_ENTRIES = 1024;

async function pickedFile(file: File, relativePath?: string): Promise<PickedFile> {
  return {
    name: file.name,
    relativePath: relativePath
      ?? (file as File & { webkitRelativePath?: string }).webkitRelativePath,
    type: file.type,
    bytes: new Uint8Array(await file.arrayBuffer()),
  };
}

/** Convert a picker result into the storage-neutral import shape. */
export async function pickedFilesFromList(files: FileList | File[]): Promise<PickedFile[]> {
  return Promise.all(Array.from(files).map((file) => pickedFile(file)));
}

function entryFile(entry: DroppedFileEntry): Promise<File> {
  return new Promise((resolve, reject) => {
    if (!entry.file) {
      reject(new EntryPathSafeError(`${entry.name} could not be read`));
      return;
    }
    entry.file(resolve, reject);
  });
}

async function directoryEntries(entry: DroppedFileEntry): Promise<DroppedFileEntry[]> {
  const reader = entry.createReader?.();
  if (!reader) return [];
  const entries: DroppedFileEntry[] = [];
  for (;;) {
    const batch = await new Promise<DroppedFileEntry[]>((resolve, reject) => {
      reader.readEntries(resolve, reject);
    });
    if (batch.length === 0) return entries;
    entries.push(...batch);
  }
}

async function walkDroppedEntry(
  entry: DroppedFileEntry,
  parentPath = '',
): Promise<PickedFile[]> {
  const path = parentPath ? `${parentPath}/${entry.name}` : entry.name;
  if (entry.isFile) {
    return [await pickedFile(await entryFile(entry), path)];
  }
  if (!entry.isDirectory) return [];
  const children = await directoryEntries(entry);
  const nested = await Promise.all(children.map((child) => walkDroppedEntry(child, path)));
  return nested.flat();
}

/**
 * Convert a browser drop into import files. Chromium/WebKit directory entries
 * are traversed so dropping a project preserves its relative paths; browsers
 * without that API fall back to the ordinary FileList.
 */
export async function pickedFilesFromDrop(transfer: DataTransfer): Promise<PickedFile[]> {
  const roots = Array.from(transfer.items)
    .filter((item) => item.kind === 'file')
    .map((item) => {
      const withEntry = item as DataTransferItem & {
        webkitGetAsEntry?: () => DroppedFileEntry | null;
      };
      return (withEntry.webkitGetAsEntry?.() ?? null) as DroppedFileEntry | null;
    })
    .filter((entry): entry is DroppedFileEntry => entry !== null);
  if (roots.length === 0) return pickedFilesFromList(transfer.files);
  try {
    const traversed = (await Promise.all(roots.map((entry) => walkDroppedEntry(entry)))).flat();
    if (traversed.length > 0) return traversed;
  } catch (error) {
    // WebKit can expose a FileSystemEntry and then reject entry.file() with
    // NotFoundError while DataTransfer.files still contains the valid file.
    // Preserve directory paths when traversal works; otherwise take the
    // interoperable FileList rather than turning a readable drop into a no-op.
    if (transfer.files.length === 0) throw error;
  }
  return pickedFilesFromList(transfer.files);
}

export interface ZipEntryBudget {
  entries: number;
  expandedBytes: number;
}

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
  if (zip.bytes.length > MAX_IMPORT_ARCHIVE_BYTES) {
    throw new EntryPathSafeError(
      `${zip.name} is larger than the ${Math.round(MAX_IMPORT_ARCHIVE_BYTES / (1024 * 1024))} MB archive limit`,
    );
  }
  const { unzipSync } = await import('fflate');
  let entries: Record<string, Uint8Array>;
  const budget: ZipEntryBudget = { entries: 0, expandedBytes: 0 };
  try {
    entries = unzipSync(zip.bytes, {
      filter: (entry) => acceptZipEntry(entry, budget),
    });
  } catch (error) {
    if (error instanceof EntryPathSafeError) throw error;
    throw new EntryPathSafeError(`${zip.name} is not a readable zip archive`);
  }
  const files: PickedFile[] = [];
  let actualExpandedBytes = 0;
  for (const [rawPath, bytes] of Object.entries(entries)) {
    if (rawPath.endsWith('/')) continue; // directory marker
    if (rawPath.startsWith('__MACOSX/') || rawPath.split('/').pop() === '.DS_Store') continue;
    const name = rawPath.split('/').pop() ?? rawPath;
    actualExpandedBytes += bytes.length;
    if (!Number.isSafeInteger(actualExpandedBytes) || actualExpandedBytes > MAX_IMPORT_EXPANDED_BYTES) {
      throw new EntryPathSafeError('The expanded archive is larger than the 128 MB import limit');
    }
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

export function acceptZipEntry(
  entry: { name: string; originalSize: number },
  budget: ZipEntryBudget,
): boolean {
  if (entry.name.endsWith('/') || entry.name.startsWith('__MACOSX/')
    || entry.name.split('/').pop() === '.DS_Store') return false;
  normalizeEntryPath(entry.name);
  if (!Number.isSafeInteger(entry.originalSize) || entry.originalSize < 0) {
    throw new EntryPathSafeError('The archive contains an invalid entry size');
  }
  if (entry.originalSize > MAX_IMPORT_FILE_BYTES) {
    throw new EntryPathSafeError(
      `${entry.name} is larger than the ${Math.round(MAX_IMPORT_FILE_BYTES / (1024 * 1024))} MB import limit`,
    );
  }
  const entries = budget.entries + 1;
  const expandedBytes = budget.expandedBytes + entry.originalSize;
  if (entries > MAX_IMPORT_ARCHIVE_ENTRIES) {
    throw new EntryPathSafeError(`The archive contains more than ${MAX_IMPORT_ARCHIVE_ENTRIES} files`);
  }
  if (!Number.isSafeInteger(expandedBytes) || expandedBytes > MAX_IMPORT_EXPANDED_BYTES) {
    throw new EntryPathSafeError('The expanded archive is larger than the 128 MB import limit');
  }
  budget.entries = entries;
  budget.expandedBytes = expandedBytes;
  return true;
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
