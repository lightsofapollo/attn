import { decompressSnapshotIfNeeded } from './snapshot-compression';
import { boundFetch } from './bound-fetch';
import { compareManifestPathsUtf8 } from './browser-workspace-manifest';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { sha256 } from '@noble/hashes/sha2.js';
import {
  BrowserSession,
  buildRegisterDeviceBodyV3,
  generateBrowserIdentity,
  type BrowserSessionOptions,
  type ReviewStoreSink,
} from './browser-session';
import { assembleBrowserEvent } from './browser-envelope';
import {
  base64UrlDecode,
  base64UrlEncode,
  buildAdmissionHeaderV3,
  deriveReadKeysV3,
  expandShareLinkKeys,
  toCanonicalBytes,
  type ShareLinkKeys,
  type ShareLinkTier,
} from './browser-crypto';
import {
  openShareCapabilityBundle,
  type ParsedShareInvite,
  type ShareCapabilityBundle,
} from './browser-share';
import {
  BrowserShareResolver,
  type DecodedDurableShareBundle,
  type DurableRollbackValue,
  type DurableShareRecord,
  type DurableShareRollbackFloor,
  type DurableShareSnapshot,
} from './browser-share-resolver';
import type {
  DurableShareOutboxStore,
  DurableShareOutboxTransition,
  PersistedShareOutboxEntry,
  ShareMailboxReceipt,
  ShareMailboxTransport,
} from './browser-share-session';
import { BrowserShareSession, StaleShareEpochError, type BrowserShareSessionOptions,
  type BrowserShareSessionState } from './browser-share-session';
import { BROWSER_POW_DIFFICULTY, mintBrowserPowInWorker } from './browser-pow';
import {
  BrowserPushConsentController,
  type BrowserPushBindingContext,
  type BrowserPushConsentOptions,
  type BrowserPushConsentState,
} from './browser-push-consent';
import type { Device } from './browser-ws';
import {
  advancePushBindingFloor,
  consumePendingPushEvents,
  derivePushBindingSnapshotKey,
  getPushBinding,
  pushBindingAdmissionHeader,
  type PushBindingRecord,
} from './browser-push-worker';
import type { Anchor, Capability, ReviewEvent, ReviewEventBody, ReviewSnapshot, SuggestionDraft } from '../types';

const DB_NAME = 'attn-browser-durable-shares';
const DB_VERSION = 1;
const FLOOR_STORE = 'rollback_floors';
const OUTBOX_STORE = 'share_outbox';
const SHARE_RECORD_KEYS = new Set([
  'v','shareId','ownerSigningKey','epoch','revision','currentRoomId','snapshots','placeholders',
  'updatedAt','expiresAt','manifestDigest','bundle','mailbox','features',
]);
const MAX_REMEMBERED_SHARE_RECORD_BYTES = 512 * 1024;
const MAX_REMEMBERED_SNAPSHOT_BYTES = 5 * 1024 * 1024;

export interface DurableShareCapability {
  ownerSigningKey: string;
  readCapabilityKey: Uint8Array;
  writeAdmissionKey?: Uint8Array;
  grantSignature?: string;
  roomKeys: ReturnType<typeof deriveReadKeysV3>;
}

export interface BrowserDurableShareNetworkOptions {
  relayUrl: string;
  invite: ParsedShareInvite;
  tier: ShareLinkTier;
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
  persistence?: BrowserDurableSharePersistence;
  signal?: AbortSignal;
}

/** Authenticate with the tier-independent read leaf and learn only this selected bundle's tier. */
/** The relay no longer knows this share: revoked by the owner or expired. */
export class ShareGoneError extends Error {
  constructor() {
    super('this share link is no longer active');
    this.name = 'ShareGoneError';
  }
}

export async function discoverDurableShareTier(input: {
  relayUrl: string; invite: ParsedShareInvite; fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>; signal?: AbortSignal;
}): Promise<ShareLinkTier> {
  const keys = expandShareLinkKeys(input.invite.linkSecret, 'view');
  const path = `/v3/shares/${encodeURIComponent(input.invite.shareId)}`;
  try {
    const response = await (input.fetchImpl ?? boundFetch)(new URL(path, input.relayUrl).href, { signal: input.signal, headers: {
      'Attn-Share-Bundle': keys.bundleId,
      'Attn-Admission': buildAdmissionHeaderV3(keys.readAdmissionKey, 'read', 'GET', path, new Uint8Array()),
    } });
    if (response.status === 404 || response.status === 410) throw new ShareGoneError();
    const value = await strictJson(response, 'share tier');
    const tier = isRecord(value) && isRecord(value.bundle) ? value.bundle.tier : undefined;
    if (tier !== 'view' && tier !== 'comment' && tier !== 'suggest') throw new Error('share tier response is invalid');
    return tier;
  } finally {
    keys.linkSecret.fill(0); keys.bundleKey.fill(0); keys.readAdmissionKey.fill(0); keys.writeAdmissionKey?.fill(0);
  }
}

export interface ProductionDurableShareSessionOptions extends BrowserDurableShareNetworkOptions {
  onState?: (state: BrowserShareSessionState) => void;
  onSnapshot?: (snapshot: DurableShareSnapshot, roomId: string) => void;
  onOptimisticEvent?: (event: ReviewEvent) => void;
  onLiveState?: (state: import('./browser-session').BrowserSessionState) => void;
  /** Decrypted live collab deliveries (owner step broadcasts, cursors). */
  onCollab?: (delivery: import('./browser-session').BrowserCollabDelivery) => void | Promise<void>;
  webSocketFactory?: (url: string, protocols: string[]) => WebSocket;
  /** Plain-store seam for non-Svelte production-boundary harnesses. */
  liveStore?: ReviewStoreSink;
  /** Disable opportunistic WebRTC where the host has no RTCPeerConnection. */
  disableWebRtc?: boolean;
  /** Reviewer display name for ParticipantJoined, resolved at announce time. */
  getDisplayName?: () => string | undefined;
  /** PoW execution seam for non-Window production-boundary harnesses. */
  mailboxMintPow?: (input: { shareId: string; deviceId: string; path: string; signal?: AbortSignal }) => Promise<string>;
  registrationMintPow?: BrowserSessionOptions['registrationMintPow'];
  outboxMintPow?: BrowserSessionOptions['outboxMintPow'];
  /** Browser seams used by the focused consent harness. */
  pushConsentDependencies?: Omit<BrowserPushConsentOptions, 'getBindingContext' | 'canEnable' | 'isBindingContextCurrent' | 'onState'>;
  onPushConsentState?: (state: BrowserPushConsentState) => void;
}

type ProductionBrowserShareSession = BrowserShareSession & { readonly pushConsent: BrowserPushConsentController };

