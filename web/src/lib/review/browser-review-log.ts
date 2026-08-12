// WorkspaceReviewProjection — the ONE hosted read path for review state
// (attn-kobw, part 1 of the single-projection architecture attn-whdh).
//
// The durable IndexedDB log + share records are the single source of truth
// for a hosted workspace's review state, but tabs used to materialize it
// through role-dependent paths: the lease-holding leader fed reviewStore
// straight from its live BrowserSession while followers replayed the durable
// log ad hoc (attn-dgya). Any two tabs could therefore disagree — the family
// of divergence bugs attn-dgya/nezn/90qq/37f9/lzee. This module is the cure:
// every hosted workspace tab, leader included (attn-ij9y), materializes the
// review store exclusively through this projection, which
//
//   1. discovers the active share record from storage (roomId, promoted
//      path → fileId bindings);
//   2. replays the durable event log through the exact verified inbound
//      pipeline (BrowserWsClient decrypt + signature + capability checks),
//      including inline snapshot-blob hydration — anchor resolution (and
//      therefore every margin card position) needs snapshot content;
//   3. re-replays on the REVIEW_INBOUND doorbell rung after every durable
//      commit (inbound network commit or the leader's own outbound enqueue);
//   4. re-discovers on the SHARE_RECORDS doorbell: room re-provisioning
//      (attn-hh9r) and stop/re-share can rotate the record's roomId at share
//      revision+1, and a tab that kept following the stale room was exactly
//      the two-tab divergence this epic exists to kill. On rotation the old
//      room's materialized state is dropped and the new room replayed.
//
// R2-spilled snapshot blobs are replayed from the durable log after their
// pointer and blob doorbells arrive. The live session still verifies network
// receipt, but it never gets a privileged store-write path: a projection is
// the only way any hosted tab materializes review plaintext.

import { BrowserWsClient, type DecodedEnvelope, type MailboxEnvelope } from './browser-ws';
import type { BrowserStorage } from './browser-storage';
import {
  ownerCredentialsFromInviteCapability,
  ownerCredentialsV3FromInviteCapability,
  parseBrowserSnapshotPlaintext,
  type BrowserOwnerCredentials,
  type ReviewStoreSink,
} from './browser-session';
import { contentHash } from './browser-crypto';
import { resolveBrowserR2Snapshot } from './browser-snapshot-r2';
import { decompressSnapshotIfNeeded } from './snapshot-compression';
import {
  REVIEW_INBOUND_CHANNEL_PREFIX,
  SHARE_RECORDS_CHANNEL_PREFIX,
  openBroadcastChannel,
  subscribeLocalDoorbell,
} from '../tab-channels';
import type {
  EventMeta,
  ReviewEvent,
  ReviewEventBody,
  ReviewSnapshot,
  RoomId,
} from '../types';

/** Minimal material a replay needs; everything else in the sealed owner
 * capability is zeroed immediately after discovery. */
export interface ReviewLogRoomKeys {
  roomId: string;
  /** Owner device id — the same identity every tab of this profile holds. */
  deviceId: string;
  protocolVersion: 2 | 3;
  eventKey: Uint8Array;
  snapshotKey: Uint8Array;
  signalingKey: Uint8Array;
  /**
   * Relay admission key retained solely to authenticate the existing R2
   * resolver's cached-body verification (read-scoped in v3). Projection
   * replay never makes a network request, so it is never sent anywhere.
   */
  readAdmissionKey: Uint8Array;
  /**
   * Promoted-manifest path → fileId map. This is how EVERY hosted tab scopes
   * the review margin to the active file (attn-9ek7) — the authority's
   * runtime bindings are no longer a review-state read path.
   */
  bindings: Array<{ path: string; fileId: string }>;
}

/** One typed snapshot of the projection: roomId, bindings, replay status. */
export interface WorkspaceReviewProjectionState {
  /** Null when the workspace has no active published share to hydrate from. */
  roomId: string | null;
  /** Promoted-manifest path → fileId map ([] when no active share). */
  bindings: ReadonlyArray<{ path: string; fileId: string }>;
  /**
   * 'idle' — no active share; 'ready' — the durable log for the current
   * room has been replayed; 'failed' — the last replay threw (the next
   * doorbell ring retries).
   */
  replay: 'idle' | 'ready' | 'failed';
}

