import type { Anchor, AnchorBlockKind, ReviewEvent, SuggestionDraft } from '../types';
import type {
  DurableShareSnapshot,
  DurableShareTier,
  ResolvedDurableShare,
} from './browser-share-resolver';

const PROTOCOL_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const BUNDLE_ID = /^[A-Za-z0-9_-]{22}$/u;
const SHA256_BASE64URL = /^[A-Za-z0-9_-]{43}$/u;
const MAX_COMMENT_WIRE_BYTES = 512 * 1024;

export interface OfflineCommentDraft {
  draftId: string;
  anchor: Anchor;
  body: string;
  threadId?: string;
}

/** Mutable assembler output; BrowserShareSession immediately copies and hashes it. */
export interface OfflineCommentSubmission {
  envelopeId: string;
  epoch: number;
  roomId: string;
  bundleId: string;
  revision: number;
  tier: DurableShareTier;
  capabilityFingerprint: string;
  canonicalWireBytes: Uint8Array;
  event?: ReviewEvent;
}

export interface PersistedOfflineComment {
  state: 'pending' | 'retryable';
  shareId: string;
  bundleId: string;
  epoch: number;
  revision: number;
  tier: DurableShareTier;
  roomId: string;
  capabilityFingerprint: string;
  envelopeId: string;
  wireHash: string;
  canonicalWireBytes: Uint8Array;
  draft: OfflineCommentDraft;
}

export interface PersistedStaleDraft {
  state: 'stale';
  shareId: string;
  bundleId: string;
  draft: OfflineCommentDraft;
}

export type PersistedShareOutboxEntry = PersistedOfflineComment | PersistedStaleDraft;

export type DurableShareOutboxTransition =
  | { kind: 'enqueue'; record: PersistedOfflineComment }
  | { kind: 'retry_stale'; draftId: string; record: PersistedOfflineComment }
  | { kind: 'retryable'; envelopeId: string; expectedWireHash: string }
  | { kind: 'stale'; envelopeId: string; expectedWireHash: string; record: PersistedStaleDraft }
  | { kind: 'ack'; envelopeId: string; expectedWireHash: string }
  | { kind: 'remove_stale'; draftId: string };

/** Every transition must commit atomically before its promise resolves. */
export interface DurableShareOutboxStore {
  hydrate(shareId: string, bundleId: string): Promise<PersistedShareOutboxEntry[]>;
  transition(shareId: string, bundleId: string, transition: DurableShareOutboxTransition): Promise<void>;
  dispose(): void | Promise<void>;
}

export interface ShareMailboxReceipt {
  envelopeId: string;
  seq: number;
  status: 'accepted' | 'duplicate';
  bundleId: string;
  epoch: number;
  revision: number;
  tier: DurableShareTier;
  roomId: string;
  capabilityFingerprint: string;
  wireHash: string;
}

export interface ShareMailboxTransport {
  submit(input: {
    shareId: string;
    bundleId: string;
    epoch: number;
    revision: number;
    tier: DurableShareTier;
    roomId: string;
    capability: unknown;
    capabilityFingerprint: string;
    envelopeId: string;
    wireHash: string;
    canonicalWireBytes: Uint8Array;
    signal?: AbortSignal;
  }): Promise<ShareMailboxReceipt>;
}

export class StaleShareEpochError extends Error {
  constructor(readonly currentEpoch?: number) {
    super('share epoch changed while the comment was being submitted');
    this.name = 'StaleShareEpochError';
  }
}

export interface DurableLiveSession {
  start(): void | Promise<void>;
  close(): void;
  createComment(anchor: Anchor, body: string, threadId?: string): Promise<ReviewEvent>;
  replyToComment(anchor: Anchor, body: string, threadId: string): Promise<ReviewEvent>;
  resolveComment(threadId: string): Promise<ReviewEvent>;
  createSuggestion(draft: SuggestionDraft): Promise<ReviewEvent>;
  retryOutbox?(): Promise<void>;
}

export interface ShareChangeSubscription { close(): void; }
export interface BrowserShareResolutionSource { resolve(signal?: AbortSignal): Promise<ResolvedDurableShare>; }

