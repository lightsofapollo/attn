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
  kind: WorkspaceEntryKind;
  presentation: EntryPresentation;
  sizeBytes: number;
  sizeLabel: string;
  mediaType?: string;
}

/** Literal status language from planning/web-authoring/00-web-presence.md.
 *  Share status ("Shared · …") is no longer a save state — it lives in the
 *  ShareChip / masthead share control. */
export type SaveState =
  | 'Saved on this device'
  | 'Saving…'
  | 'Storage needs attention'
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

import type { CollabController } from '../../lib/prosemirror/collab-controller';
import type {
  BrowserOwnerWorkspaceAcceptInput,
  BrowserOwnerWorkspaceApplyInput,
  BrowserOwnerWorkspaceRejectInput,
  BrowserOwnerWorkspaceRuntimeState,
} from '../../lib/review/browser-owner-workspace-runtime';
import type {
  AcceptBrowserSuggestionResult,
  CommittedBrowserSuggestionResult,
  RejectBrowserSuggestionResult,
} from '../../lib/review/browser-review-actions';
import type { Anchor, ReviewEvent } from '../../lib/types';
export type WorkspaceShareMode = 'live' | 'async' | 'hybrid';
export type WorkspaceShareTtlMs = 3_600_000 | 86_400_000 | 604_800_000;

export interface WorkspaceShareTierInvite {
  tier: 'view' | 'comment' | 'suggest';
  browserUrl: string;
  nativeUrl: string;
  cliCommand: string;
}

export interface WorkspaceShareInvite {
  view: WorkspaceShareTierInvite;
  comment: WorkspaceShareTierInvite;
  suggest: WorkspaceShareTierInvite;
}

export interface WorkspaceShareView {
  workspaceId: string;
  capId: string;
  shareId: string;
  roomId: string;
  scopeKind: 'file' | 'entries' | 'workspace';
  paths: string[];
  publication: 'pending' | 'published' | 'stopped';
  mode: WorkspaceShareMode;
  expiresAt: number;
  expired: boolean;
  resumable: boolean;
  invite: WorkspaceShareInvite | null;
}

export type WorkspaceShareSelection =
  | { kind: 'file'; path: string }
  | { kind: 'entries'; paths: string[] }
  | { kind: 'workspace' };

export interface WorkspaceShareRequest {
  selection: WorkspaceShareSelection;
  mode: WorkspaceShareMode;
  ttlMs: WorkspaceShareTtlMs;
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
  getOwnerState(): BrowserOwnerWorkspaceRuntimeState;
  subscribeOwner(listener: (state: BrowserOwnerWorkspaceRuntimeState) => void): () => void;
  getController(): CollabController | null;
  getCollabSeed(path: string): Promise<{ fileId: string; epoch: string; markdown: string } | null>;
  acceptSuggestion(input: BrowserOwnerWorkspaceAcceptInput): Promise<AcceptBrowserSuggestionResult>;
  applySuggestion(input: BrowserOwnerWorkspaceApplyInput): Promise<CommittedBrowserSuggestionResult>;
  rejectSuggestion(input: BrowserOwnerWorkspaceRejectInput): Promise<RejectBrowserSuggestionResult>;
  replyToComment(anchor: Anchor, body: string, threadId: string): Promise<ReviewEvent>;
  resolveComment(threadId: string): Promise<ReviewEvent>;
  retryReviewOutbox(): Promise<void>;
  inspectShare(): Promise<WorkspaceShareView | null>;
  ensureShare(input: WorkspaceShareRequest): Promise<WorkspaceShareView>;
  stopShare(): Promise<void>;
  /** Leaves edit mode; the route-lifetime owner lease remains held. */
  release(): Promise<void>;
}

/**
 * Follower handle for local multi-tab live co-editing (attn-47r): a
 * reconnecting CollabClient wire to whichever tab currently hosts the
 * workspace's authorities. `status: 'live'` means a hub answered and the
 * controller is bound to its generation; every state change requires the
 * caller to rebind + reseed (generations never mix step logs).
 */