/** Complete production durable-share session using one identity for offline and live paths. */
export async function createProductionDurableShareSession(options: ProductionDurableShareSessionOptions): Promise<ProductionBrowserShareSession> {
  const { resolver, linkKeys, persistence } = await createBrowserDurableShareResolver(options);
  const identity = generateBrowserIdentity();
  const joinedByBundle = new Map<string, ReturnType<typeof assembleBrowserEvent>>();
  let lastCreatedAt = 0;
  const nextCreatedAt = (): number => (lastCreatedAt = Math.max(Date.now(), lastCreatedAt + 1));
  const fingerprint = (resolution: Awaited<ReturnType<typeof resolver.resolve>>): string => {
    const capability = resolution.bundle.shareMailboxCapability as DurableShareCapability;
    return digest(toCanonicalBytes({ bundleId: resolution.record.bundleId, tier: resolution.bundle.tier,
      epoch: resolution.record.epoch, revision: resolution.record.revision, roomId: resolution.bundle.roomId,
      mailboxCapabilityCommitment: base64UrlEncode(capability.writeAdmissionKey!) }));
  };
  const sessionOptions: BrowserShareSessionOptions = {
    shareId: options.invite.shareId, resolver, outboxStore: persistence,
    mailbox: createShareMailboxTransport({ relayUrl: options.relayUrl, linkKeys, deviceId: identity.deviceId,
      fetchImpl: options.fetchImpl, mintPow: options.mailboxMintPow }),
    digestWire: bytes => digest(bytes), capabilityFingerprint: fingerprint,
    assembleOfflineComment: ({ resolution, draft }) => {
      const capability = resolution.bundle.shareMailboxCapability as DurableShareCapability;
      if (!capability || resolution.bundle.tier === 'view') throw new Error('view share cannot author offline comments');
      let joined = joinedByBundle.get(resolution.record.bundleId);
      if (!joined) {
        const capabilities: Capability[] = ['read_snapshot', 'write_comment', 'resolve_comment'];
        if (resolution.bundle.tier === 'suggest') capabilities.push('write_suggestion');
        const createdAt = nextCreatedAt();
        const body: ReviewEventBody = { type: 'participant_joined', participant: {
          participantId: identity.participantId,
          displayName: options.getDisplayName?.()?.trim() || 'Browser reviewer',
          kind: 'reviewer',
          publicSigningKey: base64UrlEncode(identity.signingPublic), capabilities,
        }, device: { deviceId: identity.deviceId, participantId: identity.participantId,
          publicEncryptionKey: base64UrlEncode(identity.publicEncryptionKey), publicSigningKey: base64UrlEncode(identity.signingPublic),
          client: 'attn-browser', createdAt } };
        joined = assembleBrowserEvent({ eventKey: capability.roomKeys.eventKey, signingSecret: identity.signingSecret,
          signingPublic: identity.signingPublic, roomId: resolution.bundle.roomId, authorId: identity.participantId,
          deviceId: identity.deviceId, createdAt, expiresAt: resolution.record.expiresAt, body });
        joinedByBundle.set(resolution.record.bundleId, joined);
      }
      const createdAt = nextCreatedAt();
      const comment = assembleBrowserEvent({ eventKey: capability.roomKeys.eventKey, signingSecret: identity.signingSecret,
        signingPublic: identity.signingPublic, roomId: resolution.bundle.roomId, authorId: identity.participantId,
        deviceId: identity.deviceId, createdAt, expiresAt: resolution.record.expiresAt,
        body: { type: 'comment_created', threadId: draft.threadId ?? randomProtocolId(), anchor: draft.anchor, body: draft.body } });
      const envelopeId = randomProtocolId();
      const outer = { v: 3, envelopeId, type: 'review_submission', shareId: options.invite.shareId,
        epoch: resolution.record.epoch, roomId: resolution.bundle.roomId, tier: resolution.bundle.tier,
        bundleId: resolution.record.bundleId,
        deviceRegistration: buildRegisterDeviceBodyV3(identity, resolution.bundle.tier, capability.grantSignature ?? ''),
        envelopes: [joined.envelope, comment.envelope] };
      return { envelopeId, epoch: resolution.record.epoch, revision: resolution.record.revision, tier: resolution.bundle.tier,
        roomId: resolution.bundle.roomId, bundleId: resolution.record.bundleId, capabilityFingerprint: fingerprint(resolution),
        canonicalWireBytes: toCanonicalBytes(outer), event: comment.event };
    },
    createLiveSession: ({ resolution }) => {
      const capability = resolution.bundle.roomCapability as DurableShareCapability;
      return new BrowserSession({ relayUrl: options.relayUrl, identity: { ...identity,
        signingSecret: new Uint8Array(identity.signingSecret), signingPublic: new Uint8Array(identity.signingPublic),
        encryptionSecret: new Uint8Array(identity.encryptionSecret), publicEncryptionKey: new Uint8Array(identity.publicEncryptionKey) },
        onState: options.onLiveState, onCollab: options.onCollab,
        store: options.liveStore, disableWebRtc: options.disableWebRtc,
        getDisplayName: options.getDisplayName,
        ...(options.registrationMintPow === undefined ? {} : { registrationMintPow: options.registrationMintPow }),
        ...(options.outboxMintPow === undefined ? {} : { outboxMintPow: options.outboxMintPow }),
        parsedInvite: { version: 3,
        roomId: resolution.bundle.roomId, tier: resolution.bundle.tier,
        readCapabilityKey: new Uint8Array(capability.readCapabilityKey),
        ...(capability.writeAdmissionKey === undefined ? {} : { writeAdmissionKey: new Uint8Array(capability.writeAdmissionKey) }),
        ...(capability.grantSignature === undefined ? {} : { grantSignature: capability.grantSignature }) } });
    },
    subscribeToChanges: ({ onChange, onError }) => subscribeToDurableShareChanges({ relayUrl: options.relayUrl,
      shareId: options.invite.shareId, linkKeys, onChange, onError, webSocketFactory: options.webSocketFactory }),
    onState: options.onState, onSnapshot: (snapshot, resolution) => options.onSnapshot?.(snapshot, resolution.bundle.roomId),
    onOptimisticEvent: options.onOptimisticEvent,
    disposeResolution: resolution => {
      for (const snapshot of resolution.snapshots) disposeSnapshot(snapshot);
      disposeBundle(resolution.bundle);
    },
    disposeSensitive: () => {
      identity.signingSecret.fill(0); identity.signingPublic.fill(0);
      identity.encryptionSecret.fill(0); identity.publicEncryptionKey.fill(0);
      linkKeys.linkSecret.fill(0); linkKeys.bundleKey.fill(0); linkKeys.readAdmissionKey.fill(0); linkKeys.writeAdmissionKey?.fill(0);
    },
  };
  const session = new BrowserShareSession(sessionOptions);
  const getBindingContext = async (signal?: AbortSignal): Promise<BrowserPushBindingContext> => {
    const resolution = session.currentResolutionForIntegration();
    if (!resolution || resolution.bundle.tier === 'view') throw new Error('view-only shares cannot enable notifications');
    const capability = resolution.bundle.roomCapability as DurableShareCapability;
    if (!capability.writeAdmissionKey || !linkKeys.writeAdmissionKey) throw new Error('share write capability is unavailable');
    if (capability.grantSignature === undefined) throw new Error('share device grant is unavailable');
    // Copy every capability before the first await. A watch refresh may swap
    // and zero the committed resolution while the directory request is live.
    const roomReadCapabilityBytes = new Uint8Array(capability.readCapabilityKey);
    const readAdmissionKeyBytes = new Uint8Array(linkKeys.readAdmissionKey);
    const writeAdmissionKeyBytes = new Uint8Array(linkKeys.writeAdmissionKey);
    const deviceSigningSecretBytes = new Uint8Array(identity.signingSecret);
    const roomDirectoryAdmission = new Uint8Array(capability.roomKeys.readAdmissionKey);
    const shareId = resolution.record.shareId;
    const bundleId = resolution.record.bundleId;
    const roomId = resolution.bundle.roomId;
    const epoch = resolution.record.epoch;
    const revision = resolution.record.revision;
    const manifestDigest = resolution.bundle.manifestDigest;
    const ownerSigningKey = capability.ownerSigningKey;
    const deviceRegistration = buildRegisterDeviceBodyV3(
      identity,
      resolution.bundle.tier,
      capability.grantSignature,
    );
    const first = resolution.snapshots[0];
    const metadata = first && isRecord(first.metadata) ? first.metadata : {};
    const fileName = typeof metadata.ownerDisplayPath === 'string'
      ? metadata.ownerDisplayPath.split('/').filter(Boolean).at(-1) ?? first!.fileId
      : first?.fileId ?? 'shared review';
    try {
      const roomPath = `/v3/rooms/${encodeURIComponent(roomId)}/devices`;
      const response = await (options.fetchImpl ?? boundFetch)(new URL(roomPath, options.relayUrl).href, { signal, headers: {
        'Attn-Admission': buildAdmissionHeaderV3(roomDirectoryAdmission, 'read', 'GET', roomPath, new Uint8Array()),
      } });
      const raw = await strictJson(response, 'push device directory');
      if (!isRecord(raw) || !Array.isArray(raw.devices)) throw new Error('push device directory is invalid');
      const devices = structuredClone(raw.devices) as Device[];
      return { shareId, bundleId, roomId, epoch, revision, manifestDigest, deviceId: identity.deviceId, relayUrl: options.relayUrl,
        roomReadCapabilityBytes, readAdmissionKeyBytes, writeAdmissionKeyBytes,
        deviceSigningSecretBytes, deviceRegistration, ownerSigningKey, devices, fileName };
    } catch (error) {
      roomReadCapabilityBytes.fill(0); readAdmissionKeyBytes.fill(0); writeAdmissionKeyBytes.fill(0);
      deviceSigningSecretBytes.fill(0);
      throw error;
    } finally {
      roomDirectoryAdmission.fill(0);
    }
  };
  const pushConsent = new BrowserPushConsentController({
    ...options.pushConsentDependencies,
    getBindingContext,
    canEnable: () => options.tier !== 'view',
    isBindingContextCurrent: context => {
      const current = session.currentResolutionForIntegration();
      return current !== null && current.record.bundleId === context.bundleId &&
        current.record.epoch === context.epoch && current.record.revision === context.revision &&
        current.bundle.manifestDigest === context.manifestDigest && current.bundle.roomId === context.roomId;
    },
    onState: options.onPushConsentState,
  });
  return Object.assign(session, { pushConsent });
}