export interface BrowserShareSessionState {
  status: 'idle' | 'resolving' | 'ready' | 'upgrading' | 'error' | 'terminated';
  source: 'room' | 'share_snapshot';
  ownerOnline: boolean;
  tier: DurableShareTier;
  canComment: boolean;
  canSuggest: boolean;
  epoch: number | null;
  roomId: string | null;
  snapshots: DurableShareSnapshot[];
  pendingComments: number;
  staleDrafts: OfflineCommentDraft[];
  error: string | null;
}

export type OptimisticCommentPhase = 'hydrated' | 'queued' | 'retryable' | 'accepted' | 'stale';

export interface BrowserShareSessionOptions {
  shareId: string;
  resolver: BrowserShareResolutionSource;
  mailbox: ShareMailboxTransport;
  outboxStore: DurableShareOutboxStore;
  digestWire(canonicalWireBytes: Uint8Array): Promise<string> | string;
  /** SHA-256 base64url commitment to bundleId,tier,epoch,revision,roomId and the mailbox capability. */
  capabilityFingerprint(resolution: ResolvedDurableShare): string;
  assembleOfflineComment(input: {
    shareId: string;
    resolution: ResolvedDurableShare;
    draft: OfflineCommentDraft;
  }): Promise<OfflineCommentSubmission> | OfflineCommentSubmission;
  createLiveSession(input: { resolution: ResolvedDurableShare }): Promise<DurableLiveSession> | DurableLiveSession;
  subscribeToChanges(input: {
    shareId: string;
    onChange: () => void;
    onError: (error: unknown) => void;
  }): ShareChangeSubscription;
  onState?(state: BrowserShareSessionState): void;
  onSnapshot?(snapshot: DurableShareSnapshot, resolution: ResolvedDurableShare): void;
  onOptimisticEvent?(event: ReviewEvent): void;
  onOptimisticLifecycle?(input: {
    phase: OptimisticCommentPhase;
    draft: OfflineCommentDraft;
    envelopeId?: string;
    event?: ReviewEvent;
  }): void;
  disposeResolution(resolution: ResolvedDurableShare): void;
  disposeSensitive(): void;
  randomDraftId?(): string;
}

interface FrozenPending {
  draft: OfflineCommentDraft;
  envelopeId: string;
  epoch: number;
  revision: number;
  tier: DurableShareTier;
  roomId: string;
  bundleId: string;
  capabilityFingerprint: string;
  wireHash: string;
  wireBytes: Uint8Array;
  event?: ReviewEvent;
  state: 'pending' | 'retryable';
}

export class BrowserShareSession {
  private readonly options: BrowserShareSessionOptions;
  private state: BrowserShareSessionState = {
    status: 'idle', source: 'share_snapshot', ownerOnline: false, tier: 'view',
    canComment: false, canSuggest: false, epoch: null, roomId: null, snapshots: [],
    pendingComments: 0, staleDrafts: [], error: null,
  };
  private resolution: ResolvedDurableShare | null = null;
  private live: DurableLiveSession | null = null;
  private subscription: ShareChangeSubscription | null = null;
  private abort: AbortController | null = null;
  private readonly pending = new Map<string, FrozenPending>();
  private readonly hydratedBundles = new Set<string>();
  private refreshInFlight: Promise<void> | null = null;
  private refreshQueued = false;
  private generation = 0;

  constructor(options: BrowserShareSessionOptions) { this.options = options; }

  getState(): BrowserShareSessionState {
    return { ...this.state, snapshots: [...this.state.snapshots], staleDrafts: this.state.staleDrafts.map(cloneDraft) };
  }

  /** Package integration seam. Consumers must copy capability bytes synchronously. */
  currentResolutionForIntegration(): ResolvedDurableShare | null {
    return this.resolution;
  }

  async start(): Promise<void> {
    if (this.state.status !== 'idle' && this.state.status !== 'error') return;
    const generation = ++this.generation;
    this.patch({ status: 'resolving', error: null });
    this.abort?.abort();
    this.abort = new AbortController();
    this.subscription?.close();
    this.subscription = null;
    try {
      // Subscribe first, then resolve immediately. Any change in the gap sets
      // refreshQueued and forces a second fenced resolve.
      const subscription = this.options.subscribeToChanges({
        shareId: this.options.shareId,
        onChange: () => {
          void this.handleShareChange(generation).catch((error) => {
            if (this.isCurrent(generation)) this.patch({ error: safeMessage(error) });
          });
        },
        onError: (error) => {
          if (!this.isCurrent(generation)) return;
          if (isTerminalSubscriptionError(error)) this.close();
          else this.patch({ error: safeMessage(error) });
        },
      });
      if (!this.isCurrent(generation)) { subscription.close(); return; }
      this.subscription = subscription;
      await this.handleShareChange(generation);
    } catch (error) {
      if (this.isCurrent(generation)) {
        this.subscription?.close();
        this.subscription = null;
        this.patch({ status: 'error', error: safeMessage(error) });
      }
    }
  }

