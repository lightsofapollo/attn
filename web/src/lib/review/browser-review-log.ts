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
// Scope: review events only. Snapshot BLOB hydration (content/anchor-index
// verification, R2 recovery) stays with the live session — snapshot pointer
// events still mirror content-less placeholders via ReviewStore.applyEvent,
// which is enough for thread reconstruction.

import { BrowserWsClient, type DecodedEnvelope, type MailboxEnvelope } from './browser-ws';
import type { BrowserStorage } from './browser-storage';
import {
  ownerCredentialsFromInviteCapability,
  ownerCredentialsV3FromInviteCapability,
  type BrowserOwnerCredentials,
  type ReviewStoreSink,
} from './browser-session';
import { REVIEW_INBOUND_CHANNEL_PREFIX, openBroadcastChannel } from '../tab-channels';
import type { EventMeta, ReviewEvent, ReviewEventBody, RoomId } from '../types';

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
}

export interface ReviewLogWatcher {
  /** Null when the workspace has no active published share to hydrate from. */
  readonly roomId: string | null;
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
}): Promise<void> {
  const { storage, room, store } = options;
  if (store.currentRoomId !== room.roomId) store.currentRoomId = room.roomId as RoomId;
  store.noteRoomRole?.(room.roomId as RoomId, 'owner');
  const devices = await storage.listDevices(room.roomId);
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
      onEnvelope: (decoded) => applyReplayedReviewEvent(store, decoded),
    },
  });
  try {
    const [inbound, history, pending] = await Promise.all([
      storage.replayInbound(room.roomId),
      storage.listHistory(room.roomId),
      storage.listOutbox(room.roomId, room.deviceId),
    ]);
    const replayById = new Map<string, { envelope: MailboxEnvelope; serverSeq: number }>();
    for (const item of [...inbound, ...history]) {
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
    for (const item of replay) await client.replayEnvelope(item.envelope, item.serverSeq);
  } finally {
    client.close();
  }
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
  if (!room) return { roomId: null, close: () => undefined };
  const active = room;
  const store = options.store ?? (await resolveReviewStore());

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
      await replayReviewLogIntoStore({ storage: options.storage, room: active, store });
    } catch {
      // Best-effort: the next ring (or the next workspace open) retries.
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

function applyReplayedReviewEvent(store: ReviewStoreSink, decoded: DecodedEnvelope): void {
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