export interface LocalCollabJoinState {
  status: 'connecting' | 'live';
  generation: string | null;
  ownerHolderId: string | null;
}

export interface LocalCollabSeedView {
  fileId: string;
  epoch: string;
  markdown: string;
}

export interface LocalCollabJoinHandle {
  getState(): LocalCollabJoinState;
  subscribe(listener: (state: LocalCollabJoinState) => void): () => void;
  getController(): CollabController | null;
  getSeed(path: string): Promise<LocalCollabSeedView | null>;
  close(): void;
}

/**
 * A change another tab committed to shared local storage. `content` means a
 * document body changed (`path` when known); `structure` means the entry
 * list or workspace metadata changed (create/rename/delete/import).
 */
export interface WorkspaceChange {
  workspaceId: string;
  kind: 'content' | 'structure';
  path?: string;
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
  /**
   * Join local multi-tab co-editing as a follower (attn-47r). Returns a
   * reconnecting handle, or null when the environment can't support it —
   * the caller then falls back to the read-only follow mode.
   */
  joinLocalCollab(workspaceId: string): Promise<LocalCollabJoinHandle | null>;
  /**
   * Expiry (ms epoch) of another tab's live writer lease, or null when this
   * tab could acquire now. Lets a read-only tab wait on the exact takeover
   * deadline instead of polling blindly.
   */
  peekWriterLease(workspaceId: string): Promise<number | null>;
  /**
   * Seamless-editing doorbell: ask whichever live tab holds the writer
   * lease to flush + release it. Advisory (BroadcastChannel); pair with
   * `forceWriterLease` after a grace period for dead holders.
   */
  requestWriterHandoff(workspaceId: string, intent?: 'interaction' | 'focus'): Promise<void>;
  /**
   * Holder-side answer to a handoff request: flush and close this tab's
   * owner runtime so the lease frees for the requesting tab. No-op when
   * this tab is not the live owner.
   */
  yieldEditing(workspaceId: string): Promise<void>;
  /** Holder-side "yielding — hold on" broadcast answering a handoff request. */
  acknowledgeWriterHandoff(workspaceId: string): Promise<void>;
  /**
   * Forced lease takeover for seamless editing. Always safe (the fencing
   * token bump invalidates the previous holder's writes); call only after
   * a handoff request went unanswered so a live holder gets to flush first.
   */
  forceWriterLease(workspaceId: string): Promise<void>;
  /**
   * Advisory doorbell rung after OTHER tabs commit to shared local storage —
   * self-originated changes are never delivered. Re-read the workspace from
   * storage on delivery; the message itself carries no document content.
   */
  subscribeWorkspaceChanges(listener: (change: WorkspaceChange) => void): () => void;
  // ————— multi-file/asset operations (attn-7xl.3.4) —————
  createMarkdownEntry(workspaceId: string, path: string): Promise<void>;
  addAssetFiles(workspaceId: string, files: ImportFileInput[]): Promise<void>;
  renameEntry(workspaceId: string, fromPath: string, toPath: string): Promise<void>;
  deleteEntry(workspaceId: string, path: string): Promise<void>;
  /** Decrypted head bytes for preview/download; null when absent. */
  readEntryBytes(
    workspaceId: string,
    path: string,
  ): Promise<{ bytes: Uint8Array; mediaType?: string } | null>;
  /** Every live entry with exact bytes, for zip export / download-all. */
  exportWorkspace(workspaceId: string): Promise<ImportFileInput[]>;
  /** Record a successful backup (drives honest backup labels). */
  markBackedUp(workspaceId: string): Promise<void>;
  /** Ask the browser for persistent storage from a user gesture. */
  requestPersistence(): Promise<boolean | null>;
  /** Remembered E2EE review rooms in this profile (ids only, no secrets). */
  listRememberedRooms(): Promise<string[]>;
  /** Crypto-erase a remembered room: key first, then records. */
  forgetRoom(roomId: string): Promise<void>;
  /** Delete every local workspace (crypto-erasure per workspace). */
  clearAllWorkspaces(): Promise<number>;
  shareScopeFor(workspace: WorkspaceDetail): ShareScope;
}
