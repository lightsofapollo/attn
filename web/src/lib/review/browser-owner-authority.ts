// Browser owner authority lifecycle.
//
// This is the production composition boundary between workspace ownership,
// the encrypted review transport, and ProseMirror's single-writer authority.
// It deliberately owns exactly one workspace lease. Authenticated published
// bases are supplied by the workspace/share shell; sealed step checkpoints
// are loaded before the BrowserSession can receive collaboration traffic.

import type { Node as PmNode } from 'prosemirror-model';
import { markdownParser } from '../schema';

import {
  CollabController,
  parseCollabWireMessage,
  type CollabAuthoritySeed,
  type CollabPeerLocation,
  type RemoteCursor,
} from '../prosemirror/collab-controller';
import {
  CollabAuthority,
  type CollabCheckpoint,
} from '../prosemirror/collab-authority';
import type { Anchor, FileId, ReviewEvent, ReviewEventBody } from '../types';
import {
  MAX_COLLAB_CHECKPOINT_PLAINTEXT_BYTES,
  MAX_COLLAB_CHECKPOINT_STEPS,
  type BrowserCollabCheckpoint,
} from './browser-collab-checkpoint';
import { contentHash, toCanonicalBytes } from './browser-crypto';
import type { AssembledBrowserEvent } from './browser-envelope';
import {
  BrowserSession,
  type BrowserCollabDelivery,
  type BrowserOwnerCredentials,
  type BrowserSessionOptions,
  type BrowserSessionState,
} from './browser-session';
import { StorageConflictError } from './browser-storage-errors';
import type { WorkspaceFence } from './browser-workspace-store';
import type { LeaseHandle } from './browser-workspace-lease';
import type { PublishedManifestPointer } from './browser-snapshot-publisher';
import type { SnapshotPublicationOutbox } from './browser-snapshot-publisher';
import type { MailboxEnvelope } from './browser-ws';

const DEFAULT_HEARTBEAT_INTERVAL_MS = 5_000;
const DEFAULT_ROLLOVER_STEP_HEADROOM = 256;
const DEFAULT_ROLLOVER_BYTE_HEADROOM = 4_096;
/** Matches BrowserSession's bounded signal queue and caps retained payloads. */
const MAX_TRANSITION_COLLAB_WAITERS = 64;

export interface BrowserOwnerAuthorityFile {
  fileId: FileId;
  path: string;
  revisionId: string;
  contentHash: string;
  epoch: string;
}

export interface BrowserOwnerAuthorityStorage {
  loadPublishedManifest(
    workspaceId: string,
    capId: string,
  ): Promise<PublishedManifestPointer | undefined>;
  getRevisionBody(workspaceId: string, path: string, revisionId: string): Promise<Uint8Array>;
  getCollabCheckpoint(
    workspaceId: string,
    roomId: string,
    fileId: string,
    epoch: string,
  ): Promise<BrowserCollabCheckpoint | null>;
  putCollabCheckpoint(
    workspaceId: string,
    checkpoint: BrowserCollabCheckpoint,
    options: { fence: WorkspaceFence; expectedVersion: number },
  ): Promise<unknown>;
}

export interface BrowserOwnerAuthorityLeaseManager {
  acquire(workspaceId: string, holderId: string): Promise<LeaseHandle | null>;
  heartbeat(handle: LeaseHandle): Promise<LeaseHandle>;
  release(handle: LeaseHandle): Promise<boolean>;
  close?(): void;
}

export interface BrowserOwnerSession {
  start(): Promise<void>;
  close(): void;
  sendCollab(payload: string): Promise<void>;
  getState(): BrowserSessionState;
  prepareTerminalEvent(body: ReviewEventBody): AssembledBrowserEvent;
  adoptDurableEnvelope(envelope: MailboxEnvelope): Promise<void>;
  replyToComment(anchor: Anchor, body: string, threadId: string): Promise<ReviewEvent>;
  resolveComment(threadId: string): Promise<ReviewEvent>;
  retryOutbox(): Promise<void>;
  enqueuePublicationBatch(envelopes: readonly MailboxEnvelope[]): Promise<number>;
  flushPublicationOutbox(): Promise<void>;
}

export type BrowserOwnerAuthorityPauseKind =
  | 'lease_unavailable'
  | 'lease_lost'
  | 'checkpoint_failed'
  | 'rollover_required'
  | 'transport_failed';

export interface BrowserOwnerAuthorityState {
  status: 'idle' | 'starting' | 'active' | 'transitioning' | 'paused' | 'closed';
  pauseKind: BrowserOwnerAuthorityPauseKind | null;
  pauseReason: string | null;
  pausedFileId: FileId | null;
  lease: LeaseHandle | null;
  session: BrowserSessionState | null;
}

export interface BrowserOwnerAuthorityRollover {
  /** Must remain strictly below the durable checkpoint hard cap. */
  maxSteps?: number;
  /** Must remain strictly below the sealed-checkpoint plaintext hard cap. */
  maxPlaintextBytes?: number;
  /**
   * Publish a fresh snapshot generation and replace/restart this service.
   * The triggering batch is deliberately not committed; its client retries
   * against the newly published epoch.
   */
  onRequired: (input: {
    workspaceId: string;
    roomId: string;
    fileId: FileId;
    epoch: string;
    nextVersion: number;
    stepCount: number;
    plaintextBytes: number;
    /** Exact proposed post-batch document to serialize and publish. */
    doc: PmNode;
    /** Exact full log that reconstructed `doc` against the current base. */
    checkpoint: CollabCheckpoint;
    /** Active fence for any workspace mutation needed by the publisher shell. */
    fence: WorkspaceFence;
    /** Live owner outbox scoped to this rollover publication phase. */
    publicationOutbox: SnapshotPublicationOutbox;
  }) => unknown | Promise<unknown>;
}