export interface WorkspaceReviewProjectionOptions {
  storage: BrowserStorage;
  workspaceId: string;
  /** Test seam; production resolves the runes reviewStore singleton lazily. */
  store?: ReviewStoreSink;
  /** Test seam; production discovers the workspace's active published share. */
  discover?: (storage: BrowserStorage, workspaceId: string) => Promise<ReviewLogRoomKeys | null>;
}

/**
 * Locate the workspace's single active published share and derive exactly
 * the material a replay needs. Best-effort by design: no share, no workspace
 * key, or an ambiguous share set (which runtime startup surfaces as its own
 * error) hydrates nothing rather than failing workspace open. A durable
 * share whose lifecycle left 'active' (revoke_pending tombstone awaiting
 * remote teardown, expiry) is NOT discoverable — Stop sharing must clear the
 * review surface even when the relay was unreachable (attn-9ek7).
 */
export async function discoverReviewLogRoom(
  storage: BrowserStorage,
  workspaceId: string,
): Promise<ReviewLogRoomKeys | null> {
  const rootKey = await storage.getWorkspaceRootKey(workspaceId);
  if (!rootKey) return null;
  const candidates: Array<{ roomId: string; capId: string }> = [];
  for (const share of await storage.shares.listShares(workspaceId)) {
    if (share.publication === 'stopped') continue;
    const capability = await storage.shares.openShare(rootKey, workspaceId, share.capId);
    if (!capability.publishedManifest) continue;
    if (capability.durableShare && capability.durableShare.lifecycle !== 'active') continue;
    candidates.push({ roomId: share.roomId, capId: share.capId });
  }
  if (candidates.length !== 1) return null;
  const { roomId, capId } = candidates[0]!;
  const capability = await storage.shares.openShare(rootKey, workspaceId, capId);
  const credentials = capability.durableShare
    ? ownerCredentialsV3FromInviteCapability(capability, roomId)
    : ownerCredentialsFromInviteCapability(capability, roomId);
  const room: ReviewLogRoomKeys = {
    roomId,
    deviceId: credentials.identity.deviceId,
    protocolVersion: credentials.protocolVersion ?? 2,
    eventKey: new Uint8Array(credentials.keys.eventKey),
    snapshotKey: new Uint8Array(credentials.keys.snapshotKey),
    signalingKey: new Uint8Array(credentials.keys.signalingKey),
    readAdmissionKey: new Uint8Array(
      credentials.protocolVersion === 3
        ? credentials.readAdmissionKey!
        : credentials.keys.admissionKey,
    ),
    bindings: (capability.publishedManifest?.entries ?? []).map((entry) => ({
      path: entry.path,
      fileId: entry.fileId,
    })),
  };
  zeroOwnerCredentialMaterial(credentials);
  return room;
}

/**
 * One idempotent pass: replay every durably committed review event for
 * `room` into the store. ReviewStore.applyEvent dedups by (roomId, eventId),
 * so optimistic local echoes and repeated doorbell replays never duplicate
 * a thread. Pending outbox envelopes are included — the leader's own
 * comment is durably enqueued before its doorbell ring, so this replay is
 * what renders it (attn-ij9y).
 */
