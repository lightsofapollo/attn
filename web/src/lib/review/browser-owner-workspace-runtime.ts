// Hosted browser-owner workspace runtime (attn-7xl.4.4.4).
//
// This is the non-Svelte composition boundary for a hosted owner route. It
// owns one workspace lease for the route lifetime and passes that exact fence
// to autosave, review actions, snapshot publication, and collab authority.
// UI components consume only the narrow state/ports below; BrowserStorage and
// sealed owner material never escape this module.

import type { Node as PmNode } from 'prosemirror-model';

import { markdownSerializer } from '../schema';
import type { Anchor, ResolvedAnchor, ReviewEvent, SuggestionOperation } from '../types';
import { contentHash } from './browser-crypto';
import {
  BrowserOwnerAuthorityService,
  type BrowserOwnerAuthorityFile,
  type BrowserOwnerAuthorityOptions,
  type BrowserOwnerAuthorityState,
  type BrowserPublishedEpochTransitionPhases,
} from './browser-owner-authority';
import {
  acceptBrowserSuggestion,
  applyReviewedBrowserSuggestion,
  prepareBrowserSuggestion,
  rejectBrowserSuggestion,
  type AcceptBrowserSuggestionResult,
  type BrowserReviewedSuggestion,
  type CommittedBrowserSuggestionResult,
  type RejectBrowserSuggestionResult,
} from './browser-review-actions';
import {
  ownerCredentialsFromInviteCapability,
  ownerCredentialsV3FromInviteCapability,
  type BrowserOwnerCredentials,
  type BrowserSessionOptions,
} from './browser-session';
import {
  publishBrowserSnapshots,
  resumeBrowserSnapshotPublication,
  type BrowserSnapshotEntry,
  type PublishBrowserSnapshotsOptions,
  type SnapshotPublicationOutbox,
} from './browser-snapshot-publisher';
import type { BrowserStorage } from './browser-storage';
import { BrowserStorageError, StorageConflictError } from './browser-storage-errors';
import type { InviteCapability, ShareRecordView } from './browser-workspace-share';
import type { CommittedRevision, CommitRevisionInput } from './browser-workspace-store';
import type { LeaseHandle, WorkspaceLeaseManagerOptions } from './browser-workspace-lease';
import type { CollabController } from '../prosemirror/collab-controller';
import type { BrowserReviewTerminalPort } from './browser-review-actions';
import { LocalCollabHub } from './browser-local-collab';
import {
  BrowserWorkspaceSharingCoordinator,
  type BrowserWorkspaceShareRequest,
  type BrowserWorkspaceShareView,
  type BrowserWorkspaceSharingDependencies,
} from './browser-workspace-sharing';

export type BrowserOwnerWorkspaceRuntimeStatus =
  | 'starting'
  | 'passive'
  | 'active'
  | 'transitioning'
  | 'paused'
  | 'error'
  | 'closed';

export interface BrowserOwnerWorkspaceRuntimeState {
  status: BrowserOwnerWorkspaceRuntimeStatus;
  leaseRole: 'owner' | 'passive' | 'none';
  writable: boolean;
  liveEditingAvailable: boolean;
  /** Live co-typing across THIS browser's tabs (unshared workspace; no room). */
  localCollab: boolean;
  reason: string | null;
  workspaceId: string;
  roomId: string | null;
  capId: string | null;
  bindings: readonly BrowserOwnerAuthorityFile[];
  controllerGeneration: number;
  authority: BrowserOwnerAuthorityState | null;
}

export interface BrowserOwnerWorkspaceCommitInput
  extends Omit<CommitRevisionInput, 'workspaceId' | 'fence'> {}

export interface BrowserOwnerWorkspaceAcceptInput {
  path: string;
  suggestionId: string;
  operation: SuggestionOperation;
  resolvedAnchor: ResolvedAnchor;
}

export interface BrowserOwnerWorkspaceRejectInput {
  path: string;
  suggestionId: string;
  reason?: string;
}

export interface BrowserOwnerWorkspaceApplyInput {
  path: string;
  suggestionId: string;
  replacement: string;
}

export interface BrowserOwnerWorkspaceRuntimeOptions {
  storage: BrowserStorage;
  workspaceId: string;
  holderId: string;
  collab: BrowserOwnerAuthorityOptions['collab'];
  sessionOptions?: Omit<BrowserSessionOptions, 'owner' | 'relayUrl' | 'storage' | 'onCollab' | 'onState'>;
  leaseOptions?: WorkspaceLeaseManagerOptions;
  heartbeatIntervalMs?: number;
  /** Trailing debounce before the durable share re-projects after a commit. */
  shareRepublishDebounceMs?: number;
  now?: () => number;
  onState?: (state: BrowserOwnerWorkspaceRuntimeState) => void;
  /** Test seam. Production always constructs BrowserOwnerAuthorityService. */
  authorityFactory?: (options: BrowserOwnerAuthorityOptions) => BrowserOwnerWorkspaceAuthority;
  /** Test seam. Production always calls the canonical snapshot publisher. */
  publisher?: (options: PublishBrowserSnapshotsOptions) => Promise<unknown>;
  /** Initial share/stop seams; production uses the canonical coordinator. */
  sharing?: BrowserWorkspaceSharingDependencies;
  schedule?: (callback: () => void, delayMs: number) => unknown;
  cancelScheduled?: (handle: unknown) => void;
  pagehideTarget?: {
    addEventListener(type: 'pagehide', listener: () => void): void;
    removeEventListener(type: 'pagehide', listener: () => void): void;
  } | null;
}

export interface BrowserOwnerWorkspaceAuthority extends BrowserReviewTerminalPort {
  start(): Promise<boolean>;
  close(): Promise<void>;
  getState(): BrowserOwnerAuthorityState;
  readonly controller: CollabController | null;
  transitionPublishedEpoch(
    fileId: string,
    phases: BrowserPublishedEpochTransitionPhases,
  ): Promise<readonly BrowserOwnerAuthorityFile[]>;
  createComment(anchor: Anchor, body: string): Promise<ReviewEvent>;
  announceProfile(): Promise<void>;
  replyToComment(anchor: Anchor, body: string, threadId: string): Promise<ReviewEvent>;
  resolveComment(threadId: string): Promise<ReviewEvent>;
  retryOutbox(): Promise<void>;
  /** Presence bridge, tabs → room (attn-37f9): best-effort forward of a
   *  follower tab's cursor payload over this leader's live session. */
  mirrorCursorToRoom(payload: string): void;
}

export type BrowserOwnerWorkspaceRuntimeSubscriber = (
  state: BrowserOwnerWorkspaceRuntimeState,
) => void;