/** BrowserReviewApp-compatible facade over the durable resolver/session. */
export class DurableShareBrowserSessionFacade {
  readonly closeOnDestroy = true;
  private session: ProductionBrowserShareSession | null = null;
  private observer: ((state: import('./browser-session').BrowserSessionState) => void) | null = null;
  private collabObserver: ((delivery: import('./browser-session').BrowserCollabDelivery) => void | Promise<void>) | null = null;
  private pushObserver: ((state: BrowserPushConsentState) => void) | null = null;
  private pushState: BrowserPushConsentState = { status: 'checking', message: null, enabled: false };
  private generation = 0;
  private closed = false;
  private startAbort: AbortController | null = null;
  private state: import('./browser-session').BrowserSessionState = { principal: 'reviewer', ownerOnline: false, peers: [],
    liveEditingAvailable: false, status: 'idle', connection: 'offline', directError: null,
    roomId: null, snapshotContent: null, snapshotDocType: 'markdown', snapshotId: null, fileId: null, error: null,
    authoringReady: false, grantTier: 'view', outboxPending: 0, authoringError: null, persistence: 'ephemeral',
    storagePersisted: null, canRemember: false };
  constructor(private readonly options: Omit<ProductionDurableShareSessionOptions, 'tier'>) {}
  setStateObserver(observer: (state: import('./browser-session').BrowserSessionState) => void): void { this.observer = observer; observer(this.state); }
  /** Live collab deliveries (owner step broadcasts, cursors) from the room session. */
  setCollabObserver(observer: (delivery: import('./browser-session').BrowserCollabDelivery) => void | Promise<void>): void { this.collabObserver = observer; }
  setPushConsentObserver(observer: (state: BrowserPushConsentState) => void): void { this.pushObserver = observer; observer(this.pushState); }
  getPushConsentState(): BrowserPushConsentState { return { ...this.pushState }; }
  getState(): import('./browser-session').BrowserSessionState { return this.state; }
  async start(): Promise<void> {
    if (this.closed || this.session) return;
    const generation = ++this.generation;
    const abort = new AbortController(); this.startAbort = abort;
    try {
      const tier = await discoverDurableShareTier({ ...this.options, signal: abort.signal });
      if (this.closed || generation !== this.generation) return;
      const candidate = await createProductionDurableShareSession({ ...this.options, tier, signal: abort.signal,
      onCollab: delivery => { if (!this.closed && generation === this.generation) return this.collabObserver?.(delivery); },
      onState: state => { if (!this.closed && generation === this.generation) this.mapState(state); },
      onPushConsentState: state => {
        if (!this.closed && generation === this.generation) {
          this.pushState = state; this.pushObserver?.(state);
        }
      },
      onSnapshot: (snapshot, roomId) => { if (!this.closed && generation === this.generation) void this.installSnapshot(snapshot, roomId); },
      onOptimisticEvent: event => { void this.installEvent(event); }, onLiveState: state => {
        if (!this.closed && generation === this.generation) { this.state = state; this.observer?.(state); }
      } });
      if (this.closed || generation !== this.generation) { candidate.close(); return; }
      this.session = candidate;
      await candidate.start();
      await candidate.pushConsent.initialize();
    } finally {
      this.options.invite.linkSecret.fill(0);
      if (this.startAbort === abort) this.startAbort = null;
    }
  }
  close(): void { if (this.closed) return; this.closed = true; ++this.generation; this.startAbort?.abort(); this.startAbort = null;
    this.options.invite.linkSecret.fill(0); this.session?.pushConsent.close(); this.session?.close(); this.session = null; }
  async createComment(anchor: Anchor, body: string, threadId?: string): Promise<ReviewEvent> {
    const event = await this.requireSession().createComment(anchor, body, threadId);
    if (!event) throw new Error('comment was queued without an optimistic event');
    return event;
  }
  async replyToComment(anchor: Anchor, body: string, threadId: string): Promise<ReviewEvent> { return this.createComment(anchor, body, threadId); }
  async resolveComment(threadId: string): Promise<ReviewEvent> { return this.requireSession().resolveComment(threadId); }
  async createSuggestion(draft: SuggestionDraft): Promise<ReviewEvent> { return this.requireSession().createSuggestion(draft); }
  async sendCollab(payload: string): Promise<void> { return this.requireSession().sendCollab(payload); }
  async retryOutbox(): Promise<void> { await this.requireSession().retryOutbox(); }
  /** Rename mid-session (attn-sur): re-announce with the current name. */
  async announceProfile(): Promise<void> { await this.requireSession().announceProfile(); }
  async enablePushFromUserGesture(): Promise<void> {
    const controller = this.requireSession().pushConsent;
    await controller.enableFromUserGesture();
    this.pushState = controller.getState(); this.pushObserver?.(this.pushState);
  }
  async disablePushFromUserGesture(): Promise<void> {
    const controller = this.requireSession().pushConsent;
    await controller.disableFromUserGesture();
    this.pushState = controller.getState(); this.pushObserver?.(this.pushState);
  }
  async rememberRoom(): Promise<void> { throw new Error('durable share state is already scoped to this browser'); }
  async forgetRoom(): Promise<void> { throw new Error('use the share link to reopen this review'); }
  private requireSession(): ProductionBrowserShareSession { if (!this.session) throw new Error('durable share is not ready'); return this.session; }
  private mapState(next: BrowserShareSessionState): void {
    // `terminated` reaching a facade the app did not close is the share being
    // revoked (or expiring) out from under the reviewer: mapState is gated on
    // `!this.closed`, so a deliberate teardown never lands here. Surface a
    // terminal explanation instead of an eternal "Loading review…" (attn-j2c).
    if (next.status === 'terminated') {
      this.state = { ...this.state, status: 'error', ownerOnline: false, liveEditingAvailable: false,
        connection: 'offline', authoringReady: false, outboxPending: 0,
        error: { kind: 'share_revoked', message: 'The owner stopped sharing this document.' } };
      this.observer?.(this.state);
      return;
    }
    const snapshot = next.snapshots[0];
    this.state = { ...this.state,
      status: next.status === 'ready' ? 'connected' : next.status === 'error' ? 'error' : 'connecting',
      ownerOnline: next.ownerOnline, liveEditingAvailable: false,
      connection: next.ownerOnline ? 'live_direct' : next.status === 'ready' ? 'mailbox' : 'offline', roomId: next.roomId,
      snapshotContent: snapshot?.content ?? (next.ownerOnline ? this.state.snapshotContent : null),
      snapshotDocType: snapshot?.docType ?? (next.ownerOnline ? this.state.snapshotDocType : 'markdown'),
      snapshotId: snapshot?.snapshotId ?? (next.ownerOnline ? this.state.snapshotId : null),
      fileId: snapshot?.fileId ?? (next.ownerOnline ? this.state.fileId : null),
      error: next.error ? { kind: 'network', message: next.error } : null,
      authoringReady: next.status === 'ready' && next.canComment, grantTier: next.tier,
      outboxPending: next.pendingComments, authoringError: next.error, canRemember: false };
    this.observer?.(this.state);
  }
  private async installEvent(event: ReviewEvent): Promise<void> {
    const { reviewStore } = await import('./store.svelte.js'); reviewStore.applyEvent(event);
  }
  private async installSnapshot(snapshot: DurableShareSnapshot, roomId: string): Promise<void> {
    const value = reviewSnapshotFromDurable(snapshot, roomId);
    const { reviewStore } = await import('./store.svelte.js');
    reviewStore.currentRoomId = value.roomId; reviewStore.applySnapshot(value);
    // Never steal an existing selection: this runs once per restored snapshot,
    // so unconditionally selecting made the LAST restored file win on every
    // reload (and clobbered the URL-requested file). Claim only an empty
    // selection; refresh the snapshot pick when the restored file IS selected.
    if (reviewStore.currentFileId === null) {
      reviewStore.setCurrentFile(value.fileId); reviewStore.setCurrentSnapshot(value.snapshotId);
    } else if (reviewStore.currentFileId === value.fileId) {
      reviewStore.setCurrentSnapshot(value.snapshotId);
    }
  }
}