export interface BrowserOwnerAuthorityOptions {
  workspaceId: string;
  holderId: string;
  roomId: string;
  capId: string;
  owner: BrowserOwnerCredentials;
  files: readonly BrowserOwnerAuthorityFile[];
  storage: BrowserOwnerAuthorityStorage;
  leaseManager: BrowserOwnerAuthorityLeaseManager;
  /** Coordinator-owned lease: heartbeated here but never released here. */
  attachedLease?: LeaseHandle;
  sessionOptions?: Omit<BrowserSessionOptions, 'owner' | 'onCollab' | 'onState'> & {
    onState?: (state: BrowserSessionState) => void;
  };
  collab: {
    selfClientId: string;
    selfLabel: string;
    selfColor: string;
    onRemoteCursors?: (cursors: RemoteCursor[]) => void;
    getLocation?: () => CollabPeerLocation | null;
    onPeerLocation?: (deviceId: string, location: CollabPeerLocation) => void;
    onEpochMismatch?: (fileId: FileId, expected: string, received: string) => void;
    onAuthorityPaused?: (fileId: FileId, reason: string) => void;
  };
  rollover: BrowserOwnerAuthorityRollover;
  heartbeatIntervalMs?: number;
  now?: () => number;
  onState?: (state: BrowserOwnerAuthorityState) => void;
  /** Test seam; production constructs the real BrowserSession. */
  sessionFactory?: (options: BrowserSessionOptions) => BrowserOwnerSession;
  /** Timer seams keep lease-loss tests deterministic. */
  schedule?: (callback: () => void, delayMs: number) => unknown;
  cancelScheduled?: (handle: unknown) => void;
}

export interface BrowserPublishedEpochTransition {
  workspaceId: string;
  roomId: string;
  capId: string;
  fileId: FileId;
  fence: WorkspaceFence;
  /** Trusted terminal-event access, valid only while `commit` is executing. */
  terminalPort: BrowserPublishedEpochTerminalPort;
  /** Exact live owner outbox, valid only while `publish` is executing. */
  publicationOutbox: SnapshotPublicationOutbox;
}

export interface BrowserPublishedEpochTerminalPort {
  prepareTerminalEvent(body: ReviewEventBody): AssembledBrowserEvent;
  adoptDurableEnvelope(envelope: MailboxEnvelope): Promise<void>;
}

/**
 * Explicit transition phases. `prepare` must not mutate durable state. Once
 * `commit` or `publish` is entered the service treats the operation as
 * irreversible, even if the callback rejects, because it cannot prove that a
 * local/remote write did not commit before the rejection surfaced.
 */
export interface BrowserPublishedEpochTransitionPhases {
  prepare?: (input: BrowserPublishedEpochTransition) => unknown | Promise<unknown>;
  /** Optional atomic workspace/action commit; this is an irreversible phase. */
  commit?: (input: BrowserPublishedEpochTransition) => unknown | Promise<unknown>;
  /** Promote the complete configured snapshot generation. */
  publish: (input: BrowserPublishedEpochTransition) => unknown | Promise<unknown>;
}

interface AuthorityOperation {
  generation: number;
  done: Promise<void>;
  finish(): void;
}

interface TransitionCollabBarrier {
  promise: Promise<void>;
  resolve(): void;
  reject(reason: Error): void;
  waiters: number;
}

export class BrowserAuthorityRolloverRequiredError extends Error {
  constructor(fileId: FileId, epoch: string) {
    super(`collaboration checkpoint rollover required for ${fileId} at ${epoch}`);
    this.name = 'BrowserAuthorityRolloverRequiredError';
  }
}

export class BrowserOwnerAuthorityService {
  private readonly options: BrowserOwnerAuthorityOptions;
  private readonly now: () => number;
  private readonly schedule: (callback: () => void, delayMs: number) => unknown;
  private readonly cancelScheduled: (handle: unknown) => void;
  private readonly heartbeatIntervalMs: number;
  private readonly rolloverSteps: number;
  private readonly rolloverBytes: number;
  private readonly seeds = new Map<FileId, CollabAuthoritySeed>();
  private readonly bindings = new Map<FileId, BrowserOwnerAuthorityFile>();
  private readonly authorityFileIds: readonly FileId[];
  private readonly inFlightAuthorityOperations = new Set<AuthorityOperation>();
  private transitionCollabBarrier: TransitionCollabBarrier | null = null;
  private lease: LeaseHandle | null = null;
  private ownsLease = false;
  private collabEnabled = false;
  private acceptingAuthorityOperations = false;
  private controllerGeneration = 0;
  private heartbeatTimer: unknown = null;
  private expiryTimer: unknown = null;
  private sessionValue: BrowserOwnerSession | null = null;
  private controllerValue: CollabController | null = null;
  private state: BrowserOwnerAuthorityState = {
    status: 'idle',
    pauseKind: null,
    pauseReason: null,
    pausedFileId: null,
    lease: null,
    session: null,
  };