interface DiscoveredPublishedShare {
  share: ShareRecordView;
  rootKey: CryptoKey;
  credentials: BrowserOwnerCredentials;
  bindings: BrowserOwnerAuthorityFile[];
  pendingPublication: boolean;
  localHeadsMoved: boolean;
}

export class BrowserOwnerWorkspaceRuntime {
  private readonly options: BrowserOwnerWorkspaceRuntimeOptions;
  private readonly leaseManager;
  private readonly subscribers = new Set<BrowserOwnerWorkspaceRuntimeSubscriber>();
  private stateValue: BrowserOwnerWorkspaceRuntimeState;
  private lease: LeaseHandle | null = null;
  private share: ShareRecordView | null = null;
  private credentials: BrowserOwnerCredentials | null = null;
  private authority: BrowserOwnerWorkspaceAuthority | null = null;
  private localHub: LocalCollabHub | null = null;
  private localCollabSyncGeneration = 0;
  private controllerValue: CollabController | null = null;
  private mutationTail: Promise<void> = Promise.resolve();
  private closing = false;
  private closePromise: Promise<void> | null = null;
  private released = false;
  private lastPublicationAt = 0;
  private republishHandle: unknown = null;
  private readonly reviewedSuggestions = new Map<string, BrowserReviewedSuggestion>();
  private localHeartbeatTimer: unknown = null;
  private readonly schedule: (callback: () => void, delayMs: number) => unknown;
  private readonly cancelScheduled: (handle: unknown) => void;
  private readonly pagehideTarget: BrowserOwnerWorkspaceRuntimeOptions['pagehideTarget'];
  private readonly pagehideHandler = (): void => { void this.close(); };

  constructor(options: BrowserOwnerWorkspaceRuntimeOptions) {
    if (!options.workspaceId || !options.holderId) {
      throw new BrowserStorageError('workspaceId and holderId are required');
    }
    this.options = options;
    this.leaseManager = options.storage.leases(options.leaseOptions);
    this.schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.cancelScheduled = options.cancelScheduled
      ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.pagehideTarget = options.pagehideTarget === undefined
      ? (typeof window === 'undefined' ? null : window)
      : options.pagehideTarget;
    this.stateValue = {
      status: 'starting',
      leaseRole: 'none',
      writable: false,
      liveEditingAvailable: false,
      localCollab: false,
      reason: null,
      workspaceId: options.workspaceId,
      roomId: null,
      capId: null,
      bindings: [],
      controllerGeneration: 0,
      authority: null,
    };
  }

  getState(): BrowserOwnerWorkspaceRuntimeState {
    return cloneState(this.stateValue);
  }

  subscribe(subscriber: BrowserOwnerWorkspaceRuntimeSubscriber): () => void {
    this.subscribers.add(subscriber);
    subscriber(this.getState());
    return () => this.subscribers.delete(subscriber);
  }

  get controller(): CollabController | null {
    return this.controllerValue;
  }

  get fence(): LeaseHandle | null {
    return this.lease ? { ...this.lease } : null;
  }

  getBinding(pathOrFileId: string): BrowserOwnerAuthorityFile | null {
    const binding = this.stateValue.bindings.find(
      (item) => item.path === pathOrFileId || item.fileId === pathOrFileId,
    );
    return binding ? { ...binding } : null;
  }

  /** Exact authenticated published base; never substitutes the newer local head. */
  async getCollabSeed(
    path: string,
  ): Promise<{ fileId: string; epoch: string; markdown: string } | null> {
    // Local multi-tab mode: the hub's seed cache is the single base every
    // participant (this editor included) binds from.
    if (this.localHub) return this.localHub.seedFor(path);
    return this.getPublishedCollabSeed(path);
  }

  private async getPublishedCollabSeed(
    path: string,
  ): Promise<{ fileId: string; epoch: string; markdown: string } | null> {
    const binding = this.getBinding(path);
    if (!binding) return null;
    const bytes = await this.options.storage.workspaces.getRevisionBody(
      this.options.workspaceId,
      binding.path,
      binding.revisionId,
    );
    try {
      if (contentHash(bytes) !== binding.contentHash) {
        throw new StorageConflictError('collaboration seed does not match its published hash');
      }
      return {
        fileId: binding.fileId,
        epoch: binding.epoch,
        markdown: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
      };
    } finally {
      bytes.fill(0);
    }
  }

  async start(): Promise<BrowserOwnerWorkspaceRuntimeState> {
    if (this.stateValue.status !== 'starting') return this.getState();
    try {
      const lease = await this.leaseManager.acquire(
        this.options.workspaceId,
        this.options.holderId,
      );
      if (!lease) {
        this.patchState({
          status: 'passive',
          leaseRole: 'passive',
          writable: false,
          liveEditingAvailable: false,
          reason: 'Another tab owns this workspace.',
        });
        return this.getState();
      }
      this.lease = lease;
      this.pagehideTarget?.addEventListener('pagehide', this.pagehideHandler);
      let discovered: Awaited<ReturnType<BrowserOwnerWorkspaceRuntime['discoverPublishedShare']>>;
      try {
        await this.sharingCoordinator().reconcileActive();
        discovered = await this.discoverPublishedShare();
      } catch (error) {
        this.startLocalHeartbeat();
        this.patchState({
          status: 'error',
          leaseRole: 'owner',
          writable: true,
          liveEditingAvailable: false,
          reason: errorMessage(error),
        });
        return this.getState();
      }
      if (!discovered) {
        this.startLocalHeartbeat();
        const localCollab = this.startLocalCollab();
        this.patchState({
          status: 'active',
          leaseRole: 'owner',
          writable: true,
          liveEditingAvailable: localCollab,
          localCollab,
          reason: null,
        });
        return this.getState();
      }
      await this.activatePublishedShare(discovered, lease);
      return this.getState();
    } catch (error) {
      if (this.lease) {
        const authority = this.authority;
        this.authority = null;
        if (authority) await authority.close().catch(() => undefined);
        this.controllerValue = null;
        zeroOwnerCredentials(this.credentials);
        this.credentials = null;
        this.share = null;
        this.startLocalHeartbeat();
        this.patchState({
          status: 'error',
          leaseRole: 'owner',
          writable: true,
          liveEditingAvailable: false,
          reason: errorMessage(error),
          authority: null,
        });
        return this.getState();
      }
      await this.cleanupFailedStart();
      this.patchState({
        status: 'error',
        leaseRole: this.lease ? 'owner' : 'none',
        writable: false,
        liveEditingAvailable: false,
        reason: errorMessage(error),
      });
      return this.getState();
    }
  }

