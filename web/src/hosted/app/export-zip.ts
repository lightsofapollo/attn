// Workspace export utilities (attn-7xl.3.4). fflate loads on demand so the
// app entry's static graph stays lean.

import type { ImportFileInput } from './types';

export const MANIFEST_PATH = 'attn-manifest.json';
export const MANIFEST_VERSION = 1;

/** Non-secret backup manifest: names, paths, sizes — never keys or room
 * material. Restores never require attn services. */
export interface BackupManifest {
  v: number;
  kind: 'attn-workspace-backup';
  name: string;
  exportedAt: number;
  entries: Array<{ path: string; kind: string; mediaType?: string; sizeBytes: number }>;
}

export function buildManifest(
  name: string,
  files: ImportFileInput[],
  exportedAt: number,
): BackupManifest {
  return {
    v: MANIFEST_VERSION,
    kind: 'attn-workspace-backup',
    name,
    exportedAt,
    entries: files.map((file) => ({
      path: file.path,
      kind: file.kind,
      ...(file.mediaType === undefined ? {} : { mediaType: file.mediaType }),
      sizeBytes: file.bytes.length,
    })),
  };
}

export function parseManifest(bytes: Uint8Array): BackupManifest | null {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Partial<BackupManifest>;
    if (
      parsed &&
      parsed.v === MANIFEST_VERSION &&
      parsed.kind === 'attn-workspace-backup' &&
      typeof parsed.name === 'string'
    ) {
      return parsed as BackupManifest;
    }
  } catch {
    // fall through
  }
  return null;
}

/** Build a zip preserving relative paths and exact bytes, plus the manifest. */
export async function buildWorkspaceZip(
  files: ImportFileInput[],
  manifest?: BackupManifest,
): Promise<Uint8Array> {
  const { zipSync } = await import('fflate');
  const tree: Record<string, Uint8Array> = {};
  for (const file of files) {
    tree[file.path] = file.bytes;
  }
  if (manifest) {
    tree[MANIFEST_PATH] = new TextEncoder().encode(JSON.stringify(manifest, null, 2));
  }
  return zipSync(tree, { level: 6 });
}

/** One workspace's exported bytes, ready to be folded into a desk backup. */
export interface WorkspaceExport {
  name: string;
  files: ImportFileInput[];
}

/** Index of a whole-desk backup: which folder holds which workspace. */
export interface DeskBackupManifest {
  v: number;
  kind: 'attn-desk-backup';
  exportedAt: number;
  workspaces: Array<{ name: string; folder: string; entryCount: number }>;
}

/**
 * Folder name for a workspace inside a desk backup. Two workspaces may share
 * a display name, and sanitizing can collapse two different names onto one
 * folder, so collisions are numbered rather than allowed to overwrite.
 */
export function backupFolderName(name: string, taken: Set<string>): string {
  const base = name
    .normalize('NFC')
    .replace(/[^\p{L}\p{N} _.-]/gu, '')
    .trim()
    .replace(/\s+/gu, '-');
  const stem = base.length > 0 ? base : 'workspace';
  let candidate = stem;
  let suffix = 2;
  while (taken.has(candidate)) {
    candidate = `${stem}-${suffix}`;
    suffix += 1;
  }
  taken.add(candidate);
  return candidate;
}

/**
 * Every workspace in ONE archive (attn-a9f7.1.4). The desk used to emit one
 * download per workspace, which browsers that gate multiple downloads reduce
 * to a single file with no error — so the caller could mark everything backed
 * up while almost nothing reached the disk. One archive is one download, and
 * one download either happens or visibly does not.
 */
export async function buildDeskBackupZip(
  workspaces: WorkspaceExport[],
  exportedAt: number,
): Promise<Uint8Array> {
  const { zipSync } = await import('fflate');
  const tree: Record<string, Uint8Array> = {};
  const encoder = new TextEncoder();
  const taken = new Set<string>();
  const index: DeskBackupManifest['workspaces'] = [];

  for (const workspace of workspaces) {
    const folder = backupFolderName(workspace.name, taken);
    for (const file of workspace.files) {
      tree[`${folder}/${file.path}`] = file.bytes;
    }
    tree[`${folder}/${MANIFEST_PATH}`] = encoder.encode(
      JSON.stringify(buildManifest(workspace.name, workspace.files, exportedAt), null, 2),
    );
    index.push({ name: workspace.name, folder, entryCount: workspace.files.length });
  }

  const manifest: DeskBackupManifest = {
    v: MANIFEST_VERSION,
    kind: 'attn-desk-backup',
    exportedAt,
    workspaces: index,
  };
  tree[MANIFEST_PATH] = encoder.encode(JSON.stringify(manifest, null, 2));
  return zipSync(tree, { level: 6 });
}

/** Dated filename for a whole-desk backup. */
export function deskBackupFileName(exportedAt: number): string {
  const day = new Date(exportedAt).toISOString().slice(0, 10);
  return `attn-desk-backup-${day}.zip`;
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