  constructor(options: BrowserOwnerAuthorityOptions) {
    if (!options.workspaceId || !options.holderId || !options.roomId || !options.capId) {
      throw new Error('workspaceId, holderId, roomId, and capId are required');
    }
    if (options.owner.roomId !== options.roomId) {
      throw new Error('owner credentials do not match the authority room');
    }
    if (options.files.length === 0) throw new Error('at least one authority file is required');
    const fileIds = new Set<string>();
    for (const file of options.files) {
      if (!file.fileId || !file.path || !file.revisionId || !file.contentHash || !file.epoch || fileIds.has(file.fileId)) {
        throw new Error('authority files must have complete unique published bindings');
      }
      fileIds.add(file.fileId);
    }
    this.authorityFileIds = options.files.map((file) => file.fileId);
    this.options = options;
    this.now = options.now ?? Date.now;
    this.schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.cancelScheduled = options.cancelScheduled ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    if (!Number.isSafeInteger(this.heartbeatIntervalMs) || this.heartbeatIntervalMs <= 0) {
      throw new Error('heartbeatIntervalMs must be a positive safe integer');
    }
    this.rolloverSteps = options.rollover.maxSteps
      ?? MAX_COLLAB_CHECKPOINT_STEPS - DEFAULT_ROLLOVER_STEP_HEADROOM;
    this.rolloverBytes = options.rollover.maxPlaintextBytes
      ?? MAX_COLLAB_CHECKPOINT_PLAINTEXT_BYTES - DEFAULT_ROLLOVER_BYTE_HEADROOM;
    if (
      !Number.isSafeInteger(this.rolloverSteps) ||
      this.rolloverSteps <= 0 ||
      this.rolloverSteps >= MAX_COLLAB_CHECKPOINT_STEPS
    ) {
      throw new Error('rollover maxSteps must be positive and below the checkpoint cap');
    }
    if (
      !Number.isSafeInteger(this.rolloverBytes) ||
      this.rolloverBytes <= 0 ||
      this.rolloverBytes >= MAX_COLLAB_CHECKPOINT_PLAINTEXT_BYTES
    ) {
      throw new Error('rollover maxPlaintextBytes must be positive and below the checkpoint cap');
    }
  }

  getState(): BrowserOwnerAuthorityState {
    return this.state;
  }

  get session(): BrowserOwnerSession | null {
    return this.sessionValue;
  }

  get controller(): CollabController | null {
    return this.controllerValue;
  }

  prepareTerminalEvent(body: ReviewEventBody): AssembledBrowserEvent {
    if (this.state.status !== 'active' || !this.requireFreshLease() || !this.sessionValue) {
      throw new StorageConflictError('authority lease is unavailable for terminal authoring');
    }
    return this.sessionValue.prepareTerminalEvent(body);
  }

  async adoptDurableEnvelope(envelope: MailboxEnvelope): Promise<void> {
    if (this.state.status !== 'active' || !this.requireFreshLease() || !this.sessionValue) {
      throw new StorageConflictError('authority lease is unavailable for durable event adoption');
    }
    await this.sessionValue.adoptDurableEnvelope(envelope);
    if (!this.requireFreshLease()) {
      throw new StorageConflictError('authority lease expired while adopting terminal event');
    }
  }

  /** Durable owner review remains distinct from live collab availability. */
  async replyToComment(anchor: Anchor, body: string, threadId: string): Promise<ReviewEvent> {
    const session = this.requireDurableReviewSession();
    return session.replyToComment(anchor, body, threadId);
  }

  async resolveComment(threadId: string): Promise<ReviewEvent> {
    const session = this.requireDurableReviewSession();
    return session.resolveComment(threadId);
  }

  async retryOutbox(): Promise<void> {
    const session = this.requireDurableReviewSession();
    await session.retryOutbox();
  }

  /** Fenced publication seam with an explicit irreversible phase boundary. */
  async transitionPublishedEpoch(
    fileId: FileId,
    phases: BrowserPublishedEpochTransitionPhases,
  ): Promise<readonly BrowserOwnerAuthorityFile[]> {
    return this.transitionPublishedEpochInternal(fileId, phases);
  }