/** Fragmentless notification-click recovery from a locally remembered, non-extractable binding. */
export class RememberedPushShareSessionFacade {
  readonly closeOnDestroy = true;
  private observer: ((state: import('./browser-session').BrowserSessionState) => void) | null = null;
  private closed = false;
  private abort: AbortController | null = null;
  private state: import('./browser-session').BrowserSessionState = { principal: 'reviewer', ownerOnline: false, peers: [],
    liveEditingAvailable: false, status: 'idle', connection: 'offline', directError: null,
    roomId: null, snapshotContent: null, snapshotDocType: 'markdown', snapshotId: null, fileId: null, error: null,
    authoringReady: false, grantTier: 'view', outboxPending: 0, authoringError: null, persistence: 'remembered',
    storagePersisted: true, canRemember: false };
  constructor(private readonly options: { relayUrl: string; bindingId: string; indexedDB?: IDBFactory; fetchImpl?: typeof fetch; store?: ReviewStoreSink }) {}
  setStateObserver(observer: (state: import('./browser-session').BrowserSessionState) => void): void { this.observer = observer; observer(this.state); }
  getState(): import('./browser-session').BrowserSessionState { return this.state; }
  async start(): Promise<void> {
    if (this.closed || this.state.status !== 'idle') return;
    this.patch({ status: 'connecting' });
    const abort = new AbortController(); this.abort = abort;
    try {
      const binding = await getPushBinding(this.options.bindingId, this.options.indexedDB);
      if (!binding || binding.kind !== 'share' || !binding.bundleId || binding.epoch === undefined) {
        throw new Error('This review could not be reopened from this URL alone. Open the complete share link — including the part after # — that was sent to you.');
      }
      if (canonicalRememberedRelay(this.options.relayUrl) !== binding.relayUrl) {
        throw new Error('Remembered notification relay does not match this app configuration.');
      }
      const snapshots = await this.loadSnapshots(binding, abort.signal);
      if (this.closed) return;
      const first = snapshots[0];
      const store = this.options.store ?? (await import('./store.svelte.js')).reviewStore;
      store.currentRoomId = binding.roomId;
      for (const snapshot of snapshots) store.applySnapshot(reviewSnapshotFromDurable(snapshot, binding.roomId));
      if (first && store.currentFileId === null) {
        store.setCurrentFile(first.fileId); store.setCurrentSnapshot(first.snapshotId);
      }
      await consumePendingPushEvents(binding.bindingId, event => store.applyEvent(event), {
        indexedDB: this.options.indexedDB,
      });
      if (this.closed) return;
      this.patch({ status: 'connected', connection: 'mailbox', roomId: binding.roomId,
        snapshotContent: first?.content ?? null, snapshotDocType: first?.docType ?? 'markdown',
        snapshotId: first?.snapshotId ?? null, fileId: first?.fileId ?? null });
    } catch (error) {
      if (!this.closed) this.patch({ status: 'error', error: { kind: 'invite_invalid', message: safeProductionMessage(error) } });
    } finally { if (this.abort === abort) this.abort = null; }
  }
  close(): void { this.closed = true; this.abort?.abort(); this.abort = null; }
  async createComment(): Promise<ReviewEvent> { throw new Error('reopen the original share link to author'); }
  async replyToComment(): Promise<ReviewEvent> { throw new Error('reopen the original share link to author'); }
  async resolveComment(): Promise<ReviewEvent> { throw new Error('reopen the original share link to author'); }
  async createSuggestion(): Promise<ReviewEvent> { throw new Error('reopen the original share link to author'); }
  async retryOutbox(): Promise<void> {}
  async rememberRoom(): Promise<void> {}
  async forgetRoom(): Promise<void> { throw new Error('disable notifications from the original share link'); }
  private patch(next: Partial<import('./browser-session').BrowserSessionState>): void { this.state = { ...this.state, ...next }; this.observer?.(this.state); }
  private async loadSnapshots(binding: PushBindingRecord, signal: AbortSignal): Promise<DurableShareSnapshot[]> {
    const path = `/v3/shares/${encodeURIComponent(binding.resourceId)}`;
    const response = await (this.options.fetchImpl ?? boundFetch)(new URL(path, this.options.relayUrl), { signal, headers: {
      'Attn-Share-Bundle': binding.bundleId!,
      'Attn-Admission': await pushBindingAdmissionHeader(binding, 'read', 'GET', path),
    } });
    const raw = await strictBoundedJson(response, 'remembered share', MAX_REMEMBERED_SHARE_RECORD_BYTES);
    if (!isRecord(raw) || raw.shareId !== binding.resourceId || raw.ownerSigningKey !== binding.ownerSigningKey ||
      raw.epoch !== binding.epoch || !isRecord(raw.bundle) || raw.bundle.bundleId !== binding.bundleId ||
      !Array.isArray(raw.snapshots) || raw.snapshots.length > 64 || typeof raw.manifestDigest !== 'string' ||
      !Number.isSafeInteger(raw.revision) || binding.revision === undefined || binding.manifestDigest === undefined ||
      (raw.revision as number) < binding.revision ||
      ((raw.revision as number) === binding.revision && raw.manifestDigest !== binding.manifestDigest)) {
      throw new Error('remembered share binding changed');
    }
    const refs = raw.snapshots.map(parseRememberedSnapshotRef).sort((a, b) =>
      compareManifestPathsUtf8(a.fileId, b.fileId) || compareManifestPathsUtf8(a.snapshotId, b.snapshotId));
    const manifest = toCanonicalBytes(refs.map(ref => ({ fileId: ref.fileId, snapshotId: ref.snapshotId,
      ciphertextBytes: ref.ciphertextBytes, ciphertextSha256: ref.ciphertextSha256, uploadedAt: ref.uploadedAt })));
    try { if (digest(manifest) !== raw.manifestDigest) throw new Error('remembered share manifest failed authentication'); }
    finally { manifest.fill(0); }
    const snapshotKey = await derivePushBindingSnapshotKey(binding);
    try {
      const snapshots: DurableShareSnapshot[] = [];
      for (const ref of refs) {
        const snapshotPath = `${path}/snapshots/${encodeURIComponent(ref.fileId)}`;
        const snapshotResponse = await (this.options.fetchImpl ?? boundFetch)(new URL(snapshotPath, this.options.relayUrl), { signal, headers: {
          'Attn-Share-Bundle': binding.bundleId!,
          'Attn-Admission': await pushBindingAdmissionHeader(binding, 'read', 'GET', snapshotPath),
        } });
        if (!snapshotResponse.ok) throw new Error(`remembered snapshot fetch failed (${snapshotResponse.status})`);
        if (snapshotResponse.headers.get('Attn-Share-Bundle') !== binding.bundleId ||
          snapshotResponse.headers.get('Attn-Snapshot-Id') !== ref.snapshotId) {
          throw new Error('remembered snapshot selector mismatch');
        }
        const ciphertext = await readBoundedResponse(snapshotResponse, MAX_REMEMBERED_SNAPSHOT_BYTES,
          'remembered snapshot', ref.ciphertextBytes);
        try {
          if (ciphertext.byteLength !== ref.ciphertextBytes || digest(ciphertext) !== ref.ciphertextSha256) throw new Error('remembered snapshot digest mismatch');
          snapshots.push(await decryptRememberedSnapshot(binding.resourceId, binding.epoch!, binding.roomId, snapshotKey, ref.fileId, ref.snapshotId, ciphertext));
        } finally { ciphertext.fill(0); }
      }
      await advancePushBindingFloor(binding.bindingId, {
        expectedEpoch: binding.epoch!, expectedBundleId: binding.bundleId!, expectedRoomId: binding.roomId,
        expectedRelayUrl: binding.relayUrl, expectedRevision: binding.revision!, expectedManifestDigest: binding.manifestDigest!,
        candidateRevision: raw.revision as number, candidateManifestDigest: raw.manifestDigest,
      }, this.options.indexedDB);
      return snapshots;
    } finally { snapshotKey.fill(0); }
  }
}