  async commit(input: BrowserOwnerWorkspaceCommitInput): Promise<CommittedRevision> {
    const committed = await this.enqueueMutation(async () => {
      if (!this.stateValue.writable) {
        throw new StorageConflictError('browser owner workspace is not writable');
      }
      return this.options.storage.workspaces.commitRevision({
        ...input,
        workspaceId: this.options.workspaceId,
        fence: this.requireFence(),
      });
    });
    this.scheduleShareRepublish();
    return committed;
  }

  async inspectShare(browserReviewBase: string): Promise<BrowserWorkspaceShareView | null> {
    const coordinator = this.sharingCoordinator();
    return coordinator.inspect(browserReviewBase);
  }

  async ensureShare(request: BrowserWorkspaceShareRequest): Promise<BrowserWorkspaceShareView> {
    return this.enqueueMutation(async () => {
      if (!this.stateValue.writable || !this.lease) {
        throw new StorageConflictError('browser owner workspace is not writable');
      }
      const coordinator = this.sharingCoordinator();
      const view = await coordinator.ensurePublished(request);
      if (!this.authority) {
        // Replace the legacy local authority with the published room authority.
        // A fresh same-browser hub is attached to that controller after start,
        // so follower tabs re-handshake without falling back to read-only.
        await this.stopLocalCollab();
        const discovered = await this.discoverPublishedShare();
        if (!discovered) throw new StorageConflictError('published share could not be reopened');
        try {
          await this.activatePublishedShare(discovered, this.requireFence());
        } catch (error) {
          await this.deactivateAuthority();
          this.startLocalHeartbeat();
          this.startLocalCollab();
          this.patchState({
            status: 'error',
            leaseRole: 'owner',
            writable: true,
            liveEditingAvailable: false,
            reason: errorMessage(error),
          });
        }
      }
      return view;
    });
  }

  async stopShare(): Promise<void> {
    return this.enqueueMutation(async () => {
      if (!this.stateValue.writable || !this.lease) {
        throw new StorageConflictError('browser owner workspace is not writable');
      }
      const coordinator = this.sharingCoordinator();
      // The revoke INTENT is durable before any network call. When the
      // remote teardown cannot be confirmed (partially-created share,
      // relay unreachable), keep the revoke_pending tombstone — the next
      // ensureShare retries it — but NEVER wedge the user's Stop: local
      // state clears either way and the link dies with its TTL at worst.
      const { record, teardownComplete } = await coordinator.deleteRemote();
      await this.deactivateAuthority();
      if (teardownComplete) await coordinator.eraseLocal(record);
      this.startLocalHeartbeat();
      const localCollab = this.startLocalCollab();
      this.patchState({
        status: 'active',
        leaseRole: 'owner',
        writable: true,
        liveEditingAvailable: localCollab,
        reason: null,
        roomId: null,
        capId: null,
        bindings: [],
        authority: null,
      });
    });
  }

  async accept(input: BrowserOwnerWorkspaceAcceptInput): Promise<AcceptBrowserSuggestionResult> {
    const result = await this.enqueueMutation(async () => {
      const authority = this.requireActiveAuthority();
      const binding = this.requireBinding(input.path);
      const share = this.requireShare();
      const entry = await this.options.storage.workspaces.getEntry(
        this.options.workspaceId,
        input.path,
      );
      if (!entry) throw new StorageConflictError('suggestion workspace entry disappeared');
      const currentMarkdownBytes = await this.options.storage.workspaces.getRevisionBody(
        this.options.workspaceId,
        input.path,
        entry.headRevisionId,
      );
      try {
        const prepared = prepareBrowserSuggestion({
          workspaceId: this.options.workspaceId,
          roomId: share.roomId,
          path: input.path,
          suggestionId: input.suggestionId,
          expectedHeadRevisionId: entry.headRevisionId,
          operation: input.operation,
          resolvedAnchor: input.resolvedAnchor,
          currentMarkdownBytes,
        });
        if (prepared.status === 'needs_review') {
          if ('reviewed' in prepared) {
            this.reviewedSuggestions.set(reviewedKey(input.path, input.suggestionId), prepared.reviewed);
          }
          return prepared;
        }
        let result: AcceptBrowserSuggestionResult | null = null;
        let bindings: readonly BrowserOwnerAuthorityFile[];
        try {
          bindings = await authority.transitionPublishedEpoch(binding.fileId, {
            commit: async ({ terminalPort }) => {
              result = await acceptBrowserSuggestion({
                workspaceId: this.options.workspaceId,
                roomId: share.roomId,
                path: input.path,
                suggestionId: input.suggestionId,
                operation: input.operation,
                resolvedAnchor: input.resolvedAnchor,
                currentMarkdownBytes,
                expectedHeadRevisionId: entry.headRevisionId,
                fence: this.requireFence(),
                store: this.options.storage,
                terminalPort,
              });
              if (result.status !== 'committed') {
                throw new Error('ready suggestion did not commit inside its epoch transition');
              }
            },
            publish: ({ publicationOutbox }) => this.publishCurrentGeneration(publicationOutbox),
          });
        } catch (error) {
          const durable = result as AcceptBrowserSuggestionResult | null;
          if (durable?.status === 'committed') {
            return {
              ...durable,
              deliveryPending: true,
              deliveryError: [durable.deliveryError, `Snapshot publication pending: ${errorMessage(error)}`]
                .filter(Boolean)
                .join(' '),
            };
          }
          throw error;
        }
        this.afterTransition(bindings);
        if (!result) throw new Error('suggestion transition completed without an action result');
        return result;
      } finally {
        currentMarkdownBytes.fill(0);
      }
    });
    if (result.status === 'committed') this.scheduleShareRepublish();
    return result;
  }

  async applySuggestion(
    input: BrowserOwnerWorkspaceApplyInput,
  ): Promise<CommittedBrowserSuggestionResult> {
    const applied = await this.enqueueMutation(async () => {
      const authority = this.requireActiveAuthority();
      const binding = this.requireBinding(input.path);
      const key = reviewedKey(input.path, input.suggestionId);
      const reviewed = this.reviewedSuggestions.get(key);
      if (!reviewed) {
        throw new StorageConflictError('suggestion has no current reviewed three-way context');
      }
      let result: CommittedBrowserSuggestionResult | null = null;
      let bindings: readonly BrowserOwnerAuthorityFile[];
      try {
        bindings = await authority.transitionPublishedEpoch(binding.fileId, {
          commit: async ({ terminalPort }) => {
            result = await applyReviewedBrowserSuggestion({
              reviewed,
              replacement: input.replacement,
              fence: this.requireFence(),
              store: this.options.storage,
              terminalPort,
            });
            this.reviewedSuggestions.delete(key);
          },
          publish: ({ publicationOutbox }) => this.publishCurrentGeneration(publicationOutbox),
        });
      } catch (error) {
        const durable = result as CommittedBrowserSuggestionResult | null;
        if (durable) {
          return {
            ...durable,
            deliveryPending: true,
            deliveryError: [durable.deliveryError, `Snapshot publication pending: ${errorMessage(error)}`]
              .filter(Boolean)
              .join(' '),
          };
        }
        throw error;
      }
      this.afterTransition(bindings);
      if (!result) throw new Error('reviewed suggestion completed without an action result');
      return result;
    });
    this.scheduleShareRepublish();
    return applied;
  }