  private async transitionPublishedEpochInternal(
    fileId: FileId,
    phases: BrowserPublishedEpochTransitionPhases,
    currentOperation?: AuthorityOperation,
  ): Promise<readonly BrowserOwnerAuthorityFile[]> {
    const handle = this.lease;
    const session = this.sessionValue;
    if (
      !handle ||
      !session ||
      !this.authorityFileIds.includes(fileId) ||
      this.state.status !== 'active' ||
      !this.requireFreshLease()
    ) {
      throw new StorageConflictError('authority lease is unavailable for epoch transition');
    }
    const oldGeneration = this.controllerGeneration;
    const transitionBarrier = this.beginTransitionCollabBarrier();
    this.collabEnabled = false;
    this.acceptingAuthorityOperations = false;
    this.controllerValue = null;
    this.setState({ status: 'transitioning', pausedFileId: fileId });
    let transitionPhase: 'quiescing' | 'prepare' | 'commit' | 'publish' | 'closed' = 'quiescing';
    const requireCommitTerminalAccess = (): void => {
      const live = this.lease;
      if (
        transitionPhase !== 'commit' ||
        !live ||
        live.workspaceId !== handle.workspaceId ||
        live.holderId !== handle.holderId ||
        live.fencingToken !== handle.fencingToken ||
        this.transitionCollabBarrier !== transitionBarrier ||
        this.state.status !== 'transitioning' ||
        !this.requireFreshLease()
      ) {
        throw new StorageConflictError('transition terminal port is unavailable outside the live commit phase');
      }
    };
    const requirePublishOutboxAccess = (): void => {
      const live = this.lease;
      if (
        transitionPhase !== 'publish' ||
        !live ||
        live.workspaceId !== handle.workspaceId ||
        live.holderId !== handle.holderId ||
        live.fencingToken !== handle.fencingToken ||
        this.transitionCollabBarrier !== transitionBarrier ||
        this.state.status !== 'transitioning' ||
        !this.requireFreshLease()
      ) {
        throw new StorageConflictError('transition publication outbox is unavailable outside the live publish phase');
      }
    };
    const input: BrowserPublishedEpochTransition = {
      workspaceId: this.options.workspaceId,
      roomId: this.options.roomId,
      capId: this.options.capId,
      fileId,
      fence: handle,
      terminalPort: {
        prepareTerminalEvent: (body) => {
          requireCommitTerminalAccess();
          return session.prepareTerminalEvent(body);
        },
        adoptDurableEnvelope: async (envelope) => {
          requireCommitTerminalAccess();
          await session.adoptDurableEnvelope(envelope);
          requireCommitTerminalAccess();
        },
      },
      publicationOutbox: {
        enqueueBatchDurably: async (envelopes) => {
          requirePublishOutboxAccess();
          const inserted = await session.enqueuePublicationBatch(envelopes);
          requirePublishOutboxAccess();
          return inserted;
        },
        flushNow: async () => {
          requirePublishOutboxAccess();
          await session.flushPublicationOutbox();
          requirePublishOutboxAccess();
        },
      },
    };
    let irreversiblePhaseEntered = false;
    try {
      await this.quiesceGeneration(oldGeneration, currentOperation);
      this.requireTransitionCollabBarrier(transitionBarrier);
      this.controllerGeneration += 1;
      if (!this.requireFreshLease()) {
        throw new StorageConflictError('authority lease expired while quiescing epoch transition');
      }
      transitionPhase = 'prepare';
      await phases.prepare?.(input);
      this.requireTransitionCollabBarrier(transitionBarrier);
      if (!this.requireFreshLease()) {
        throw new StorageConflictError('authority lease expired before epoch commit');
      }
      if (phases.commit) {
        // Crossing this line is intentionally conservative: a rejecting
        // action may already have committed before its error reached us.
        irreversiblePhaseEntered = true;
        transitionPhase = 'commit';
        await phases.commit(input);
        this.requireTransitionCollabBarrier(transitionBarrier);
        if (!this.requireFreshLease()) {
          throw new StorageConflictError('authority lease expired after epoch commit');
        }
      }
      // Publication is equally irreversible even without a separate commit.
      irreversiblePhaseEntered = true;
      transitionPhase = 'publish';
      await phases.publish(input);
      this.requireTransitionCollabBarrier(transitionBarrier);
      if (!this.requireFreshLease()) throw new StorageConflictError('authority lease expired during epoch transition');
      const manifest = await this.options.storage.loadPublishedManifest(
        this.options.workspaceId,
        this.options.capId,
      );
      if (!this.requireFreshLease()) throw new StorageConflictError('authority lease expired after publication');
      if (!manifest) throw new Error('promoted published manifest is unavailable after transition');
      const nextBindings = this.bindingsFromPromotedManifest(manifest);
      const replacement = await this.loadVerifiedBindingSet(nextBindings, manifest);
      if (!this.requireFreshLease()) throw new StorageConflictError('authority lease expired during reseed');
      this.replaceBindingSet(replacement);
      this.controllerValue = this.buildController(session);
      this.collabEnabled = true;
      this.acceptingAuthorityOperations = true;
      this.setState({
        status: 'active', pauseKind: null, pauseReason: null, pausedFileId: null,
      });
      this.resolveTransitionCollabBarrier();
      transitionPhase = 'closed';
      return nextBindings.map((binding) => ({ ...binding }));
    } catch (error) {
      transitionPhase = 'closed';
      if (
        !irreversiblePhaseEntered &&
        this.transitionCollabBarrier === transitionBarrier &&
        this.getState().status === 'transitioning' &&
        this.requireFreshLease()
      ) {
        let restored = false;
        try {
          await this.restoreCurrentPublishedGeneration(session);
          restored = true;
        } catch (restoreError) {
          error = restoreError;
        }
        if (restored) throw error;
      }
      if (this.getState().status === 'paused') throw error;
      this.rejectTransitionCollabBarrier(error);
      this.controllerValue = null;
      this.collabEnabled = false;
      this.acceptingAuthorityOperations = false;
      this.setState({
        status: 'paused',
        pauseKind: 'rollover_required',
        pauseReason: error instanceof Error ? error.message : String(error),
        pausedFileId: fileId,
      });
      throw error;
    }
  }

  private requireDurableReviewSession(): BrowserOwnerSession {
    if (!this.lease || !this.sessionValue || !this.requireFreshLease()) {
      throw new StorageConflictError('owner durable review session is unavailable');
    }
    return this.sessionValue;
  }

  /** Acquire, preload every file authority, compose controller, then connect. */
  async start(): Promise<boolean> {
    if (this.state.status !== 'idle') throw new Error('owner authority service already started');
    this.setState({ status: 'starting', pauseKind: null, pauseReason: null, pausedFileId: null });
    const lease = this.options.attachedLease ?? await this.options.leaseManager.acquire(
      this.options.workspaceId,
      this.options.holderId,
    );
    if (!lease) {
      this.setState({
        status: 'paused',
        pauseKind: 'lease_unavailable',
        pauseReason: 'Another tab owns this workspace.',
      });
      return false;
    }
    if (lease.workspaceId !== this.options.workspaceId || lease.holderId !== this.options.holderId) {
      throw new Error('attached authority lease does not match workspace/holder');
    }
    this.ownsLease = this.options.attachedLease === undefined;
    this.lease = lease;
    this.setState({ lease: { ...lease } });
    if (!this.requireFreshLease()) return false;
    this.armExpiryWatchdog();

    try {
      await this.preloadSeeds();
      if (!this.requireFreshLease()) return false;
      const sessionFactory = this.options.sessionFactory
        ?? ((sessionOptions: BrowserSessionOptions) => new BrowserSession(sessionOptions));
      const callerSessionState = this.options.sessionOptions?.onState;
      const session = sessionFactory({
        ...this.options.sessionOptions,
        owner: this.options.owner,
        onCollab: (delivery: BrowserCollabDelivery) => this.routeCollabDelivery(delivery),
        onState: (sessionState) => {
          callerSessionState?.(sessionState);
          this.setState({ session: sessionState });
          if (sessionState.status === 'error' && this.state.status === 'active') {
            this.pauseTransport(
              'transport_failed',
              sessionState.error?.message ?? 'Browser owner transport failed.',
            );
          }
        },
      });
      this.sessionValue = session;
      this.controllerValue = this.buildController(session);
      this.collabEnabled = true;
      this.acceptingAuthorityOperations = true;
      await session.start();
      if (!this.requireFreshLease()) return false;
      const sessionState = session.getState();
      if (sessionState.status === 'error' || sessionState.status === 'terminated') {
        this.pauseTransport(
          'transport_failed',
          sessionState.error?.message ?? 'Browser owner transport failed during startup.',
        );
        return false;
      }
      this.setState({ status: 'active', session: sessionState });
      this.scheduleHeartbeat();
      return true;
    } catch (error) {
      if (this.state.pauseKind === 'lease_lost') return false;
      this.sessionValue?.close();
      this.sessionValue = null;
      this.controllerValue = null;
      this.collabEnabled = false;
      this.acceptingAuthorityOperations = false;
      this.controllerGeneration += 1;
      const handle = this.lease;
      this.lease = null;
      this.clearLeaseTimers();
      if (handle && this.ownsLease) await this.options.leaseManager.release(handle).catch(() => false);
      this.setState({
        status: 'paused',
        pauseKind: 'checkpoint_failed',
        pauseReason: error instanceof Error ? error.message : String(error),
        lease: null,
      });
      return false;
    }
  }