export async function replayReviewLogIntoStore(options: {
  storage: BrowserStorage;
  room: ReviewLogRoomKeys;
  store: ReviewStoreSink;
  /** Snapshot ids already hydrated by an earlier pass of THIS projection —
   *  skips re-decompressing unchanged blobs on every doorbell ring. */
  hydratedSnapshots?: Set<string>;
}): Promise<void> {
  const { storage, room, store } = options;
  const hydrated = options.hydratedSnapshots ?? new Set<string>();
  // Adopt the room: undismiss (a rotation may return to a previously-left
  // roomId), stamp the owner role, and select it for thread scoping.
  if (store.adoptRoom) {
    store.adoptRoom(room.roomId as RoomId, 'owner');
  } else {
    if (store.currentRoomId !== room.roomId) store.currentRoomId = room.roomId as RoomId;
    store.noteRoomRole?.(room.roomId as RoomId, 'owner');
  }
  const devices = await storage.listDevices(room.roomId);
  // Snapshot pointers harvested during the event pass (blobId → pointer),
  // and the decrypted blob payloads the pipeline hands back — hydrated
  // AFTER the replay loop so the (sync) onEnvelope callback never races an
  // async decompress against client.close().
  const pointers = new Map<string, SnapshotPointer>();
  const decodedBlobs: Array<{ envelope: MailboxEnvelope; plaintext: Uint8Array }> = [];
  // Never started: replayEnvelope() drives the verified decrypt/signature
  // pipeline entirely offline; the connection fields only satisfy the
  // constructor shape.
  const client = new BrowserWsClient({
    roomId: room.roomId,
    localDeviceId: room.deviceId,
    url: 'wss://replay.invalid/',
    subprotocol: 'attn.replay',
    afterSeq: 0,
    eventKey: room.eventKey,
    snapshotKey: room.snapshotKey,
    signalingKey: room.signalingKey,
    protocolVersion: room.protocolVersion,
    initialDevices: new Map(devices.map((device, index) => [`stored-${index}`, device])),
    callbacks: {
      onEnvelope: (decoded) => {
        if (decoded.envelope.kind === 'snapshot_blob') {
          decodedBlobs.push({
            envelope: decoded.envelope,
            plaintext: new Uint8Array(decoded.plaintext),
          });
          decoded.plaintext.fill(0);
          return;
        }
        applyReplayedReviewEvent(store, decoded, pointers);
      },
    },
  });
  try {
    const [inbound, history, pending] = await Promise.all([
      storage.replayInbound(room.roomId),
      storage.listHistory(room.roomId),
      storage.listOutbox(room.roomId, room.deviceId),
    ]);
    const replayById = new Map<string, { envelope: MailboxEnvelope; serverSeq: number }>();
    const storedBlobs = new Map<string, { envelope: MailboxEnvelope; serverSeq: number }>();
    for (const item of [...inbound, ...history]) {
      if (item.envelope.kind === 'snapshot_blob') {
        storedBlobs.set(item.envelope.envelopeId, item);
        continue;
      }
      if (item.envelope.kind !== 'event') continue;
      replayById.set(item.envelope.envelopeId, item);
    }
    for (const envelope of pending) {
      if (envelope.kind !== 'event') continue;
      if (!replayById.has(envelope.envelopeId)) {
        replayById.set(envelope.envelopeId, { envelope, serverSeq: 0 });
      }
    }
    const replay = [...replayById.values()].sort((a, b) => {
      if (a.serverSeq > 0 && b.serverSeq > 0) return a.serverSeq - b.serverSeq;
      if (a.serverSeq > 0) return -1;
      if (b.serverSeq > 0) return 1;
      return a.envelope.createdAt - b.envelope.createdAt;
    });
    // Debug-level breadcrumb: an unexpectedly empty review surface in any
    // tab is diagnosable from these counts alone.
    console.debug('attn: review-log replay', {
      roomId: room.roomId,
      inbound: inbound.length,
      history: history.length,
      pending: pending.length,
      replaying: replay.length,
    });
    for (const item of replay) await client.replayEnvelope(item.envelope, item.serverSeq);
    // Second pass: decrypt the snapshot blobs the harvested pointers name
    // (skipping ones a previous ring already hydrated), then verify + apply
    // outside the client so close() can't race the async decompress.
    for (const [blobId, pointer] of pointers) {
      if (hydrated.has(pointer.body.snapshotId)) continue;
      const item = storedBlobs.get(blobId);
      if (item) await client.replayEnvelope(item.envelope, item.serverSeq);
    }
    for (const blob of decodedBlobs) {
      const pointer = pointers.get(blob.envelope.envelopeId);
      if (!pointer) {
        blob.plaintext.fill(0);
        continue;
      }
      if (isR2BlobRefPlaintext(blob.plaintext, blob.envelope.envelopeId)) {
        // The envelope wrapper has already passed BrowserWsClient's AEAD +
        // device-signature pipeline. The resolver re-opens it to bind the
        // cached sealed body to its signed blob reference. It is deliberately
        // cache-only here: no projection tab learns a presigned R2 URL or
        // writes a newly fetched body through a live-session authority.
        blob.plaintext.fill(0);
        let recovered: Uint8Array | null = null;
        try {
          recovered = await resolveBrowserR2Snapshot({
            relayUrl: 'https://replay.invalid/',
            roomId: room.roomId,
            admissionKey: room.readAdmissionKey,
            protocolVersion: room.protocolVersion,
            snapshotKey: room.snapshotKey,
            wrapper: blob.envelope,
            fetchImpl: async () => {
              throw new Error('projection R2 recovery is cache-only');
            },
            sealedCache: {
              getSealed: (storedRoomId, blobId) => storage.getSealedBlob(storedRoomId, blobId),
              // A projection has no privileged network receipt path. It may
              // consume a sealed body verified and persisted earlier, never
              // persist one itself.
              putSealed: () => undefined,
            },
          });
          await hydrateReplayedSnapshot(store, pointer, recovered, hydrated);
        } catch {
          // A cache miss or integrity failure leaves the snapshot unhydrated
          // for this pass. There is intentionally no fallback network fetch;
          // the next durable blob commit + doorbell can retry safely.
        } finally {
          recovered?.fill(0);
        }
        continue;
      }
      await hydrateReplayedSnapshot(store, pointer, blob.plaintext, hydrated);
    }
  } finally {
    client.close();
  }
}