  async reject(input: BrowserOwnerWorkspaceRejectInput): Promise<RejectBrowserSuggestionResult> {
    return this.enqueueMutation(async () => {
      const authority = this.requireActiveAuthority();
      this.requireBinding(input.path);
      const share = this.requireShare();
      const entry = await this.options.storage.workspaces.getEntry(
        this.options.workspaceId,
        input.path,
      );
      if (!entry) throw new StorageConflictError('suggestion workspace entry disappeared');
      return rejectBrowserSuggestion({
        workspaceId: this.options.workspaceId,
        roomId: share.roomId,
        path: input.path,
        suggestionId: input.suggestionId,
        expectedHeadRevisionId: entry.headRevisionId,
        ...(input.reason === undefined ? {} : { reason: input.reason }),
        fence: this.requireFence(),
        store: this.options.storage,
        terminalPort: authority,
      });
    });
  }

  async createComment(anchor: Anchor, body: string): Promise<ReviewEvent> {
    return this.requireDurableReviewAuthority().createComment(anchor, body);
  }

  async announceProfile(): Promise<void> {
    await this.requireDurableReviewAuthority().announceProfile();
  }

  async replyToComment(anchor: Anchor, body: string, threadId: string): Promise<ReviewEvent> {
    return this.requireDurableReviewAuthority().replyToComment(anchor, body, threadId);
  }

  async resolveComment(threadId: string): Promise<ReviewEvent> {
    return this.requireDurableReviewAuthority().resolveComment(threadId);
  }

  async retryOutbox(): Promise<void> {
    await this.requireDurableReviewAuthority().retryOutbox();
  }

  /** True from the moment close() starts until the runtime is fully closed.
   *  beginOwnerRuntime must never hand out a runtime in this window — a
   *  session installed on a closing runtime is a zombie that wedges the
   *  tab's ownership recovery. */
  isClosing(): boolean {
    return this.closing;
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = (async () => {
      // Flush local co-editing first: its trailing commits enqueue onto the
      // mutation tail awaited below, and its goodbye lets follower tabs
      // re-handshake instead of waiting out the lease.
      this.localCollabSyncGeneration += 1;
      await this.stopLocalCollab();
      // A pending debounced republish must not fire after teardown; flush it
      // now (best-effort) so reviewers get the final content. This is the
      // one moment plain-typing heads are published as a fresh generation:
      // the live room is going away with this owner.
      if (this.republishHandle !== null) {
        this.cancelScheduled(this.republishHandle);
        this.republishHandle = null;
        if (this.share && this.lease) {
          await this.enqueueInternal(() => this.flushShareRepublish({ allowEpochTransition: true }))
            .catch(() => undefined);
        }
      }
      await this.mutationTail.catch(() => undefined);
      const authority = this.authority;
      this.authority = null;
      if (authority) await authority.close().catch(() => undefined);
      this.controllerValue = null;
      this.stopLocalHeartbeat();
      this.pagehideTarget?.removeEventListener('pagehide', this.pagehideHandler);
      await this.releaseOnce();
      zeroOwnerCredentials(this.credentials);
      this.reviewedSuggestions.clear();
      this.credentials = null;
      this.share = null;
      this.patchState({
        status: 'closed', leaseRole: 'none', writable: false,
        liveEditingAvailable: false, reason: null, authority: null,
      });
    })();
    return this.closePromise;
  }

  /**
   * Keep the durable /s/ share fresh after content changes: reviewers render
   * the published snapshots and only refetch when the share record's revision
   * bumps, so an owner who keeps editing after sharing must re-publish.
   * Freshness takes two steps — publish a new room snapshot generation for
   * the moved heads (an epoch transition, exactly what accepts do), then
   * mirror the advanced manifest into the durable share record. Trailing
   * debounce: continuous typing keeps pushing the flush out, so the epoch
   * transition (which reseeds the editor binding) only lands in idle gaps.
   */
  private scheduleShareRepublish(): void {
    if (this.closing || !this.share) return;
    if (this.republishHandle !== null) this.cancelScheduled(this.republishHandle);
    this.republishHandle = this.schedule(() => {
      this.republishHandle = null;
      if (this.closing) return; // close() flushes explicitly
      void this.enqueueInternal(() => this.flushShareRepublish({ allowEpochTransition: false }));
    }, this.options.shareRepublishDebounceMs ?? 5_000);
  }

  /**
   * Mid-session (`allowEpochTransition: false`): only mirror an already
   * advanced manifest (accepted/applied suggestions) into the durable /s/
   * record. Plain typing is NOT flushed mid-session — live room collab
   * carries it to connected reviewers, and late joiners converge by
   * resyncing the epoch's step log; rotating epochs under an active live
   * session would churn every follower's binding.
   * At close (`allowEpochTransition: true`): publish the moved heads as a
   * fresh generation and mirror it, so reviewers who arrive after this
   * owner leaves still get the final content.
   */
  private async flushShareRepublish(options: { allowEpochTransition: boolean }): Promise<void> {
    if (!this.share || !this.lease) return;
    try {
      if (await this.sharedHeadsMoved()) {
        if (!options.allowEpochTransition) return;
        const binding = this.stateValue.bindings[0];
        const authority = this.authority;
        if (binding && authority && authority.getState().status === 'active') {
          const bindings = await authority.transitionPublishedEpoch(binding.fileId, {
            publish: ({ publicationOutbox }) => this.publishCurrentGeneration(publicationOutbox),
          });
          this.afterTransition(bindings);
        }
      }
      await this.sharingCoordinator().reconcileActive();
    } catch {
      // Best-effort freshness: reviewers keep the previous revision and the
      // next commit reschedules; never surface a republish failure.
    }
  }

