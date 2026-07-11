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

/** Injected service the shells render from. The mock implementation is
 * synchronous fixture data; the storage-backed implementation keeps this
 * exact surface. */
export interface WorkspaceService {
  storageHealth(): StorageHealth;
  listWorkspaces(): WorkspaceSummary[];
  getWorkspace(workspaceId: string): WorkspaceDetail | undefined;
  /** The one-click landing intent: a fresh workspace holding `untitled.md`. */
  newWorkspaceDraft(): WorkspaceDetail;
  shareScopeFor(workspace: WorkspaceDetail): ShareScope;
}
