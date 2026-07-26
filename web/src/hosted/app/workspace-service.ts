// Browser workspace service (attn-7xl.3.1).
//
// The storage-backed implementation behind the local desk and editor shells:
// typed load/create/import/export/edit operations over BrowserStorage's
// workspace transactions (attn-7xl.2.x), plus capability probing and writer
// leases. Everything here is plain TypeScript so the whole surface runs under
// tsx in unit tests; the Svelte 5 reactive wrapper lives in
// workspace-state.svelte.ts and stays deliberately thin.
//
// Local-first invariant: nothing in this module performs a network request.
// Rooms, relays, and Share belong to attn-7xl.4.

import {
  BrowserStorage,
  BrowserStorageError,
  StorageConflictError,
  type BrowserStorageNavigator,
} from '../../lib/review/browser-storage';
import type { WorkspaceLeaseManager } from '../../lib/review/browser-workspace-lease';
import {
  probeStorageCapabilities,
  toPersistenceMode,
  type StorageCapabilities,
} from '../../lib/review/browser-storage-probe';
import type {
  CommittedRevision,
  WorkspaceFence,
} from '../../lib/review/browser-workspace-store';
import type {
  WorkspaceEntryKind,
  WorkspaceEntryRecord,
  WorkspaceRecord,
} from '../../lib/review/browser-workspace-schema';
import type { PersistenceMode, ReviewProjectionHandle, WorkspaceSummary } from './types';
import { readStoredColor } from '../../lib/browser-profile';
import { resolveParticipantColor } from '../../lib/participant-color';
// Runes module: loaded lazily so node-side tests can import this file
// (top-level $state would throw outside Svelte compilation). The getter
// falls back to undefined until the module resolves — announce paths then
// use their role-label fallback, and the rename re-announce always runs
// long after load.
let profileModule: typeof import('../../lib/profile.svelte') | null = null;
void import('../../lib/profile.svelte')
  .then((m) => {
    profileModule = m;
  })
  .catch(() => {});

import {
  BrowserOwnerWorkspaceRuntime,
  type BrowserOwnerWorkspaceRuntimeOptions,
} from '../../lib/review/browser-owner-workspace-runtime';
import { openWorkspaceReviewProjection } from '../../lib/review/browser-review-log';

export type WorkspaceErrorKind = 'conflict' | 'quota' | 'unavailable' | 'storage';

export interface WorkspaceServiceError {
  kind: WorkspaceErrorKind;
  message: string;
}

/** Typed failure whose `info` maps directly onto user-visible states. */
export class WorkspaceServiceFailure extends Error {
  readonly info: WorkspaceServiceError;

  constructor(info: WorkspaceServiceError) {
    super(info.message);
    this.name = 'WorkspaceServiceFailure';
    this.info = info;
  }
}

export interface LoadedWorkspace {
  workspace: WorkspaceRecord;
  entries: WorkspaceEntryRecord[];
}

export interface WorkspaceFileInput {
  path: string;
  bytes: Uint8Array;
  kind: WorkspaceEntryKind;
  mediaType?: string;
}

export interface BrowserWorkspaceServiceOptions {
  databaseName?: string;
  indexedDB?: IDBFactory;
  crypto?: Crypto;
  navigator?: BrowserStorageNavigator | null;
  now?: () => number;
  requestPersist?: boolean;
}

const UNTITLED_PATH = 'untitled.md';

export class BrowserWorkspaceService {
  private readonly storage: BrowserStorage;
  private readonly leaseManager: WorkspaceLeaseManager;
  private capabilitiesSnapshot: StorageCapabilities;
  private readonly probeOptions: BrowserWorkspaceServiceOptions;
  private readonly ownerRuntimes = new Map<string, BrowserOwnerWorkspaceRuntime>();

  private constructor(
    storage: BrowserStorage,
    capabilities: StorageCapabilities,
    options: BrowserWorkspaceServiceOptions,
  ) {
    this.storage = storage;
    this.leaseManager = storage.leases();
    this.capabilitiesSnapshot = capabilities;
    this.probeOptions = options;
  }

