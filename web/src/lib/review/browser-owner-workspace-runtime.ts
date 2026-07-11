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
  replyToComment(anchor: Anchor, body: string, threadId: string): Promise<ReviewEvent>;
  resolveComment(threadId: string): Promise<ReviewEvent>;
  retryOutbox(): Promise<void>;
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
  private controllerValue: CollabController | null = null;
  private mutationTail: Promise<void> = Promise.resolve();
  private closing = false;
  private closePromise: Promise<void> | null = null;
  private released = false;
  private lastPublicationAt = 0;
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
        this.patchState({
          status: 'active',
          leaseRole: 'owner',
          writable: true,
          liveEditingAvailable: false,
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
    return this.enqueueMutation(async () => {
      if (!this.stateValue.writable) {
        throw new StorageConflictError('browser owner workspace is not writable');
      }
      return this.options.storage.workspaces.commitRevision({
        ...input,
        workspaceId: this.options.workspaceId,
        fence: this.requireFence(),
      });
    });
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
        const discovered = await this.discoverPublishedShare();
        if (!discovered) throw new StorageConflictError('published share could not be reopened');
        try {
          await this.activatePublishedShare(discovered, this.requireFence());
        } catch (error) {
          await this.deactivateAuthority();
          this.startLocalHeartbeat();
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
      // Do not claim a stop until the owner-signed relay deletion succeeds.
      const record = await coordinator.deleteRemote();
      await this.deactivateAuthority();
      await coordinator.eraseLocal(record);
      this.startLocalHeartbeat();
      this.patchState({
        status: 'active',
        leaseRole: 'owner',
        writable: true,
        liveEditingAvailable: false,
        reason: null,
        roomId: null,
        capId: null,
        bindings: [],
        authority: null,
      });
    });
  }

  async accept(input: BrowserOwnerWorkspaceAcceptInput): Promise<AcceptBrowserSuggestionResult> {
    return this.enqueueMutation(async () => {
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
  }

  async applySuggestion(
    input: BrowserOwnerWorkspaceApplyInput,
  ): Promise<CommittedBrowserSuggestionResult> {
    return this.enqueueMutation(async () => {
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

  async replyToComment(anchor: Anchor, body: string, threadId: string): Promise<ReviewEvent> {
    return this.requireDurableReviewAuthority().replyToComment(anchor, body, threadId);
  }

  async resolveComment(threadId: string): Promise<ReviewEvent> {
    return this.requireDurableReviewAuthority().resolveComment(threadId);
  }

  async retryOutbox(): Promise<void> {
    await this.requireDurableReviewAuthority().retryOutbox();
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = (async () => {
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
      bindings: discovered.bindings,
      authority: authority.getState(),
    });
    return true;
  }

  private async deactivateAuthority(): Promise<void> {
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
    const credentials = ownerCredentialsFromInviteCapability(capability, share.roomId);
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
          if (discovered.pendingPublication) {
            try {
              await resumeBrowserSnapshotPublication(publicationOutbox, {
                sink: this.options.storage.shares.publicationSink(discovered.rootKey),
                workspaceId: this.options.workspaceId,
                capId: discovered.share.capId,
                fence: this.requireFence(),
                revisionSource: this.options.storage.workspaces,
              });
            } catch (error) {
              if (
                !(error instanceof StorageConflictError) ||
                !(await this.pendingPublicationSourceMoved(
                  discovered.rootKey,
                  discovered.share.capId,
                ))
              ) {
                throw error;
              }
              await this.options.storage.shares.discardPendingPublication(
                discovered.rootKey,
                this.options.workspaceId,
                discovered.share.capId,
                this.requireFence(),
              );
              this.share = { ...discovered.share, publication: 'published' };
              await this.publishCurrentGeneration(publicationOutbox);
            }
          } else {
            await this.publishCurrentGeneration(publicationOutbox);
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
  }

  private refreshController(): void {
    const next = this.authority?.controller ?? null;
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
    const run = this.mutationTail.then(operation, operation);
    this.mutationTail = run.then(() => undefined, () => undefined);
    return run;
  }

  private nextPublicationTimestamp(): number {
    const now = (this.options.now ?? Date.now)();
    if (!Number.isSafeInteger(now) || now <= 0) throw new Error('publication clock is invalid');
    this.lastPublicationAt = Math.max(now, this.lastPublicationAt + 1);
    return this.lastPublicationAt;
  }

  private patchState(patch: Partial<BrowserOwnerWorkspaceRuntimeState>): void {
    this.stateValue = { ...this.stateValue, ...patch };
    const snapshot = this.getState();
    this.options.onState?.(snapshot);
    for (const subscriber of this.subscribers) subscriber(snapshot);
  }

  private async cleanupFailedStart(): Promise<void> {
    const authority = this.authority;
    this.authority = null;
    if (authority) await authority.close().catch(() => undefined);
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
        this.patchState({
          status: 'passive', leaseRole: 'passive', writable: false,
          liveEditingAvailable: false, reason: errorMessage(error),
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
  credentials.identity.signingSecret.fill(0);
  credentials.identity.signingPublic.fill(0);
  credentials.identity.encryptionSecret.fill(0);
  credentials.identity.publicEncryptionKey.fill(0);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function reviewedKey(path: string, suggestionId: string): string {
  return `${path}\u0000${suggestionId}`;
}