  close(): void {
    if (this.isTerminated()) return;
    ++this.generation;
    this.abort?.abort(); this.abort = null;
    this.subscription?.close(); this.subscription = null;
    this.live?.close(); this.live = null;
    if (this.resolution) this.disposeResolution(this.resolution);
    this.resolution = null;
    for (const pending of this.pending.values()) pending.wireBytes.fill(0);
    this.pending.clear();
    try {
      const disposal = this.options.outboxStore.dispose();
      if (disposal instanceof Promise) void disposal.catch(() => undefined);
    } catch {
      // All sensitive in-memory copies are still cleared below.
    }
    this.hydratedBundles.clear();
    try { this.options.disposeSensitive(); } catch { /* Continue clearing observable state. */ }
    this.patch({ status: 'terminated', source: 'share_snapshot', ownerOnline: false, tier: 'view',
      canComment: false, canSuggest: false, epoch: null, roomId: null, pendingComments: 0,
      snapshots: [], staleDrafts: [], error: null });
  }

  async createComment(anchor: Anchor, body: string, threadId?: string): Promise<ReviewEvent | undefined> {
    const resolution = this.requireReady();
    this.requireWritable(resolution);
    if (this.live) return this.live.createComment(anchor, body, threadId);
    const text = body.trim();
    if (!text) throw new Error('comment body cannot be empty');
    const draft: OfflineCommentDraft = {
      draftId: this.options.randomDraftId?.() ?? randomId(), anchor: cloneAndFreezeAnchor(anchor), body: text,
      ...(threadId === undefined ? {} : { threadId }),
    };
    return this.submitNewDraft(draft, resolution);
  }

  async replyToComment(anchor: Anchor, body: string, threadId: string): Promise<ReviewEvent | undefined> {
    return this.createComment(anchor, body, threadId);
  }

  async resolveComment(threadId: string): Promise<ReviewEvent> {
    const resolution = this.requireReady();
    this.requireWritable(resolution);
    if (!this.live) throw new Error('comments can only be resolved while the owner room is live');
    return this.live.resolveComment(threadId);
  }

  async createSuggestion(draft: SuggestionDraft): Promise<ReviewEvent> {
    const resolution = this.requireReady();
    if (resolution.bundle.tier !== 'suggest') throw new Error('suggestion authoring requires suggest grant');
    if (!this.live) throw new Error('suggestions require a live owner room');
    return this.live.createSuggestion(draft);
  }

  async retryOutbox(): Promise<void> {
    const resolution = this.requireReady();
    this.requireWritable(resolution);
    for (const pending of [...this.pending.values()]) if (pending.state === 'retryable') await this.sendFrozen(pending);
    await this.live?.retryOutbox?.();
  }

  async refreshNow(): Promise<void> { await this.handleShareChange(this.generation); }

  async retryStaleDraft(draftId: string): Promise<ReviewEvent | undefined> {
    let resolution = this.requireReady();
    this.requireWritable(resolution);
    const draft = this.state.staleDrafts.find((candidate) => candidate.draftId === draftId);
    if (!draft) throw new Error('stale comment draft was not found');
    await this.refreshNow();
    resolution = this.requireReady();
    this.requireWritable(resolution);
    let event: ReviewEvent | undefined;
    if (this.live) event = await this.live.createComment(draft.anchor, draft.body, draft.threadId);
    else return this.submitNewDraft(draft, resolution, draftId);
    await this.options.outboxStore.transition(this.options.shareId, resolution.record.bundleId, { kind: 'remove_stale', draftId });
    this.patch({ staleDrafts: this.state.staleDrafts.filter((item) => item.draftId !== draftId) });
    return event;
  }