type SnapshotPointer = {
  meta: EventMeta;
  body: Extract<ReviewEventBody, { type: 'snapshot_created' }>;
};

/**
 * BrowserWsClient has authenticated the wrapper before this runs. This small
 * shape check only selects the cache-only R2 path; the resolver repeats the
 * cryptographic wrapper and sealed-body validation before any plaintext is
 * materialized.
 */
function isR2BlobRefPlaintext(bytes: Uint8Array, envelopeId: string): boolean {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return false;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const candidate = value as {
    storage?: unknown;
    blobId?: unknown;
    byteLength?: unknown;
    contentHash?: unknown;
  };
  return (
    candidate.storage === 'r2'
    && candidate.blobId === envelopeId
    && Number.isSafeInteger(candidate.byteLength)
    && (candidate.byteLength as number) >= 0
    && typeof candidate.contentHash === 'string'
  );
}

/**
 * Verify + apply one replayed inline snapshot blob. Content is pinned to
 * the signed pointer's baseHash; markdown/html only (assets and workspace
 * manifests have no bearing on margin anchoring).
 */
async function hydrateReplayedSnapshot(
  store: ReviewStoreSink,
  pointer: SnapshotPointer,
  plaintext: Uint8Array,
  hydrated: Set<string>,
): Promise<void> {
  const { meta, body } = pointer;
  if (hydrated.has(body.snapshotId)) {
    plaintext.fill(0);
    return;
  }
  let inflated: Uint8Array;
  try {
    inflated = await decompressSnapshotIfNeeded(plaintext);
  } catch {
    inflated = plaintext;
  }
  const parsed = parseBrowserSnapshotPlaintext(inflated);
  if (inflated !== plaintext) inflated.fill(0);
  plaintext.fill(0);
  if (!parsed || (parsed.docType !== 'markdown' && parsed.docType !== 'html')) return;
  const raw = new TextEncoder().encode(parsed.content);
  const byteLength = raw.length;
  const hashOk = contentHash(raw) === body.baseHash;
  raw.fill(0);
  if (!hashOk) return;
  const snapshot: ReviewSnapshot = {
    roomId: meta.roomId,
    fileId: body.fileId,
    snapshotId: body.snapshotId,
    ownerDisplayPath: body.ownerDisplayPath,
    parentSnapshotId: body.parentSnapshotId,
    createdAt: meta.createdAt,
    createdBy: meta.authorId,
    baseHash: body.baseHash,
    byteLength,
    docType: parsed.docType,
    encryptedBlobRef: body.encryptedBlobRef,
    content: parsed.content,
    ...(parsed.docType === 'markdown' && parsed.anchorIndex !== undefined
      ? { anchorIndex: parsed.anchorIndex }
      : {}),
    // HTML's annotation substrate is a declared capability, not an index —
    // dropping it here leaves the reviewer with a read-only document.
    ...(parsed.docType === 'html' && parsed.annotation !== undefined
      ? { annotation: parsed.annotation }
      : {}),
  };
  store.applySnapshot(snapshot);
  hydrated.add(body.snapshotId);
}