  static async open(
    options: BrowserWorkspaceServiceOptions = {},
  ): Promise<BrowserWorkspaceService> {
    const capabilities = await probeStorageCapabilities({
      indexedDB: options.indexedDB,
      crypto: options.crypto,
      navigator: options.navigator,
      requestPersist: options.requestPersist,
    });
    if (!capabilities.indexedDb.ok || !capabilities.cryptoKeyClone.ok) {
      throw new WorkspaceServiceFailure({
        kind: 'unavailable',
        message: 'This browser currently blocks local document storage.',
      });
    }
    const storage = await BrowserStorage.open({
      createIfMissing: true,
      databaseName: options.databaseName,
      indexedDB: options.indexedDB,
      crypto: options.crypto,
      navigator: options.navigator,
      now: options.now,
    }).catch((error) => {
      throw mapError(error);
    });
    return new BrowserWorkspaceService(storage, capabilities, options);
  }

  close(): void {
    const closing = [...this.ownerRuntimes.values()].map((runtime) => runtime.close());
    this.ownerRuntimes.clear();
    void Promise.allSettled(closing).finally(() => {
      this.leaseManager.close();
      this.storage.close();
    });
  }

  /** Route-lifetime owner coordinator; BrowserStorage remains encapsulated. */
  async beginOwnerRuntime(
    workspaceId: string,
    holderId: string,
    options: Partial<Pick<
      BrowserOwnerWorkspaceRuntimeOptions,
      'collab' | 'sessionOptions' | 'heartbeatIntervalMs' | 'onState'
    >> = {},
  ): Promise<BrowserOwnerWorkspaceRuntime> {
    const existing = this.ownerRuntimes.get(workspaceId);
    if (existing && existing.getState().status !== 'closed' && !existing.isClosing()) {
      const state = existing.getState();
      // A cached runtime whose lease expired (or that errored) is a husk —
      // it never re-acquires on its own, and returning it made every
      // "Retry edit" a no-op (attn-d6ai). Close it and build one that
      // actually re-attempts the lease. Healthy owner runtimes (including
      // paused-but-lease-holding rollover states) are returned untouched.
      if (state.leaseRole === 'owner' && state.status !== 'error') {
        return existing;
      }
      await existing.close();
    }
    // A runtime mid-close (seamless lease yield) must finish tearing down
    // before a fresh one claims — otherwise the caller gets a zombie whose
    // lease is being released out from under it.
    if (existing && existing.isClosing()) await existing.close();
    const runtime = new BrowserOwnerWorkspaceRuntime({
      storage: this.storage,
      workspaceId,
      holderId,
      collab: options.collab ?? {
        selfClientId: holderId,
        // Broadcast to peers — remote carets render this label, so it must
        // name this participant from THEIR perspective, never "You".
        selfLabel: 'Owner',
        // Personal identity color (attn-3gdd): picked color first. The
        // participant id isn't known until credentials exist, so the hash
        // fallback here is provisional — EditorShell re-syncs the live
        // controller via setSelfColor once the room's owner id is known.
        selfColor: resolveParticipantColor('', readStoredColor(), 'owner'),
      },
      // The announce path reads the LIVE profile (rename/repick re-announce),
      // so the getters must always be present; explicit options still win.
      sessionOptions: {
        getDisplayName: () => profileModule?.userProfile.effectiveName,
        getColor: () => profileModule?.userProfile.color ?? readStoredColor(),
        ...(options.sessionOptions ?? {}),
      },
      ...(options.heartbeatIntervalMs === undefined
        ? {}
        : { heartbeatIntervalMs: options.heartbeatIntervalMs }),
      ...(options.onState === undefined ? {} : { onState: options.onState }),
      // Local documents never wait on relay room bootstrap/recovery. The
      // runtime upgrades this fenced local session to the published authority
      // in the background and reports failures through its existing banner.
      backgroundShareResume: true,
    });
    this.ownerRuntimes.set(workspaceId, runtime);
    await runtime.start();
    return runtime;
  }