  /** True when any shared file's local head moved past its published base. */
  private async sharedHeadsMoved(): Promise<boolean> {
    for (const binding of this.stateValue.bindings) {
      const entry = await this.options.storage.workspaces.getEntry(
        this.options.workspaceId,
        binding.path,
      );
      if (entry && entry.headRevisionId !== binding.revisionId) return true;
    }
    return false;
  }

  private sharingCoordinator(): BrowserWorkspaceSharingCoordinator {
    return new BrowserWorkspaceSharingCoordinator(
      this.options.storage,
      this.options.workspaceId,
      this.requireFence(),
      {
        ...this.options.sharing,
        ...(this.options.publisher === undefined ? {} : { publish: this.options.publisher }),
        ...(this.options.now === undefined ? {} : { now: this.options.now }),
      },
    );
  }

  private async activatePublishedShare(
    discovered: DiscoveredPublishedShare,
    lease: LeaseHandle,
  ): Promise<boolean> {
    this.stopLocalHeartbeat();
    this.share = discovered.share;
    this.credentials = discovered.credentials;
    const factory = this.options.authorityFactory
      ?? ((authorityOptions) => new BrowserOwnerAuthorityService(authorityOptions));
    const authority = factory({
      workspaceId: this.options.workspaceId,
      holderId: this.options.holderId,
      roomId: discovered.share.roomId,
      capId: discovered.share.capId,
      owner: discovered.credentials,
      files: discovered.bindings,
      storage: this.authorityStorage(discovered.rootKey),
      leaseManager: this.leaseManager,
      attachedLease: lease,
      sessionOptions: {
        ...this.options.sessionOptions,
        relayUrl: discovered.share.relayUrl,
        // BrowserSession owns and closes its persistence connection.
        // Never hand it the app service's shared BrowserStorage handle.
        storageFactory: (createIfMissing) =>
          this.options.storage.openSibling(createIfMissing),
      },
      collab: this.options.collab,
      // Presence bridge, room → tabs (attn-37f9): reviewer cursors arriving
      // over the relay re-post onto the local tab channel so follower tabs
      // render them too (they dedupe by clientID).
      onCursorDelivery: (payload) => this.localHub?.mirrorCursorPayload(payload),
      rollover: {
        onRequired: (input) => this.commitRolloverAndPublish(
          input.fileId,
          input.doc,
          input.publicationOutbox,
        ),
      },
      ...(this.options.heartbeatIntervalMs === undefined
        ? {}
        : { heartbeatIntervalMs: this.options.heartbeatIntervalMs }),
      ...(this.options.now === undefined ? {} : { now: this.options.now }),
      onState: (authorityState) => this.onAuthorityState(authorityState),
    });
    this.authority = authority;
    this.patchState({
      roomId: discovered.share.roomId,
      capId: discovered.share.capId,
      bindings: discovered.bindings,
      authority: authority.getState(),
    });
    const started = await authority.start();
    if (!started) {
      this.onAuthorityState(authority.getState());
      return false;
    }
    this.refreshController();
    const reconciled = await this.reconcileStartupPublication(discovered);
    if (!reconciled) return false;
    this.patchState({
      status: 'active',
      leaseRole: 'owner',
      writable: true,
      liveEditingAvailable: true,
      reason: null,
      roomId: discovered.share.roomId,
      capId: discovered.share.capId,
      // Startup reconcile may have transitioned to a fresh epoch and already
      // adopted its bindings (afterTransition). Re-patching the discovered
      // (pre-transition) bindings here rebound the editor to the DEAD epoch:
      // the reloaded owner then broadcast steps no reviewer followed, and
      // late joiners rendered the new epoch's snapshot with no live catch-up
      // (attn-w22).
      bindings: this.stateValue.bindings,
      authority: authority.getState(),
    });
    this.startLocalCollab();
    return true;
  }

  private async deactivateAuthority(): Promise<void> {
    this.localCollabSyncGeneration += 1;
    await this.stopLocalCollab();
    const authority = this.authority;
    this.authority = null;
    if (authority) await authority.close().catch(() => undefined);
    this.refreshController();
    zeroOwnerCredentials(this.credentials);
    this.credentials = null;
    this.share = null;
  }

  private async discoverPublishedShare(): Promise<DiscoveredPublishedShare | null> {
    const rootKey = await this.options.storage.getWorkspaceRootKey(this.options.workspaceId);
    if (!rootKey) throw new BrowserStorageError('workspace key is unavailable');
    const candidates: Array<{
      share: ShareRecordView;
      capability: InviteCapability;
    }> = [];
    for (const share of await this.options.storage.shares.listShares(this.options.workspaceId)) {
      if (share.publication === 'stopped') continue;
      const capability = await this.options.storage.shares.openShare(
        rootKey,
        this.options.workspaceId,
        share.capId,
      );
      if (capability.publishedManifest) candidates.push({ share, capability });
    }
    if (candidates.length === 0) return null;
    if (candidates.length !== 1) {
      throw new StorageConflictError(
        'workspace has multiple active published shares',
      );
    }
    const { share, capability } = candidates[0]!;
    const credentials = capability.durableShare
      ? ownerCredentialsV3FromInviteCapability(capability, share.roomId)
      : ownerCredentialsFromInviteCapability(capability, share.roomId);
    try {
      const manifest = capability.publishedManifest;
      if (!manifest) throw new StorageConflictError('active share has no promoted manifest');
      const entries = await this.options.storage.workspaces.listEntries(this.options.workspaceId);
      const entriesByPath = new Map(entries.map((entry) => [entry.path, entry]));
      const bindings: BrowserOwnerAuthorityFile[] = [];
      let localHeadsMoved = false;
      for (const published of manifest.entries) {
        if (!published.revisionId) {
          throw new StorageConflictError('published manifest is missing an exact workspace revision');
        }
        const entry = entriesByPath.get(published.path);
        if (!entry) throw new StorageConflictError('published manifest references a missing workspace entry');
        const bytes = await this.options.storage.workspaces.getRevisionBody(
          this.options.workspaceId,
          published.path,
          published.revisionId,
        );
        try {
          if (contentHash(bytes) !== published.contentHash) {
            throw new StorageConflictError('published workspace revision hash is invalid');
          }
        } finally {
          bytes.fill(0);
        }
        if (entry.kind === 'markdown') {
          bindings.push({
            fileId: published.fileId,
            path: published.path,
            revisionId: published.revisionId,
            contentHash: published.contentHash,
            epoch: published.snapshotId,
          });
        }
        if (entry.headRevisionId !== published.revisionId) localHeadsMoved = true;
      }
      if (bindings.length === 0) {
        throw new StorageConflictError('published share has no Markdown authority binding');
      }
      return {
        share,
        rootKey,
        credentials,
        bindings,
        pendingPublication: share.publication === 'pending',
        localHeadsMoved,
      };
    } catch (error) {
      zeroOwnerCredentials(credentials);
      throw error;
    }
  }