export function reviewSnapshotFromDurable(snapshot: DurableShareSnapshot, roomId: string): ReviewSnapshot {
    const metadata = isRecord(snapshot.metadata) ? snapshot.metadata : {};
    const baseHash = typeof metadata.baseHash === 'string' ? metadata.baseHash : digest(new TextEncoder().encode(snapshot.content));
    return { roomId, fileId: snapshot.fileId, snapshotId: snapshot.snapshotId,
      createdAt: Number.isSafeInteger(metadata.createdAt) ? metadata.createdAt as number : Date.now(),
      createdBy: typeof metadata.createdBy === 'string' ? metadata.createdBy : 'share-owner', baseHash,
      byteLength: new TextEncoder().encode(snapshot.content).length, docType: snapshot.docType, content: snapshot.content,
      ...(isRecord(metadata.anchorIndex) ? { anchorIndex: metadata.anchorIndex as unknown as ReviewSnapshot['anchorIndex'] } : {}),
      ...(typeof metadata.ownerDisplayPath === 'string' ? { ownerDisplayPath: metadata.ownerDisplayPath } : {}) };
}

/** IndexedDB-backed rollback floor and byte-exact share outbox. */
export class BrowserDurableSharePersistence implements DurableShareRollbackFloor, DurableShareOutboxStore {
  private constructor(private readonly db: IDBDatabase) {}