  /** Close transport synchronously, then release the still-owned lease. */
  async close(): Promise<void> {
    if (this.state.status === 'closed') return;
    this.clearLeaseTimers();
    this.sessionValue?.close();
    this.sessionValue = null;
    this.controllerValue = null;
    this.collabEnabled = false;
    this.acceptingAuthorityOperations = false;
    this.controllerGeneration += 1;
    this.rejectTransitionCollabBarrier(new Error('browser owner authority closed'));
    const handle = this.lease;
    this.lease = null;
    this.setState({ status: 'closed', lease: null });
    if (handle && this.ownsLease) await this.options.leaseManager.release(handle).catch(() => false);
  }

  private async preloadSeeds(): Promise<void> {
    const manifest = await this.options.storage.loadPublishedManifest(
      this.options.workspaceId,
      this.options.capId,
    );
    if (!this.requireFreshLease()) throw new StorageConflictError('authority lease expired during preload');
    if (!manifest) throw new Error('promoted published manifest is unavailable');
    const replacement = await this.loadVerifiedBindingSet(this.options.files, manifest);
    this.replaceBindingSet(replacement);
  }

  private async loadVerifiedBindingSet(
    files: readonly BrowserOwnerAuthorityFile[],
    manifest: PublishedManifestPointer,
  ): Promise<{
    bindings: Map<FileId, BrowserOwnerAuthorityFile>;
    seeds: Map<FileId, CollabAuthoritySeed>;
  }> {
    const bindings = new Map<FileId, BrowserOwnerAuthorityFile>();
    const seeds = new Map<FileId, CollabAuthoritySeed>();
    for (const file of files) {
      const seed = await this.loadVerifiedBinding(file, manifest);
      if (!this.requireFreshLease()) {
        throw new StorageConflictError('authority lease expired while loading binding set');
      }
      bindings.set(file.fileId, { ...file });
      seeds.set(file.fileId, seed);
    }
    if (bindings.size !== this.authorityFileIds.length) {
      throw new Error('promoted manifest does not cover the complete authority file set');
    }
    return { bindings, seeds };
  }

  private async loadVerifiedBinding(
    file: BrowserOwnerAuthorityFile,
    manifest: PublishedManifestPointer,
  ): Promise<CollabAuthoritySeed> {
    const promoted = manifest.entries.find((entry) => entry.fileId === file.fileId && entry.path === file.path);
    if (
      !promoted ||
      promoted.snapshotId !== file.epoch ||
      promoted.revisionId !== file.revisionId ||
      promoted.contentHash !== file.contentHash
    ) {
      throw new Error('authority file binding does not match the promoted manifest');
    }
    const bytes = await this.options.storage.getRevisionBody(
      this.options.workspaceId,
      file.path,
      file.revisionId,
    );
    if (!this.requireFreshLease()) {
      bytes.fill(0);
      throw new StorageConflictError('authority lease expired while loading revision');
    }
    let doc: PmNode;
    try {
      if (contentHash(bytes) !== file.contentHash) {
        throw new Error('authority revision bytes do not match the published content hash');
      }
      const markdown = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      doc = markdownParser.parse(markdown);
    } finally {
      bytes.fill(0);
    }
    const stored = await this.options.storage.getCollabCheckpoint(
      this.options.workspaceId,
      this.options.roomId,
      file.fileId,
      file.epoch,
    );
    if (!this.requireFreshLease()) throw new StorageConflictError('authority lease expired while loading checkpoint');
    const checkpoint: CollabCheckpoint | null = stored ? {
      v: stored.v,
      epoch: stored.epoch,
      version: stored.version,
      steps: stored.steps,
      clientIDs: stored.clientIDs,
    } : null;
    if (checkpoint) CollabAuthority.fromCheckpoint(doc, file.epoch, checkpoint);
    return {
      epoch: file.epoch,
      baseSnapshotId: file.epoch,
      doc,
      checkpoint,
    };
  }

  private bindingsFromPromotedManifest(
    manifest: PublishedManifestPointer,
  ): BrowserOwnerAuthorityFile[] {
    return this.authorityFileIds.map((fileId) => {
      const matches = manifest.entries.filter((entry) => entry.fileId === fileId);
      if (matches.length !== 1) {
        throw new Error('promoted manifest must contain each authority file exactly once');
      }
      const promoted = matches[0]!;
      if (!promoted.path || !promoted.snapshotId || !promoted.contentHash || !promoted.revisionId) {
        throw new Error('promoted authority binding is incomplete');
      }
      return {
        fileId,
        path: promoted.path,
        revisionId: promoted.revisionId,
        contentHash: promoted.contentHash,
        epoch: promoted.snapshotId,
      };
    });
  }