  private async submitNewDraft(
    draft: OfflineCommentDraft,
    resolution: ResolvedDurableShare,
    replacesStaleDraftId?: string,
  ): Promise<ReviewEvent | undefined> {
    const assembled = await this.options.assembleOfflineComment({ shareId: this.options.shareId, resolution, draft: cloneDraft(draft) });
    let wireBytes: Uint8Array;
    try {
      validateAssembled(assembled, resolution, expectedFingerprint(this.options, resolution));
      wireBytes = new Uint8Array(assembled.canonicalWireBytes);
    } finally {
      if (assembled.canonicalWireBytes instanceof Uint8Array) assembled.canonicalWireBytes.fill(0);
    }
    if (wireBytes.byteLength < 1 || wireBytes.byteLength > MAX_COMMENT_WIRE_BYTES) {
      wireBytes.fill(0); throw new Error('offline comment wire size is invalid');
    }
    let wireHash: string;
    try { wireHash = await this.options.digestWire(wireBytes); }
    catch (error) { wireBytes.fill(0); throw error; }
    if (!SHA256_BASE64URL.test(wireHash)) { wireBytes.fill(0); throw new Error('offline comment wire hash is invalid'); }
    const pending: FrozenPending = {
      draft: cloneDraft(draft), envelopeId: assembled.envelopeId, epoch: assembled.epoch,
      revision: assembled.revision, tier: assembled.tier,
      roomId: assembled.roomId, bundleId: assembled.bundleId,
      capabilityFingerprint: assembled.capabilityFingerprint, wireHash, wireBytes,
      ...(assembled.event === undefined ? {} : { event: assembled.event }), state: 'pending',
    };
    if (this.pending.has(pending.envelopeId)) { wireBytes.fill(0); throw new Error('offline comment envelope id is already pending'); }
    const record = persisted(pending, this.options.shareId);
    try {
      await this.options.outboxStore.transition(this.options.shareId, pending.bundleId,
        replacesStaleDraftId === undefined
          ? { kind: 'enqueue', record }
          : { kind: 'retry_stale', draftId: replacesStaleDraftId, record });
    } catch (error) {
      wireBytes.fill(0);
      throw error;
    } finally { record.canonicalWireBytes.fill(0); }
    if (replacesStaleDraftId !== undefined) {
      this.patch({ staleDrafts: this.state.staleDrafts.filter((item) => item.draftId !== replacesStaleDraftId) });
    }
    this.pending.set(pending.envelopeId, pending);
    if (pending.event) {
      try { this.options.onOptimisticEvent?.(pending.event); } catch { /* Durability already won. */ }
    }
    this.emitLifecycle('queued', pending);
    this.publishPending();
    await this.sendFrozen(pending);
    return pending.event;
  }

  private async sendFrozen(pending: FrozenPending): Promise<void> {
    const resolution = this.requireReady();
    this.requireWritable(resolution);
    if (
      pending.bundleId !== resolution.record.bundleId || pending.epoch !== resolution.record.epoch ||
      pending.revision !== resolution.record.revision || pending.tier !== resolution.bundle.tier ||
      pending.roomId !== resolution.bundle.roomId || pending.capabilityFingerprint !== expectedFingerprint(this.options, resolution)
    ) {
      await this.markStale(pending); throw new StaleShareEpochError(resolution.record.epoch);
    }
    const transportBytes = new Uint8Array(pending.wireBytes);
    try {
      const receipt = await this.options.mailbox.submit({
        shareId: this.options.shareId, bundleId: pending.bundleId, epoch: pending.epoch,
        revision: pending.revision, tier: pending.tier, roomId: pending.roomId,
        capability: resolution.bundle.shareMailboxCapability,
        capabilityFingerprint: pending.capabilityFingerprint, envelopeId: pending.envelopeId,
        wireHash: pending.wireHash, canonicalWireBytes: transportBytes,
        ...(this.abort === null ? {} : { signal: this.abort.signal }),
      });
      validateReceipt(receipt, pending);
      await this.options.outboxStore.transition(this.options.shareId, pending.bundleId, {
        kind: 'ack', envelopeId: pending.envelopeId, expectedWireHash: pending.wireHash,
      });
      this.pending.delete(pending.envelopeId); pending.wireBytes.fill(0);
      this.emitLifecycle('accepted', pending);
      this.patch({ error: null }); this.publishPending();
    } catch (error) {
      if (error instanceof StaleShareEpochError) await this.markStale(pending);
      else {
        pending.state = 'retryable';
        await this.options.outboxStore.transition(this.options.shareId, pending.bundleId, {
          kind: 'retryable', envelopeId: pending.envelopeId, expectedWireHash: pending.wireHash,
        });
        this.emitLifecycle('retryable', pending);
        this.patch({ error: safeMessage(error) });
      }
      this.publishPending(); throw error;
    } finally { transportBytes.fill(0); }
  }