/**
 * The single role-agnostic review-state materializer for one hosted
 * workspace tab (attn-kobw). Construct via `openWorkspaceReviewProjection`;
 * the returned handle is `getState()/subscribe()/refresh()/close()`.
 */
export class WorkspaceReviewProjection {
  private readonly storage: BrowserStorage;
  private readonly workspaceId: string;
  private readonly discover: (
    storage: BrowserStorage,
    workspaceId: string,
  ) => Promise<ReviewLogRoomKeys | null>;
  private store: ReviewStoreSink | null;

  private stateValue: WorkspaceReviewProjectionState = {
    roomId: null,
    bindings: [],
    replay: 'idle',
  };
  private readonly subscribers = new Set<(state: WorkspaceReviewProjectionState) => void>();

  private room: ReviewLogRoomKeys | null = null;
  private hydratedSnapshots = new Set<string>();
  private closed = false;

  // Serialized work queue: discovery passes and replay passes never overlap,
  // so a rotation can never race a replay of the room it is retiring.
  private tail: Promise<void> = Promise.resolve();
  private replayQueued = false;
  private discoverQueued = false;

  private roomChannel: BroadcastChannel | null = null;
  private unsubscribeRoomLocal: (() => void) | null = null;
  private shareChannel: BroadcastChannel | null = null;
  private unsubscribeShareLocal: (() => void) | null = null;

  constructor(options: WorkspaceReviewProjectionOptions) {
    this.storage = options.storage;
    this.workspaceId = options.workspaceId;
    this.discover = options.discover ?? discoverReviewLogRoom;
    this.store = options.store ?? null;
  }

  getState(): WorkspaceReviewProjectionState {
    return { ...this.stateValue, bindings: [...this.stateValue.bindings] };
  }

  /** Delivers the current state immediately, then every change. */
  subscribe(subscriber: (state: WorkspaceReviewProjectionState) => void): () => void {
    this.subscribers.add(subscriber);
    subscriber(this.getState());
    return () => this.subscribers.delete(subscriber);
  }

  /** Coalescing durable-log re-replay — the review-doorbell target. */
  refresh(): Promise<void> {
    if (this.closed || this.replayQueued) return Promise.resolve();
    this.replayQueued = true;
    return this.enqueue(async () => {
      this.replayQueued = false;
      await this.replayPass();
    });
  }