  private replaceBindingSet(replacement: {
    bindings: Map<FileId, BrowserOwnerAuthorityFile>;
    seeds: Map<FileId, CollabAuthoritySeed>;
  }): void {
    this.bindings.clear();
    this.seeds.clear();
    for (const [fileId, binding] of replacement.bindings) {
      this.bindings.set(fileId, binding);
    }
    for (const [fileId, seed] of replacement.seeds) {
      this.seeds.set(fileId, seed);
    }
  }

  private async restoreCurrentPublishedGeneration(
    session: BrowserOwnerSession,
  ): Promise<void> {
    const manifest = await this.options.storage.loadPublishedManifest(
      this.options.workspaceId,
      this.options.capId,
    );
    if (!this.requireFreshLease()) {
      throw new StorageConflictError('authority lease expired while restoring published generation');
    }
    if (!manifest) throw new Error('promoted published manifest is unavailable while restoring authority');
    const currentBindings = this.bindingsFromPromotedManifest(manifest);
    const replacement = await this.loadVerifiedBindingSet(currentBindings, manifest);
    if (!this.requireFreshLease()) {
      throw new StorageConflictError('authority lease expired while restoring authority');
    }
    this.replaceBindingSet(replacement);
    this.controllerValue = this.buildController(session);
    this.collabEnabled = true;
    this.acceptingAuthorityOperations = true;
    this.setState({
      status: 'active', pauseKind: null, pauseReason: null, pausedFileId: null,
    });
    this.resolveTransitionCollabBarrier();
  }

  private async persistCheckpoint(
    fileId: FileId,
    epoch: string,
    checkpoint: CollabCheckpoint,
    expectedVersion: number,
    generation: number,
    operation: AuthorityOperation,
  ): Promise<void> {
    this.requireCurrentAuthorityGeneration(generation);
    const handle = this.lease;
    if (!handle || this.now() >= handle.expiresAt) {
      this.loseLease('Workspace authority lease expired before checkpoint persistence.');
      throw new StorageConflictError('workspace authority lease expired');
    }
    const seed = this.seeds.get(fileId);
    if (!seed || seed.epoch !== epoch || checkpoint.epoch !== epoch) {
      throw new Error('collaboration checkpoint does not match its authenticated epoch');
    }
    const stored: BrowserCollabCheckpoint = {
      v: 1,
      kind: 'collab_authority_checkpoint',
      roomId: this.options.roomId,
      fileId,
      epoch,
      base: { kind: 'snapshot', id: epoch },
      version: checkpoint.version,
      steps: checkpoint.steps as BrowserCollabCheckpoint['steps'],
      clientIDs: checkpoint.clientIDs,
    };
    const bytes = toCanonicalBytes(stored);
    const plaintextBytes = bytes.length;
    bytes.fill(0);
    if (
      stored.steps.length >= this.rolloverSteps ||
      plaintextBytes >= this.rolloverBytes
    ) {
      const proposed = CollabAuthority.fromCheckpoint(seed.doc, epoch, checkpoint);
      this.requireCurrentAuthorityGeneration(generation);
      await this.transitionPublishedEpochInternal(fileId, {
        publish: (transition) => this.options.rollover.onRequired({
          ...transition,
          epoch,
          nextVersion: checkpoint.version,
          stepCount: stored.steps.length,
          plaintextBytes,
          doc: proposed.doc,
          checkpoint,
        }),
      }, operation);
      throw new BrowserAuthorityRolloverRequiredError(fileId, epoch);
    }
    try {
      this.requireCurrentAuthorityGeneration(generation);
      await this.options.storage.putCollabCheckpoint(
        this.options.workspaceId,
        stored,
        { fence: handle, expectedVersion },
      );
      if (!this.requireFreshLease()) {
        throw new StorageConflictError('authority lease expired after checkpoint persistence');
      }
      this.requireCurrentAuthorityGeneration(generation);
      this.seeds.set(fileId, {
        ...seed,
        checkpoint: {
          v: checkpoint.v,
          epoch: checkpoint.epoch,
          version: checkpoint.version,
          steps: structuredClone(checkpoint.steps),
          clientIDs: [...checkpoint.clientIDs],
        },
      });
    } catch (error) {
      if (error instanceof StorageConflictError) {
        this.loseLease('Workspace authority lease was fenced off during checkpoint persistence.');
      }
      throw error;
    }
  }

  private async runCheckpointPersistence(
    fileId: FileId,
    epoch: string,
    checkpoint: CollabCheckpoint,
    expectedVersion: number,
    generation: number,
  ): Promise<void> {
    const operation = this.beginAuthorityOperation(generation);
    try {
      await this.persistCheckpoint(
        fileId,
        epoch,
        checkpoint,
        expectedVersion,
        generation,
        operation,
      );
    } finally {
      operation.finish();
    }
  }