  /**
   * Graceful lease yield for seamless multi-tab editing: close this tab's
   * owner runtime (flushes local collab + share republish, releases the
   * lease, broadcasts 'released') so the requesting tab can acquire
   * immediately. The closed runtime stays in the cache; beginOwnerRuntime
   * re-creates on the next claim because its status is 'closed'.
   */
  async yieldOwnerRuntime(workspaceId: string): Promise<void> {
    const runtime = this.ownerRuntimes.get(workspaceId);
    if (!runtime || runtime.getState().status === 'closed') return;
    if (runtime.getState().leaseRole !== 'owner') return;
    await runtime.close();
  }

  /**
   * Hydrate this tab's review store from the workspace's durable inbound
   * log and keep it fresh on the cross-tab review doorbell, so every tab
   * shows the same comment threads regardless of which tab holds the
   * writer lease (attn-dgya). No-ops (still returning a disposer) when
   * the workspace has no active published share. Reads only — safe for
   * passive tabs that never acquire the lease.
   */
  async openReviewProjection(workspaceId: string): Promise<ReviewProjectionHandle> {
    return openWorkspaceReviewProjection({ storage: this.storage, workspaceId });
  }

  // ————— capabilities —————

  capabilities(): StorageCapabilities {
    return this.capabilitiesSnapshot;
  }

  persistenceMode(): PersistenceMode {
    return toPersistenceMode(this.capabilitiesSnapshot);
  }

  async refreshCapabilities(): Promise<StorageCapabilities> {
    this.capabilitiesSnapshot = await probeStorageCapabilities({
      indexedDB: this.probeOptions.indexedDB,
      crypto: this.probeOptions.crypto,
      navigator: this.probeOptions.navigator,
    });
    return this.capabilitiesSnapshot;
  }

  // ————— reads —————

  async listWorkspaces(now = Date.now()): Promise<WorkspaceSummary[]> {
    return run(async () => {
      const workspaces = await this.storage.workspaces.listWorkspaces();
      const summaries: WorkspaceSummary[] = [];
      for (const workspace of workspaces) {
        const entries = await this.storage.workspaces.listEntries(workspace.workspaceId);
        const sharing = await this.hasActivePublishedShare(workspace.workspaceId)
          ? 'shared'
          : 'local-only';
        summaries.push(toSummary(workspace, entries, now, sharing));
      }
      return summaries;
    });
  }

  private async hasActivePublishedShare(workspaceId: string): Promise<boolean> {
    const rootKey = await this.storage.getWorkspaceRootKey(workspaceId);
    if (!rootKey) return false;
    for (const share of await this.storage.shares.listShares(workspaceId)) {
      if (share.publication === 'stopped') continue;
      const capability = await this.storage.shares.openShare(rootKey, workspaceId, share.capId);
      if (capability.publishedManifest) return true;
    }
    return false;
  }

  async loadWorkspace(workspaceId: string): Promise<LoadedWorkspace | null> {
    return run(async () => {
      const workspace = await this.storage.workspaces.getWorkspace(workspaceId);
      if (!workspace) return null;
      const entries = await this.storage.workspaces.listEntries(workspaceId);
      return { workspace, entries };
    });
  }

  async readHeadText(workspaceId: string, path: string): Promise<string> {
    return run(async () => {
      const bytes = await this.storage.workspaces.getHeadBody(workspaceId, path);
      try {
        return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
      } finally {
        bytes.fill(0);
      }
    });
  }

  async readHeadBytes(workspaceId: string, path: string): Promise<Uint8Array> {
    return run(() => this.storage.workspaces.getHeadBody(workspaceId, path));
  }

  // ————— mutations —————

  /** One-click create: `untitled.md`, no dialog, zero network requests. */
  async createWorkspace(name = 'Untitled'): Promise<CommittedRevision> {
    return run(() =>
      this.storage.workspaces.createWorkspace({
        name,
        storagePersisted: this.capabilitiesSnapshot.persisted === true,
        entry: { path: UNTITLED_PATH, kind: 'markdown', body: new Uint8Array(0) },
      }),
    );
  }

