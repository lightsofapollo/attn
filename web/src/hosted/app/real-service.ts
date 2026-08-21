// Storage-backed WorkspaceAppService adapter (attn-7xl.3.2).
//
// Maps BrowserWorkspaceService (attn-7xl.3.1) onto the view contract the
// shells render. This module pulls the crypto/storage graph, so the app
// entry loads it via dynamic import only — the route bundle gate forbids it
// from the static graph.

import { publishDeskCount, readDeskCount } from '../desk-count';
import { SAVE_STATE_AUTOSAVED } from '../../lib/save-state-copy';
import type {
  EditingSession,
  ImportFileInput,
  LocalCollabJoinHandle,
  PersistenceMode,
  ReviewProjectionHandle,
  ShareScope,
  StorageHealth,
  WorkspaceAppService,
  WorkspaceChange,
  WorkspaceDetail,
  WorkspaceEntry,
  WorkspaceSummary,
} from './types';
import {
  BrowserWorkspaceService,
  sizeLabel,
  type BrowserWorkspaceServiceOptions,
} from './workspace-service';
import { quotaPressure } from '../../lib/review/browser-storage-probe';
import { readStoredColor, readStoredDisplayName } from '../../lib/browser-profile';
import { resolveParticipantColor } from '../../lib/participant-color';
import { resolveBrowserRelayUrl } from '../../lib/review/browser-relay-url';
import { resolveBrowserReviewBase } from './share-environment';
import type { WorkspaceEntryRecord } from '../../lib/review/browser-workspace-schema';
import type { WorkspaceFence } from '../../lib/review/browser-workspace-store';
import { LEASE_CHANNEL_NAME, openBroadcastChannel } from '../../lib/tab-channels';
import type { LeaseHandle } from '../../lib/review/browser-workspace-lease';

/** Safe raster types that may render inline (epic scope note 2026-07-10). */
const INLINE_SAFE_MEDIA = /^image\/(?:png|jpeg|gif|webp|avif)$/iu;
const HTML_MEDIA = /^text\/html(?:;\s*charset=[^;]+)?$/iu;

/**
 * Read-time migration for pre-z64t uploads. Their sealed bytes remain intact;
 * only the local view interpretation changes, avoiding an expensive rewrite
 * of every encrypted revision just to promote text/html from "asset".
 */
function isHtmlRecord(entry: WorkspaceEntryRecord): boolean {
  return entry.kind === 'html' || (entry.kind === 'asset' && HTML_MEDIA.test(entry.mediaType ?? ''));
}

const TAB_HOLDER_STORAGE_KEY = 'attn:browser-tab-holder:v1';
const TAB_IDENTITY_CHANNEL = 'attn:browser-tab-identity:v1';
const TAB_IDENTITY_PROBE_MS = 75;
const WORKSPACE_CHANGE_CHANNEL = 'attn:workspace-changes:v1';

type WorkspaceChangeMessage = WorkspaceChange & { senderId: string };

type TabIdentityMessage =
  | { type: 'probe'; holderId: string; probeId: string }
  | { type: 'present'; holderId: string; probeId: string };

let tabHolderPromise: Promise<string> | null = null;
let tabHolderId: string | null = null;
let tabIdentityChannel: BroadcastChannel | null = null;