  private async markStale(pending: FrozenPending): Promise<void> {
    if (!this.pending.has(pending.envelopeId)) return;
    const stale = { state: 'stale' as const, shareId: this.options.shareId, bundleId: pending.bundleId, draft: cloneDraft(pending.draft) };
    await this.options.outboxStore.transition(this.options.shareId, pending.bundleId, {
      kind: 'stale', envelopeId: pending.envelopeId, expectedWireHash: pending.wireHash, record: stale,
    });
    this.pending.delete(pending.envelopeId); pending.wireBytes.fill(0);
    if (!this.state.staleDrafts.some((item) => item.draftId === pending.draft.draftId)) {
      this.patch({ staleDrafts: [...this.state.staleDrafts, cloneDraft(pending.draft)] });
    }
    this.emitLifecycle('stale', pending);
    this.patch({ error: 'The share changed. Your comment draft was preserved for retry.' });
  }

  private async handleShareChange(generation: number): Promise<void> {
    if (!this.isCurrent(generation)) return;
    if (this.refreshInFlight) { this.refreshQueued = true; return this.refreshInFlight; }
    const run = (async () => {
      do { this.refreshQueued = false; await this.refresh(generation, this.abort?.signal); }
      while (this.refreshQueued && this.isCurrent(generation));
    })().finally(() => { if (this.refreshInFlight === run) this.refreshInFlight = null; });
    this.refreshInFlight = run; return run;
  }

  private async refresh(generation: number, signal?: AbortSignal): Promise<void> {
    const next = await this.options.resolver.resolve(signal);
    if (!this.isCurrent(generation)) { this.disposeResolution(next); return; }
    let candidate: DurableLiveSession | null = null;
    let committed = false;
    try {
      await this.hydrate(next);
      if (!this.isCurrent(generation)) return;
      await this.reconcilePending(next);
      if (!this.isCurrent(generation)) return;
      let nextLive = this.live;
      if (next.source === 'room' && (!this.live || this.resolution?.bundle.roomId !== next.bundle.roomId)) {
        this.patch({ status: 'upgrading' });
        candidate = await this.options.createLiveSession({ resolution: next });
        await candidate.start();
        if (!this.isCurrent(generation)) return;
        nextLive = candidate;
      }
      const oldLive = this.live;
      const oldResolution = this.resolution;
      this.live = next.source === 'room' ? nextLive : null;
      this.resolution = next;
      committed = true;
      candidate = null;
      if (oldLive && oldLive !== this.live) oldLive.close();
      if (oldResolution && oldResolution !== next) this.disposeResolution(oldResolution);
      for (const snapshot of next.snapshots) {
        try { this.options.onSnapshot?.(snapshot, next); } catch { /* Session state remains authoritative. */ }
      }
      this.patchFromResolution(next);
    } finally {
      candidate?.close();
      if (!committed) this.disposeResolution(next);
    }
  }

  private async hydrate(resolution: ResolvedDurableShare): Promise<void> {
    const bundleId = resolution.record.bundleId;
    if (this.hydratedBundles.has(bundleId)) return;
    const entries = await this.options.outboxStore.hydrate(this.options.shareId, bundleId);
    const staged: FrozenPending[] = [];
    const stale: OfflineCommentDraft[] = [];
    try {
      for (const entry of entries) {
        if (entry.shareId !== this.options.shareId || entry.bundleId !== bundleId) throw new Error('persisted share outbox scope mismatch');
        if (entry.state === 'stale') { validateDraft(entry.draft); stale.push(cloneDraft(entry.draft)); continue; }
        if (resolution.bundle.tier === 'view') throw new Error('view share contains a persisted mutating outbox record');
        validatePersisted(entry);
        const bytes = new Uint8Array(entry.canonicalWireBytes);
        let transferred = false;
        try {
          const hash = await this.options.digestWire(bytes);
          if (hash !== entry.wireHash) throw new Error('persisted share outbox wire hash mismatch');
          const pending: FrozenPending = {
            draft: cloneDraft(entry.draft), envelopeId: entry.envelopeId, epoch: entry.epoch,
            revision: entry.revision, tier: entry.tier, roomId: entry.roomId, bundleId: entry.bundleId,
            capabilityFingerprint: entry.capabilityFingerprint, wireHash: entry.wireHash,
            wireBytes: bytes, state: 'retryable',
          };
          if (this.pending.has(pending.envelopeId) || staged.some(item => item.envelopeId === pending.envelopeId)) {
            throw new Error('persisted share outbox contains duplicate envelope ids');
          }
          staged.push(pending);
          transferred = true;
        } finally {
          if (!transferred) bytes.fill(0);
        }
      }
      for (const pending of staged) this.pending.set(pending.envelopeId, pending);
      const staleIds = new Set(this.state.staleDrafts.map(item => item.draftId));
      this.patch({ staleDrafts: [...this.state.staleDrafts, ...stale.filter(item => !staleIds.has(item.draftId))] });
      this.hydratedBundles.add(bundleId);
      for (const pending of staged) this.emitLifecycle('hydrated', pending);
      this.publishPending();
    } catch (error) {
      for (const pending of staged) pending.wireBytes.fill(0);
      throw error;
    } finally {
      for (const entry of entries) if (entry.state !== 'stale' && entry.canonicalWireBytes instanceof Uint8Array) entry.canonicalWireBytes.fill(0);
    }
  }