  static async open(indexedDBImpl: IDBFactory = indexedDB): Promise<BrowserDurableSharePersistence> {
    const request = indexedDBImpl.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(FLOOR_STORE)) db.createObjectStore(FLOOR_STORE, { keyPath: 'key' });
      if (!db.objectStoreNames.contains(OUTBOX_STORE)) db.createObjectStore(OUTBOX_STORE, { keyPath: 'key' });
    };
    return new BrowserDurableSharePersistence(await idbRequest(request));
  }

  async atomicMax(input: { shareId: string; bundleId: string; candidate: DurableRollbackValue }): Promise<DurableRollbackValue> {
    const key = `${input.shareId}:${input.bundleId}`;
    const tx = this.db.transaction(FLOOR_STORE, 'readwrite');
    const store = tx.objectStore(FLOOR_STORE);
    const current = await idbRequest<{ key: string; value: DurableRollbackValue } | undefined>(store.get(key));
    let value = current?.value;
    if (!value || input.candidate.epoch > value.epoch ||
      (input.candidate.epoch === value.epoch && input.candidate.revision > value.revision)) {
      value = { ...input.candidate };
      store.put({ key, value });
    }
    await idbDone(tx);
    return { ...value };
  }

  async hydrate(shareId: string, bundleId: string): Promise<PersistedShareOutboxEntry[]> {
    const tx = this.db.transaction(OUTBOX_STORE, 'readonly');
    const records = await idbRequest<Array<{ key: string; shareId: string; bundleId: string; entry: PersistedShareOutboxEntry }>>(
      tx.objectStore(OUTBOX_STORE).getAll(),
    );
    await idbDone(tx);
    return records.filter(item => item.shareId === shareId && item.bundleId === bundleId)
      .map(item => cloneEntry(item.entry));
  }

  async transition(shareId: string, bundleId: string, transition: DurableShareOutboxTransition): Promise<void> {
    const tx = this.db.transaction(OUTBOX_STORE, 'readwrite');
    const store = tx.objectStore(OUTBOX_STORE);
    const envelopeKey = (id: string): string => `${shareId}:${bundleId}:envelope:${id}`;
    const draftKey = (id: string): string => `${shareId}:${bundleId}:draft:${id}`;
    if (transition.kind === 'enqueue') {
      store.add({ key: envelopeKey(transition.record.envelopeId), shareId, bundleId, entry: cloneEntry(transition.record) });
    } else if (transition.kind === 'retry_stale') {
      store.delete(draftKey(transition.draftId));
      store.add({ key: envelopeKey(transition.record.envelopeId), shareId, bundleId, entry: cloneEntry(transition.record) });
    } else if (transition.kind === 'remove_stale') {
      store.delete(draftKey(transition.draftId));
    } else {
      const key = envelopeKey(transition.envelopeId);
      const current = await idbRequest<{ entry: PersistedShareOutboxEntry } | undefined>(store.get(key));
      if (!current || current.entry.state === 'stale' || current.entry.wireHash !== transition.expectedWireHash) {
        tx.abort();
        throw new Error('durable share outbox transition precondition failed');
      }
      if (transition.kind === 'ack') store.delete(key);
      else if (transition.kind === 'retryable') store.put({ key, shareId, bundleId, entry: { ...current.entry, state: 'retryable' } });
      else {
        store.delete(key);
        store.put({ key: draftKey(transition.record.draft.draftId), shareId, bundleId, entry: cloneEntry(transition.record) });
      }
    }
    await idbDone(tx);
  }

  dispose(): void { this.db.close(); }
}

/** Construct the authenticated ShareDO resolver for one stripped link bearer. */
export async function createBrowserDurableShareResolver(options: BrowserDurableShareNetworkOptions): Promise<{
  resolver: BrowserShareResolver<ShareLinkKeys>;
  linkKeys: ShareLinkKeys;
  persistence: BrowserDurableSharePersistence;
}> {
  const fetchImpl = options.fetchImpl ?? boundFetch;
  let linkKeys: ShareLinkKeys;
  try { linkKeys = expandShareLinkKeys(options.invite.linkSecret, options.tier); }
  finally { options.invite.linkSecret.fill(0); }
  let persistence: BrowserDurableSharePersistence;
  try { persistence = options.persistence ?? await BrowserDurableSharePersistence.open(); }
  catch (error) { disposeLinkKeys(linkKeys); throw error; }
  const relay = new URL(options.relayUrl);
  const sharePath = `/v3/shares/${encodeURIComponent(options.invite.shareId)}`;
  const shareUrl = new URL(sharePath, relay).href;
  const headers = (method: string, path: string, body = new Uint8Array()): HeadersInit => ({
    'Attn-Share-Bundle': linkKeys.bundleId,
    'Attn-Admission': buildAdmissionHeaderV3(linkKeys.readAdmissionKey, 'read', method, path, body),
  });
  const resolver = new BrowserShareResolver<ShareLinkKeys>({
    shareId: options.invite.shareId,
    capability: linkKeys,
    rollbackFloor: persistence,
    fetchRecord: async ({ signal }) => {
      const response = await fetchImpl(shareUrl, { headers: headers('GET', sharePath), signal });
      const raw = await strictJson(response, 'share record');
      return mapShareRecord(raw, options.invite.shareId, linkKeys.bundleId, options.tier);
    },
    // The expected digest comes from the resolver's own computation over this
    // record's manifest — never from server claims or shared mutable state.
    decodeBundle: ({ shareId, bundleId, epoch, revision, manifestDigest, sealedBundle }) => {
      const raw = openShareCapabilityBundle(linkKeys.bundleKey, bundleId, {
        shareId, epoch, revision, manifestDigest, tier: options.tier,
      }, base64UrlEncode(sealedBundle));
      return decodedBundle(raw);
    },
    isRoomLive: async ({ bundle, signal }) => {
      const capability = bundle.roomCapability as DurableShareCapability;
      const path = `/v3/rooms/${encodeURIComponent(bundle.roomId)}/devices`;
      const response = await fetchImpl(new URL(path, relay).href, { signal, headers: {
        'Attn-Admission': buildAdmissionHeaderV3(capability.roomKeys.readAdmissionKey, 'read', 'GET', path, new Uint8Array()),
      } });
      if (response.status === 404) return false;
      if (!response.ok) throw new Error(`share room liveness fetch failed (${response.status})`);
      return true;
    },
    digestManifest: bytes => digest(bytes),
    fetchSnapshot: async ({ shareId, ref, signal }) => {
      const path = `${sharePath}/snapshots/${encodeURIComponent(ref.fileId)}`;
      const response = await fetchImpl(new URL(path, relay).href, { headers: headers('GET', path), signal });
      if (!response.ok) throw new Error(`share snapshot fetch failed (${response.status})`);
      const selected = response.headers.get('Attn-Share-Bundle');
      const tier = response.headers.get('Attn-Share-Tier');
      const snapshotId = response.headers.get('Attn-Snapshot-Id');
      if (selected !== linkKeys.bundleId || tier !== options.tier || snapshotId !== ref.snapshotId) {
        throw new Error('share snapshot selector mismatch');
      }
      return { ciphertext: new Uint8Array(await response.arrayBuffer()), ciphertextSha256: ref.ciphertextSha256 };
    },
    digestCiphertext: bytes => digest(bytes),
    decryptSnapshot: ({ shareId, epoch, bundle, ref, ciphertext }) => decryptDurableShareSnapshot(shareId, epoch, bundle, ref.fileId, ref.snapshotId, ciphertext),
    disposeBundle,
    disposeSnapshot: snapshot => disposeSnapshot(snapshot),
  });
  return { resolver, linkKeys, persistence };
}