  async importWorkspace(name: string, files: WorkspaceFileInput[]): Promise<LoadedWorkspace> {
    if (files.length === 0) {
      throw new WorkspaceServiceFailure({
        kind: 'storage',
        message: 'Nothing to import: no files were selected.',
      });
    }
    return run(async () => {
      const [first, ...rest] = files;
      const created = await this.storage.workspaces.createWorkspace({
        name,
        storagePersisted: this.capabilitiesSnapshot.persisted === true,
        entry: {
          path: first!.path,
          kind: first!.kind,
          ...(first!.mediaType === undefined ? {} : { mediaType: first!.mediaType }),
          body: first!.bytes,
        },
      });
      const workspaceId = created.workspace.workspaceId;
      for (const file of rest) {
        await this.storage.workspaces.createEntry({
          workspaceId,
          path: file.path,
          kind: file.kind,
          ...(file.mediaType === undefined ? {} : { mediaType: file.mediaType }),
          body: file.bytes,
        });
      }
      // Open on the first Markdown entry: an import that happens to lead
      // with an asset should still land the reader in prose.
      const firstMarkdown = files.find((file) => file.kind === 'markdown');
      if (firstMarkdown && firstMarkdown.path !== first!.path) {
        await this.storage.workspaces.selectEntry({ workspaceId, path: firstMarkdown.path });
      }
      const loaded = await this.loadWorkspace(workspaceId);
      if (!loaded) throw new BrowserStorageError('imported workspace vanished');
      return loaded;
    });
  }

  async commitText(
    workspaceId: string,
    path: string,
    text: string,
    options: { expectedHeadRevisionId?: string; fence?: WorkspaceFence } = {},
  ): Promise<CommittedRevision> {
    return run(() =>
      this.storage.workspaces.commitRevision({
        workspaceId,
        path,
        body: new TextEncoder().encode(text),
        ...options,
      }),
    );
  }

  async createMarkdown(
    workspaceId: string,
    path: string,
    text = '',
    fence?: WorkspaceFence,
  ): Promise<CommittedRevision> {
    return run(() =>
      this.storage.workspaces.createEntry({
        workspaceId,
        path,
        kind: 'markdown',
        body: new TextEncoder().encode(text),
        ...(fence === undefined ? {} : { fence }),
      }),
    );
  }

  async addAsset(
    workspaceId: string,
    path: string,
    bytes: Uint8Array,
    mediaType: string | undefined,
    fence?: WorkspaceFence,
  ): Promise<CommittedRevision> {
    return run(() =>
      this.storage.workspaces.createEntry({
        workspaceId,
        path,
        kind: 'asset',
        ...(mediaType === undefined ? {} : { mediaType }),
        body: bytes,
        ...(fence === undefined ? {} : { fence }),
      }),
    );
  }

  async renameEntry(
    workspaceId: string,
    fromPath: string,
    toPath: string,
    fence?: WorkspaceFence,
  ): Promise<CommittedRevision> {
    return run(() =>
      this.storage.workspaces.renameEntry({
        workspaceId,
        fromPath,
        toPath,
        ...(fence === undefined ? {} : { fence }),
      }),
    );
  }

  async deleteEntry(workspaceId: string, path: string, fence?: WorkspaceFence): Promise<void> {
    await run(() =>
      this.storage.workspaces.deleteEntry({
        workspaceId,
        path,
        ...(fence === undefined ? {} : { fence }),
      }),
    );
  }

  async selectEntry(workspaceId: string, path: string): Promise<WorkspaceRecord> {
    return run(() => this.storage.workspaces.selectEntry({ workspaceId, path }));
  }

  async renameWorkspace(
    workspaceId: string,
    name: string,
    fence?: WorkspaceFence,
  ): Promise<WorkspaceRecord> {
    return run(() =>
      this.storage.workspaces.renameWorkspace({
        workspaceId,
        name,
        ...(fence === undefined ? {} : { fence }),
      }),
    );
  }

  async deleteWorkspace(workspaceId: string): Promise<boolean> {
    return run(() => this.storage.workspaces.deleteWorkspace(workspaceId));
  }

  async markBackedUp(workspaceId: string): Promise<void> {
    await run(() => this.storage.workspaces.markBackedUp(workspaceId));
  }