  private async reconcilePending(resolution: ResolvedDurableShare): Promise<void> {
    for (const pending of [...this.pending.values()]) {
      if (
        pending.bundleId !== resolution.record.bundleId || pending.epoch < resolution.record.epoch ||
        pending.revision !== resolution.record.revision || pending.tier !== resolution.bundle.tier ||
        pending.roomId !== resolution.bundle.roomId || pending.capabilityFingerprint !== expectedFingerprint(this.options, resolution)
      ) await this.markStale(pending);
      else if (pending.epoch > resolution.record.epoch) throw new Error('persisted outbox epoch exceeds resolved share epoch');
    }
  }

  private patchFromResolution(resolution: ResolvedDurableShare): void {
    const live = resolution.source === 'room'; const tier = resolution.bundle.tier;
    this.patch({ status: 'ready', source: resolution.source, ownerOnline: live, tier,
      canComment: tier !== 'view', canSuggest: live && tier === 'suggest', epoch: resolution.record.epoch,
      roomId: resolution.bundle.roomId, snapshots: resolution.snapshots, error: null });
  }

  private requireReady(): ResolvedDurableShare {
    if (this.state.status !== 'ready' || !this.resolution) throw new Error('durable share is not ready');
    return this.resolution;
  }
  private requireWritable(resolution: ResolvedDurableShare): void {
    if (resolution.bundle.tier === 'view' || resolution.bundle.shareMailboxCapability == null) throw new Error('view share cannot mutate');
  }
  private isCurrent(generation: number): boolean { return generation === this.generation && !this.isTerminated(); }
  private isTerminated(): boolean { return this.state.status === 'terminated'; }
  private emitLifecycle(phase: OptimisticCommentPhase, pending: FrozenPending): void {
    try {
      this.options.onOptimisticLifecycle?.({
        phase, draft: cloneDraft(pending.draft), envelopeId: pending.envelopeId, event: pending.event,
      });
    } catch {
      // UI optimism cannot alter durable queue transitions.
    }
  }
  private disposeResolution(resolution: ResolvedDurableShare): void {
    try { this.options.disposeResolution(resolution); } catch { /* Continue lifecycle teardown. */ }
  }
  private publishPending(): void { this.patch({ pendingComments: this.pending.size }); }
  private patch(patch: Partial<BrowserShareSessionState>): void {
    this.state = { ...this.state, ...patch };
    try { this.options.onState?.(this.getState()); } catch { /* Rendering cannot corrupt session state. */ }
  }
}