function randomHolderId(): string {
  const holder = new Uint8Array(9);
  crypto.getRandomValues(holder);
  return `tab-${Array.from(holder, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Keep the writer identity stable across a reload in one browsing context.
 *
 * `sessionStorage` has exactly the lifetime we need, but browsers copy it
 * when a tab is duplicated or opened by another same-origin tab. The small
 * BroadcastChannel probe detects that live copy and rotates the new tab's
 * identity before either page asks IndexedDB for the fenced writer lease.
 */
async function browserTabHolderId(): Promise<string> {
  if (tabHolderId) return tabHolderId;
  if (tabHolderPromise) return tabHolderPromise;

  tabHolderPromise = (async () => {
    let candidate = randomHolderId();
    try {
      candidate = sessionStorage.getItem(TAB_HOLDER_STORAGE_KEY) ?? candidate;
    } catch {
      // IndexedDB may still be available when sessionStorage is restricted.
    }

    if (typeof BroadcastChannel !== 'undefined') {
      try {
        const channel = new BroadcastChannel(TAB_IDENTITY_CHANNEL);
        tabIdentityChannel = channel;
        const probeId = crypto.randomUUID();
        let copiedFromLiveTab = false;

        channel.addEventListener('message', (event: MessageEvent<TabIdentityMessage>) => {
          const message = event.data;
          if (!message || message.holderId !== tabHolderId) return;
          if (message.type === 'probe') {
            channel.postMessage({
              type: 'present',
              holderId: tabHolderId,
              probeId: message.probeId,
            } satisfies TabIdentityMessage);
          }
        });
        const detectCopy = (event: MessageEvent<TabIdentityMessage>): void => {
          const message = event.data;
          if (
            message?.type === 'present'
            && message.holderId === candidate
            && message.probeId === probeId
          ) copiedFromLiveTab = true;
        };
        channel.addEventListener('message', detectCopy);
        channel.postMessage({ type: 'probe', holderId: candidate, probeId } satisfies TabIdentityMessage);
        await new Promise((resolve) => window.setTimeout(resolve, TAB_IDENTITY_PROBE_MS));
        channel.removeEventListener('message', detectCopy);
        if (copiedFromLiveTab) candidate = randomHolderId();

        window.addEventListener('pagehide', () => {
          channel.close();
          if (tabIdentityChannel === channel) tabIdentityChannel = null;
        }, { once: true });
      } catch {
        // BroadcastChannel can be policy-disabled even when the constructor
        // exists. The probe is UX-only: even an undetected duplicate cannot
        // co-write, because the lease manager treats a same-holder acquire
        // from another JS context as a token-bumping takeover.
        tabIdentityChannel?.close();
        tabIdentityChannel = null;
      }
    }

    try {
      sessionStorage.setItem(TAB_HOLDER_STORAGE_KEY, candidate);
    } catch {
      // Best-effort stability; the fenced lease remains safe without it.
    }
    tabHolderId = candidate;
    return candidate;
  })();

  return tabHolderPromise;
}

export class RealWorkspaceAppService implements WorkspaceAppService {
  private readonly service: BrowserWorkspaceService;
  // One shared instance for both posting and listening: a BroadcastChannel
  // never delivers a message back to the instance that posted it, so this
  // tab's own commits never echo into its subscribers.
  private readonly changeChannel: BroadcastChannel | null;

  private constructor(service: BrowserWorkspaceService) {
    this.service = service;
    this.changeChannel = openBroadcastChannel(WORKSPACE_CHANGE_CHANNEL);
  }

  /** Ring the cross-tab doorbell after a durable mutation. Advisory only. */
  private announce(change: WorkspaceChange): void {
    try {
      this.changeChannel?.postMessage({
        ...change,
        senderId: tabHolderId ?? '',
      } satisfies WorkspaceChangeMessage);
    } catch {
      // Followers fall back to their next storage read; never fail the write.
    }
  }

  subscribeWorkspaceChanges(listener: (change: WorkspaceChange) => void): () => void {
    const channel = this.changeChannel;
    if (!channel) return () => undefined;
    const onMessage = (event: MessageEvent): void => {
      const message = event.data as Partial<WorkspaceChangeMessage> | null;
      if (!message || typeof message.workspaceId !== 'string') return;
      if (
        message.kind !== 'content'
        && message.kind !== 'structure'
        && message.kind !== 'review'
      ) return;
      if (message.senderId === tabHolderId) return;
      listener({
        workspaceId: message.workspaceId,
        kind: message.kind,
        ...(typeof message.path === 'string' ? { path: message.path } : {}),
      });
    };
    channel.addEventListener('message', onMessage);
    return () => channel.removeEventListener('message', onMessage);
  }

  /** attn-whdh: the single review projection, any lease role. */
  async openReviewProjection(workspaceId: string): Promise<ReviewProjectionHandle> {
    return this.service.openReviewProjection(workspaceId);
  }

  announceReviewActivity(workspaceId: string): void {
    this.announce({ workspaceId, kind: 'review' });
  }

  static async open(options: BrowserWorkspaceServiceOptions = {}): Promise<RealWorkspaceAppService> {
    // Establish the browsing-context identity while the shell opens, not only
    // on the first edit. That lets an idle desk tab answer a later duplicate's
    // collision probe before either one attempts to become the writer.
    const [service] = await Promise.all([
      BrowserWorkspaceService.open(options),
      browserTabHolderId(),
    ]);
    return new RealWorkspaceAppService(service);
  }

  close(): void {
    this.changeChannel?.close();
    this.service.close();
  }

  storageHealth(): StorageHealth {
    const capabilities = this.service.capabilities();
    const estimate = capabilities.estimate;
    const usage = estimate?.usage;
    const quota = estimate?.quota;
    const mode: PersistenceMode = this.service.persistenceMode();
    return {
      mode,
      usedLabel: usage === undefined ? '—' : sizeLabel(usage),
      quotaLabel: quota === undefined ? 'unknown' : sizeLabel(quota),
      usedFraction:
        usage !== undefined && quota !== undefined && quota > 0
          ? Math.min(1, usage / quota)
          : quotaPressure(estimate)
            ? 1
            : 0,
    };
  }

  async listWorkspaces(): Promise<WorkspaceSummary[]> {
    const summaries = await this.service.listWorkspaces();
    publishDeskCount(summaries.length);
    return Promise.all(summaries.map(async (summary) => this.withReviewCounts(summary)));
  }

  /**
   * Attach review counts to a shared workspace's row (attn-n01r.34).
   *
   * Bounded on purpose. Only workspaces whose sharing state is 'shared' are
   * touched: a local-only workspace has no review log, discoverReviewLogRoom
   * returns null for it, and paying a replay per row would make listing cost
   * scale with the desk rather than with the work actually waiting.
   *
   * Failure is swallowed and the row simply carries no counts. A desk that
   * cannot render because a review log is unreadable is worse than a desk
   * that renders without a badge.
   */
  private async withReviewCounts(summary: WorkspaceSummary): Promise<WorkspaceSummary> {
    if (summary.sharing !== 'shared') return summary;
    try {
      const review = await this.service.reviewCountsFor(summary.id);
      return review ? { ...summary, review } : summary;
    } catch {
      return summary;
    }
  }

  async getWorkspace(workspaceId: string): Promise<WorkspaceDetail | undefined> {
    const loaded = await this.service.loadWorkspace(workspaceId);
    if (!loaded) return undefined;
    const summaries = await this.service.listWorkspaces();
    const summary = summaries.find((candidate) => candidate.id === workspaceId);
    return {
      ...(summary ?? {
        id: workspaceId,
        name: loaded.workspace.name,
        markdownCount: 0,
        htmlCount: 0,
        assetCount: 0,
        lastEditedLabel: 'Just now',
        sharing: 'local-only' as const,
        sizeLabel: '—',
        backupLabel: 'Never backed up',
        openPath: loaded.workspace.activePath ?? 'untitled.md',
      }),
      entries: loaded.entries.map(toViewEntry),
      saveState: SAVE_STATE_AUTOSAVED,
      reviewCards: [],
    };
  }

  async readBodyText(workspaceId: string, path: string): Promise<string | null> {
    const loaded = await this.service.loadWorkspace(workspaceId);
    const entry = loaded?.entries.find((candidate) => candidate.path === path);
    if (!entry || (entry.kind !== 'markdown' && !isHtmlRecord(entry))) return null;
    return this.service.readHeadText(workspaceId, path);
  }

  async createWorkspace(): Promise<WorkspaceDetail> {
    const created = await this.service.createWorkspace();
    const detail = await this.getWorkspace(created.workspace.workspaceId);
    if (!detail) throw new Error('created workspace vanished');
    publishDeskCount(readDeskCount() + 1);
    return detail;
  }

  async importFiles(name: string, files: ImportFileInput[]): Promise<WorkspaceDetail> {
    const imported = await this.service.importWorkspace(name, files);
    const detail = await this.getWorkspace(imported.workspace.workspaceId);
    if (!detail) throw new Error('imported workspace vanished');
    return detail;
  }

  async renameWorkspace(workspaceId: string, name: string): Promise<void> {
    await this.withWorkspaceFence(workspaceId, (fence) =>
      this.service.renameWorkspace(workspaceId, name, fence),
    );
    this.announce({ workspaceId, kind: 'structure' });
  }

  async deleteWorkspace(workspaceId: string): Promise<void> {
    publishDeskCount(Math.max(0, readDeskCount() - 1));
    await this.service.deleteWorkspace(workspaceId);
  }

  async joinLocalCollab(workspaceId: string): Promise<LocalCollabJoinHandle | null> {
    const holderId = await browserTabHolderId();
    const { LocalCollabJoin } = await import('../../lib/review/browser-local-collab');
    const join = new LocalCollabJoin({
      workspaceId,
      holderId,
      selfLabel: 'Another tab',
      // Same user, same identity color (attn-3gdd) — a passive tab's caret
      // should not read as a different person than the leader tab's.
      selfColor: resolveParticipantColor('', readStoredColor(), 'owner'),
    });
    if (!join.available) {
      join.close();
      return null;
    }
    return join;
  }

  async peekWriterLease(workspaceId: string): Promise<number | null> {
    const holderId = await browserTabHolderId();
    const record = await this.service.leases.current(workspaceId);
    if (!record || record.holderId === holderId || record.expiresAt <= Date.now()) return null;
    return record.expiresAt;
  }

  async yieldEditing(workspaceId: string): Promise<void> {
    await this.service.yieldOwnerRuntime(workspaceId);
  }

  async closeEditingRuntime(workspaceId: string): Promise<void> {
    await this.service.closeOwnerRuntime(workspaceId);
  }

  async requestWriterHandoff(
    workspaceId: string,
    intent: 'interaction' | 'focus' = 'interaction',
  ): Promise<void> {
    const holderId = await browserTabHolderId();
    this.service.leases.requestHandoff(workspaceId, holderId, intent);
  }

  async acknowledgeWriterHandoff(workspaceId: string): Promise<void> {
    const holderId = await browserTabHolderId();
    this.service.leases.acknowledgeHandoff(workspaceId, holderId);
  }

  async forceWriterLease(workspaceId: string): Promise<void> {
    const holderId = await browserTabHolderId();
    await this.service.leases.takeover(workspaceId, holderId);
  }

  /**
   * Seamless lease claim (user feedback: the "Another tab is editing" wall
   * must never appear). Try a polite acquire; when another live tab holds
   * the lease, ring the handoff doorbell and give the holder a short grace
   * to flush + release (the 'released' broadcast resolves the wait early);
   * a holder that never answers — crashed or suspended — is fenced off by
   * a forced takeover. Editing follows the tab the user is acting in.
   */
  private async acquireLeaseSeamlessly(
    workspaceId: string,
    holderId: string,
    graceMs = 1_500,
  ): Promise<LeaseHandle> {
    const leases = this.service.leases;
    const first = await leases.acquire(workspaceId, holderId);
    if (first) return first;
    leases.requestHandoff(workspaceId, holderId);
    const released = new Promise<void>((resolve) => {
      const channel = openBroadcastChannel(LEASE_CHANNEL_NAME);
      if (!channel) {
        resolve();
        return;
      }
      let timer: ReturnType<typeof setTimeout>;
      const finish = (): void => {
        clearTimeout(timer);
        channel.close();
        resolve();
      };
      timer = setTimeout(finish, graceMs);
      channel.onmessage = (event: MessageEvent) => {
        const message = event.data as { workspaceId?: string; event?: string } | null;
        if (message?.workspaceId !== workspaceId) return;
        if (message.event === 'handoff-ack') {
          // The holder is flushing — big documents outlast the short grace,
          // so extend the wait rather than fencing off its final commit.
          clearTimeout(timer);
          timer = setTimeout(finish, 10_000);
          return;
        }
        if (message.event === 'released') finish();
      };
    });
    await released;
    const second = await leases.acquire(workspaceId, holderId);
    if (second) return second;
    return leases.takeover(workspaceId, holderId);
  }

  async beginEditing(workspaceId: string): Promise<EditingSession | null> {
    const holderId = await browserTabHolderId();
    const runtime = await this.service.beginOwnerRuntime(workspaceId, holderId);
    if (runtime.getState().leaseRole !== 'owner') {
      await runtime.close();
      return null;
    }
    const announce = (change: WorkspaceChange): void => this.announce(change);
    return {
      async commitText(path: string, text: string): Promise<void> {
        // The runtime serializes this with accepted suggestions and authority
        // rollovers. Let that single fenced queue choose the current head;
        // a UI-side cached CAS becomes stale immediately after either path.
        await runtime.commit({
          path,
          body: new TextEncoder().encode(text),
        });
        announce({ workspaceId, kind: 'content', path });
      },
      getOwnerState: () => runtime.getState(),
      subscribeOwner: (listener) => runtime.subscribe(listener),
      getController: () => runtime.controller,
      getCollabSeed: (path) => runtime.getCollabSeed(path),
      acceptSuggestion: async (input) => {
        const result = await runtime.accept(input);
        announce({ workspaceId, kind: 'content', path: input.path });
        return result;
      },
      applySuggestion: async (input) => {
        const result = await runtime.applySuggestion(input);
        announce({ workspaceId, kind: 'content', path: input.path });
        return result;
      },
      rejectSuggestion: (input) => runtime.reject(input),
      createComment: (anchor, body) => runtime.createComment(anchor, body),
      announceProfile: () => runtime.announceProfile(),
      replyToComment: (anchor, body, threadId) => runtime.replyToComment(anchor, body, threadId),
      resolveComment: (threadId) => runtime.resolveComment(threadId),
      reopenComment: (threadId) => runtime.reopenComment(threadId),
      retryReviewOutbox: () => runtime.retryOutbox(),
      recoverReview: () => runtime.recoverReview(),
      inspectShare: () => runtime.inspectShare(browserReviewBase()),
      ensureShare: async (input) => {
        const mode = this.storageHealth().mode;
        if (mode === 'unavailable' || mode === 'quota-pressure') {
          throw new Error('Local storage must be writable before creating a review room.');
        }
        const selection = input.selection;
        return runtime.ensureShare({
          relayUrl: resolveBrowserRelayUrl(
            import.meta.env.VITE_ATTN_RELAY_URL,
            window.location.origin,
          ),
          browserReviewBase: browserReviewBase(),
          scopeKind: selection.kind,
          paths: selection.kind === 'workspace'
            ? []
            : selection.kind === 'file'
              ? [selection.path]
              : selection.paths,
          mode: input.mode,
          ttlMs: input.ttlMs,
          // Owner genesis announces this name to every reviewer; without it
          // the room's ParticipantJoined fell back to "Browser owner".
          ownerDisplayName: readStoredDisplayName() ?? undefined,
          // Picked identity color rides the same genesis announce (attn-3gdd).
          ownerColor: readStoredColor(),
        });
      },
      stopShare: () => runtime.stopShare(),
      async release(): Promise<void> {},
    };
  }

  /**
   * Run a structural mutation under the workspace writer lease. Structural
   * changes (create/rename/delete/import) are as destructive as content
   * commits, so they carry the same fence: a follower tab cannot delete or
   * rename the file the writer is editing out from under it.
   *
   * When this tab already owns the lease (an active editing session),
   * acquire is an idempotent renewal — same token, the session is untouched
   * and we leave the lease alone afterwards. Otherwise we take the lease for
   * exactly this mutation and release it; if another tab is the live writer,
   * acquire returns null and the mutation fails with an actionable message.
   */
  private async withWorkspaceFence<T>(
    workspaceId: string,
    action: (fence: WorkspaceFence, renew: () => Promise<void>) => Promise<T>,
  ): Promise<T> {
    const holderId = await browserTabHolderId();
    const before = await this.service.leases.current(workspaceId);
    let handle: LeaseHandle | null = await this.acquireLeaseSeamlessly(workspaceId, holderId);
    const ridingExistingOwnership =
      before !== null
      && before.holderId === holderId
      && before.fencingToken === handle.fencingToken;
    try {
      return await action(
        { holderId: handle.holderId, fencingToken: handle.fencingToken },
        async () => {
          handle = await this.service.leases.heartbeat(handle!);
        },
      );
    } finally {
      if (!ridingExistingOwnership) {
        await this.service.leases.release(handle).catch(() => undefined);
      }
    }
  }

  async createMarkdownEntry(workspaceId: string, path: string): Promise<void> {
    await this.withWorkspaceFence(workspaceId, (fence) =>
      this.service.createMarkdown(workspaceId, path, '', fence),
    );
    this.announce({ workspaceId, kind: 'structure' });
  }

  async addAssetFiles(workspaceId: string, files: ImportFileInput[]): Promise<void> {
    if (files.length === 0) return;
    await this.withWorkspaceFence(workspaceId, async (fence, renew) => {
      for (const file of files) {
        // Multi-file imports can outlive one lease period; keep it beating.
        await renew();
        if (file.kind === 'markdown') {
          await this.service.createMarkdown(
            workspaceId,
            file.path,
            new TextDecoder().decode(file.bytes),
            fence,
          );
        } else if (file.kind === 'html') {
          await this.service.addHtml(workspaceId, file.path, file.bytes, fence);
        } else {
          await this.service.addAsset(workspaceId, file.path, file.bytes, file.mediaType, fence);
        }
      }
    });
    this.announce({ workspaceId, kind: 'structure' });
  }

  async renameEntry(workspaceId: string, fromPath: string, toPath: string): Promise<void> {
    await this.withWorkspaceFence(workspaceId, (fence) =>
      this.service.renameEntry(workspaceId, fromPath, toPath, fence),
    );
    this.announce({ workspaceId, kind: 'structure' });
  }

  async deleteEntry(workspaceId: string, path: string): Promise<void> {
    await this.withWorkspaceFence(workspaceId, (fence) =>
      this.service.deleteEntry(workspaceId, path, fence),
    );
    this.announce({ workspaceId, kind: 'structure' });
  }

  async readEntryBytes(
    workspaceId: string,
    path: string,
  ): Promise<{ bytes: Uint8Array; mediaType?: string } | null> {
    const loaded = await this.service.loadWorkspace(workspaceId);
    const entry = loaded?.entries.find((candidate) => candidate.path === path);
    if (!entry) return null;
    const bytes = await this.service.readHeadBytes(workspaceId, path);
    return { bytes, ...(entry.mediaType === undefined ? {} : { mediaType: entry.mediaType }) };
  }

  async exportWorkspace(workspaceId: string): Promise<ImportFileInput[]> {
    return this.service.exportWorkspace(workspaceId);
  }

  async markBackedUp(workspaceId: string): Promise<void> {
    await this.service.markBackedUp(workspaceId);
  }

  async requestPersistence(): Promise<boolean | null> {
    return this.service.requestPersistence();
  }

  async listRememberedRooms(): Promise<string[]> {
    return this.service.listRememberedRooms();
  }

  async forgetRoom(roomId: string): Promise<void> {
    await this.service.forgetRoom(roomId);
  }

  async clearAllWorkspaces(): Promise<number> {
    return this.service.clearAllWorkspaces();
  }

  shareScopeFor(workspace: WorkspaceDetail): ShareScope {
    const entryCount = workspace.entries.length;
    return {
      kind: 'workspace',
      markdownCount: workspace.markdownCount,
      htmlCount: workspace.htmlCount,
      assetCount: workspace.assetCount,
      label: `Share the whole workspace · ${entryCount} ${entryCount === 1 ? 'entry' : 'entries'}`,
    };
  }
}

function toViewEntry(entry: WorkspaceEntryRecord): WorkspaceEntry {
  const html = isHtmlRecord(entry);
  return {
    path: entry.path,
    kind: html ? 'html' : entry.kind,
    presentation:
      entry.kind === 'markdown'
        ? 'editable'
        : html
          ? 'html'
        : entry.mediaType !== undefined && INLINE_SAFE_MEDIA.test(entry.mediaType)
          ? 'preview'
          : 'download-only',
    sizeBytes: entry.sizeBytes,
    sizeLabel: sizeLabel(entry.sizeBytes),
    ...(entry.mediaType === undefined ? {} : { mediaType: entry.mediaType }),
  };
}

function browserReviewBase(): string {
  return resolveBrowserReviewBase(
    import.meta.env.VITE_ATTN_SHARE_ORIGIN,
    import.meta.env.VITE_ATTN_RELAY_URL,
    typeof window === 'undefined' ? undefined : window.location.origin,
  );
}
