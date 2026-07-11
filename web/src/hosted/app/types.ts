// Typed contracts for the local workspace shells (attn-7xl.1.3).
//
// These are the *view* contracts the page shells render against. They are
// deliberately storage-free: attn-7xl.2 implements the durable IndexedDB/OPFS
// service and attn-7xl.3 swaps the injected mock for it without changing the
// shells. Workspaces are folder-shaped — nested Markdown plus arbitrary
// binary assets with normalized relative paths (epic scope note 2026-07-10).

/** How an entry may be presented. Safe raster types render inline; unknown or
 * active types are download-only. */
export type EntryPresentation = 'editable' | 'preview' | 'download-only';

/** Entry kinds mirror the storage schema without importing it. */
export type WorkspaceEntryKind = 'markdown' | 'asset';

export interface WorkspaceEntry {
  /** Normalized relative path within the workspace, e.g. `docs/notes.md`. */
  path: string;
  presentation: EntryPresentation;
  sizeLabel: string;
}

/** Literal status language from planning/web-authoring/00-web-presence.md. */
export type SaveState =
  | 'Saved on this device'
  | 'Saving…'
  | 'Storage needs attention'
  | 'Shared · Direct'
  | 'Shared · Encrypted relay'
  | 'Owner offline · Review still available';

export type SharingState = 'local-only' | 'shared' | 'backed-up';

export interface WorkspaceSummary {
  id: string;
  name: string;
  markdownCount: number;
  assetCount: number;
  lastEditedLabel: string;
  sharing: SharingState;
  sizeLabel: string;
  backupLabel: string;
  /** Entry to open when the workspace is selected from the desk. */
  openPath: string;
}

export interface ReviewCard {
  author: string;
  ageLabel: string;
  body: string;
}

export interface WorkspaceDetail extends WorkspaceSummary {
  entries: WorkspaceEntry[];
  saveState: SaveState;
  reviewCards: ReviewCard[];
}

/** Storage persistence modes surfaced in the desk header and storage page. */
export type PersistenceMode =
  | 'persistent'
  | 'best-effort'
  | 'session-only'
  | 'unavailable'
  | 'quota-pressure';

export interface StorageHealth {
  mode: PersistenceMode;
  usedLabel: string;
  quotaLabel: string;
  /** 0..1 fraction of quota used, for the meter. */
  usedFraction: number;
}

export interface ShareScope {
  kind: 'workspace' | 'current-file' | 'selected';
  markdownCount: number;
  assetCount: number;
  label: string;
}

/** A file handed to import (already read into memory by the picker). */
export interface ImportFileInput {
  path: string;
  bytes: Uint8Array;
  kind: WorkspaceEntryKind;
  mediaType?: string;
}

/**
 * Injected async view-service the shells render from (attn-7xl.3.2). The
 * mock implementation serves the `?shell=` scenarios; the storage-backed
 * adapter (real-service.ts) is the default and is loaded via dynamic import
 * so the app entry's static graph stays free of the crypto/storage modules.
 */
/**
 * A held writing session (attn-7xl.3.3): the real implementation owns the
 * cross-tab writer lease (heartbeating in the background) and performs
 * fenced, head-tracked durable commits. Release it when leaving edit mode.
 */
export interface EditingSession {
  commitText(path: string, text: string): Promise<void>;
  release(): Promise<void>;
}

export interface WorkspaceAppService {
  storageHealth(): StorageHealth;
  listWorkspaces(): Promise<WorkspaceSummary[]>;
  getWorkspace(workspaceId: string): Promise<WorkspaceDetail | undefined>;
  /** Decoded head body for a Markdown entry; null for assets. */
  readBodyText(workspaceId: string, path: string): Promise<string | null>;
  /** One-click create: untitled.md, no dialog, zero network requests. */
  createWorkspace(): Promise<WorkspaceDetail>;
  importFiles(name: string, files: ImportFileInput[]): Promise<WorkspaceDetail>;
  renameWorkspace(workspaceId: string, name: string): Promise<void>;
  deleteWorkspace(workspaceId: string): Promise<void>;
  /** Null when another tab holds the writer lease — stay read-only. */
  beginEditing(workspaceId: string): Promise<EditingSession | null>;
  shareScopeFor(workspace: WorkspaceDetail): ShareScope;
}