function persisted(pending: FrozenPending, shareId: string): PersistedOfflineComment {
  return { state: pending.state, shareId, bundleId: pending.bundleId, epoch: pending.epoch,
    revision: pending.revision, tier: pending.tier,
    roomId: pending.roomId, capabilityFingerprint: pending.capabilityFingerprint,
    envelopeId: pending.envelopeId, wireHash: pending.wireHash,
    canonicalWireBytes: new Uint8Array(pending.wireBytes), draft: cloneDraft(pending.draft) };
}
function validateAssembled(value: OfflineCommentSubmission, resolution: ResolvedDurableShare, fingerprint: string): void {
  if (!PROTOCOL_ID.test(value.envelopeId) || value.epoch !== resolution.record.epoch ||
    value.revision !== resolution.record.revision || value.tier !== resolution.bundle.tier ||
    value.roomId !== resolution.bundle.roomId || value.bundleId !== resolution.record.bundleId ||
    !SHA256_BASE64URL.test(value.capabilityFingerprint) || value.capabilityFingerprint !== fingerprint ||
    !(value.canonicalWireBytes instanceof Uint8Array)) throw new Error('offline comment assembler returned a mismatched submission');
}
function validatePersisted(value: PersistedOfflineComment): void {
  if (!PROTOCOL_ID.test(value.envelopeId) || !BUNDLE_ID.test(value.bundleId) ||
    !Number.isSafeInteger(value.epoch) || value.epoch < 0 || !PROTOCOL_ID.test(value.roomId) ||
    !Number.isSafeInteger(value.revision) || value.revision < 0 ||
    (value.tier !== 'view' && value.tier !== 'comment' && value.tier !== 'suggest') ||
    !SHA256_BASE64URL.test(value.wireHash) || !(value.canonicalWireBytes instanceof Uint8Array) ||
    value.canonicalWireBytes.byteLength < 1 || value.canonicalWireBytes.byteLength > MAX_COMMENT_WIRE_BYTES ||
    !SHA256_BASE64URL.test(value.capabilityFingerprint)) throw new Error('persisted share outbox record is invalid');
  validateDraft(value.draft);
}
function validateDraft(draft: OfflineCommentDraft): void {
  if (!PROTOCOL_ID.test(draft.draftId) || typeof draft.body !== 'string' || !draft.body.trim() || draft.body.length > 256 * 1024 ||
    (draft.threadId !== undefined && !PROTOCOL_ID.test(draft.threadId))) throw new Error('persisted comment draft is invalid');
  cloneAndFreezeAnchor(draft.anchor);
}
function validateReceipt(receipt: ShareMailboxReceipt, pending: FrozenPending): void {
  if (receipt.envelopeId !== pending.envelopeId || receipt.bundleId !== pending.bundleId ||
    receipt.epoch !== pending.epoch || receipt.revision !== pending.revision || receipt.tier !== pending.tier ||
    receipt.roomId !== pending.roomId || receipt.capabilityFingerprint !== pending.capabilityFingerprint ||
    receipt.wireHash !== pending.wireHash ||
    !Number.isSafeInteger(receipt.seq) || receipt.seq < 1 ||
    (receipt.status !== 'accepted' && receipt.status !== 'duplicate')) throw new Error('share mailbox acknowledgement is invalid');
}
function cloneDraft(draft: OfflineCommentDraft): OfflineCommentDraft {
  return { draftId: draft.draftId, anchor: cloneAndFreezeAnchor(draft.anchor), body: draft.body, ...(draft.threadId === undefined ? {} : { threadId: draft.threadId }) };
}
function expectedFingerprint(options: BrowserShareSessionOptions, resolution: ResolvedDurableShare): string {
  const value = options.capabilityFingerprint(resolution);
  if (!SHA256_BASE64URL.test(value)) throw new Error('mailbox capability fingerprint is invalid');
  return value;
}
function cloneAndFreezeAnchor(value: unknown): Anchor {
  if (!recordWith(value, ['v', 'fileId', 'snapshotId', 'baseHash', 'position', 'quote', 'block', 'context', 'structure']) ||
    value.v !== 2 || !PROTOCOL_ID.test(value.fileId as string) || !PROTOCOL_ID.test(value.snapshotId as string) ||
    !SHA256_BASE64URL.test(value.baseHash as string)) throw new Error('comment anchor is invalid');
  const p = value.position;
  if (!recordWith(p, ['byteRange', 'lineRange', 'pmRange'])) throw new Error('comment anchor position is invalid');
  const position = Object.freeze({ byteRange: range(p.byteRange), lineRange: range(p.lineRange),
    ...(p.pmRange === undefined ? {} : { pmRange: range(p.pmRange) }) });
  let quote: Anchor['quote'];
  if (value.quote !== undefined) {
    const q = value.quote;
    if (!recordWith(q, ['exact', 'exactHash', 'normalized', 'normalizedHash']) || typeof q.exact !== 'string' ||
      typeof q.normalized !== 'string' || !SHA256_BASE64URL.test(q.exactHash as string) ||
      !SHA256_BASE64URL.test(q.normalizedHash as string)) throw new Error('comment anchor quote is invalid');
    quote = Object.freeze({ exact: q.exact, exactHash: q.exactHash as string, normalized: q.normalized, normalizedHash: q.normalizedHash as string });
  }
  let block: Anchor['block'];
  if (value.block !== undefined) {
    const b = value.block;
    const kinds = new Set(['heading','paragraph','list_item','code_block','blockquote','table','thematic_break','html','math','mermaid','unknown']);
    if (!recordWith(b, ['snapshotBlockId','contentFingerprint','kind','offsetInBlockBytes','blockByteRange','blockLineRange']) ||
      !PROTOCOL_ID.test(b.snapshotBlockId as string) || !SHA256_BASE64URL.test(b.contentFingerprint as string) || !kinds.has(b.kind as string))
      throw new Error('comment anchor block is invalid');
    block = Object.freeze({ snapshotBlockId: b.snapshotBlockId as string, contentFingerprint: b.contentFingerprint as string,
      kind: b.kind as AnchorBlockKind, offsetInBlockBytes: range(b.offsetInBlockBytes),
      blockByteRange: range(b.blockByteRange), blockLineRange: range(b.blockLineRange) }) as Anchor['block'];
  }
  let context: Anchor['context'];
  if (value.context !== undefined) {
    const c = value.context;
    if (!recordWith(c, ['prefix','suffix','prefixHash','suffixHash','previousBlockHash','nextBlockHash']) ||
      typeof c.prefix !== 'string' || typeof c.suffix !== 'string' || !SHA256_BASE64URL.test(c.prefixHash as string) ||
      !SHA256_BASE64URL.test(c.suffixHash as string) ||
      (c.previousBlockHash !== undefined && !SHA256_BASE64URL.test(c.previousBlockHash as string)) ||
      (c.nextBlockHash !== undefined && !SHA256_BASE64URL.test(c.nextBlockHash as string))) throw new Error('comment anchor context is invalid');
    context = Object.freeze({ prefix: c.prefix, suffix: c.suffix, prefixHash: c.prefixHash as string, suffixHash: c.suffixHash as string,
      ...(c.previousBlockHash === undefined ? {} : { previousBlockHash: c.previousBlockHash as string }),
      ...(c.nextBlockHash === undefined ? {} : { nextBlockHash: c.nextBlockHash as string }) });
  }
  let structure: Anchor['structure'];
  if (value.structure !== undefined) {
    const s = value.structure;
    if (!recordWith(s, ['headingPath','ordinalInParent']) || !Array.isArray(s.headingPath) || !nonnegative(s.ordinalInParent))
      throw new Error('comment anchor structure is invalid');
    const headingPath = s.headingPath.map(h => {
      if (!recordWith(h, ['level','textHash','ordinalAtLevel']) || !Number.isInteger(h.level) || (h.level as number) < 1 ||
        (h.level as number) > 6 || !SHA256_BASE64URL.test(h.textHash as string) || !nonnegative(h.ordinalAtLevel))
        throw new Error('comment anchor heading path is invalid');
      return Object.freeze({ level: h.level as number, textHash: h.textHash as string, ordinalAtLevel: h.ordinalAtLevel as number });
    });
    structure = Object.freeze({ headingPath: Object.freeze(headingPath) as unknown as typeof headingPath, ordinalInParent: s.ordinalInParent as number });
  }
  return Object.freeze({ v: 2, fileId: value.fileId as string, snapshotId: value.snapshotId as string,
    baseHash: value.baseHash as string, position, ...(quote ? { quote } : {}), ...(block ? { block } : {}),
    ...(context ? { context } : {}), ...(structure ? { structure } : {}) });
}
function recordWith(value: unknown, allowed: string[]): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.keys(value).every(key => allowed.includes(key));
}
function nonnegative(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }
function range(value: unknown): [number, number] {
  if (!Array.isArray(value) || value.length !== 2 || !nonnegative(value[0]) || !nonnegative(value[1]) || value[0] > value[1])
    throw new Error('comment anchor range is invalid');
  return Object.freeze([value[0], value[1]]) as unknown as [number, number];
}
function randomId(): string { const bytes = new Uint8Array(16); crypto.getRandomValues(bytes); return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(''); }
function safeMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function isTerminalSubscriptionError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { terminal?: unknown }).terminal === true;
}
