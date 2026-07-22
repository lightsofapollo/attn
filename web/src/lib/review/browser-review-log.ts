// Durable review-log hydration for hosted workspace tabs (attn-dgya).
//
// `reviewStore.events` is a per-tab in-memory buffer fed by the workspace
// lease holder's live BrowserSession. Every other tab of the same browser
// profile — a follower that lost the writer lease, or a tab whose own
// session has not started yet — previously left it empty even though each
// inbound envelope IS durably committed to the shared IndexedDB
// (BrowserSession.handleEnvelopeAsync → storage.commitInbound). This module
// replays that durable log through the exact verified inbound pipeline
// (BrowserWsClient decrypt + signature + capability authorization) into the
// review store, and keeps followers fresh by re-running the replay whenever
// the leader's session rings the REVIEW_INBOUND doorbell after a commit.
//
// Scope: review events, plus MINIMAL snapshot hydration for inline
// markdown/html blobs — anchor resolution (and therefore every margin card
// position) needs the latest snapshot's content + anchorIndex, so a
// follower with only content-less pointers rendered an empty margin.
// Content is pinned to the signed pointer's baseHash before it enters the
// store; R2-spilled blobs and the anchor-index REBUILD check stay with the
// live session (the leader hard-verifies each blob on live receipt, and a
// wrong-but-hash-valid index can only misplace a card into the orphan
// tray, never alter content).

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
import { decompressSnapshotIfNeeded } from './snapshot-compression';
import { REVIEW_INBOUND_CHANNEL_PREFIX, openBroadcastChannel } from '../tab-channels';
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
   * Promoted-manifest path → fileId map. Follower tabs have no authority
   * bindings, so this is how they scope the review margin to the active
   * file (store.setCurrentFile) — without it every thread is invisible.
   */
  bindings: Array<{ path: string; fileId: string }>;
}

export interface ReviewLogWatcher {
  /** Null when the workspace has no active published share to hydrate from. */
  readonly roomId: string | null;
  /** Promoted-manifest path → fileId map ([] when no active share). */
  readonly bindings: ReadonlyArray<{ path: string; fileId: string }>;
  close(): void;
}

export interface WatchWorkspaceReviewLogOptions {
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
 * error) hydrates nothing rather than failing workspace open.
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
    if (capability.publishedManifest) candidates.push({ roomId: share.roomId, capId: share.capId });
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
 * so live delivery in the leader tab and repeated doorbell replays here
 * never duplicate a thread.
 */
export async function replayReviewLogIntoStore(options: {
  storage: BrowserStorage;
  room: ReviewLogRoomKeys;
  store: ReviewStoreSink;
  /** Snapshot ids already hydrated by an earlier pass of THIS watcher —
   *  skips re-decompressing unchanged blobs on every doorbell ring. */
  hydratedSnapshots?: Set<string>;
}): Promise<void> {
  const { storage, room, store } = options;
  const hydrated = options.hydratedSnapshots ?? new Set<string>();
  if (store.currentRoomId !== room.roomId) store.currentRoomId = room.roomId as RoomId;
  store.noteRoomRole?.(room.roomId as RoomId, 'owner');
  const devices = await storage.listDevices(room.roomId);
  // Snapshot pointers harvested during the event pass (blobId → pointer),
  // and the decrypted blob payloads the pipeline hands back — hydrated
  // AFTER the replay loop so the (sync) onEnvelope callback never races an
  // async decompress against client.close().
  const pointers = new Map<string, SnapshotPointer>();
  const decodedBlobs: Array<{ blobId: string; plaintext: Uint8Array }> = [];
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
            blobId: decoded.envelope.envelopeId,
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
    // Debug-level breadcrumb: an unexpectedly empty review surface in a
    // follower tab is diagnosable from these counts alone.
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
      const pointer = pointers.get(blob.blobId);
      if (!pointer) {
        blob.plaintext.fill(0);
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
 * Verify + apply one replayed inline snapshot blob. Content is pinned to
 * the signed pointer's baseHash; markdown/html only (assets and workspace
 * manifests have no bearing on margin anchoring, and R2 wrappers parse to
 * null and are skipped — those threads stay in the orphan tray until this
 * tab is promoted and the live session recovers the spill).
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
  };
  store.applySnapshot(snapshot);
  hydrated.add(body.snapshotId);
}

/**
 * Hydrate the review store from the workspace's durable log NOW, then keep
 * it fresh: every REVIEW_INBOUND doorbell ring from the lease holder's live
 * session re-runs the replay. Rings arriving mid-replay coalesce into one
 * trailing pass instead of stacking. Returns after the initial hydration so
 * callers observe a populated store deterministically.
 */
export async function watchWorkspaceReviewLog(
  options: WatchWorkspaceReviewLogOptions,
): Promise<ReviewLogWatcher> {
  const discover = options.discover ?? discoverReviewLogRoom;
  let room: ReviewLogRoomKeys | null = null;
  try {
    room = await discover(options.storage, options.workspaceId);
  } catch {
    room = null;
  }
  if (!room) return { roomId: null, bindings: [], close: () => undefined };
  const active = room;
  const store = options.store ?? (await resolveReviewStore());
  const hydratedSnapshots = new Set<string>();

  let closed = false;
  let replaying = false;
  let rerunWanted = false;
  const replay = async (): Promise<void> => {
    if (closed || replaying) {
      rerunWanted = rerunWanted || replaying;
      return;
    }
    replaying = true;
    try {
      await replayReviewLogIntoStore({ storage: options.storage, room: active, store, hydratedSnapshots });
    } catch (error) {
      // Best-effort: the next ring (or the next workspace open) retries —
      // but say so, or a follower tab silently renders an empty review
      // surface with no trace of why.
      console.warn('attn: review-log replay failed', error);
    } finally {
      replaying = false;
    }
    if (rerunWanted && !closed) {
      rerunWanted = false;
      void replay();
    }
  };
  await replay();

  const channel = openBroadcastChannel(REVIEW_INBOUND_CHANNEL_PREFIX + active.roomId);
  if (channel) channel.onmessage = () => void replay();
  return {
    roomId: active.roomId,
    bindings: active.bindings,
    close: (): void => {
      if (closed) return;
      closed = true;
      channel?.close();
      active.eventKey.fill(0);
      active.snapshotKey.fill(0);
      active.signalingKey.fill(0);
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

/** Replay only ever copies the three AEAD keys out; clobber the rest. */
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