  async requestPersistence(): Promise<boolean | null> {
    const result = await this.storage.requestPersistence();
    await this.refreshCapabilities().catch(() => undefined);
    return result;
  }

  async listRememberedRooms(): Promise<string[]> {
    return run(() => this.storage.listRoomIds());
  }

  /** Crypto-erasure: BrowserStorage.forgetRoom deletes the room key first. */
  async forgetRoom(roomId: string): Promise<void> {
    await run(() => this.storage.forgetRoom(roomId));
  }

  async clearAllWorkspaces(): Promise<number> {
    return run(async () => {
      const workspaces = await this.storage.workspaces.listWorkspaces();
      let cleared = 0;
      for (const workspace of workspaces) {
        if (await this.storage.workspaces.deleteWorkspace(workspace.workspaceId)) cleared += 1;
      }
      return cleared;
    });
  }

  // ————— export —————

  async exportWorkspace(workspaceId: string): Promise<WorkspaceFileInput[]> {
    return run(async () => {
      const entries = await this.storage.workspaces.listEntries(workspaceId);
      const files: WorkspaceFileInput[] = [];
      for (const entry of entries) {
        files.push({
          path: entry.path,
          bytes: await this.storage.workspaces.getHeadBody(workspaceId, entry.path),
          kind: entry.kind,
          ...(entry.mediaType === undefined ? {} : { mediaType: entry.mediaType }),
        });
      }
      return files;
    });
  }

  // ————— leases —————

  get leases(): WorkspaceLeaseManager {
    return this.leaseManager;
  }
}

// ————— error mapping —————

export function mapError(error: unknown): WorkspaceServiceFailure {
  if (error instanceof WorkspaceServiceFailure) return error;
  if (error instanceof StorageConflictError) {
    return new WorkspaceServiceFailure({ kind: 'conflict', message: error.message });
  }
  if (error instanceof DOMException && error.name === 'QuotaExceededError') {
    return new WorkspaceServiceFailure({
      kind: 'quota',
      message: 'Storage is nearly full. New edits are paused.',
    });
  }
  if (error instanceof BrowserStorageError) {
    return new WorkspaceServiceFailure({ kind: 'storage', message: error.message });
  }
  return new WorkspaceServiceFailure({
    kind: 'storage',
    message: error instanceof Error ? error.message : String(error),
  });
}

async function run<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw mapError(error);
  }
}

// ————— UI label shaping (pure, unit-tested) —————

export function toSummary(
  workspace: WorkspaceRecord,
  entries: WorkspaceEntryRecord[],
  now: number,
  sharing: WorkspaceSummary['sharing'] = 'local-only',
): WorkspaceSummary {
  const markdownCount = entries.filter((entry) => entry.kind === 'markdown').length;
  const totalBytes = entries.reduce((sum, entry) => sum + entry.sizeBytes, 0);
  return {
    id: workspace.workspaceId,
    name: workspace.name,
    markdownCount,
    assetCount: entries.length - markdownCount,
    lastEditedLabel: relativeTimeLabel(workspace.updatedAt, now),
    sharing,
    sizeLabel: sizeLabel(totalBytes),
    backupLabel: backupLabel(workspace.lastBackupAt, now),
    openPath: workspace.activePath ?? entries[0]?.path ?? UNTITLED_PATH,
  };
}

export function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function backupLabel(lastBackupAt: number | undefined, now: number): string {
  if (lastBackupAt === undefined) return 'Never backed up';
  const elapsed = Math.max(0, now - lastBackupAt);
  const hour = 3_600_000;
  if (elapsed < hour) return 'Backed up just now';
  if (elapsed < 24 * hour) return `Backed up ${Math.floor(elapsed / hour)} h ago`;
  return `Backed up ${new Date(lastBackupAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
}

export function relativeTimeLabel(at: number, now: number): string {
  const elapsed = Math.max(0, now - at);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (elapsed < minute) return 'Just now';
  if (elapsed < hour) return `Edited ${Math.floor(elapsed / minute)} min ago`;
  if (elapsed < day) return `Edited ${Math.floor(elapsed / hour)} h ago`;
  if (elapsed < 2 * day) return 'Yesterday';
  return new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