  private authorityStorage(rootKey: CryptoKey): BrowserOwnerAuthorityOptions['storage'] {
    return {
      loadPublishedManifest: (workspaceId, capId) =>
        this.options.storage.shares.loadPromotedManifest(rootKey, workspaceId, capId),
      getRevisionBody: (workspaceId, path, revisionId) =>
        this.options.storage.workspaces.getRevisionBody(workspaceId, path, revisionId),
      getCollabCheckpoint: (workspaceId, roomId, fileId, epoch) =>
        this.options.storage.getCollabCheckpoint(workspaceId, roomId, fileId, epoch),
      putCollabCheckpoint: (workspaceId, checkpoint, options) =>
        this.options.storage.putCollabCheckpoint(workspaceId, checkpoint, options),
    };
  }

  private async reconcileStartupPublication(
    discovered: DiscoveredPublishedShare,
  ): Promise<boolean> {
    if (!discovered.pendingPublication && !discovered.localHeadsMoved) return true;
    const authority = this.requireActiveAuthority();
    const binding = discovered.bindings[0]!;
    try {
      const bindings = await authority.transitionPublishedEpoch(binding.fileId, {
        publish: async ({ publicationOutbox }) => {
          // Bounded convergence (attn-3wgd): this startup publication races
          // live co-editing — a second tab's routed commits or a takeover
          // commit can advance the workspace head between (re)staging and
          // promotion, and the stage/commit gates in
          // browser-workspace-share.ts then correctly reject the stale
          // source revision. A single discard+republish used to wedge the
          // authority in a paused banner; instead each retry below reads
          // the CURRENT head, so it converges unless commits land
          // continuously — the final failure keeps today's pause.
          let resumePending = discovered.pendingPublication;
          for (let attempt = 1; ; attempt += 1) {
            try {
              if (resumePending) {
                await resumeBrowserSnapshotPublication(publicationOutbox, {
                  sink: this.options.storage.shares.publicationSink(discovered.rootKey),
                  workspaceId: this.options.workspaceId,
                  capId: discovered.share.capId,
                  fence: this.requireFence(),
                  revisionSource: this.options.storage.workspaces,
                });
              } else {
                await this.publishCurrentGeneration(publicationOutbox);
              }
              return;
            } catch (error) {
              if (!(error instanceof StorageConflictError)) throw error;
              const staleSource = await this.pendingPublicationSourceMoved(
                discovered.rootKey,
                discovered.share.capId,
              );
              // Only a provably head-moved conflict is retryable. Every
              // other conflict (unacked envelopes, cross-tab share record
              // changes) keeps its existing hard-failure semantics.
              if (!staleSource && !isPublicationHeadMovedConflict(error)) throw error;
              if (attempt >= STARTUP_PUBLICATION_ATTEMPTS) throw error;
              if (staleSource) {
                await this.options.storage.shares.discardPendingPublication(
                  discovered.rootKey,
                  this.options.workspaceId,
                  discovered.share.capId,
                  this.requireFence(),
                );
                this.share = { ...discovered.share, publication: 'published' };
              }
              resumePending = false;
            }
          }
        },
      });
      this.share = { ...discovered.share, publication: 'published' };
      this.afterTransition(bindings);
      return true;
    } catch (error) {
      this.refreshController();
      this.patchState({
        status: 'paused',
        leaseRole: 'owner',
        writable: true,
        liveEditingAvailable: false,
        reason: errorMessage(error),
        authority: authority.getState(),
      });
      return false;
    }
  }

  private async pendingPublicationSourceMoved(
    rootKey: CryptoKey,
    capId: string,
  ): Promise<boolean> {
    const capability = await this.options.storage.shares.openShare(
      rootKey,
      this.options.workspaceId,
      capId,
    );
    const pending = capability.pendingPublication;
    if (!pending) return false;
    for (const published of pending.publishedManifest.entries) {
      const entry = await this.options.storage.workspaces.getEntry(
        this.options.workspaceId,
        published.path,
      );
      if (!entry || entry.headRevisionId !== published.revisionId) return true;
    }
    return false;
  }

  private async publishCurrentGeneration(outbox: SnapshotPublicationOutbox): Promise<void> {
    const share = this.requireShare();
    const credentials = this.credentials;
    if (!credentials) throw new StorageConflictError('owner credentials are unavailable');
    const rootKey = await this.options.storage.getWorkspaceRootKey(this.options.workspaceId);
    if (!rootKey) throw new BrowserStorageError('workspace key is unavailable');
    const previous = await this.options.storage.shares.loadPublishedManifest(
      rootKey,
      this.options.workspaceId,
      share.capId,
    );
    if (!previous) throw new StorageConflictError('published manifest is unavailable');
    const workspaceEntries = await this.options.storage.workspaces.listEntries(this.options.workspaceId);
    const byPath = new Map(workspaceEntries.map((entry) => [entry.path, entry]));
    const entries: BrowserSnapshotEntry[] = [];
    try {
      for (const published of previous.entries) {
        const entry = byPath.get(published.path);
        if (!entry) throw new StorageConflictError('shared workspace entry disappeared');
        const bytes = await this.options.storage.workspaces.getRevisionBody(
          this.options.workspaceId,
          entry.path,
          entry.headRevisionId,
        );
        if (entry.kind === 'asset') {
          if (!entry.mediaType) {
            bytes.fill(0);
            throw new BrowserStorageError('shared asset is missing its media type');
          }
          entries.push({
            path: entry.path,
            docType: 'asset',
            mediaType: entry.mediaType,
            bytes,
            fileId: published.fileId,
            revisionId: entry.headRevisionId,
          });
        } else {
          entries.push({
            path: entry.path,
            docType: 'markdown',
            bytes,
            fileId: published.fileId,
            revisionId: entry.headRevisionId,
          });
        }
      }
      const publisher = this.options.publisher ?? publishBrowserSnapshots;
      await publisher({
        protocolVersion: credentials.protocolVersion,
        relayUrl: share.relayUrl,
        roomId: share.roomId,
        roomSecret: credentials.roomSecret,
        keys: credentials.keys,
        identity: credentials.identity,
        policy: credentials.policy,
        entries,
        scope: share.scopeKind,
        outbox,
        publication: {
          sink: this.options.storage.shares.publicationSink(rootKey),
          workspaceId: this.options.workspaceId,
          capId: share.capId,
          fence: this.requireFence(),
          revisionSource: this.options.storage.workspaces,
        },
        now: () => this.nextPublicationTimestamp(),
      });
    } finally {
      for (const entry of entries) entry.bytes.fill(0);
    }
  }