/** Exact selected-bundle ShareDO mailbox transport. */
export function createShareMailboxTransport(input: {
  relayUrl: string;
  linkKeys: ShareLinkKeys;
  deviceId: string;
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
  powDifficulty?: number;
  mintPow?: (input: { shareId: string; deviceId: string; path: string; signal?: AbortSignal }) => Promise<string>;
}): ShareMailboxTransport {
  const fetchImpl = input.fetchImpl ?? boundFetch;
  return { submit: async request => {
    const path = `/v3/shares/${encodeURIComponent(request.shareId)}/mailbox`;
    const body = JSON.stringify({ epoch: request.epoch, deviceId: input.deviceId,
      items: [JSON.parse(new TextDecoder().decode(request.canonicalWireBytes)) as unknown] });
    const bodyBytes = new TextEncoder().encode(body);
    const abort = request.signal;
    const pow = input.mintPow
      ? await input.mintPow({ shareId: request.shareId, deviceId: input.deviceId, path, ...(abort ? { signal: abort } : {}) })
      : await mintBrowserPowInWorker({ roomId: request.shareId, deviceId: input.deviceId,
          method: 'POST', path, difficulty: input.powDifficulty ?? BROWSER_POW_DIFFICULTY }, { signal: abort });
    const response = await fetchImpl(new URL(path, input.relayUrl).href, { method: 'POST', signal: abort,
      headers: { 'Content-Type': 'application/json', 'Attn-Share-Bundle': request.bundleId,
        'Attn-Admission': buildAdmissionHeaderV3(input.linkKeys.writeAdmissionKey!, 'write', 'POST', path, bodyBytes), 'Attn-PoW': pow }, body });
    const value = await response.json() as { results?: Array<{ envelopeId: string; seq: number; status: 'accepted'|'duplicate' }>;
      error?: { code?: string; currentEpoch?: number }; currentEpoch?: number };
    if (response.status === 409 && value.error?.code === 'ATTN_SHARE_EPOCH_STALE') {
      throw new StaleShareEpochError(value.currentEpoch ?? value.error.currentEpoch);
    }
    if (!response.ok || value.results?.length !== 1) throw new Error(`share mailbox submit failed (${response.status})`);
    const receipt = value.results[0]!;
    return { ...receipt, bundleId: request.bundleId, epoch: request.epoch, revision: request.revision,
      tier: request.tier, roomId: request.roomId, capabilityFingerprint: request.capabilityFingerprint,
      wireHash: request.wireHash } satisfies ShareMailboxReceipt;
  } };
}