  private async routeCollabDelivery(delivery: BrowserCollabDelivery): Promise<void> {
    const message = parseCollabWireMessage(delivery.payload);
    // This is the browser workspace's owner-authority boundary. BrowserSession
    // has already authenticated `sender`; only non-mutating remote presence
    // and replay requests cross into the ProseMirror controller. Suggestions
    // arrive as durable SuggestionCreated events and are applied elsewhere by
    // an explicit owner action.
    if (typeof window !== 'undefined' && message) {
      const debug = (window as unknown as { __attnOwnerCollabIn?: Record<string, number> })
        .__attnOwnerCollabIn ??= {};
      debug[message.kind] = (debug[message.kind] ?? 0) + 1;
    }
    if (!message || (message.kind !== 'resync' && message.kind !== 'cursor')) return;
    const barrier = this.transitionCollabBarrier;
    if (barrier) {
      if (barrier.waiters >= MAX_TRANSITION_COLLAB_WAITERS) {
        const error = new Error('too many collaboration deliveries are waiting for epoch transition');
        this.failTransitionCollabBarrier(error);
        throw error;
      }
      barrier.waiters += 1;
      try {
        await barrier.promise;
      } finally {
        barrier.waiters -= 1;
      }
    }
    const controller = this.controllerValue;
    if (!this.collabEnabled || !controller) {
      throw new Error('browser owner collaboration authority is unavailable');
    }
    controller.onInbound(delivery.payload, delivery.sender.deviceId);
  }

  private beginTransitionCollabBarrier(): TransitionCollabBarrier {
    if (this.transitionCollabBarrier) {
      throw new Error('collaboration transition barrier is already active');
    }
    let resolve!: () => void;
    let reject!: (reason: Error) => void;
    const promise = new Promise<void>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    // The barrier may have no waiters; keep rejection from becoming an
    // unhandled promise while preserving rejection for every actual waiter.
    void promise.catch(() => undefined);
    const barrier = { promise, resolve, reject, waiters: 0 };
    this.transitionCollabBarrier = barrier;
    return barrier;
  }

  private requireTransitionCollabBarrier(barrier: TransitionCollabBarrier): void {
    if (this.transitionCollabBarrier !== barrier || this.state.status !== 'transitioning') {
      throw new Error('collaboration epoch transition was interrupted');
    }
  }

  private failTransitionCollabBarrier(reason: Error): void {
    this.rejectTransitionCollabBarrier(reason);
    this.controllerValue = null;
    this.collabEnabled = false;
    this.acceptingAuthorityOperations = false;
    this.controllerGeneration += 1;
    this.setState({
      status: 'paused',
      pauseKind: 'checkpoint_failed',
      pauseReason: reason.message,
    });
  }

  private resolveTransitionCollabBarrier(): void {
    const barrier = this.transitionCollabBarrier;
    if (!barrier) return;
    this.transitionCollabBarrier = null;
    barrier.resolve();
  }

  private rejectTransitionCollabBarrier(reason: unknown): void {
    const barrier = this.transitionCollabBarrier;
    if (!barrier) return;
    this.transitionCollabBarrier = null;
    barrier.reject(reason instanceof Error ? reason : new Error(String(reason)));
  }

  private async runAuthoritySend(
    generation: number,
    session: BrowserOwnerSession,
    payload: string,
  ): Promise<void> {
    this.requireCurrentAuthorityGeneration(generation);
    // Automation/introspection counters, mirroring the reviewer pipeline's
    // window.__attnReviewCollab — lets E2E probes localize a dark link.
    const debug = typeof window === 'undefined'
      ? null
      : ((window as unknown as { __attnOwnerCollab?: { attempts: number; sent: number; failed: number; lastError: string | null; kinds: string[] } })
          .__attnOwnerCollab ??= { attempts: 0, sent: 0, failed: 0, lastError: null, kinds: [] });
    if (debug) {
      debug.attempts += 1;
      try {
        const parsed = JSON.parse(payload) as { kind?: string; epoch?: string };
        if (debug.kinds.length < 80) debug.kinds.push(`${parsed.kind ?? '?'}@${parsed.epoch?.slice(0, 8) ?? ''}`);
      } catch { /* introspection only */ }
    }
    // A send that belongs to an already-persisted host batch may begin while
    // transition quiescence is draining that generation. Track and await it.
    const operation = this.beginAuthorityOperation(generation, true);
    try {
      await session.sendCollab(payload);
      if (debug) debug.sent += 1;
      this.requireCurrentAuthorityGeneration(generation);
    } catch (error) {
      if (debug) {
        debug.failed += 1;
        debug.lastError = error instanceof Error ? error.message : String(error);
      }
      throw error;
    } finally {
      operation.finish();
    }
  }

  private beginAuthorityOperation(
    generation: number,
    allowDuringQuiescence = false,
  ): AuthorityOperation {
    this.requireCurrentAuthorityGeneration(generation);
    if (!allowDuringQuiescence && !this.acceptingAuthorityOperations) {
      throw new Error('collaboration authority is quiescing');
    }
    let resolveDone!: () => void;
    let finished = false;
    const operation: AuthorityOperation = {
      generation,
      done: new Promise<void>((resolve) => { resolveDone = resolve; }),
      finish: () => {
        if (finished) return;
        finished = true;
        this.inFlightAuthorityOperations.delete(operation);
        resolveDone();
      },
    };
    this.inFlightAuthorityOperations.add(operation);
    return operation;
  }

  private async quiesceGeneration(
    generation: number,
    excluded?: AuthorityOperation,
  ): Promise<void> {
    while (true) {
      const pending = [...this.inFlightAuthorityOperations]
        .filter((operation) => operation.generation === generation && operation !== excluded)
        .map((operation) => operation.done);
      if (pending.length > 0) await Promise.all(pending);
      // Let a CollabHost continuation move from completed persistence into its
      // tracked broadcast before deciding the generation is drained.
      await Promise.resolve();
      const remaining = [...this.inFlightAuthorityOperations].some(
        (operation) => operation.generation === generation && operation !== excluded,
      );
      if (!remaining) return;
    }
  }

  private isAuthorityGenerationActive(generation: number): boolean {
    return generation === this.controllerGeneration
      && this.collabEnabled
      && this.acceptingAuthorityOperations;
  }