  /** Coalescing share-record re-discovery — the share-doorbell target. */
  refreshShareRecord(): Promise<void> {
    if (this.closed || this.discoverQueued) return Promise.resolve();
    this.discoverQueued = true;
    return this.enqueue(async () => {
      this.discoverQueued = false;
      await this.discoverPass();
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.detachRoomDoorbell();
    this.unsubscribeShareLocal?.();
    this.unsubscribeShareLocal = null;
    this.shareChannel?.close();
    this.shareChannel = null;
    if (this.room) {
      zeroRoomKeys(this.room);
      this.room = null;
    }
    this.subscribers.clear();
  }

  /** Resolve the store, subscribe the share doorbell, hydrate NOW. Returns
   *  after the initial discovery + replay so callers observe a populated
   *  store deterministically. */
  async open(): Promise<void> {
    this.store ??= await resolveReviewStore();
    if (this.closed) return;
    const shareChannelName = SHARE_RECORDS_CHANNEL_PREFIX + this.workspaceId;
    this.shareChannel = openBroadcastChannel(shareChannelName);
    if (this.shareChannel) this.shareChannel.onmessage = () => void this.refreshShareRecord();
    this.unsubscribeShareLocal = subscribeLocalDoorbell(
      shareChannelName,
      () => void this.refreshShareRecord(),
    );
    await this.enqueue(() => this.discoverPass());
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const run = this.tail.then(operation, operation);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Re-read the share record; follow a room rotation by resetting +
   *  re-replaying (attn-hh9r divergence). Runs only on the queue. */
  private async discoverPass(): Promise<void> {
    if (this.closed) return;
    let next: ReviewLogRoomKeys | null = null;
    try {
      next = await this.discover(this.storage, this.workspaceId);
    } catch {
      next = null;
    }
    if (this.closed) {
      if (next) zeroRoomKeys(next);
      return;
    }
    const previous = this.room;
    if (previous && next?.roomId !== previous.roomId) {
      // Rotation or share stopped: the old room's materialized threads are
      // dead state now — leaveRoom drops its events/snapshots/resolutions
      // and clears the selection if it pointed there.
      this.store?.leaveRoom?.(previous.roomId as RoomId);
      zeroRoomKeys(previous);
      this.room = null;
      this.hydratedSnapshots = new Set<string>();
      this.detachRoomDoorbell();
    }
    if (next && this.room?.roomId === next.roomId && this.room !== next) {
      // Same room, refreshed record (manifest/bindings may have changed).
      zeroRoomKeys(this.room);
      this.room = next;
    } else if (next && !this.room) {
      this.room = next;
      this.attachRoomDoorbell(next.roomId);
    }
    this.patchState({
      roomId: this.room?.roomId ?? null,
      bindings: this.room ? [...this.room.bindings] : [],
      ...(this.room ? {} : { replay: 'idle' as const }),
    });
    if (this.room) await this.replayPass();
  }

  /** One replay of the current room's durable log. Runs only on the queue. */
  private async replayPass(): Promise<void> {
    const room = this.room;
    const store = this.store;
    if (this.closed || !room || !store) return;
    try {
      await replayReviewLogIntoStore({
        storage: this.storage,
        room,
        store,
        hydratedSnapshots: this.hydratedSnapshots,
      });
      this.patchState({ replay: 'ready' });
    } catch (error) {
      // Best-effort: the next ring (or the next workspace open) retries —
      // but say so, or a tab silently renders an empty review surface with
      // no trace of why.
      console.warn('attn: review-log replay failed', error);
      this.patchState({ replay: 'failed' });
    }
  }

  private attachRoomDoorbell(roomId: string): void {
    const name = REVIEW_INBOUND_CHANNEL_PREFIX + roomId;
    this.roomChannel = openBroadcastChannel(name);
    if (this.roomChannel) this.roomChannel.onmessage = () => void this.refresh();
    // Same-tab delivery: the leader's own session rings after each durable
    // commit, and BroadcastChannel never loops back to the posting context —
    // without this the LEADER tab would be the one lagging (attn-ij9y).
    this.unsubscribeRoomLocal = subscribeLocalDoorbell(name, () => void this.refresh());
  }

  private detachRoomDoorbell(): void {
    this.unsubscribeRoomLocal?.();
    this.unsubscribeRoomLocal = null;
    this.roomChannel?.close();
    this.roomChannel = null;
  }

  private patchState(patch: Partial<WorkspaceReviewProjectionState>): void {
    const next: WorkspaceReviewProjectionState = { ...this.stateValue, ...patch };
    const bindingsChanged =
      next.bindings.length !== this.stateValue.bindings.length ||
      next.bindings.some(
        (binding, index) =>
          binding.path !== this.stateValue.bindings[index]?.path ||
          binding.fileId !== this.stateValue.bindings[index]?.fileId,
      );
    if (
      !bindingsChanged &&
      next.roomId === this.stateValue.roomId &&
      next.replay === this.stateValue.replay
    ) {
      return;
    }
    this.stateValue = next;
    const snapshot = this.getState();
    for (const subscriber of [...this.subscribers]) subscriber(snapshot);
  }
}

/**
 * Open the projection for a workspace and hydrate the review store NOW.
 * Every hosted workspace tab — leader or follower — holds exactly one of
 * these for the route lifetime (EditorShell's watcher effect).
 */
export async function openWorkspaceReviewProjection(
  options: WorkspaceReviewProjectionOptions,
): Promise<WorkspaceReviewProjection> {
  const projection = new WorkspaceReviewProjection(options);
  await projection.open();
  return projection;
}

/**
 * The hosted owner session's store sink (attn-ij9y). The leader's live
 * BrowserSession no longer materializes review EVENTS into the runes store —
 * inbound envelopes commit durably and ring the doorbell, outbound envelopes
 * enqueue durably and ring, and the projection replays both into the store
 * exactly as it does in follower tabs. If the projection ever misses an
 * event, the leader sees the bug too: divergence impossible by construction.
 *
 * What still passes through:
 *   - pendingOutbox: the ReviewBar's OutboxIndicator ("N pending · Retry")
 *     reflects the live outbox, which only the session knows.
 * Everything else — including snapshots — belongs to the projection +
 * EditorShell. A durable snapshot blob now rings the same review doorbell as
 * an event, so the projection will re-hydrate it after verified persistence.
 */
export function createHostedOwnerSessionStoreSink(): ReviewStoreSink {
  let target: ReviewStoreSink | null = null;
  let loading: Promise<void> | null = null;
  const withStore = (apply: (store: ReviewStoreSink) => void): void => {
    if (target) {
      apply(target);
      return;
    }
    loading ??= resolveReviewStore().then((store) => {
      target = store;
    });
    void loading.then(() => {
      if (target) apply(target);
    }).catch(() => undefined);
  };
  return {
    // Projection-owned: the durable commit + doorbell that precede this call
    // are the real write path. Deliberately NOT forwarded.
    applyEvent: () => undefined,
    applySnapshot: () => undefined,
    setCurrentFile: () => undefined,
    setCurrentSnapshot: () => undefined,
    // Plain inert fields — the session stamps/clears them on start/close,
    // but the projection owns the real store's room selection. leaveRoom is
    // intentionally absent: a transport failure in the leader must not wipe
    // the projection-materialized threads (storage still has them).
    currentRoomId: null,
    currentFileId: null,
    get pendingOutbox(): unknown[] {
      return target?.pendingOutbox ?? [];
    },
    set pendingOutbox(value: unknown[]) {
      withStore((store) => {
        store.pendingOutbox = value;
      });
    },
  };
}

/**
 * Runes singleton resolved lazily — same pattern as BrowserSession's
 * ensureStore, so plain-tsx tests can inject a stub without loading the
 * `.svelte.ts` module.
 */
async function resolveReviewStore(): Promise<ReviewStoreSink> {
  const mod = await import('./store.svelte.js');
  return mod.reviewStore as unknown as ReviewStoreSink;
}

function applyReplayedReviewEvent(
  store: ReviewStoreSink,
  decoded: DecodedEnvelope,
  pointers: Map<string, SnapshotPointer>,
): void {
  const { envelope, plaintext } = decoded;
  if (envelope.kind !== 'event') {
    plaintext.fill(0);
    return;
  }
  let parsed: { meta?: EventMeta; body?: ReviewEventBody; auth?: ReviewEvent['auth'] };
  try {
    parsed = JSON.parse(new TextDecoder().decode(plaintext)) as typeof parsed;
  } catch {
    return;
  } finally {
    plaintext.fill(0);
  }
  const meta = parsed.meta;
  const body = parsed.body;
  const auth = parsed.auth;
  if (!meta || !body || !auth) return;
  store.applyEvent({ meta, body, auth });
  // Harvest snapshot pointers for the blob-hydration pass: the pointer's
  // signed baseHash is what pins each decrypted blob's content.
  if (body.type === 'snapshot_created' && body.encryptedBlobRef !== undefined) {
    pointers.set(body.encryptedBlobRef.blobId, { meta, body });
  }
}

function zeroRoomKeys(room: ReviewLogRoomKeys): void {
  room.eventKey.fill(0);
  room.snapshotKey.fill(0);
  room.signalingKey.fill(0);
  room.readAdmissionKey.fill(0);
}

/** Replay copies only its necessary AEAD + read-admission keys; clobber the rest. */
function zeroOwnerCredentialMaterial(credentials: BrowserOwnerCredentials): void {
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