/** Authenticated content-blind share watch; selector is a browser-safe subprotocol token. */
export function subscribeToDurableShareChanges(input: {
  relayUrl: string;
  shareId: string;
  linkKeys: ShareLinkKeys;
  onChange: () => void;
  onError: (error: unknown) => void;
  webSocketFactory?: (url: string, protocols: string[]) => WebSocket;
  reconnectInitialMs?: number;
  reconnectMaxMs?: number;
}): { close(): void } {
  const path = `/v3/shares/${encodeURIComponent(input.shareId)}/watch`;
  const url = new URL(path, input.relayUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const admission = buildAdmissionHeaderV3(input.linkKeys.readAdmissionKey, 'read', 'GET', path, new Uint8Array());
  const proof = admission.replace(/^v3\.read\./u, '');
  if (!/^[A-Za-z0-9_-]{43}$/u.test(proof)) throw new Error('share watch proof is invalid');
  const protocols = ['attn.v3', `bundle.${input.linkKeys.bundleId}`, `read-hmac.${proof}`];
  const initial = Math.max(0, input.reconnectInitialMs ?? 250);
  const maximum = Math.max(initial, input.reconnectMaxMs ?? 10_000);
  let delay = initial; let closed = false; let terminal = false; let socket: WebSocket | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const reconnect = (): void => {
    if (closed || terminal || timer !== null) return;
    timer = setTimeout(() => { timer = null; connect(); }, delay);
    delay = Math.min(maximum, Math.max(1, delay * 2));
  };
  const connect = (): void => {
    if (closed || terminal) return;
    const candidate = input.webSocketFactory?.(url.href, protocols) ?? new WebSocket(url.href, protocols);
    socket = candidate;
    candidate.onopen = () => {
      if (closed || candidate !== socket) { candidate.close(1000, 'stale share watch'); return; }
      if (candidate.protocol !== 'attn.v3') {
        terminal = true; candidate.close(1002, 'invalid share watch protocol');
        input.onError(new Error('invalid share watch protocol')); return;
      }
      delay = initial;
      input.onChange();
    };
    candidate.onmessage = event => {
      try {
        const frame = JSON.parse(String(event.data)) as unknown;
        if (!isRecord(frame)) throw new Error('invalid share watch frame');
        if (frame.type === 'ping' && Number.isSafeInteger(frame.ts)) candidate.send(JSON.stringify({ type: 'pong', ts: frame.ts }));
        else if (frame.type === 'share_changed' && Number.isSafeInteger(frame.epoch) && Number.isSafeInteger(frame.revision)) input.onChange();
        else throw new Error('invalid share watch frame');
      } catch (error) { input.onError(error); }
    };
    candidate.onerror = () => { /* onclose owns retry scheduling */ };
    candidate.onclose = event => {
      if (candidate !== socket) return;
      socket = null;
      if (closed) return;
      if (event.code === 4000) { terminal = true; input.onError(new Error('share watch admission rejected')); }
      else if (event.code === 4001) {
        terminal = true;
        input.onError(Object.assign(new Error('durable share was revoked or expired'), { terminal: true }));
      }
      else reconnect();
    };
  };
  connect();
  return { close: () => {
    if (closed) return; closed = true;
    if (timer !== null) { clearTimeout(timer); timer = null; }
    const active = socket; socket = null; active?.close(1000, 'share session closed');
  } };
}

function mapShareRecord(value: unknown, shareId: string, bundleId: string, tier: ShareLinkTier): DurableShareRecord {
  if (!isRecord(value) || Object.keys(value).some(key => !SHARE_RECORD_KEYS.has(key)) || !isRecord(value.bundle) ||
    value.bundle.bundleId !== bundleId || value.bundle.tier !== tier || typeof value.bundle.sealedBundle !== 'string' ||
    typeof value.manifestDigest !== 'string') throw new Error('share record response is invalid');
  return { v: value.v as 3, shareId: value.shareId as string, bundleId, epoch: value.epoch as number,
    revision: value.revision as number, ...(typeof value.currentRoomId === 'string' ? { currentRoomId: value.currentRoomId } : {}),
    snapshots: value.snapshots, selectedBundle: base64UrlDecode(value.bundle.sealedBundle),
    updatedAt: value.updatedAt as number, expiresAt: value.expiresAt as number };
}

function decodedBundle(bundle: ShareCapabilityBundle): DecodedDurableShareBundle {
  const readCapabilityKey = base64UrlDecode(bundle.readCapabilityKey);
  const roomKeys = deriveReadKeysV3(readCapabilityKey);
  const capability: DurableShareCapability = { ownerSigningKey: bundle.ownerSigningKey, readCapabilityKey,
    ...(bundle.writeAdmissionKey === undefined ? {} : { writeAdmissionKey: base64UrlDecode(bundle.writeAdmissionKey) }),
    ...(bundle.grantSignature === undefined ? {} : { grantSignature: bundle.grantSignature }), roomKeys };
  return { v: 3, shareId: bundle.shareId, bundleId: bundle.bundleId, epoch: bundle.epoch, revision: bundle.revision,
    manifestDigest: bundle.manifestDigest, roomId: bundle.roomId, tier: bundle.tier, roomCapability: capability,
    ...(bundle.tier === 'view' ? {} : { shareMailboxCapability: capability }) };
}

export async function decryptDurableShareSnapshot(shareId: string, epoch: number, bundle: DecodedDurableShareBundle,
  fileId: string, snapshotId: string, sealed: Uint8Array): Promise<DurableShareSnapshot> {
  if (sealed.length < 41) throw new Error('durable share snapshot is truncated');
  const capability = bundle.roomCapability as DurableShareCapability;
  const aad = toCanonicalBytes({ v: 3, purpose: 'attn durable share snapshot v3', shareId, epoch, fileId, snapshotId });
  let plaintext: Uint8Array | null = null;
  let inflated: Uint8Array | null = null;
  try {
    plaintext = xchacha20poly1305(capability.roomKeys.snapshotKey, sealed.subarray(0, 24), aad).decrypt(sealed.subarray(24));
    inflated = await decompressSnapshotIfNeeded(plaintext);
    const value = JSON.parse(new TextDecoder().decode(inflated)) as unknown;
    if (!isRecord(value) || Object.keys(value).some(key => !['v','fileId','snapshotId','docType','content','metadata'].includes(key)) ||
      value.v !== 3 || value.fileId !== fileId || value.snapshotId !== snapshotId ||
      (value.docType !== 'markdown' && value.docType !== 'html') || typeof value.content !== 'string') {
      throw new Error('durable share snapshot plaintext is invalid');
    }
    return { fileId, snapshotId, docType: value.docType, content: value.content,
      ...(value.metadata === undefined ? {} : { metadata: structuredClone(value.metadata) }) };
  } finally { aad.fill(0); if (inflated !== plaintext) inflated?.fill(0); plaintext?.fill(0); }
}

function disposeBundle(bundle: DecodedDurableShareBundle): void {
  const capability = bundle.roomCapability as DurableShareCapability;
  capability.readCapabilityKey.fill(0); capability.writeAdmissionKey?.fill(0);
  for (const value of Object.values(capability.roomKeys)) if (value instanceof Uint8Array) value.fill(0);
}
function disposeLinkKeys(keys: ShareLinkKeys): void {
  keys.linkSecret.fill(0); keys.bundleKey.fill(0); keys.readAdmissionKey.fill(0); keys.writeAdmissionKey?.fill(0);
}
function disposeSnapshot(snapshot: DurableShareSnapshot): void { snapshot.content = ''; snapshot.metadata = undefined; }
function parseRememberedSnapshotRef(value: unknown): { fileId: string; snapshotId: string; ciphertextBytes: number; ciphertextSha256: string; uploadedAt: number } {
  if (!isRecord(value) || typeof value.fileId !== 'string' || typeof value.snapshotId !== 'string' ||
    !Number.isSafeInteger(value.ciphertextBytes) || (value.ciphertextBytes as number) < 41 ||
    (value.ciphertextBytes as number) > MAX_REMEMBERED_SNAPSHOT_BYTES ||
    typeof value.ciphertextSha256 !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(value.ciphertextSha256) ||
    !Number.isSafeInteger(value.uploadedAt)) {
    throw new Error('remembered snapshot manifest is invalid');
  }
  return { fileId: value.fileId, snapshotId: value.snapshotId,
    ciphertextBytes: value.ciphertextBytes as number, ciphertextSha256: value.ciphertextSha256,
    uploadedAt: value.uploadedAt as number };
}
async function decryptRememberedSnapshot(shareId: string, epoch: number, _roomId: string, snapshotKey: Uint8Array,
  fileId: string, snapshotId: string, sealed: Uint8Array): Promise<DurableShareSnapshot> {
  const aad = toCanonicalBytes({ v: 3, purpose: 'attn durable share snapshot v3', shareId, epoch, fileId, snapshotId });
  let plaintext: Uint8Array | null = null;
  let inflated: Uint8Array | null = null;
  try {
    plaintext = xchacha20poly1305(snapshotKey, sealed.subarray(0, 24), aad).decrypt(sealed.subarray(24));
    inflated = await decompressSnapshotIfNeeded(plaintext);
    const value = JSON.parse(new TextDecoder().decode(inflated)) as unknown;
    if (!isRecord(value) || value.v !== 3 || value.fileId !== fileId || value.snapshotId !== snapshotId ||
      (value.docType !== 'markdown' && value.docType !== 'html') || typeof value.content !== 'string') {
      throw new Error('remembered snapshot plaintext is invalid');
    }
    return { fileId, snapshotId, docType: value.docType, content: value.content,
      ...(value.metadata === undefined ? {} : { metadata: structuredClone(value.metadata) }) };
  } finally { aad.fill(0); if (inflated !== plaintext) inflated?.fill(0); plaintext?.fill(0); }
}
function safeProductionMessage(error: unknown): string { return error instanceof Error ? error.message : 'remembered share could not be opened'; }
function canonicalRememberedRelay(value: string): string {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '') ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')))) {
    throw new Error('remembered relay configuration is invalid');
  }
  return url.origin;
}
function digest(bytes: Uint8Array): string { const value = sha256(bytes); try { return base64UrlEncode(value); } finally { value.fill(0); } }
function randomProtocolId(): string { return base64UrlEncode(crypto.getRandomValues(new Uint8Array(16))); }
async function strictJson(response: Response, label: string): Promise<unknown> {
  if (!response.ok) throw new Error(`${label} fetch failed (${response.status})`);
  return response.json();
}
async function strictBoundedJson(response: Response, label: string, maxBytes: number): Promise<unknown> {
  const bytes = await readBoundedResponse(response, maxBytes, label);
  try { return JSON.parse(new TextDecoder().decode(bytes)) as unknown; }
  finally { bytes.fill(0); }
}
async function readBoundedResponse(response: Response, maxBytes: number, label: string, exactBytes?: number): Promise<Uint8Array> {
  if (!response.ok) throw new Error(`${label} fetch failed (${response.status})`);
  const declaredRaw = response.headers.get('Content-Length');
  if (declaredRaw !== null) {
    const declared = Number(declaredRaw);
    if (!Number.isSafeInteger(declared) || declared < 0 || declared > maxBytes ||
      (exactBytes !== undefined && declared !== exactBytes)) throw new Error(`${label} response length is invalid`);
  }
  if (!response.body) {
    if (exactBytes !== undefined && exactBytes !== 0) throw new Error(`${label} response length is invalid`);
    return new Uint8Array();
  }
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      total += value.byteLength;
      if (total > maxBytes || (exactBytes !== undefined && total > exactBytes)) {
        await reader.cancel().catch(() => undefined); throw new Error(`${label} response exceeds bound`);
      }
      chunks.push(value);
    }
    if (exactBytes !== undefined && total !== exactBytes) throw new Error(`${label} response length is invalid`);
    const result = new Uint8Array(total); let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
    for (const chunk of chunks) chunk.fill(0);
    return result;
  } catch (error) {
    for (const chunk of chunks) chunk.fill(0);
    throw error;
  }
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function cloneEntry<T extends PersistedShareOutboxEntry>(entry: T): T {
  const clone = structuredClone(entry);
  if (clone.state !== 'stale' && entry.state !== 'stale') clone.canonicalWireBytes = new Uint8Array(entry.canonicalWireBytes);
  return clone;
}
function idbRequest<T>(request: IDBRequest<T>): Promise<T> { return new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
}); }
function idbDone(tx: IDBTransaction): Promise<void> { return new Promise((resolve, reject) => {
  tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
  tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
}); }