  private requireCurrentAuthorityGeneration(generation: number): void {
    if (generation !== this.controllerGeneration) {
      throw new Error('stale collaboration authority generation');
    }
  }

  private buildController(session: BrowserOwnerSession): CollabController {
    const generation = ++this.controllerGeneration;
    return new CollabController({
      isOwner: true,
      send: (payload) => this.runAuthoritySend(generation, session, payload),
      selfClientId: this.options.collab.selfClientId,
      selfLabel: this.options.collab.selfLabel,
      selfColor: this.options.collab.selfColor,
      getAuthorityEpoch: (fileId) => this.isAuthorityGenerationActive(generation)
        ? this.seeds.get(fileId)?.epoch ?? null
        : null,
      getAuthoritySeed: (fileId, epoch) => {
        if (!this.isAuthorityGenerationActive(generation)) return null;
        const seed = this.seeds.get(fileId);
        return seed?.epoch === epoch ? seed : null;
      },
      persistCheckpoint: (fileId, epoch, checkpoint, expectedVersion) =>
        this.runCheckpointPersistence(
          fileId,
          epoch,
          checkpoint,
          expectedVersion,
          generation,
        ),
      onEpochMismatch: this.options.collab.onEpochMismatch,
      onAuthorityPaused: (fileId, reason) => {
        if (generation !== this.controllerGeneration || !this.collabEnabled) return;
        this.collabEnabled = false;
        this.acceptingAuthorityOperations = false;
        this.controllerValue = null;
        this.controllerGeneration += 1;
        this.rejectTransitionCollabBarrier(new Error(reason));
        this.setState({
          status: 'paused',
          pauseKind: reason.includes('checkpoint rollover required')
            ? 'rollover_required'
            : 'checkpoint_failed',
          pauseReason: reason,
          pausedFileId: fileId,
        });
        this.options.collab.onAuthorityPaused?.(fileId, reason);
      },
      onRemoteCursors: this.options.collab.onRemoteCursors,
      getLocation: this.options.collab.getLocation,
      onPeerLocation: this.options.collab.onPeerLocation,
    });
  }

  private scheduleHeartbeat(): void {
    if (!this.lease || this.state.status === 'closed') return;
    if (this.heartbeatTimer !== null) this.cancelScheduled(this.heartbeatTimer);
    this.heartbeatTimer = this.schedule(() => {
      this.heartbeatTimer = null;
      void this.heartbeat();
    }, this.heartbeatIntervalMs);
  }

  private async heartbeat(): Promise<void> {
    const handle = this.lease;
    if (!handle || this.state.status === 'closed') return;
    if (this.now() >= handle.expiresAt) {
      this.loseLease('Workspace authority lease expired.');
      return;
    }
    try {
      const renewed = await this.options.leaseManager.heartbeat(handle);
      if (!this.lease || this.lease.fencingToken !== handle.fencingToken) return;
      if (renewed.expiresAt <= this.now()) {
        this.loseLease('Workspace authority heartbeat returned an expired lease.');
        return;
      }
      this.lease = renewed;
      this.setState({ lease: { ...renewed } });
      this.armExpiryWatchdog();
      this.scheduleHeartbeat();
    } catch (error) {
      this.loseLease(error instanceof Error ? error.message : 'Workspace authority lease was lost.');
    }
  }

  private armExpiryWatchdog(): void {
    if (this.expiryTimer !== null) this.cancelScheduled(this.expiryTimer);
    const handle = this.lease;
    if (!handle) return;
    const delay = Math.max(0, handle.expiresAt - this.now() + 1);
    this.expiryTimer = this.schedule(() => {
      this.expiryTimer = null;
      if (this.lease && this.now() >= this.lease.expiresAt) {
        this.loseLease('Workspace authority lease expired.');
      }
    }, delay);
  }

  private loseLease(reason: string): void {
    if (this.state.status === 'closed' || this.state.pauseKind === 'lease_lost') return;
    // Transport closes before any asynchronous cleanup or observer callback.
    this.sessionValue?.close();
    // Detach the stale authority graph before surfacing pause. Callers holding
    // only this service can no longer submit into a fenced host.
    this.sessionValue = null;
    this.controllerValue = null;
    this.collabEnabled = false;
    this.acceptingAuthorityOperations = false;
    this.controllerGeneration += 1;
    this.rejectTransitionCollabBarrier(new Error(reason));
    this.clearLeaseTimers();
    this.lease = null;
    this.setState({
      status: 'paused',
      pauseKind: 'lease_lost',
      pauseReason: reason,
      pausedFileId: null,
      lease: null,
    });
  }

  private pauseTransport(kind: BrowserOwnerAuthorityPauseKind, reason: string): void {
    this.sessionValue?.close();
    this.sessionValue = null;
    this.controllerValue = null;
    this.collabEnabled = false;
    this.acceptingAuthorityOperations = false;
    this.controllerGeneration += 1;
    this.rejectTransitionCollabBarrier(new Error(reason));
    this.setState({ status: 'paused', pauseKind: kind, pauseReason: reason });
  }

  private clearLeaseTimers(): void {
    if (this.heartbeatTimer !== null) this.cancelScheduled(this.heartbeatTimer);
    if (this.expiryTimer !== null) this.cancelScheduled(this.expiryTimer);
    this.heartbeatTimer = null;
    this.expiryTimer = null;
  }

  private requireFreshLease(): boolean {
    if (!this.lease || this.state.status === 'closed' || this.state.pauseKind === 'lease_lost') return false;
    if (this.now() >= this.lease.expiresAt) {
      this.loseLease('Workspace authority lease expired.');
      return false;
    }
    return true;
  }

  private setState(patch: Partial<BrowserOwnerAuthorityState>): void {
    this.state = { ...this.state, ...patch };
    this.options.onState?.(this.state);
  }
}