  private async commitRolloverAndPublish(
    fileId: string,
    doc: PmNode,
    outbox: SnapshotPublicationOutbox,
  ): Promise<void> {
    return this.enqueueMutation(async () => {
      const binding = this.requireBinding(fileId);
      const body = new TextEncoder().encode(markdownSerializer.serialize(doc));
      try {
        const entry = await this.options.storage.workspaces.getEntry(
          this.options.workspaceId,
          binding.path,
        );
        if (!entry) throw new StorageConflictError('rollover workspace entry disappeared');
        const current = await this.options.storage.workspaces.getRevisionBody(
          this.options.workspaceId,
          binding.path,
          entry.headRevisionId,
        );
        try {
          if (contentHash(current) !== contentHash(body)) {
            await this.options.storage.workspaces.commitRevision({
              workspaceId: this.options.workspaceId,
              path: binding.path,
              body,
              expectedHeadRevisionId: entry.headRevisionId,
              fence: this.requireFence(),
            });
          }
        } finally {
          current.fill(0);
        }
        await this.publishCurrentGeneration(outbox);
      } finally {
        body.fill(0);
      }
    });
  }

  private afterTransition(bindings: readonly BrowserOwnerAuthorityFile[]): void {
    this.refreshController();
    this.patchState({
      status: 'active',
      leaseRole: 'owner',
      writable: true,
      liveEditingAvailable: true,
      reason: null,
      bindings: bindings.map((binding) => ({ ...binding })),
      authority: this.authority?.getState() ?? null,
    });
  }

  private onAuthorityState(authorityState: BrowserOwnerAuthorityState): void {
    if (this.closing) return;
    this.refreshController();
    const status = authorityState.status === 'active'
      ? 'active'
      : authorityState.status === 'transitioning'
        ? 'transitioning'
        : authorityState.status === 'paused' || authorityState.status === 'closed'
          ? 'paused'
          : 'starting';
    const leaseLost = authorityState.pauseKind === 'lease_lost';
    if (leaseLost) this.lease = null;
    this.patchState({
      status,
      leaseRole: leaseLost ? 'passive' : 'owner',
      writable: !leaseLost,
      liveEditingAvailable: status === 'active',
      reason: authorityState.pauseReason,
      authority: authorityState,
    });
    if (leaseLost) {
      this.localCollabSyncGeneration += 1;
      void this.stopLocalCollab();
    } else this.syncPublishedLocalCollab();
  }

  /** Keep the same-browser channel attached when the room authority replaces
   * its controller during reconnects or published-epoch transitions. */
  private syncPublishedLocalCollab(): void {
    const controller = this.authority?.controller ?? null;
    if (!controller || this.localHub?.controller === controller) return;
    const generation = ++this.localCollabSyncGeneration;
    void this.stopLocalCollab().then(() => {
      if (
        generation !== this.localCollabSyncGeneration
        || this.closing
        || this.authority?.controller !== controller
      ) return;
      this.startLocalCollab();
      this.patchState({});
    });
  }

  private refreshController(): void {
    const next = this.authority?.controller ?? this.localHub?.controller ?? null;
    if (next === this.controllerValue) return;
    this.controllerValue = next;
    this.stateValue = {
      ...this.stateValue,
      controllerGeneration: this.stateValue.controllerGeneration + 1,
    };
  }

  private requireActiveAuthority(): BrowserOwnerWorkspaceAuthority {
    if (this.closing || this.stateValue.status !== 'active' || !this.authority) {
      throw new StorageConflictError('browser owner workspace is not writable');
    }
    return this.authority;
  }

  private requireDurableReviewAuthority(): BrowserOwnerWorkspaceAuthority {
    if (this.closing || !this.stateValue.writable || !this.authority) {
      throw new StorageConflictError('browser owner durable review is unavailable');
    }
    return this.authority;
  }

  private requireFence(): LeaseHandle {
    if (!this.lease) throw new StorageConflictError('workspace lease is unavailable');
    return this.lease;
  }

  private requireShare(): ShareRecordView {
    if (!this.share) throw new StorageConflictError('active workspace share is unavailable');
    return this.share;
  }

  private requireBinding(pathOrFileId: string): BrowserOwnerAuthorityFile {
    const binding = this.getBinding(pathOrFileId);
    if (!binding) throw new StorageConflictError('path is not part of the active Markdown share');
    return binding;
  }

  private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new StorageConflictError('owner workspace is closing'));
    return this.enqueueInternal(operation);
  }

  /** Serialized like enqueueMutation, but usable during close (hub flush). */
  private enqueueInternal<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.mutationTail.then(operation, operation);
    this.mutationTail = run.then(() => undefined, () => undefined);
    return run;
  }

  /**
   * Host local multi-tab co-editing for an UNSHARED workspace: every tab of
   * this browser profile can live-edit through this tab's authority while the
   * fenced lease (and therefore every durable commit) stays right here.
   * Returns false when BroadcastChannel is unavailable.
   */
  private startLocalCollab(): boolean {
    if (this.localHub) return this.localHub.available;
    const publishedController = this.authority?.controller ?? null;
    // Never create a parallel legacy authority while a published authority is
    // still starting. Its onState callback attaches this channel once the
    // authenticated controller exists.
    if (this.authority && !publishedController) return false;
    const hub = new LocalCollabHub({
      workspaceId: this.options.workspaceId,
      holderId: this.options.holderId,
      selfLabel: this.options.collab.selfLabel,
      selfColor: this.options.collab.selfColor,
      ...(this.options.schedule === undefined ? {} : { schedule: this.options.schedule }),
      ...(this.options.cancelScheduled === undefined
        ? {}
        : { cancelScheduled: this.options.cancelScheduled }),
      readHeadMarkdown: async (path) => {
        const entry = await this.options.storage.workspaces.getEntry(
          this.options.workspaceId,
          path,
        );
        if (entry?.kind !== 'markdown') return null;
        const bytes = await this.options.storage.workspaces.getHeadBody(
          this.options.workspaceId,
          path,
        );
        try {
          return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        } finally {
          bytes.fill(0);
        }
      },
      commitMarkdown: async (path, markdown) => {
        await this.enqueueInternal(async () => {
          await this.options.storage.workspaces.commitRevision({
            workspaceId: this.options.workspaceId,
            path,
            body: new TextEncoder().encode(markdown),
            fence: this.requireFence(),
          });
        });
        // A follower may edit a selected file that the owner tab is not
        // currently viewing. Keep the durable share fresh just as owner-tab
        // autosave does for the active file.
        this.scheduleShareRepublish();
      },
      ...(publishedController
        ? {
            controller: publishedController,
            seedForPath: (path: string) => this.getPublishedCollabSeed(path),
            pathForFileId: (fileId: string) => this.getBinding(fileId)?.path ?? null,
            // Presence bridge, tabs → room (attn-37f9): follower cursors ride
            // this leader's live session out to reviewers.
            forwardCursor: (payload: string) => this.authority?.mirrorCursorToRoom(payload),
          }
        : {}),
    });
    if (!hub.available) {
      void hub.close();
      return false;
    }
    this.localHub = hub;
    this.refreshController();
    return true;
  }

  private async stopLocalCollab(): Promise<void> {
    const hub = this.localHub;
    if (!hub) return;
    this.localHub = null;
    await hub.close();
    this.refreshController();
  }

  private nextPublicationTimestamp(): number {
    const now = (this.options.now ?? Date.now)();
    if (!Number.isSafeInteger(now) || now <= 0) throw new Error('publication clock is invalid');
    this.lastPublicationAt = Math.max(now, this.lastPublicationAt + 1);
    return this.lastPublicationAt;
  }

  private patchState(patch: Partial<BrowserOwnerWorkspaceRuntimeState>): void {
    // localCollab mirrors the hub's existence — share transitions and lease
    // loss tear the hub down, so no individual patch site tracks the flag.
    this.stateValue = { ...this.stateValue, ...patch, localCollab: this.localHub !== null };
    const snapshot = this.getState();
    this.options.onState?.(snapshot);
    for (const subscriber of this.subscribers) subscriber(snapshot);
  }

  private async cleanupFailedStart(): Promise<void> {
    const authority = this.authority;
    this.authority = null;
    if (authority) await authority.close().catch(() => undefined);
    this.localCollabSyncGeneration += 1;
    await this.stopLocalCollab().catch(() => undefined);
    this.controllerValue = null;
    this.stopLocalHeartbeat();
    this.pagehideTarget?.removeEventListener('pagehide', this.pagehideHandler);
    await this.releaseOnce();
    zeroOwnerCredentials(this.credentials);
    this.credentials = null;
    this.share = null;
  }

  private startLocalHeartbeat(): void {
    if (this.localHeartbeatTimer !== null || !this.lease) return;
    const interval = this.options.heartbeatIntervalMs ?? 5_000;
    this.localHeartbeatTimer = this.schedule(() => {
      this.localHeartbeatTimer = null;
      const lease = this.lease;
      if (!lease || this.closing) return;
      void this.leaseManager.heartbeat(lease).then((renewed) => {
        if (!this.closing && this.lease?.fencingToken === renewed.fencingToken) {
          this.lease = renewed;
          this.startLocalHeartbeat();
        }
      }).catch((error) => {
        this.lease = null;
        // Fenced off: this tab can no longer commit, so it must also stop
        // hosting local co-editing (the new lease holder hosts instead).
        void this.stopLocalCollab().then(() => {
          this.patchState({
            status: 'passive', leaseRole: 'passive', writable: false,
            liveEditingAvailable: false, reason: errorMessage(error),
          });
        });
      });
    }, interval);
  }

  private stopLocalHeartbeat(): void {
    if (this.localHeartbeatTimer === null) return;
    this.cancelScheduled(this.localHeartbeatTimer);
    this.localHeartbeatTimer = null;
  }

  private async releaseOnce(): Promise<void> {
    if (this.released) return;
    this.released = true;
    const lease = this.lease;
    this.lease = null;
    if (lease) await this.leaseManager.release(lease).catch(() => false);
    this.leaseManager.close();
  }
}

export async function openBrowserOwnerWorkspaceRuntime(
  options: BrowserOwnerWorkspaceRuntimeOptions,
): Promise<BrowserOwnerWorkspaceRuntime> {
  const runtime = new BrowserOwnerWorkspaceRuntime(options);
  await runtime.start();
  return runtime;
}

function cloneState(
  state: BrowserOwnerWorkspaceRuntimeState,
): BrowserOwnerWorkspaceRuntimeState {
  return {
    ...state,
    bindings: state.bindings.map((binding) => ({ ...binding })),
    authority: state.authority
      ? {
          ...state.authority,
          lease: state.authority.lease ? { ...state.authority.lease } : null,
          session: state.authority.session ? { ...state.authority.session } : null,
        }
      : null,
  };
}

function zeroOwnerCredentials(credentials: BrowserOwnerCredentials | null): void {
  if (!credentials) return;
  credentials.roomSecret.fill(0);
  credentials.keys.rootKey.fill(0);
  credentials.keys.eventKey.fill(0);
  credentials.keys.snapshotKey.fill(0);
  credentials.keys.signalingKey.fill(0);
  credentials.keys.admissionKey.fill(0);
  credentials.readAdmissionKey?.fill(0);
  credentials.readCapabilityKey?.fill(0);
  if ('shareSecret' in credentials && credentials.shareSecret instanceof Uint8Array) {
    credentials.shareSecret.fill(0);
  }
  credentials.identity.signingSecret.fill(0);
  credentials.identity.signingPublic.fill(0);
  credentials.identity.encryptionSecret.fill(0);
  credentials.identity.publicEncryptionKey.fill(0);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Head-moved retry budget for the startup publication (attn-3wgd). Relay
 * flushes are slow enough for a co-editing tab to land another commit
 * mid-flight; three fresh-head attempts absorb a refresh during live
 * co-editing without ever weakening the consistency gates, while continuous
 * commits still pause the authority instead of looping.
 */
const STARTUP_PUBLICATION_ATTEMPTS = 3;

/**
 * The stage/commit consistency gates in browser-workspace-share.ts that mean
 * "the live workspace head advanced past the staged source revision"
 * (attn-3wgd). The gates stay authoritative — this classification only
 * decides whether the runtime may re-stage from a fresher head.
 */
const PUBLICATION_HEAD_MOVED_CONFLICTS: ReadonlySet<string> = new Set([
  // commitPublication
  'published source revision moved before promotion',
  'published source revision is no longer a live workspace head',
  // stagePublication
  'published source revision is not a live workspace head',
  'published source revision moved or mismatches content',
]);

function isPublicationHeadMovedConflict(error: unknown): boolean {
  return error instanceof StorageConflictError
    && PUBLICATION_HEAD_MOVED_CONFLICTS.has(error.message);
}

function reviewedKey(path: string, suggestionId: string): string {
  return `${path}\u0000${suggestionId}`;
}
