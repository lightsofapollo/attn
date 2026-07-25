// Browser-side review session orchestrator (attn-nnj.9.4).
//
// Stitches together the lower-level pieces built in 9.2 / 9.3:
//
//   - `browser-invite.ts` — parse + strip the `#key=…` fragment.
//   - `browser-crypto.ts`  — HKDF + admission HMAC + AAD AEAD + signature verify.
//   - `browser-ws.ts`      — encrypted mailbox WebSocket transport.
//
// The session is a reviewer surface with encrypted mailbox authoring:
//   1. Parse + strip the invite fragment from `location.hash`.
//   2. Derive `RoomKeys` and `roomId` from `roomSecret`.
//   3. Generate an in-memory `(deviceId, signingKeyPair, encryptionKeyPair)` by
//      default, or explicitly recover a remembered room from encrypted local
//      state. Invite-only mode still performs no durable writes.
//   4. POST `/v2/rooms/:roomId/devices` with `kind: "reviewer"` + admission HMAC
//      + selfSignature + a Web-Worker-minted PoW token.
//   5. Open the `BrowserWsClient` and pump decoded envelopes into the global
//      `reviewStore`. The store already knows how to render comments,
//      suggestions, ambiguous/stale anchors, and snapshots via the existing
//      Phase 2 components — see `web/src/lib/ReviewMargin.svelte`.
//
// What this module deliberately leaves out:
//
//   - Owner-only mutations such as applying suggestions or publishing snapshots.
//   - Browser ownership and native working-copy mutation.
//   - Plaintext offline workspaces. Remembered rooms persist only keys and
//     exact encrypted envelopes / sealed snapshot blobs.
//
// Tests: `browser-session.test.ts`. Run with:
//
//   cd web && npx tsx src/lib/review/browser-session.test.ts

import { sanitizeParticipantColor } from '../participant-color';
import { decompressSnapshotIfNeeded } from './snapshot-compression';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import {
  base64UrlDecode,
  base64UrlEncode,
  buildAdmissionHeader,
  buildAdmissionHeaderV3,
  buildAdmissionSubprotocol,
  buildAdmissionSubprotocolV3,
  contentHash,
  deriveRoomId,
  deriveRoomIdV3,
  deriveRoomKeyTreeV3,
  deriveRoomKeys,
  deriveReadKeysV3,
  deriveShareEpochRoomSecret,
  toCanonicalBytes,
  type RoomKeys,
  type RoomKeyTreeV3,
} from './browser-crypto';
import {
  decodeCanonicalBase64Url,
  validateSnapshotPlaintext,
} from './browser-workspace-manifest';
import { assembleBrowserEvent, type AssembledBrowserEvent } from './browser-envelope';
import {
  BrowserOutbox,
  type BrowserOutboxError,
  type BrowserOutboxOptions,
  type BrowserOutboxPersistence,
  type BrowserOutboxResponse,
} from './browser-outbox';
import {
  BrowserStorage,
  type BrowserStorageRoom,
  type StoredInboundEnvelope,
} from './browser-storage';
import { StorageConflictError } from './browser-storage-errors';
import {
  parseAndStripInviteFromUrl,
  parseInviteUrl,
  zero,
  type BrowserWindowLike,
  type ParsedInvite,
} from './browser-invite';
import {
  BrowserWsClient,
  buildWsUrl,
  socketPath,
  type Device,
  type DecodedEnvelope,
  type MailboxEnvelope,
  type WebSocketLike,
  type WsTerminalError,
  type RoomPolicy,
} from './browser-ws';
import { BROWSER_POW_DIFFICULTY, mintBrowserPowInWorker } from './browser-pow';
import { validateBrowserRelayUrl } from './browser-relay-url';
import { resolveBrowserR2Snapshot } from './browser-snapshot-r2';
import {
  assembleBrowserSignal,
  parseBrowserSignalingPayload,
  type BrowserSignalingPayload,
} from './browser-signaling';
import {
  BrowserPeerMesh,
  type BrowserDirectState,
} from './browser-webrtc';
import { createDeviceWebSocketProofV3 } from './device-proof';
import { REVIEW_INBOUND_CHANNEL_PREFIX, openBroadcastChannel, ringLocalDoorbell } from '../tab-channels';
import type { InviteCapability } from './browser-workspace-share';
import {
  parseCollabWireMessage,
  type CollabWireMessage,
} from '../prosemirror/collab-controller';
import type {
  Anchor,
  AnchorIndex,
  Capability,
  DocType,
  EventId,
  EventMeta,
  FileId,
  ReviewEvent,
  ReviewEventBody,
  ReviewSnapshot,
  SnapshotId,
  SnapshotPlaintext,
  RoomId,
  SuggestionDraft,
  WorkspaceManifestEntry,
} from '../types';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Lifecycle state of the browser review session. */
export type BrowserSessionStatus =
  | 'idle'
  | 'parsing_invite'
  | 'invalid_invite'
  | 'registering_device'
  | 'connecting'
  | 'connected'
  | 'offline'
  | 'error'
  | 'terminated';

/** Tagged error surfaced to the UI for empty/error states. */
export interface BrowserSessionError {
  /**
   * Stable tag — UI maps to a localized message. Matches the close-code /
   * admission errors documented in `relay-spec.md`:
   *
   *   - `invite_invalid`     → fragment missing, malformed, or wrong shape
   *   - `device_register`    → POST /devices rejected (network or 4xx)
   *   - `admission_rejected` → WS close 4000
   *   - `room_deleted`       → WS close 4001
   *   - `room_expired`       → WS close 4002
   *   - `cursor_too_old`     → WS close 4005
   *   - `network`            → generic transport failure
   */
  kind:
    | 'invite_invalid'
    | 'device_register'
    | 'admission_rejected'
    | 'room_deleted'
    | 'room_expired'
    | 'cursor_too_old'
    | 'share_revoked'
    | 'network';
  message: string;
}

/**
 * In-memory device identity for the browser reviewer. Generated fresh on every
 * page load (per amendments.md #13 — no persistence).
 */
export interface BrowserDeviceIdentity {
  deviceId: string;
  participantId: string;
  /**
   * Ed25519 secret seed (32 bytes — matches `ed25519.keygen().secretKey` from
   * `@noble/curves`). Held only in JS memory.
   */
  signingSecret: Uint8Array;
  /** Ed25519 public key bytes (32). */
  signingPublic: Uint8Array;
  /** X25519 secret key bytes (32). Held only in JS memory. */
  encryptionSecret: Uint8Array;
  /** X25519 public key bytes (32). */
  publicEncryptionKey: Uint8Array;
}

/** Already-owned browser room material. The session validates and copies it. */
export interface BrowserOwnerCredentials {
  protocolVersion?: 2 | 3;
  roomId: string;
  roomSecret: Uint8Array;
  keys: RoomKeys;
  /** Present only for v3; `keys.admissionKey` is the write leaf. */
  readAdmissionKey?: Uint8Array;
  readCapabilityKey?: Uint8Array;
  identity: BrowserDeviceIdentity;
  policy: RoomPolicy;
}

export interface BrowserOwnerCredentialsV3 extends BrowserOwnerCredentials {
  protocolVersion: 3;
  shareSecret: Uint8Array;
  shareId: string;
  epoch: number;
}

export interface BrowserCollabDelivery {
  envelopeId: string;
  source: DecodedEnvelope['source'];
  payload: string;
  /** Authenticated immutable registration matching the envelope sender. */
  sender: Device;
}

/**
 * Reactive snapshot of the session that the UI can render off of. Pure plain
 * object — we wire it into a `$state` field at the component layer.
 */
/**
 * One registered room device other than this session's own, with live
 * presence. Derived from the authenticated device directory + relay
 * hello/presence frames; display names are resolved by the consumer (the
 * `ParticipantJoined` event log owns identities, not the transport).
 */
export interface BrowserPeerPresence {
  participantId: string;
  deviceId: string;
  kind: 'owner' | 'reviewer' | 'agent';
  online: boolean;
}

export interface BrowserSessionState {
  principal: 'owner' | 'reviewer';
  /** Authenticated owner-device presence, separate from relay connectivity. */
  ownerOnline: boolean;
  /** Every other registered device in the room, with live presence. */
  peers: BrowserPeerPresence[];
  /** True only while the owner authority and a transport are both online. */
  liveEditingAvailable: boolean;
  status: BrowserSessionStatus;
  /** Honest hybrid transport state; mailbox remains durable in every online state. */
  connection: BrowserDirectState | 'offline';
  /** Opaque diagnostic for direct setup only; never contains SDP or ICE. */
  directError: string | null;
  /** Non-null once the invite has been parsed (and stripped). */
  roomId: RoomId | null;
  /** Raw document source recovered from the latest SnapshotCreated. */
  snapshotContent: string | null;
  /** Kind of the latest snapshot — markdown (editor) or html (read-only). */
  snapshotDocType: DocType;
  /** Snapshot id of the latest snapshot we have content for. */
  snapshotId: SnapshotId | null;
  /** File id of the latest snapshot we have content for. */
  fileId: FileId | null;
  /** Tagged error, or null when status is healthy. */
  error: BrowserSessionError | null;
  /** True only after the signed ParticipantJoined envelope is acknowledged. */
  authoringReady: boolean;
  /** Effective invite tier; legacy v2 sessions retain suggest behavior. */
  grantTier: 'view' | 'comment' | 'suggest';
  /** Number of sealed event envelopes waiting for relay acknowledgement. */
  outboxPending: number;
  /** Last authoring transport error. Reading remains available. */
  authoringError: string | null;
  /** Local recovery is always opt-in; degraded means browser persistence was denied. */
  persistence: 'ephemeral' | 'saving' | 'remembered' | 'degraded';
  /** Result of navigator.storage.persist(); null before an explicit request. */
  storagePersisted: boolean | null;
  /** V2 recovery is available; scoped v3 capability persistence lands with durable shares. */
  canRemember: boolean;
}

/**
 * Narrow interface that the session writes into. The production wiring binds
 * this to the global `reviewStore` runes singleton; tests pass a plain
 * dictionary so the harness can run under `tsx` without the runes runtime.
 */
export interface ReviewStoreSink {
  applyEvent(event: ReviewEvent): void;
  applySnapshot(snapshot: ReviewSnapshot): void;
  setCurrentFile(fileId: FileId | null): void;
  setCurrentSnapshot(snapshotId: SnapshotId | null): void;
  /** Remove room-scoped plaintext and selection state on close/failure. */
  leaveRoom?(roomId: RoomId): void;
  /** Plain field write — runes proxy intercepts this in production. */
  currentRoomId: RoomId | null;
  /** Read by restore paths so they never steal a selection that exists. */
  currentFileId: FileId | null;
  /** Mark which side of the room this client is (role-gated owner UI). */
  noteRoomRole?(roomId: RoomId, role: 'owner' | 'reviewer'): void;
  /** Undismiss + role-stamp + select a room in one step (attn-kobw). The
   *  projection uses it when following a room rotation back onto a roomId
   *  that leaveRoom previously dismissed. */
  adoptRoom?(roomId: RoomId, role: 'owner' | 'reviewer'): void;
  /** Sealed browser envelopes awaiting relay acknowledgement. */
  pendingOutbox?: unknown[];
}

export interface BrowserSessionOptions {
  /** Explicit already-registered owner path; bypasses invite parsing and registration. */
  owner?: BrowserOwnerCredentials;
  /** Window-like for parsing the invite from location.hash. */
  window?: BrowserWindowLike;
  /**
   * Override the invite URL (used by tests). Takes precedence over the
   * window fragment when provided.
   */
  inviteUrl?: string;
  /** Already-parsed hosted invite; avoids reconstructing a secret-bearing URL. */
  parsedInvite?: ParsedInvite;
  /** Narrow-bootstrap parse failure to surface through the normal error state. */
  inviteError?: string;
  /** Clean fragmentless path candidate; malformed fragments never reach this fallback. */
  rememberedRoomId?: string;
  /** Relay base URL. Required before any network operation. */
  relayUrl?: string;
  /**
   * Override `fetch` for the `POST /devices` call. Tests inject a stub.
   * Receives the full URL + RequestInit shape (browser-compatible).
   */
  fetchImpl?: (url: string, init: FetchLikeInit) => Promise<FetchLikeResponse>;
  /** Binary fetch override for authenticated R2 snapshot resolution. */
  r2FetchImpl?: (input: string, init: RequestInit) => Promise<Response>;
  /** Override the WebSocket factory (used by tests with Node `ws`). */
  webSocketFactory?: (url: string, protocols: string | string[]) => WebSocketLike;
  /** WebRTC factory/test seam. Production uses the browser constructor. */
  peerConnectionFactory?: (configuration: RTCConfiguration) => RTCPeerConnection;
  /** Optional STUN-only override. TURN/TURNS values are rejected. */
  stunServers?: string[];
  /** Explicitly disable the opportunistic direct path. */
  disableWebRtc?: boolean;
  /** Override reconnect timing — tests want fast retries. */
  reconnectInitialMs?: number;
  reconnectMaxMs?: number;
  /** Override the PoW token (tests skip the miner). */
  powToken?: string;
  /** Override registration PoW minting (tests assert authenticated policy use). */
  registrationMintPow?: BrowserOutboxOptions['mintPow'];
  /** Override browser outbox PoW minting independently from registration. */
  outboxMintPow?: BrowserOutboxOptions['mintPow'];
  /** Canonical Rust/WASM anchor builder seam; loaded lazily in production. */
  anchorIndexBuilder?: (markdown: Uint8Array, snapshotId: string) => Promise<AnchorIndex>;
  /**
   * Human-readable encrypted ParticipantJoined display name, resolved at
   * announce time (a getter, not a snapshot — the name prompt may confirm
   * after construction but before authoring init).
   */
  getDisplayName?: () => string | undefined;
  /**
   * Picked identity color for ParticipantJoined (attn-3gdd), resolved at
   * announce time like the display name. Null/invalid → omitted (peers
   * derive the deterministic hash color from the participant id).
   */
  getColor?: () => string | null;
  /** Inject a pre-built identity (tests want deterministic keys). */
  identity?: BrowserDeviceIdentity;
  /** Optional state observer — called on every state mutation. */
  onState?: (state: BrowserSessionState) => void;
  /** Decrypted collab payload after sender-directory binding and envelope dedup. */
  onCollab?: (delivery: BrowserCollabDelivery) => void | Promise<void>;
  /**
   * Sink for review-event / snapshot dispatch. Defaults to the global
   * `reviewStore` runes singleton; tests pass a plain object so they can
   * run under tsx without loading `.svelte.ts` modules.
   */
  store?: ReviewStoreSink;
  /** Injected durable store for tests; production opens IndexedDB lazily. */
  storage?: BrowserStorage;
  /** Override the production IndexedDB opener. */
  storageFactory?: (createIfMissing: boolean) => Promise<BrowserStorage | null>;
}

/** Minimal fetch shape — avoids depending on lib.dom.d.ts in TS tests. */
export interface FetchLikeInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

export interface FetchLikeResponse {
  status: number;
  /** Read the body as text. */
  text(): Promise<string>;
  headers?: { get(name: string): string | null };
}

interface ActiveRoomKeys {
  version: 2 | 3;
  rootKey?: Uint8Array;
  readCapabilityKey?: Uint8Array;
  eventKey: Uint8Array;
  snapshotKey: Uint8Array;
  signalingKey: Uint8Array;
  readAdmissionKey: Uint8Array;
  writeAdmissionKey?: Uint8Array;
}

function activeV2Keys(keys: Omit<RoomKeys, 'rootKey'> & { rootKey?: Uint8Array }): ActiveRoomKeys {
  return {
    version: 2,
    rootKey: keys.rootKey,
    eventKey: keys.eventKey,
    snapshotKey: keys.snapshotKey,
    signalingKey: keys.signalingKey,
    readAdmissionKey: keys.admissionKey,
    writeAdmissionKey: keys.admissionKey,
  };
}

function activeOwnerKeys(credentials: BrowserOwnerCredentials): ActiveRoomKeys {
  if ((credentials.protocolVersion ?? 2) === 2) return activeV2Keys(credentials.keys);
  if (!credentials.readAdmissionKey || !credentials.readCapabilityKey) {
    throw new Error('v3 owner read capability is unavailable');
  }
  return {
    version: 3,
    rootKey: credentials.keys.rootKey,
    readCapabilityKey: credentials.readCapabilityKey,
    eventKey: credentials.keys.eventKey,
    snapshotKey: credentials.keys.snapshotKey,
    signalingKey: credentials.keys.signalingKey,
    readAdmissionKey: credentials.readAdmissionKey,
    writeAdmissionKey: credentials.keys.admissionKey,
  };
}

// ---------------------------------------------------------------------------
// Identity generation
// ---------------------------------------------------------------------------

/**
 * Generate a fresh in-memory device identity. Keys are derived from
 * `crypto.getRandomValues`; deviceId and participantId are random 16-byte
 * base64url strings.
 */
export function generateBrowserIdentity(): BrowserDeviceIdentity {
  const deviceSeed = new Uint8Array(32);
  crypto.getRandomValues(deviceSeed);
  const { secretKey, publicKey } = ed25519.keygen(deviceSeed);

  const idBytes = new Uint8Array(16);
  crypto.getRandomValues(idBytes);
  const partBytes = new Uint8Array(16);
  crypto.getRandomValues(partBytes);
  const encryption = x25519.keygen();

  return {
    deviceId: 'br-' + base64UrlEncode(idBytes),
    participantId: 'br-' + base64UrlEncode(partBytes),
    signingSecret: secretKey,
    signingPublic: publicKey,
    encryptionSecret: encryption.secretKey,
    publicEncryptionKey: encryption.publicKey,
  };
}

/** Reconstruct and cross-check owner runtime material opened from a sealed capability. */
export function ownerCredentialsFromInviteCapability(
  capability: InviteCapability,
  expectedRoomId: string,
): BrowserOwnerCredentials {
  if (!expectedRoomId) throw new Error('expected owner roomId is required');
  // Keep every secret-bearing allocation tracked until ownership is
  // transferred to the successful return value. A later decode or validation
  // failure must clobber material decoded earlier in the sequence.
  let roomSecret: Uint8Array | null = null;
  let signingSecret: Uint8Array | null = null;
  let encryptionSecret: Uint8Array | null = null;
  let signingPublic: Uint8Array | null = null;
  let encryptionPublic: Uint8Array | null = null;
  let keys: RoomKeys | null = null;
  try {
    roomSecret = decodeCanonicalSecret(capability.roomSecret, 'room secret');
    signingSecret = decodeCanonicalSecret(
      capability.ownerSigningSecret,
      'owner signing secret',
    );
    encryptionSecret = decodeCanonicalSecret(
      capability.ownerEncryptionSecret,
      'owner encryption secret',
    );
    const roomId = deriveRoomId(roomSecret);
    if (roomId !== expectedRoomId) throw new Error('sealed owner roomId does not match its binding');
    if (!capability.ownerDeviceId || !capability.ownerParticipantId) {
      throw new Error('sealed owner identity ids are invalid');
    }
    const policy = validateRoomPolicy(capability.policy);
    keys = deriveRoomKeys(roomSecret);
    signingPublic = ed25519.getPublicKey(signingSecret);
    encryptionPublic = x25519.getPublicKey(encryptionSecret);
    const credentials: BrowserOwnerCredentials = {
      roomId,
      roomSecret,
      keys,
      identity: {
        deviceId: capability.ownerDeviceId,
        participantId: capability.ownerParticipantId,
        signingSecret,
        signingPublic,
        encryptionSecret,
        publicEncryptionKey: encryptionPublic,
      },
      policy,
    };
    roomSecret = null;
    signingSecret = null;
    encryptionSecret = null;
    signingPublic = null;
    encryptionPublic = null;
    keys = null;
    return credentials;
  } catch (error) {
    if (roomSecret) zero(roomSecret);
    if (signingSecret) zero(signingSecret);
    if (encryptionSecret) zero(encryptionSecret);
    if (signingPublic) zero(signingPublic);
    if (encryptionPublic) zero(encryptionPublic);
    if (keys) zeroRoomKeys(keys);
    throw error;
  }
}

/** Reconstruct one durable share's exact v3 epoch owner from sealed state. */
export function ownerCredentialsV3FromInviteCapability(
  capability: InviteCapability,
  expectedRoomId: string,
): BrowserOwnerCredentialsV3 {
  const durable = capability.durableShare;
  if (!durable || durable.protocolVersion !== 3) {
    throw new Error('sealed owner capability is not a durable v3 share');
  }
  let roomSecret: Uint8Array | null = null;
  let shareSecret: Uint8Array | null = null;
  let signingSecret: Uint8Array | null = null;
  let encryptionSecret: Uint8Array | null = null;
  try {
    roomSecret = decodeCanonicalSecret(capability.roomSecret, 'room secret');
    shareSecret = decodeCanonicalSecret(durable.shareSecret, 'share secret');
    const derivedEpochSecret = deriveShareEpochRoomSecret(shareSecret, durable.epoch);
    try {
      if (base64UrlEncode(derivedEpochSecret) !== base64UrlEncode(roomSecret)) {
        throw new Error('sealed v3 epoch secret does not match the share root');
      }
    } finally {
      derivedEpochSecret.fill(0);
    }
    const roomId = deriveRoomIdV3(roomSecret);
    if (roomId !== expectedRoomId || durable.currentRoomId !== undefined && durable.currentRoomId !== roomId) {
      throw new Error('sealed v3 owner roomId does not match its binding');
    }
    signingSecret = decodeCanonicalSecret(capability.ownerSigningSecret, 'owner signing secret');
    encryptionSecret = decodeCanonicalSecret(capability.ownerEncryptionSecret, 'owner encryption secret');
    const signingPublic = ed25519.getPublicKey(signingSecret);
    const publicEncryptionKey = x25519.getPublicKey(encryptionSecret);
    const tree = deriveRoomKeyTreeV3(roomSecret);
    return {
      protocolVersion: 3,
      roomId,
      roomSecret,
      shareSecret,
      keys: {
        rootKey: tree.rootKey,
        eventKey: tree.readKeys.eventKey,
        snapshotKey: tree.readKeys.snapshotKey,
        signalingKey: tree.readKeys.signalingKey,
        admissionKey: tree.writeAdmissionKey,
      },
      readAdmissionKey: tree.readKeys.readAdmissionKey,
      readCapabilityKey: tree.readKeys.readCapabilityKey,
      identity: {
        deviceId: capability.ownerDeviceId,
        participantId: capability.ownerParticipantId,
        signingSecret,
        signingPublic,
        encryptionSecret,
        publicEncryptionKey,
      },
      policy: validateRoomPolicy(capability.policy),
      shareId: durable.shareId,
      epoch: durable.epoch,
    };
  } catch (error) {
    roomSecret?.fill(0);
    shareSecret?.fill(0);
    signingSecret?.fill(0);
    encryptionSecret?.fill(0);
    throw error;
  }
}

function decodeCanonicalSecret(value: unknown, label: string): Uint8Array {
  if (typeof value !== 'string') throw new Error(`sealed ${label} is invalid`);
  let bytes: Uint8Array;
  try {
    bytes = base64UrlDecode(value);
  } catch {
    throw new Error(`sealed ${label} is invalid`);
  }
  if (bytes.length !== 32 || base64UrlEncode(bytes) !== value) {
    zero(bytes);
    throw new Error(`sealed ${label} must be 32 canonical bytes`);
  }
  return bytes;
}

function validateRoomPolicy(value: unknown): RoomPolicy {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('owner room policy is invalid');
  }
  const policy = value as Partial<RoomPolicy>;
  if (policy.mode !== 'live' && policy.mode !== 'async' && policy.mode !== 'hybrid') {
    throw new Error('owner room policy mode is invalid');
  }
  for (const [label, number] of [
    ['maxPeers', policy.maxPeers],
    ['maxSnapshotBytes', policy.maxSnapshotBytes],
    ['maxEventBytes', policy.maxEventBytes],
    ['maxEvents', policy.maxEvents],
    ['expiresAt', policy.expiresAt],
    ['powBits', policy.powBits],
  ] as const) {
    if (!Number.isSafeInteger(number) || (number as number) <= 0) {
      throw new Error(`owner room policy ${label} is invalid`);
    }
  }
  if ((policy.powBits as number) < 12 || (policy.powBits as number) > 24) {
    throw new Error('owner room policy powBits is invalid');
  }
  if ((policy.maxPeers as number) > 8) {
    throw new Error('owner room policy maxPeers is invalid');
  }
  for (const [label, flag] of [
    ['deleteEventsAfterOwnerAck', policy.deleteEventsAfterOwnerAck],
    ['allowBrowser', policy.allowBrowser],
    ['allowRemoteAgents', policy.allowRemoteAgents],
  ] as const) {
    if (typeof flag !== 'boolean') throw new Error(`owner room policy ${label} is invalid`);
  }
  return structuredClone(policy) as RoomPolicy;
}

function zeroRoomKeys(keys: RoomKeys): void {
  zero(keys.rootKey);
  zero(keys.eventKey);
  zero(keys.snapshotKey);
  zero(keys.signalingKey);
  zero(keys.admissionKey);
}

function cloneAndValidateOwnerCredentials(
  input: BrowserOwnerCredentials,
): BrowserOwnerCredentials {
  if (!(input.roomSecret instanceof Uint8Array) || input.roomSecret.length !== 32) {
    throw new Error('owner roomSecret must be 32 bytes');
  }
  const protocolVersion = input.protocolVersion ?? 2;
  if ((protocolVersion === 3 ? deriveRoomIdV3(input.roomSecret) : deriveRoomId(input.roomSecret)) !== input.roomId) {
    throw new Error('owner roomSecret does not derive the bound roomId');
  }
  const derivedTree = protocolVersion === 3 ? deriveRoomKeyTreeV3(input.roomSecret) : null;
  const derived = derivedTree === null ? deriveRoomKeys(input.roomSecret) : {
    rootKey: derivedTree.rootKey,
    eventKey: derivedTree.readKeys.eventKey,
    snapshotKey: derivedTree.readKeys.snapshotKey,
    signalingKey: derivedTree.readKeys.signalingKey,
    admissionKey: derivedTree.writeAdmissionKey,
  };
  try {
    for (const key of ['rootKey', 'eventKey', 'snapshotKey', 'signalingKey', 'admissionKey'] as const) {
      if (!(input.keys[key] instanceof Uint8Array) || !equalBytes(input.keys[key], derived[key])) {
        throw new Error(`owner ${key} does not match roomSecret`);
      }
    }
    if (protocolVersion === 3 && (
      !(input.readAdmissionKey instanceof Uint8Array)
      || !(input.readCapabilityKey instanceof Uint8Array)
      || !equalBytes(input.readAdmissionKey, derivedTree!.readKeys.readAdmissionKey)
      || !equalBytes(input.readCapabilityKey, derivedTree!.readKeys.readCapabilityKey)
    )) {
      throw new Error('owner v3 read capability does not match roomSecret');
    }
  } finally {
    zeroRoomKeys(derived);
    derivedTree?.readKeys.readAdmissionKey.fill(0);
    derivedTree?.readKeys.readCapabilityKey.fill(0);
  }
  const identity = input.identity;
  if (!identity.deviceId || !identity.participantId) throw new Error('owner identity ids are invalid');
  for (const [label, bytes] of [
    ['signingSecret', identity.signingSecret],
    ['signingPublic', identity.signingPublic],
    ['encryptionSecret', identity.encryptionSecret],
    ['publicEncryptionKey', identity.publicEncryptionKey],
  ] as const) {
    if (!(bytes instanceof Uint8Array) || bytes.length !== 32) {
      throw new Error(`owner ${label} must be 32 bytes`);
    }
  }
  let derivedSigningPublic: Uint8Array | null = null;
  let derivedEncryptionPublic: Uint8Array | null = null;
  try {
    derivedSigningPublic = ed25519.getPublicKey(identity.signingSecret);
    derivedEncryptionPublic = x25519.getPublicKey(identity.encryptionSecret);
    if (!equalBytes(derivedSigningPublic, identity.signingPublic)) {
      throw new Error('owner Ed25519 secret/public keys do not match');
    }
    if (!equalBytes(derivedEncryptionPublic, identity.publicEncryptionKey)) {
      throw new Error('owner X25519 secret/public keys do not match');
    }
  } finally {
    if (derivedSigningPublic) zero(derivedSigningPublic);
    if (derivedEncryptionPublic) zero(derivedEncryptionPublic);
  }
  // Finish every potentially-throwing validation before allocating session
  // copies, so rejected credentials cannot strand cloned secret material.
  const policy = validateRoomPolicy(input.policy);
  return {
    protocolVersion,
    roomId: input.roomId,
    roomSecret: new Uint8Array(input.roomSecret),
    keys: {
      rootKey: new Uint8Array(input.keys.rootKey),
      eventKey: new Uint8Array(input.keys.eventKey),
      snapshotKey: new Uint8Array(input.keys.snapshotKey),
      signalingKey: new Uint8Array(input.keys.signalingKey),
      admissionKey: new Uint8Array(input.keys.admissionKey),
    },
    ...(protocolVersion === 3
      ? {
          readAdmissionKey: new Uint8Array(input.readAdmissionKey!),
          readCapabilityKey: new Uint8Array(input.readCapabilityKey!),
        }
      : {}),
    identity: {
      deviceId: identity.deviceId,
      participantId: identity.participantId,
      signingSecret: new Uint8Array(identity.signingSecret),
      signingPublic: new Uint8Array(identity.signingPublic),
      encryptionSecret: new Uint8Array(identity.encryptionSecret),
      publicEncryptionKey: new Uint8Array(identity.publicEncryptionKey),
    },
    policy,
  };
}

function assertRegisteredBrowserOwner(
  devices: readonly Device[],
  identity: BrowserDeviceIdentity,
): void {
  const matches = devices.filter((device) => device.deviceId === identity.deviceId);
  if (matches.length !== 1) throw new Error('owner device registration is missing or ambiguous');
  const actual = matches[0]!;
  const expected = buildRegisterDeviceBody(identity, 'owner');
  if (
    actual.participantId !== expected.participantId ||
    actual.kind !== 'owner' ||
    actual.client !== 'attn-browser' ||
    actual.publicSigningKey !== expected.publicSigningKey ||
    actual.publicEncryptionKey !== expected.publicEncryptionKey ||
    actual.selfSignature !== expected.selfSignature
  ) {
    throw new Error('registered owner identity does not match sealed credentials');
  }
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) diff |= left[index]! ^ right[index]!;
  return diff === 0;
}

// ---------------------------------------------------------------------------
// POST /devices body — mirror of `bootstrap.rs::RegisterDeviceBody`.
// ---------------------------------------------------------------------------

interface RegisterDeviceBody {
  deviceId: string;
  participantId: string;
  publicSigningKey: string;
  publicEncryptionKey: string;
  client: 'attn-browser';
  kind: 'reviewer' | 'owner';
  selfSignature: string;
}

export interface RegisterDeviceBodyV3 extends RegisterDeviceBody {
  grantTier: 'comment' | 'suggest';
  grantSignature: string;
}

export function canonicalDeviceGrantV3(
  roomId: string,
  grantTier: 'comment' | 'suggest',
): Uint8Array {
  return toCanonicalBytes({
    grantTier,
    purpose: 'attn device grant v3',
    roomId,
    v: 3,
  });
}

export function verifyDeviceGrantV3(
  roomId: string,
  grantTier: 'comment' | 'suggest',
  grantSignature: string,
  ownerSigningKey: string,
): boolean {
  try {
    return ed25519.verify(
      base64UrlDecode(grantSignature),
      canonicalDeviceGrantV3(roomId, grantTier),
      base64UrlDecode(ownerSigningKey),
    );
  } catch {
    return false;
  }
}

function uniqueOwnerDevice(devices: Device[]): Device {
  const owners = devices.filter((device) => device.kind === 'owner');
  if (owners.length !== 1) throw new Error('v3 device directory requires exactly one owner');
  const owner = owners[0]!;
  if (owner.grantTier !== undefined || owner.grantSignature !== undefined) {
    throw new Error('v3 owner registration must not carry a grant');
  }
  return owner;
}

/**
 * Canonical-JSON bytes used as the input to `selfSignature`. The relay
 * reproduces the same bytes by dropping `selfSignature` before canonicalizing,
 * so we sign over the unsigned-body form. Matches
 * `bootstrap.rs::canonical_register_device_bytes`.
 */
export function canonicalRegisterDeviceBytes(body: RegisterDeviceBody): Uint8Array {
  const unsigned: Record<string, unknown> = {
    deviceId: body.deviceId,
    participantId: body.participantId,
    publicSigningKey: body.publicSigningKey,
    publicEncryptionKey: body.publicEncryptionKey,
    client: body.client,
    kind: body.kind,
    ...('grantTier' in body ? { grantTier: body.grantTier } : {}),
    ...('grantSignature' in body ? { grantSignature: body.grantSignature } : {}),
  };
  return toCanonicalBytes(unsigned);
}

/**
 * Build the `POST /v2/rooms/:roomId/devices` body, signing `selfSignature`
 * over the unsigned canonical form.
 */
export function buildRegisterDeviceBody(
  identity: BrowserDeviceIdentity,
  kind: 'reviewer' | 'owner' = 'reviewer',
): RegisterDeviceBody {
  const body: RegisterDeviceBody = {
    deviceId: identity.deviceId,
    participantId: identity.participantId,
    publicSigningKey: base64UrlEncode(identity.signingPublic),
    publicEncryptionKey: base64UrlEncode(identity.publicEncryptionKey),
    client: 'attn-browser',
    kind,
    selfSignature: '',
  };
  const canonical = canonicalRegisterDeviceBytes(body);
  const sig = ed25519.sign(canonical, identity.signingSecret);
  body.selfSignature = base64UrlEncode(sig);
  return body;
}

export function buildRegisterDeviceBodyV3(
  identity: BrowserDeviceIdentity,
  grantTier: 'comment' | 'suggest',
  grantSignature: string,
): RegisterDeviceBodyV3 {
  const body: RegisterDeviceBodyV3 = {
    ...buildRegisterDeviceBody(identity),
    grantTier,
    grantSignature,
    selfSignature: '',
  };
  body.selfSignature = base64UrlEncode(
    ed25519.sign(canonicalRegisterDeviceBytes(body), identity.signingSecret),
  );
  return body;
}

/**
 * Build the `Attn-Admission` HTTP header value over the canonical request
 * bytes. Matches `bootstrap.rs::admission_header_value` — same canonical form
 * as the WS subprotocol HMAC.
 */
export function admissionHeaderValue(
  admissionKey: Uint8Array,
  method: string,
  urlPath: string,
  body: Uint8Array,
): string {
  return buildAdmissionHeader(admissionKey, method, urlPath, body);
}

// ---------------------------------------------------------------------------
// BrowserSession
// ---------------------------------------------------------------------------

/**
 * Orchestrates the browser-side review session. One per page load.
 */
export class BrowserSession {
  private readonly opts: BrowserSessionOptions;
  private state: BrowserSessionState = {
    principal: 'reviewer',
    ownerOnline: false,
    peers: [],
    liveEditingAvailable: false,
    status: 'idle',
    connection: 'offline',
    directError: null,
    roomId: null,
    snapshotContent: null,
    snapshotDocType: 'markdown',
    snapshotId: null,
    fileId: null,
    error: null,
    authoringReady: false,
    grantTier: 'suggest',
    outboxPending: 0,
    authoringError: null,
    persistence: 'ephemeral',
    storagePersisted: null,
    canRemember: true,
  };
  private identity: BrowserDeviceIdentity | null = null;
  private ownerRoomSecret: Uint8Array | null = null;
  private readonly principal: 'owner' | 'reviewer';
  private wsClient: BrowserWsClient | null = null;
  private keys: ActiveRoomKeys | null = null;
  private store: ReviewStoreSink | null;
  private powAbortController: AbortController | null = null;
  private outbox: BrowserOutbox | null = null;
  private peerMesh: BrowserPeerMesh | null = null;
  private latestPresenceEnvelope: MailboxEnvelope | null = null;
  private joinEnvelopeId: string | null = null;
  private lastCreatedAt = 0;
  private readonly authoringReadyWaiters = new Set<() => void>();
  /** Bounded startup grace for publication callers racing the connection. */
  private static readonly PUBLICATION_READY_TIMEOUT_MS = 15_000;
  private roomPolicy: RoomPolicy | null = null;
  private bootstrapDevices: Device[] = [];
  private readonly onlineDeviceIds = new Set<string>();
  private storage: BrowserStorage | null;
  private persistedCursor = 0;
  private localAttestationRestored = false;
  private storageWritesEnabled = true;
  private readonly volatileInbound = new Map<string, StoredInboundEnvelope>();
  private readonly snapshotBlobs = new Map<string, CachedSnapshotBlob>();
  private readonly invalidSnapshotBlobIds = new Set<string>();
  private readonly pendingSnapshots = new Map<string, PendingSnapshot[]>();
  private readonly hydratedEntries = new Map<string, HydratedEntryMetadata>();
  private readonly pendingWorkspaceManifests = new Map<string, PendingWorkspaceManifest>();
  private readonly signerRefreshAttempts = new Set<string>();
  private directoryRefresh: Promise<void> | null = null;
  private readonly dispatchedEnvelopeIds = new Set<string>();
  private readonly collabDispatches = new Map<string, Promise<boolean>>();
  private readonly pendingSignals: BrowserSignalingPayload[] = [];
  private readonly pagehideTarget: BrowserWindowLike | null;
  private readonly pagehideHandler = (): void => this.close();
  private transportGeneration = 0;
  private readonly viewerId = randomOpaqueId();
  /** Cross-tab review doorbell (attn-dgya); opened lazily on first commit. */
  private reviewInboundDoorbell: BroadcastChannel | null = null;

  constructor(opts: BrowserSessionOptions = {}) {
    this.opts = opts;
    this.principal = opts.owner ? 'owner' : 'reviewer';
    this.state = { ...this.state, principal: this.principal };
    this.store = opts.store ?? null;
    this.storage = opts.storage ?? null;
    this.pagehideTarget = opts.window ?? (globalThis as unknown as BrowserWindowLike);
    this.pagehideTarget.addEventListener?.('pagehide', this.pagehideHandler);
  }

  /**
   * Lazily resolve the store. The runes singleton lives in `store.svelte.ts`
   * which requires the Svelte 5 runtime at load time; we defer the import
   * so tests can swap a plain object via `opts.store` without ever
   * touching the runes module.
   */
  private async ensureStore(): Promise<ReviewStoreSink> {
    if (this.store) return this.store;
    const mod = await import('./store.svelte.js');
    this.store = mod.reviewStore as unknown as ReviewStoreSink;
    return this.store;
  }

  private async openStorage(createIfMissing: boolean): Promise<BrowserStorage | null> {
    if (this.storage) return this.storage;
    try {
      const storage = this.opts.storageFactory
        ? await this.opts.storageFactory(createIfMissing)
        : await BrowserStorage.open({ createIfMissing });
      this.storage = storage;
      return storage;
    } catch {
      return null;
    }
  }

  /** Recover only state that was explicitly remembered under this exact room id. */
  private async resumeRememberedRoom(roomId: string): Promise<boolean> {
    const storage = await this.openStorage(false);
    if (!storage) return false;
    const room = await storage.getRoom(roomId);
    if (!room) {
      storage.close();
      this.storage = null;
      return false;
    }
    if (room.policy.expiresAt <= Date.now()) {
      await storage.forgetRoom(roomId);
      storage.close();
      this.storage = null;
      return false;
    }
    let keys: ActiveRoomKeys;
    let identity: BrowserDeviceIdentity | null;
    try {
      const [storedKeys, loadedIdentity] = await Promise.all([
        storage.deriveRoomKeys(roomId),
        storage.loadIdentity(roomId),
      ]);
      keys = activeV2Keys(storedKeys);
      identity = loadedIdentity;
    } catch {
      await storage.forgetRoom(roomId).catch(() => undefined);
      storage.close();
      this.storage = null;
      return false;
    }
    if (!identity) {
      await storage.forgetRoom(roomId);
      storage.close();
      this.storage = null;
      return false;
    }

    this.keys = keys;
    this.identity = identity;
    this.roomPolicy = room.policy;
    this.lastCreatedAt = room.lastCreatedAt;
    this.bootstrapDevices = await storage.listDevices(roomId);
    this.persistedCursor = await storage.getCursor(roomId, identity.deviceId);
    this.setState({
      roomId: roomId as RoomId,
      status: 'connecting',
      connection: 'offline',
      persistence: room.storagePersisted ? 'remembered' : 'degraded',
      storagePersisted: room.storagePersisted,
    });
    const store = await this.ensureStore();
    store.currentRoomId = roomId as RoomId;
    store.noteRoomRole?.(roomId as RoomId, 'reviewer');

    const client = this.buildWsClient(roomId, keys);
    await this.replayDurableLog(client, storage, roomId, identity.deviceId);

    await this.initializeAuthoring(room.policy, this.localAttestationRestored, true);
    this.setState({ status: this.state.snapshotContent === null ? 'connecting' : 'connected' });
    client.start();
    return true;
  }

  /**
   * Replay the durable local log for `roomId` through the verified inbound
   * pipeline (decrypt + signature + capability authorization) so UI state
   * rebuilds before the socket subscribes. Relay-sequenced items replay in
   * serverSeq order ahead of unacknowledged outbox items. Shared by the
   * reviewer resume path and the owner reopen path (attn-dgya).
   */
  private async replayDurableLog(
    client: BrowserWsClient,
    storage: BrowserStorage,
    roomId: string,
    deviceId: string,
  ): Promise<void> {
    const [inbound, history, pending] = await Promise.all([
      storage.replayInbound(roomId),
      storage.listHistory(roomId),
      storage.listOutbox(roomId, deviceId),
    ]);
    const replayById = new Map<string, { envelope: MailboxEnvelope; serverSeq: number }>();
    for (const item of [...inbound, ...history]) {
      // SDP/ICE/collab is negotiation-generation scoped. Never resurrect
      // sealed signaling plaintext from an earlier page lifetime.
      if (item.envelope.kind === 'signal') continue;
      replayById.set(item.envelope.envelopeId, item);
    }
    for (const envelope of pending) {
      if (envelope.kind === 'signal') continue;
      if (!replayById.has(envelope.envelopeId)) replayById.set(envelope.envelopeId, { envelope, serverSeq: 0 });
    }
    const replay = [...replayById.values()].sort((a, b) => {
      if (a.serverSeq > 0 && b.serverSeq > 0) return a.serverSeq - b.serverSeq;
      if (a.serverSeq > 0) return -1;
      if (b.serverSeq > 0) return 1;
      return a.envelope.createdAt - b.envelope.createdAt;
    });
    for (const item of replay) await client.replayEnvelope(item.envelope, item.serverSeq);
  }

  /** Current state snapshot — UI binds against this. */
  getState(): BrowserSessionState {
    if (
      this.state.liveEditingAvailable &&
      (!this.roomPolicy?.allowBrowser || this.roomPolicy.expiresAt <= Date.now())
    ) {
      this.setState({});
    }
    return this.state;
  }

  async createComment(anchor: Anchor, body: string, threadId?: string): Promise<ReviewEvent> {
    if (this.state.grantTier === 'view') throw new Error('view grant cannot author comments');
    const text = body.trim();
    if (text.length === 0) throw new Error('comment body cannot be empty');
    return this.authorEvent({
      type: 'comment_created',
      threadId: threadId ?? randomOpaqueId(),
      anchor,
      body: text,
    });
  }

  async replyToComment(anchor: Anchor, body: string, threadId: string): Promise<ReviewEvent> {
    return this.createComment(anchor, body, threadId);
  }

  async resolveComment(threadId: string): Promise<ReviewEvent> {
    if (this.state.grantTier === 'view') throw new Error('view grant cannot resolve comments');
    if (threadId.length === 0) throw new Error('threadId cannot be empty');
    const identity = this.requireIdentity();
    return this.authorEvent({
      type: 'comment_resolved',
      threadId,
      resolvedBy: identity.participantId,
    });
  }

  async createSuggestion(draft: SuggestionDraft): Promise<ReviewEvent> {
    if (this.state.grantTier !== 'suggest') {
      throw new Error('suggestion authoring requires suggest grant');
    }
    return this.authorEvent({
      type: 'suggestion_created',
      suggestionId: randomOpaqueId(),
      anchor: draft.anchor,
      operation: draft.operation,
      ...(draft.note === undefined || draft.note.length === 0 ? {} : { note: draft.note }),
    });
  }

  async retryOutbox(): Promise<void> {
    await this.outbox?.flushNow();
  }

  /** Owner-only trusted terminal-event preparation for a wider atomic commit. */
  prepareTerminalEvent(body: ReviewEventBody): AssembledBrowserEvent {
    if (this.principal !== 'owner') throw new Error('only the browser owner may prepare terminal events');
    if (body.type !== 'suggestion_accepted' && body.type !== 'suggestion_rejected') {
      throw new Error('terminal event body must accept or reject a suggestion');
    }
    const identity = this.requireIdentity();
    const keys = this.keys;
    const policy = this.roomPolicy;
    const roomId = this.state.roomId;
    if (!keys || !policy || !roomId || !this.state.authoringReady) {
      throw new Error('browser owner authoring is unavailable');
    }
    return assembleBrowserEvent({
      eventKey: keys.eventKey,
      signingSecret: identity.signingSecret,
      signingPublic: identity.signingPublic,
      roomId,
      authorId: identity.participantId,
      deviceId: identity.deviceId,
      createdAt: this.nextCreatedAt(),
      expiresAt: policy.expiresAt,
      body,
    });
  }

  /** Adopt exact ciphertext already committed by an atomic workspace action. */
  async adoptDurableEnvelope(envelope: MailboxEnvelope): Promise<void> {
    if (this.principal !== 'owner') throw new Error('only the browser owner may adopt terminal events');
    const identity = this.requireIdentity();
    const roomId = this.state.roomId;
    const outbox = this.outbox;
    if (!roomId || !outbox) throw new Error('browser owner outbox is unavailable');
    if (
      envelope.roomId !== roomId ||
      envelope.kind !== 'event' ||
      (envelope.target !== undefined && envelope.target !== null) ||
      envelope.authorId !== identity.participantId ||
      envelope.deviceId !== identity.deviceId
    ) {
      throw new Error('durable terminal envelope is not bound to this browser owner');
    }
    await outbox.enqueueDurably(envelope);
    await outbox.flushNow();
  }

  /** Owner-only snapshot batch adoption for a lease-scoped publication. */
  async enqueuePublicationBatch(envelopes: readonly MailboxEnvelope[]): Promise<number> {
    if (this.principal !== 'owner') throw new Error('only the browser owner may publish snapshots');
    await this.awaitAuthoringReady(BrowserSession.PUBLICATION_READY_TIMEOUT_MS);
    const outbox = this.outbox;
    if (!outbox || !this.state.authoringReady) {
      throw new Error('browser owner publication outbox is unavailable');
    }
    return outbox.enqueueBatchDurably(envelopes);
  }

  /** Flush the exact owner outbox used by snapshot publication. */
  async flushPublicationOutbox(): Promise<void> {
    if (this.principal !== 'owner') throw new Error('only the browser owner may publish snapshots');
    await this.awaitAuthoringReady(BrowserSession.PUBLICATION_READY_TIMEOUT_MS);
    const outbox = this.outbox;
    if (!outbox || !this.state.authoringReady) {
      throw new Error('browser owner publication outbox is unavailable');
    }
    await outbox.flushNow();
  }

  /**
   * Bounded wait for authoring readiness (outbox initialized and the join
   * envelope flushed). Publication callers race the room connection on a
   * reload with a staged share republish: a fast relay wins the race, a real
   * network loses it, and throwing immediately paused the authority with
   * "publication outbox is unavailable" and no retry (attn-w22).
   */
  private awaitAuthoringReady(timeoutMs: number): Promise<void> {
    if (this.state.authoringReady || this.isTerminated()) return Promise.resolve();
    return new Promise((resolve) => {
      const waiter = (): void => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        this.authoringReadyWaiters.delete(waiter);
        resolve();
      }, timeoutMs);
      this.authoringReadyWaiters.add(waiter);
    });
  }

  /**
   * Send live collaboration. Cursor/view presence is WebRTC-only ephemeral
   * state; document collaboration keeps the direct-first relay safety net.
   */
  async sendCollab(payload: string): Promise<void> {
    const message = parseCollabWireMessage(payload);
    if (!message || !this.outboundCollabAllowed(message)) {
      throw new Error(
        this.principal === 'owner'
          ? 'browser owner may only broadcast its own document state or cursor presence'
          : 'reviewers cannot submit live document mutations; create a durable suggestion instead',
      );
    }
    // Re-evaluate wall-clock expiry even if no presence/policy frame has
    // caused a state transition since the last render. Owner document
    // broadcasts require the live authority; reviewer cursor/resync traffic
    // only requires an authenticated writable connection.
    this.setState({});
    if (
      this.state.status !== 'connected'
      || this.state.connection === 'offline'
      || (this.principal === 'owner' && !this.state.liveEditingAvailable)
    ) {
      throw new Error('live editing is paused until the owner authority is online');
    }
    const identity = this.requireIdentity();
    const keys = this.keys;
    const policy = this.roomPolicy;
    const outbox = this.outbox;
    const roomId = this.state.roomId;
    if (!keys || !policy || !outbox || !roomId) throw new Error('browser session is unavailable');
    const createdAt = this.nextCreatedAt();
    const envelope = assembleBrowserSignal({
      signalingKey: keys.signalingKey,
      roomId,
      authorId: identity.participantId,
      deviceId: identity.deviceId,
      createdAt,
      expiresAt: policy.expiresAt,
      payload: { kind: 'collab', from: identity.deviceId, payload },
      protocolVersion: keys.version,
      ...(keys.version === 3 ? {
        signalGeneration: createdAt,
        ...(message.kind === 'cursor' ? { signalClass: 'presence' as const } : {}),
        signingSecret: identity.signingSecret,
      } : {}),
    });
    if (message.kind === 'cursor') {
      // Presence is deliberately lossy: if no direct peer channel is open,
      // drop this sample and let the next caret/view update supersede it. It
      // must never enter the durable outbox or consume relay bandwidth/state.
      this.latestPresenceEnvelope = envelope;
      this.peerMesh?.broadcastPresenceEnvelope(envelope);
      return;
    }

    // Install document collaboration locally before any network side effect.
    // The DataChannel gets the exact immutable envelope ahead of the relay
    // POST; the later network echo is deduplicated after its cursor commit.
    const enqueued = this.storage
      ? outbox.enqueueDurably(envelope).then(() => undefined)
      : Promise.resolve().then(() => { outbox.enqueue(envelope); });
    this.peerMesh?.broadcastEnvelope(envelope);
    await enqueued;
    // The sealed envelope remains queued on a transient relay failure, but
    // the caller must still learn that this submission did not reach the
    // durable transport yet so its inflight controller can recover/resync.
    await outbox.flushNow();
  }

  private outboundCollabAllowed(message: CollabWireMessage): boolean {
    if (this.principal === 'owner') {
      return message.kind === 'broadcast' || message.kind === 'cursor';
    }
    // Reviewers are read-only at the ProseMirror document layer. Resync lets
    // them request the owner's authoritative log and cursor remains ephemeral
    // presence; neither can advance an authority/checkpoint/workspace head.
    return message.kind === 'resync' || message.kind === 'cursor';
  }

  private inboundCollabAllowed(
    message: CollabWireMessage,
    sender: Device,
  ): boolean {
    if (this.principal === 'owner') {
      // Authenticated remote devices may request an owner replay or publish
      // cursor presence, but no remote identity (including another owner
      // device) may submit/linearize ProseMirror steps in this workspace.
      return message.kind === 'resync' || message.kind === 'cursor';
    }
    // Reviewers converge read-only from a directory-authenticated owner.
    // Other registered participants may contribute cursors only.
    return message.kind === 'cursor'
      || (message.kind === 'broadcast' && sender.kind === 'owner');
  }

  /** Explicitly persist a non-extractable room capability and sealed recovery state. */
  async rememberRoom(): Promise<void> {
    if (this.state.grantTier === 'view' || this.keys?.version === 3) {
      throw new Error('v3 capability persistence is not available yet');
    }
    if (this.state.persistence === 'remembered' || this.state.persistence === 'degraded') return;
    const roomId = this.state.roomId;
    const keys = this.keys;
    const identity = this.identity;
    const policy = this.roomPolicy;
    if (!roomId || !keys?.rootKey || !identity || !policy) {
      throw new Error('room is not ready to remember');
    }
    this.setState({ persistence: 'saving', authoringError: null });
    let durableStorage: BrowserStorage | null = null;
    let rollbackNewState = false;
    const rememberClaimId = randomOpaqueId();
    try {
      this.storageWritesEnabled = true;
      const storage = this.storage ?? await this.openStorage(true);
      if (!storage) throw new Error('durable browser storage is unavailable');
      durableStorage = storage;
      this.storage = storage;
      const room: BrowserStorageRoom = {
        roomId,
        policy,
        lastCreatedAt: this.lastCreatedAt,
        storagePersisted: false,
      };
      rollbackNewState = await storage.claimRoom(room, rememberClaimId);
      if (!rollbackNewState) {
        throw new Error('this room is already remembered; reload without the invite to resume it');
      }
      await storage.putRoom(room);
      await storage.installRoomKey(roomId, keys.rootKey);
      await storage.saveIdentity(roomId, identity);
      for (const device of this.bootstrapDevices) await storage.putDevice(roomId, device);
      await storage.putDevice(roomId, this.localDeviceRecord(identity));
      for (const stored of [...this.volatileInbound.values()].sort(
        (a, b) => a.serverSeq - b.serverSeq,
      )) {
        if (stored.envelope.signalClass === 'presence') continue;
        await storage.commitInbound(roomId, identity.deviceId, stored.envelope, stored.serverSeq);
      }
      this.persistedCursor = await storage.getCursor(roomId, identity.deviceId);
      const persistence = this.makeOutboxPersistence(storage, roomId, identity.deviceId);
      await this.outbox?.enablePersistence(persistence);
      const storagePersisted = (await storage.requestPersistence()) ?? false;
      await storage.putRoom({ ...room, storagePersisted, lastCreatedAt: this.lastCreatedAt });
      await storage.completeRoomClaim(roomId, rememberClaimId);
      this.setState({
        persistence: storagePersisted ? 'remembered' : 'degraded',
        storagePersisted,
      });
    } catch (error) {
      this.storageWritesEnabled = false;
      this.outbox?.disablePersistence();
      if (durableStorage && rollbackNewState) {
        await durableStorage.forgetClaimedRoom(roomId, rememberClaimId).catch(() => undefined);
      }
      if (durableStorage) {
        durableStorage.close();
        if (this.storage === durableStorage) this.storage = null;
      }
      this.setState({
        persistence: 'ephemeral',
        storagePersisted: null,
        authoringError: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /** Delete the recoverable key first, then all room-scoped ciphertext/cache state. */
  async forgetRoom(): Promise<void> {
    const roomId = this.state.roomId;
    if (!roomId || !this.storage) return;
    this.storageWritesEnabled = false;
    this.outbox?.disablePersistence();
    this.stopTransport();
    await this.storage.forgetRoom(roomId);
    this.storage.close();
    this.storage = null;
    this.persistedCursor = 0;
    this.setState({
      persistence: 'ephemeral',
      storagePersisted: null,
      status: 'offline',
      connection: 'offline',
      authoringReady: false,
      outboxPending: 0,
    });
  }

  /**
   * Bring the session up. Returns when the WS is in `connected` state OR a
   * terminal error has been emitted. The state observer is called along the
   * way so the UI can render `Loading review…` / error states.
   */
  async start(): Promise<void> {
    if (this.state.status !== 'idle') return;
    if (this.opts.owner) {
      await this.startOwner(this.opts.owner);
      return;
    }
    this.setState({ status: 'parsing_invite' });

    // 1. Parse the invite (override > location.hash). A clean fragmentless
    // `/review/:roomId` may recover only an explicitly remembered room.
    let invite: ParsedInvite | null = null;
    try {
      if (this.opts.inviteError) {
        throw new Error(this.opts.inviteError);
      } else if (this.opts.parsedInvite) {
        invite = this.opts.parsedInvite;
      } else if (this.opts.inviteUrl) {
        invite = parseInviteUrl(this.opts.inviteUrl);
      } else {
        const win = this.opts.window ?? (globalThis as unknown as BrowserWindowLike);
        const parsed = parseAndStripInviteFromUrl(win);
        invite = parsed;
      }
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      this.fail('invite_invalid', m);
      return;
    }

    if (!invite) {
      const rememberedRoomId = this.opts.rememberedRoomId;
      if (rememberedRoomId && await this.resumeRememberedRoom(rememberedRoomId)) return;
      this.fail('invite_invalid', 'no invite fragment or remembered room');
      return;
    }

    // 2. Derive the versioned read/write capability set. Legacy v2 still
    // cross-checks roomId from the full room secret. V3 URLs already carry
    // least-privilege capability keys and never expose the root secret.
    let roomKeys: ActiveRoomKeys;
    try {
      if (invite.version === 2) {
        const v2 = deriveRoomKeys(invite.roomSecret);
        const derivedRoomId = deriveRoomId(invite.roomSecret);
        if (derivedRoomId !== invite.roomId) {
          throw new Error(`roomId mismatch: derived ${derivedRoomId} vs invite ${invite.roomId}`);
        }
        zero(invite.roomSecret);
        roomKeys = activeV2Keys(v2);
      } else {
        const read = deriveReadKeysV3(invite.readCapabilityKey);
        roomKeys = {
          version: 3,
          readCapabilityKey: read.readCapabilityKey,
          eventKey: read.eventKey,
          snapshotKey: read.snapshotKey,
          signalingKey: read.signalingKey,
          readAdmissionKey: read.readAdmissionKey,
          ...(invite.writeAdmissionKey === undefined
            ? {}
            : { writeAdmissionKey: new Uint8Array(invite.writeAdmissionKey) }),
        };
        zero(invite.readCapabilityKey);
        if (invite.writeAdmissionKey) zero(invite.writeAdmissionKey);
        this.setState({ grantTier: invite.tier });
        this.setState({ canRemember: false });
      }
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      this.fail('invite_invalid', `key derivation: ${m}`);
      if (invite.version === 2) zero(invite.roomSecret);
      return;
    }
    this.keys = roomKeys;
    this.setState({ roomId: invite.roomId });
    const store = await this.ensureStore();
    store.currentRoomId = invite.roomId;
    store.noteRoomRole?.(invite.roomId, 'reviewer');

    // 3. View bearers never create a registered identity. Writable sessions
    // use an ephemeral identity unless the user explicitly remembers v2.
    if (this.state.grantTier !== 'view') {
      this.identity = this.opts.identity ?? generateBrowserIdentity();
    }

    // 4. Fetch the authenticated policy before mining registration PoW. Room
    // policy may require more than the protocol floor of 12 bits.
    this.setState({ status: 'registering_device' });
    try {
      const bootstrap = await this.fetchRoomBootstrap(invite.roomId, roomKeys);
      this.roomPolicy = bootstrap.policy;
      this.bootstrapDevices = bootstrap.devices;
      if (invite.version === 3 && invite.tier !== 'view') {
        const owner = uniqueOwnerDevice(bootstrap.devices);
        if (!invite.grantSignature || !verifyDeviceGrantV3(
          invite.roomId,
          invite.tier,
          invite.grantSignature,
          owner.publicSigningKey,
        )) {
          throw new Error('v3 owner grant signature is invalid');
        }
      }
      if (this.state.grantTier !== 'view') {
        await this.registerDevice(invite, roomKeys, bootstrap.policy.powBits);
      }
    } catch (err) {
      if (this.isTerminated()) return;
      const m = err instanceof Error ? err.message : String(err);
      this.fail('device_register', m);
      return;
    }

    // 5. Open the WS.
    if (this.isTerminated()) return;
    this.setState({ status: 'connecting' });
    this.openWs(invite.roomId, roomKeys);
  }

  private async startOwner(input: BrowserOwnerCredentials): Promise<void> {
    let credentials: BrowserOwnerCredentials;
    try {
      credentials = cloneAndValidateOwnerCredentials(input);
    } catch (error) {
      this.fail('device_register', error instanceof Error ? error.message : String(error));
      return;
    }
    const activeKeys = activeOwnerKeys(credentials);
    this.ownerRoomSecret = credentials.roomSecret;
    this.keys = activeKeys;
    this.identity = credentials.identity;
    this.roomPolicy = credentials.policy;
    this.setState({
      roomId: credentials.roomId as RoomId,
      status: 'connecting',
      connection: 'offline',
    });
    const store = await this.ensureStore();
    store.currentRoomId = credentials.roomId as RoomId;
    store.noteRoomRole?.(credentials.roomId as RoomId, 'owner');
    try {
      const bootstrap = await this.fetchRoomBootstrap(credentials.roomId, activeKeys);
      assertRegisteredBrowserOwner(bootstrap.devices, credentials.identity);
      if (!bootstrap.policy.allowBrowser || bootstrap.policy.expiresAt <= Date.now()) {
        throw new Error('authenticated room policy does not permit browser owner authority');
      }
      this.roomPolicy = bootstrap.policy;
      this.bootstrapDevices = bootstrap.devices;
    } catch (error) {
      if (this.isTerminated()) return;
      this.fail('device_register', error instanceof Error ? error.message : String(error));
      return;
    }
    if (this.isTerminated()) return;
    // attn-dgya: a REOPENED owner tab used to come up with an empty
    // reviewStore and subscribe from seq 0 — existing comment threads only
    // reappeared if the relay still retained them (deleteEventsAfterOwnerAck
    // rooms retain nothing). Mirror resumeRememberedRoom instead: seed the
    // cursor from the shared durable store and replay the sealed local log
    // through the verified pipeline before the socket subscribes. applyEvent
    // dedups by (roomId, eventId), so live echoes stay idempotent.
    let replayClient: BrowserWsClient | null = null;
    try {
      const storage = this.storage ?? await this.openStorage(false);
      if (storage) {
        this.persistedCursor = await storage.getCursor(
          credentials.roomId,
          credentials.identity.deviceId,
        );
        replayClient = this.buildWsClient(credentials.roomId, activeKeys);
        await this.replayDurableLog(
          replayClient,
          storage,
          credentials.roomId,
          credentials.identity.deviceId,
        );
      }
    } catch {
      // The durable log is a local cache of the relay history; a failed
      // replay must never block the owner from connecting live.
    }
    if (this.isTerminated()) return;
    if (replayClient) replayClient.start();
    else this.openWs(credentials.roomId, activeKeys);
  }

  /** Tear down transports and clobber in-memory keys. Safe to call repeatedly. */
  close(): void {
    this.detachPagehide();
    this.stopTransport();
    this.reviewInboundDoorbell?.close();
    this.reviewInboundDoorbell = null;
    this.storage?.close();
    this.storage = null;
    this.releaseSensitiveState();
    this.snapshotBlobs.clear();
    this.invalidSnapshotBlobIds.clear();
    this.pendingSnapshots.clear();
    this.hydratedEntries.clear();
    this.pendingWorkspaceManifests.clear();
    this.signerRefreshAttempts.clear();
    this.volatileInbound.clear();
    this.clearStorePlaintext();
    this.setState({
      status: 'terminated',
      connection: 'offline',
      snapshotContent: null,
      snapshotId: null,
      fileId: null,
      authoringReady: false,
      outboxPending: 0,
      authoringError: null,
    });
  }

  // -----------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------

  private setState(patch: Partial<BrowserSessionState>): void {
    const next = { ...this.state, ...patch };
    const ownerDeviceIds = new Set(
      this.bootstrapDevices
        .filter((device) => device.kind === 'owner')
        .map((device) => device.deviceId),
    );
    const ownerOnline = [...ownerDeviceIds].some((deviceId) => this.onlineDeviceIds.has(deviceId));
    const selfDeviceId = this.identity?.deviceId ?? null;
    const peers: BrowserPeerPresence[] = this.bootstrapDevices
      .filter((device) => device.deviceId !== selfDeviceId)
      .map((device) => ({
        participantId: device.participantId,
        deviceId: device.deviceId,
        kind: device.kind,
        online: this.onlineDeviceIds.has(device.deviceId),
      }));
    this.state = {
      ...next,
      principal: this.principal,
      ownerOnline,
      peers,
      liveEditingAvailable:
        this.principal === 'owner' &&
        ownerOnline &&
        next.status === 'connected' &&
        next.connection !== 'offline' &&
        this.roomPolicy?.mode !== 'async' &&
        this.roomPolicy?.allowBrowser === true &&
        this.roomPolicy.expiresAt > Date.now(),
    };
    if (this.state.authoringReady || this.isTerminated()) {
      for (const waiter of this.authoringReadyWaiters) waiter();
      this.authoringReadyWaiters.clear();
    }
    this.opts.onState?.(this.state);
  }

  private isTerminated(): boolean {
    return this.state.status === 'terminated';
  }

  private requireIdentity(): BrowserDeviceIdentity {
    if (!this.identity) throw new Error('browser identity is unavailable');
    return this.identity;
  }

  private nextCreatedAt(): number {
    const now = Date.now();
    const createdAt = Math.max(now, this.lastCreatedAt + 1);
    if (!Number.isSafeInteger(createdAt)) throw new Error('authoring clock is outside safe range');
    if (this.roomPolicy && createdAt > this.roomPolicy.expiresAt) {
      throw new Error('review room has expired');
    }
    this.lastCreatedAt = createdAt;
    return createdAt;
  }

  private async authorEvent(body: ReviewEventBody): Promise<ReviewEvent> {
    if (!this.state.authoringReady) {
      throw new Error('encrypted authoring is not ready yet');
    }
    return this.enqueueEvent(body);
  }

  private async enqueueEvent(body: ReviewEventBody): Promise<ReviewEvent> {
    const identity = this.requireIdentity();
    const keys = this.keys;
    const policy = this.roomPolicy;
    const outbox = this.outbox;
    const roomId = this.state.roomId;
    if (!keys || !policy || !outbox || !roomId) throw new Error('browser session is unavailable');
    const assembled = assembleBrowserEvent({
      eventKey: keys.eventKey,
      signingSecret: identity.signingSecret,
      signingPublic: identity.signingPublic,
      roomId,
      authorId: identity.participantId,
      deviceId: identity.deviceId,
      createdAt: this.nextCreatedAt(),
      expiresAt: policy.expiresAt,
      body,
    });
    if (this.storage) await outbox.enqueueDurably(assembled.envelope);
    else outbox.enqueue(assembled.envelope);
    if (this.storage) await this.persistDirectoryAndRoom(this.bootstrapDevices, policy);
    const store = await this.ensureStore();
    // Optimistic echo. On the hosted OWNER the store sink no-ops this
    // (attn-ij9y): the leader's OWN comment renders through the projection,
    // which replays pending outbox envelopes on the doorbell ring below —
    // so the leader materializes it via the same path as every follower.
    // On the /s/ reviewer + native paths this echo is the live feed and the
    // ring is a harmless no-op (they run no projection).
    store.applyEvent(assembled.event);
    if (this.storage) this.ringReviewInboundDoorbell(roomId);
    void outbox.flushNow().catch(() => undefined);
    return assembled.event;
  }

  private async initializeAuthoring(
    policy: RoomPolicy,
    skipJoin = false,
    durableOffline = false,
  ): Promise<void> {
    if (this.state.grantTier === 'view') {
      this.setState({ authoringReady: false, authoringError: null });
      return;
    }
    this.roomPolicy = policy;
    if (this.outbox) {
      try {
        this.outbox.updatePolicy({
          powBits: policy.powBits,
          maxEventBytes: policy.maxEventBytes,
          maxSnapshotBytes: policy.maxSnapshotBytes,
        });
      } catch (error) {
        this.setState({
          authoringReady: false,
          authoringError: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      void this.outbox.flushNow().catch(() => undefined);
      return;
    }
    const keys = this.keys;
    const identity = this.identity;
    const roomId = this.state.roomId;
    if (!keys || !keys.writeAdmissionKey || !identity || !roomId || policy.expiresAt <= Date.now()) {
      this.setState({ authoringError: 'This review room is no longer writable.' });
      return;
    }
    const relayUrl = validateBrowserRelayUrl(this.opts.relayUrl);
    const mintPow =
      this.opts.outboxMintPow ??
      (this.opts.powToken === undefined ? undefined : async () => this.opts.powToken!);
    // The owner's snapshot-publication commit gate reads the workspace
    // database: staged rows must leave STORE_OUTBOX and land in STORE_HISTORY
    // when the relay acknowledges. Only this outbox's persistence adapter
    // performs that move, so a memory-only owner outbox makes every staged
    // publication (startup resume, epoch rollover) fail acknowledgment and
    // pause the authority (attn-w22). Reviewers stay memory-only until an
    // explicit remember.
    if (this.principal === 'owner' && !this.storage) {
      this.storage = await this.openStorage(false);
    }
    const outbox = new BrowserOutbox({
      relayUrl,
      roomId,
      deviceId: identity.deviceId,
      admissionKey: keys.writeAdmissionKey,
      protocolVersion: keys.version,
      powBits: policy.powBits,
      maxEventBytes: policy.maxEventBytes,
      // Without this the outbox falls back to maxEventBytes (256 KiB) and
      // rejects perfectly valid snapshots: any document over ~256 KiB
      // paused live review with ATTN_ENVELOPE_TOO_LARGE even though the
      // relay's snapshot cap is 5 MiB (attn user report, 2026-07-18).
      maxSnapshotBytes: policy.maxSnapshotBytes,
      fetchImpl: async (url, init): Promise<BrowserOutboxResponse> =>
        this.fetchImpl()(url, init),
      ...(mintPow === undefined ? {} : { mintPow }),
      onlineTarget: this.pagehideTarget ?? undefined,
      ...(this.storage
        ? { persistence: this.makeOutboxPersistence(this.storage, roomId, identity.deviceId) }
        : {}),
      onState: (outboxState) => {
        if (this.store) this.store.pendingOutbox = Array.from(this.outbox?.pendingEnvelopes() ?? []);
        this.setState({
          outboxPending: outboxState.pendingCount,
          authoringError: outboxState.lastError,
        });
        if (this.joinEnvelopeId && outboxState.pendingCount === 0) {
          this.joinEnvelopeId = null;
          this.setState({ authoringReady: true, authoringError: null });
        }
      },
      onTerminal: (error) => this.handleOutboxTerminal(error),
      onAccepted: (batch) => {
        for (const envelope of batch) {
          if (envelope.kind !== 'signal') this.peerMesh?.broadcastEnvelope(envelope);
        }
      },
    });
    this.outbox = outbox;
    await outbox.initialize();
    if (this.outbox !== outbox || this.isTerminated()) return;

    if (skipJoin) {
      this.setState({
        authoringReady: true,
        outboxPending: outbox.getState().pendingCount,
        authoringError: outbox.getState().lastError,
      });
      void outbox.flushNow().catch(() => undefined);
      return;
    }

    const createdAt = this.nextCreatedAt();
    const capabilities: Capability[] = [
      'read_snapshot',
      'write_comment',
      'resolve_comment',
    ];
    if (this.state.grantTier === 'suggest') capabilities.push('write_suggestion');
    const joined: ReviewEventBody = {
      type: 'participant_joined',
      participant: {
        participantId: identity.participantId,
        displayName: this.opts.getDisplayName?.()?.trim() || 'Browser reviewer',
        kind: 'reviewer',
        publicSigningKey: base64UrlEncode(identity.signingPublic),
        capabilities,
        ...this.declaredColorEntry(),
      },
      device: {
        deviceId: identity.deviceId,
        participantId: identity.participantId,
        publicEncryptionKey: base64UrlEncode(identity.publicEncryptionKey),
        publicSigningKey: base64UrlEncode(identity.signingPublic),
        client: 'attn-browser',
        createdAt,
      },
    };
    const assembled = assembleBrowserEvent({
      eventKey: keys.eventKey,
      signingSecret: identity.signingSecret,
      signingPublic: identity.signingPublic,
      roomId,
      authorId: identity.participantId,
      deviceId: identity.deviceId,
      createdAt,
      expiresAt: policy.expiresAt,
      body: joined,
    });
    this.joinEnvelopeId = assembled.envelope.envelopeId;
    if (this.storage) await outbox.enqueueDurably(assembled.envelope);
    else outbox.enqueue(assembled.envelope);
    if (this.outbox !== outbox || this.isTerminated()) return;
    const store = await this.ensureStore();
    if (this.outbox !== outbox || this.isTerminated()) return;
    store.applyEvent(assembled.event);
    if (durableOffline) {
      this.setState({ authoringReady: true, authoringError: null });
    }
    void outbox.flushNow().catch(() => undefined);
  }

  /**
   * Re-announce this participant with the CURRENT display name (attn-sur).
   * The store's participant reducer is last-write-wins per participantId, so
   * peers pick the rename up immediately. The initial announce happens during
   * authoring init and may race the name prompt — this closes that gap when
   * the user confirms a name after the session already introduced itself.
   * Safe no-op before authoring is ready (the init announce reads the getter).
   */
  /** Spread-ready `{ color }` entry for ParticipantJoined bodies (attn-3gdd):
   *  the picked color when valid, else nothing (hash fallback on receivers). */
  private declaredColorEntry(): { color: string } | Record<string, never> {
    const declared = sanitizeParticipantColor(this.opts.getColor?.() ?? null);
    return declared !== null ? { color: declared } : {};
  }

  /** The session identity's participant id (attn-3gdd), or null before the
   *  session has minted/loaded one. Seeds the local caret/chip hash color —
   *  the same id every ParticipantJoined above announces. */
  getParticipantId(): string | null {
    return this.identity?.participantId ?? null;
  }

  async announceProfile(): Promise<void> {
    const outbox = this.outbox;
    const identity = this.identity;
    const keys = this.keys;
    const policy = this.roomPolicy;
    const roomId = this.state.roomId;
    if (!outbox || !identity || !keys || !policy || !roomId) return;
    if (!this.state.authoringReady || this.state.grantTier === 'view') return;
    const createdAt = this.nextCreatedAt();
    // Receivers verify the announced capability list EXACTLY against the
    // registered device kind (validParticipantAttestation). Announcing the
    // reviewer set from an owner made every receiving client silently drop
    // the re-announce as unauthorized — the rename then existed only in the
    // author's local echo and reverted on any replay.
    const capabilities: Capability[] =
      this.principal === 'owner'
        ? [
            'room_admin',
            'read_snapshot',
            'write_comment',
            'write_suggestion',
            'resolve_comment',
            'accept_suggestion',
            'publish_snapshot',
          ]
        : this.state.grantTier === 'suggest'
          ? ['read_snapshot', 'write_comment', 'resolve_comment', 'write_suggestion']
          : ['read_snapshot', 'write_comment', 'resolve_comment'];
    const joined: ReviewEventBody = {
      type: 'participant_joined',
      participant: {
        participantId: identity.participantId,
        displayName: this.opts.getDisplayName?.()?.trim() ||
          (this.principal === 'owner' ? 'Browser owner' : 'Browser reviewer'),
        kind: this.principal,
        publicSigningKey: base64UrlEncode(identity.signingPublic),
        capabilities,
        ...this.declaredColorEntry(),
      },
      device: {
        deviceId: identity.deviceId,
        participantId: identity.participantId,
        publicEncryptionKey: base64UrlEncode(identity.publicEncryptionKey),
        publicSigningKey: base64UrlEncode(identity.signingPublic),
        client: 'attn-browser',
        createdAt,
      },
    };
    const assembled = assembleBrowserEvent({
      eventKey: keys.eventKey,
      signingSecret: identity.signingSecret,
      signingPublic: identity.signingPublic,
      roomId,
      authorId: identity.participantId,
      deviceId: identity.deviceId,
      createdAt,
      expiresAt: policy.expiresAt,
      body: joined,
    });
    if (this.storage) await outbox.enqueueDurably(assembled.envelope);
    else outbox.enqueue(assembled.envelope);
    const store = await this.ensureStore();
    store.applyEvent(assembled.event);
    void outbox.flushNow().catch(() => undefined);
  }

  private async sendSignal(
    targetDeviceId: string,
    payload: BrowserSignalingPayload,
  ): Promise<void> {
    const identity = this.requireIdentity();
    const keys = this.keys;
    const policy = this.roomPolicy;
    const outbox = this.outbox;
    const roomId = this.state.roomId;
    if (!keys || !policy || !outbox || !roomId) throw new Error('browser session is unavailable');
    const target = this.bootstrapDevices.find((device) => device.deviceId === targetDeviceId);
    if (!target || (target.client !== 'attn-native' && target.client !== 'attn-browser')) {
      throw new Error('signal target is not an authenticated WebRTC peer');
    }
    const createdAt = this.nextCreatedAt();
    const envelope = assembleBrowserSignal({
      signalingKey: keys.signalingKey,
      roomId,
      authorId: identity.participantId,
      deviceId: identity.deviceId,
      targetDeviceId,
      createdAt,
      expiresAt: policy.expiresAt,
      payload,
      protocolVersion: keys.version,
      ...(keys.version === 3 ? {
        signalGeneration: createdAt,
        signingSecret: identity.signingSecret,
      } : {}),
    });
    if (this.storage) await outbox.enqueueDurably(envelope);
    else outbox.enqueue(envelope);
    void outbox.flushNow().catch(() => undefined);
  }

  private async startPeerMesh(policy: RoomPolicy, devices: Device[]): Promise<void> {
    if (
      this.opts.disableWebRtc ||
      policy.mode === 'async' ||
      !policy.allowBrowser ||
      (!this.opts.peerConnectionFactory && typeof RTCPeerConnection === 'undefined')
    ) {
      this.peerMesh?.close();
      this.peerMesh = null;
      this.setState({ connection: this.state.status === 'connected' ? 'mailbox' : 'offline' });
      return;
    }
    const identity = this.requireIdentity();
    if (!this.peerMesh) {
      this.peerMesh = new BrowserPeerMesh({
        localDeviceId: identity.deviceId,
        maxEnvelopeBytes: Math.max(4_096, policy.maxEventBytes * 2 + 4_096),
        ...(this.opts.stunServers === undefined ? {} : { stunServers: this.opts.stunServers }),
        ...(this.opts.peerConnectionFactory === undefined
          ? {}
          : { createPeerConnection: this.opts.peerConnectionFactory }),
        onSignal: (targetDeviceId, payload) => this.sendSignal(targetDeviceId, payload),
        onEnvelope: async (envelope) => {
          if (envelope.roomId !== this.state.roomId) throw new Error('direct envelope room mismatch');
          await this.wsClient?.ingestDirectEnvelope(envelope);
        },
        onState: (connection) => {
          if (this.state.status === 'connected') {
            this.setState({ connection, ...(connection === 'live_direct' ? { directError: null } : {}) });
          }
        },
        onPresenceReady: () => {
          if (this.latestPresenceEnvelope) {
            this.peerMesh?.broadcastPresenceEnvelope(this.latestPresenceEnvelope);
          }
        },
        onError: (message) => this.setState({ directError: message }),
      });
    }
    this.peerMesh.syncDevices(devices.filter((device) => this.onlineDeviceIds.has(device.deviceId)));
    if (this.state.status === 'connected') this.setState({ connection: this.peerMesh.getState() });
    const pending = this.pendingSignals.splice(0);
    for (const payload of pending) await this.peerMesh.handleSignal(payload);
  }

  private activeWebRtcDevices(): Device[] {
    return this.bootstrapDevices.filter((device) => this.onlineDeviceIds.has(device.deviceId));
  }

  private localDeviceRecord(identity: BrowserDeviceIdentity): Device {
    const registration = buildRegisterDeviceBody(identity, this.principal);
    return {
      ...registration,
      kind: this.principal,
      client: 'attn-browser',
    };
  }

  private makeOutboxPersistence(
    storage: BrowserStorage,
    roomId: string,
    deviceId: string,
  ): BrowserOutboxPersistence {
    return {
      loadPending: () => storage.listOutbox(roomId, deviceId),
      putPending: async (envelope) => {
        // Signaling is ephemeral negotiation state. It is relay-durable but
        // intentionally not recovered across browser lifetimes.
        if (envelope.kind !== 'signal') await storage.putOutbox(roomId, envelope);
      },
      putPendingBatch: async (envelopes) => {
        const durable = envelopes.filter((envelope) => envelope.kind !== 'signal');
        if (durable.length > 0) await storage.putOutboxBatch(roomId, durable);
      },
      acknowledge: async (batch, accepted) => {
        await storage.acknowledge(roomId, batch, accepted);
      },
    };
  }

  private async persistDirectoryAndRoom(devices: Device[], policy: RoomPolicy): Promise<void> {
    const storage = this.storage;
    const roomId = this.state.roomId;
    if (!storage || !roomId || !this.storageWritesEnabled) return;
    for (const device of devices) await storage.putDevice(roomId, device);
    // Browser-owned continuity lives in the workspace-key-sealed share cap.
    // Do not create a half-remembered reviewer-room row without a room key.
    if (this.principal === 'owner') return;
    if (!this.storageWritesEnabled) return;
    await storage.putRoom({
      roomId,
      policy,
      lastCreatedAt: this.lastCreatedAt,
      storagePersisted: this.state.storagePersisted ?? false,
    });
  }

  private fail(kind: BrowserSessionError['kind'], message: string): void {
    this.detachPagehide();
    this.stopTransport();
    this.storage?.close();
    this.storage = null;
    this.releaseSensitiveState();
    this.snapshotBlobs.clear();
    this.invalidSnapshotBlobIds.clear();
    this.pendingSnapshots.clear();
    this.hydratedEntries.clear();
    this.pendingWorkspaceManifests.clear();
    this.signerRefreshAttempts.clear();
    this.volatileInbound.clear();
    this.clearStorePlaintext();
    this.setState({
      status: 'error',
      connection: 'offline',
      snapshotContent: null,
      snapshotId: null,
      fileId: null,
      authoringReady: false,
      outboxPending: 0,
      authoringError: null,
      error: { kind, message },
    });
  }

  private clearStorePlaintext(): void {
    const roomId = this.state.roomId;
    if (!this.store) return;
    if (roomId && this.store.leaveRoom) {
      this.store.leaveRoom(roomId);
      return;
    }
    this.store.setCurrentSnapshot(null);
    this.store.setCurrentFile(null);
    this.store.currentRoomId = null;
  }

  private detachPagehide(): void {
    this.pagehideTarget?.removeEventListener?.('pagehide', this.pagehideHandler);
  }

  private stopTransport(): void {
    this.transportGeneration += 1;
    this.peerMesh?.close();
    this.peerMesh = null;
    this.latestPresenceEnvelope = null;
    this.outbox?.close();
    this.outbox = null;
    this.joinEnvelopeId = null;
    this.roomPolicy = null;
    this.bootstrapDevices = [];
    this.onlineDeviceIds.clear();
    this.pendingSignals.length = 0;
    this.dispatchedEnvelopeIds.clear();
    this.collabDispatches.clear();
    this.powAbortController?.abort();
    this.powAbortController = null;
    if (!this.wsClient) return;
    try {
      this.wsClient.close();
    } catch {
      // Best-effort teardown; key clobbering must still continue.
    }
    this.wsClient = null;
  }

  private releaseSensitiveState(): void {
    this.localAttestationRestored = false;
    if (this.ownerRoomSecret) {
      zero(this.ownerRoomSecret);
      this.ownerRoomSecret = null;
    }
    if (this.keys) {
      if (this.keys.rootKey) zero(this.keys.rootKey);
      zero(this.keys.eventKey);
      zero(this.keys.snapshotKey);
      zero(this.keys.signalingKey);
      zero(this.keys.readAdmissionKey);
      if (this.keys.writeAdmissionKey && this.keys.writeAdmissionKey !== this.keys.readAdmissionKey) {
        zero(this.keys.writeAdmissionKey);
      }
      if (this.keys.readCapabilityKey) zero(this.keys.readCapabilityKey);
      this.keys = null;
    }
    if (this.identity) {
      zero(this.identity.signingSecret);
      zero(this.identity.signingPublic);
      zero(this.identity.encryptionSecret);
      zero(this.identity.publicEncryptionKey);
      this.identity = null;
    }
  }

  private async fetchRoomBootstrap(
    roomId: string,
    keys: ActiveRoomKeys,
  ): Promise<{ policy: RoomPolicy; devices: Device[] }> {
    const path = `/v${keys.version}/rooms/${roomId}/devices`;
    const relay = validateBrowserRelayUrl(this.opts.relayUrl);
    const admission = keys.version === 3
      ? buildAdmissionHeaderV3(keys.readAdmissionKey, 'read', 'GET', path, new Uint8Array())
      : admissionHeaderValue(keys.readAdmissionKey, 'GET', path, new Uint8Array());
    const response = await this.fetchImpl()(`${relay}${path}`, {
      method: 'GET',
      headers: { 'Attn-Admission': admission },
    });
    const raw = await response.text();
    if (response.status !== 200) {
      throw new Error(`GET /devices failed: status=${response.status} body=${raw.slice(0, 200)}`);
    }
    const parsed = JSON.parse(raw) as { policy?: RoomPolicy; devices?: Device[] };
    if (!parsed.policy || !Array.isArray(parsed.devices)) {
      throw new Error('GET /devices omitted authenticated room policy or device directory');
    }
    return { policy: validateRoomPolicy(parsed.policy), devices: parsed.devices };
  }

  private async registerDevice(invite: ParsedInvite, keys: ActiveRoomKeys, powBits: number): Promise<void> {
    if (!this.identity) throw new Error('identity missing');
    if (!keys.writeAdmissionKey) throw new Error('write capability missing');
    const roomId = invite.roomId;
    if (invite.version === 3 && invite.tier === 'view') {
      throw new Error('view invite cannot register a device');
    }
    let body: RegisterDeviceBody | RegisterDeviceBodyV3;
    if (invite.version === 3) {
      if (invite.tier === 'view') throw new Error('view invite cannot register a device');
      body = buildRegisterDeviceBodyV3(this.identity, invite.tier, invite.grantSignature ?? '');
    } else {
      body = buildRegisterDeviceBody(this.identity);
    }
    const bodyJson = JSON.stringify(body);
    const bodyBytes = new TextEncoder().encode(bodyJson);
    const path = `/v${keys.version}/rooms/${roomId}/devices`;
    const admission = keys.version === 3
      ? buildAdmissionHeaderV3(keys.writeAdmissionKey, 'write', 'POST', path, bodyBytes)
      : admissionHeaderValue(keys.writeAdmissionKey, 'POST', path, bodyBytes);
    const relay = validateBrowserRelayUrl(this.opts.relayUrl);
    const url = `${relay}${path}`;
    this.powAbortController = new AbortController();
    const powInput = {
      roomId,
      deviceId: this.identity.deviceId,
      method: 'POST' as const,
      path,
      difficulty: Math.max(BROWSER_POW_DIFFICULTY, powBits),
    };
    const pow =
      this.opts.powToken ??
      (this.opts.registrationMintPow
        ? await this.opts.registrationMintPow(powInput, this.powAbortController.signal)
        : await mintBrowserPowInWorker(powInput, { signal: this.powAbortController.signal }));
    this.powAbortController = null;
    const headers: Record<string, string> = {
      'content-type': 'application/json; charset=utf-8',
      'Attn-Admission': admission,
      'Attn-PoW': pow,
    };
    const fetchImpl = this.fetchImpl();
    const resp = await fetchImpl(url, {
      method: 'POST',
      headers,
      body: bodyJson,
    });
    if (resp.status !== 200 && resp.status !== 204) {
      const text = await resp.text().catch(() => '');
      throw new Error(`POST /devices failed: status=${resp.status} body=${text.slice(0, 200)}`);
    }
  }

  private openWs(roomId: string, keys: ActiveRoomKeys): void {
    this.buildWsClient(roomId, keys).start();
  }

  private buildWsClient(roomId: string, keys: ActiveRoomKeys): BrowserWsClient {
    const relay = validateBrowserRelayUrl(this.opts.relayUrl);
    const viewOnly = this.state.grantTier === 'view';
    const identityId = viewOnly ? this.viewerId : this.requireIdentity().deviceId;
    const identityKind = viewOnly ? 'viewer' : 'device';
    const path = socketPath(roomId, keys.version);
    const queryName = viewOnly ? 'viewer_id' : 'device_id';
    // The WS handshake admission HMAC is over METHOD=GET, path, empty body —
    // exactly what `buildAdmissionSubprotocol` produces (the `Sec-WebSocket-
    // Protocol` value carries it; browsers can't set custom headers on a WS
    // upgrade).
    const buildConnection = (): { url: string; subprotocol: string } => {
      const query: Array<[string, string]> = [[queryName, identityId]];
      let deviceProofSignature: string | undefined;
      if (keys.version === 3 && !viewOnly) {
        const proof = createDeviceWebSocketProofV3({
          roomId,
          deviceId: identityId,
          path,
          signingSecret: this.requireIdentity().signingSecret,
        });
        query.push(['proof_expires', String(proof.expiresAt)], ['proof_nonce', proof.nonce]);
        deviceProofSignature = proof.signature;
      }
      const urlObject = new URL(buildWsUrl(relay, roomId, identityId, keys.version, identityKind));
      for (const [name, value] of query.slice(1)) urlObject.searchParams.append(name, value);
      let subprotocol = keys.version === 3
        ? buildAdmissionSubprotocolV3(
            keys.readAdmissionKey,
            'GET',
            path,
            query,
            viewOnly ? undefined : keys.writeAdmissionKey,
          )
        : buildAdmissionSubprotocol(keys.readAdmissionKey, 'GET', path, query);
      if (deviceProofSignature !== undefined) {
        subprotocol += `, device-proof.${deviceProofSignature}`;
      }
      return { url: urlObject.toString(), subprotocol };
    };
    const initialConnection = buildConnection();
    const client = new BrowserWsClient({
      roomId,
      localDeviceId: identityId,
      ...initialConnection,
      refreshConnection: buildConnection,
      afterSeq: this.persistedCursor,
      eventKey: keys.eventKey,
      snapshotKey: keys.snapshotKey,
      signalingKey: keys.signalingKey,
      protocolVersion: keys.version,
      initialDevices: new Map(
        this.bootstrapDevices.map((device, index) => [`bootstrap-${index}`, device]),
      ),
      webSocketFactory: this.opts.webSocketFactory,
      reconnectInitialMs: this.opts.reconnectInitialMs,
      reconnectMaxMs: this.opts.reconnectMaxMs,
      callbacks: {
        onSeqRegression: async () => {
          // The room instance rotated under this roomId; our persisted
          // cursor and cached inbound log belong to the dead instance.
          const holder = globalThis as {
            __attnInboundErrors?: { at: number; code: string; message: string }[];
          };
          (holder.__attnInboundErrors ??= []).push({
            at: Date.now(),
            code: 'ATTN_ROOM_INSTANCE_ROTATED',
            message: 'room rebuilt under the same id; purging stale local history and resyncing',
          });
          this.persistedCursor = 0;
          if (this.storage && this.storageWritesEnabled) {
            await this.storage.resetRoomInboundHistory(roomId).catch(() => undefined);
          }
        },
        onHello: (frame, verifiedDevices) => {
          const devices = [...verifiedDevices.values()];
          let policy: RoomPolicy;
          try {
            policy = validateRoomPolicy(frame.policy);
            if (this.principal === 'owner') {
              const identity = this.identity;
              if (!identity) throw new Error('owner identity is unavailable');
              // The authoritative hello directory must itself contain the
              // exact owner registration; the verified cache check below
              // additionally proves that registration passed self-signature
              // and immutable device-key binding validation.
              assertRegisteredBrowserOwner(frame.devices, identity);
              assertRegisteredBrowserOwner(devices, identity);
              if (!policy.allowBrowser) {
                throw new Error('authenticated room policy disabled browser owner authority');
              }
              if (policy.expiresAt <= Date.now()) {
                this.fail('room_expired', 'authenticated room policy has expired');
                return;
              }
            }
          } catch (error) {
            this.fail('network', error instanceof Error ? error.message : String(error));
            return;
          }
          this.roomPolicy = policy;
          this.bootstrapDevices = devices;
          this.onlineDeviceIds.clear();
          for (const deviceId of frame.onlineDeviceIds ?? []) {
            this.onlineDeviceIds.add(deviceId);
          }
          // The relay's hello lists sockets that have already announced
          // presence — never the connecting socket itself. An owner must
          // count its own device or ownerOnline stays false and every
          // authority broadcast throws "live editing is paused".
          if (this.principal === 'owner' && this.identity) {
            this.onlineDeviceIds.add(this.identity.deviceId);
          }
          this.setState({ status: 'connected', connection: 'mailbox' });
          void this.persistDirectoryAndRoom(this.bootstrapDevices, policy).catch(() => undefined);
          if (viewOnly) {
            this.setState({ authoringReady: false, authoringError: null });
            return;
          }
          const generation = this.transportGeneration;
          void (async () => {
            await this.initializeAuthoring(policy, this.principal === 'owner');
            if (generation !== this.transportGeneration || this.isTerminated()) return;
            await this.startPeerMesh(policy, this.bootstrapDevices);
          })().catch(() => {
            if (generation !== this.transportGeneration || this.isTerminated()) return;
            this.setState({
              connection: 'direct_failed',
              directError: 'direct_start_failed',
            });
          });
        },
        onEnvelope: (decoded) => this.handleEnvelopeAsync(decoded),
        onUnknownSigner: (envelope) => this.refreshSignerAndRetry(roomId, keys, envelope),
        onClose: (code) => {
          if (code < 4000 && this.state.status !== 'error' && this.state.status !== 'terminated') {
            this.onlineDeviceIds.clear();
            this.setState({
              status: this.state.snapshotContent === null ? 'connecting' : 'offline',
              connection: 'offline',
            });
          }
        },
        onTerminal: (err) => this.handleTerminal(err),
        onError: (code, message) => {
          // Non-fatal for the connection — but never invisible. A dropped
          // inbound envelope (failed signature, capability authorization,
          // unknown signer) is exactly how "their comment never showed up"
          // presents, so keep a bounded diagnostic ring readable from the
          // console / the __attnCollabDebug probe.
          const holder = globalThis as {
            __attnInboundErrors?: { at: number; code: string; message: string }[];
          };
          const log = (holder.__attnInboundErrors ??= []);
          log.push({ at: Date.now(), code, message });
          if (log.length > 50) log.shift();
        },
        onPolicyChanged: (policy) => {
          let validated: RoomPolicy;
          try {
            validated = validateRoomPolicy(policy);
            if (this.principal === 'owner') {
              if (!validated.allowBrowser) {
                throw new Error('authenticated room policy disabled browser owner authority');
              }
              if (validated.expiresAt <= Date.now()) {
                this.fail('room_expired', 'authenticated room policy has expired');
                return;
              }
            }
          } catch (error) {
            this.fail('network', error instanceof Error ? error.message : String(error));
            return;
          }
          this.roomPolicy = validated;
          this.setState({});
          if (viewOnly) return;
          const generation = this.transportGeneration;
          void (async () => {
            await this.initializeAuthoring(validated, this.principal === 'owner');
            if (generation !== this.transportGeneration || this.isTerminated()) return;
            await this.startPeerMesh(validated, this.bootstrapDevices);
          })().catch(() => {
            if (generation === this.transportGeneration && !this.isTerminated()) {
              this.setState({ connection: 'direct_failed', directError: 'direct_policy_update_failed' });
            }
          });
        },
        onPresence: (event, deviceId, participantId) => {
          const authenticated = this.bootstrapDevices.find(
            (device) =>
              device.deviceId === deviceId && device.participantId === participantId,
          );
          if (import.meta.env?.DEV) {
            const target = globalThis as unknown as { __attnPresenceDebug?: unknown[] };
            (target.__attnPresenceDebug ??= []).push({
              event, deviceId: deviceId.slice(0, 8), participantId: participantId.slice(0, 8),
              authenticated: Boolean(authenticated), principal: this.principal, at: Date.now(),
            });
          }
          if (!authenticated) {
            if (event === 'join' && !viewOnly) {
              const generation = this.transportGeneration;
              void this.refreshDeviceDirectory(roomId, keys).then(() => {
                if (generation !== this.transportGeneration || this.isTerminated()) return;
                const refreshed = this.bootstrapDevices.find(
                  (device) => device.deviceId === deviceId && device.participantId === participantId,
                );
                if (!refreshed) return;
                this.onlineDeviceIds.add(deviceId);
                this.peerMesh?.syncDevices(this.activeWebRtcDevices());
                this.setState({});
              }).catch((error: unknown) => {
                if (import.meta.env?.DEV) {
                  const target = globalThis as unknown as { __attnPresenceDebug?: unknown[] };
                  (target.__attnPresenceDebug ??= []).push({
                    phase: 'refresh-failed',
                    error: error instanceof Error ? error.message : String(error),
                  });
                }
              });
            }
            return;
          }
          if (viewOnly) return;
          if (event === 'leave') {
            this.onlineDeviceIds.delete(deviceId);
            this.peerMesh?.removePeer(deviceId);
          } else {
            this.onlineDeviceIds.add(deviceId);
            this.peerMesh?.syncDevices(this.activeWebRtcDevices());
          }
          this.setState({});
        },
      },
    });
    this.wsClient = client;
    return client;
  }

  private fetchImpl(): (url: string, init: FetchLikeInit) => Promise<FetchLikeResponse> {
    return (
      this.opts.fetchImpl ??
      (async (url, init) => {
        const response = await (globalThis as unknown as {
          fetch: (
            url: string,
            init: FetchLikeInit,
          ) => Promise<{ status: number; text: () => Promise<string> }>;
        }).fetch(url, init);
        return response as FetchLikeResponse;
      })
    );
  }

  private async refreshSignerAndRetry(
    roomId: string,
    keys: ActiveRoomKeys,
    envelope: MailboxEnvelope,
  ): Promise<void> {
    if (this.signerRefreshAttempts.has(envelope.envelopeId)) {
      if (this.state.snapshotContent === null) {
        this.fail('network', 'Could not verify the snapshot signer');
      }
      return;
    }
    this.signerRefreshAttempts.add(envelope.envelopeId);
    try {
      await this.refreshDeviceDirectory(roomId, keys);
    } catch (error) {
      this.signerRefreshAttempts.delete(envelope.envelopeId);
      if (this.state.snapshotContent === null) {
        this.fail('network', 'Could not refresh participant signing keys');
      }
      throw error;
    }
  }

  /** Refresh signed device records before trusting a join for a newly-seen peer. */
  private async refreshDeviceDirectory(roomId: string, keys: ActiveRoomKeys): Promise<void> {
    if (this.directoryRefresh) return this.directoryRefresh;
    const refresh = (async () => {
      const path = `/v${keys.version}/rooms/${roomId}/devices`;
      const relay = validateBrowserRelayUrl(this.opts.relayUrl);
      const admission = keys.version === 3
        ? buildAdmissionHeaderV3(keys.readAdmissionKey, 'read', 'GET', path, new Uint8Array())
        : admissionHeaderValue(keys.readAdmissionKey, 'GET', path, new Uint8Array());
      const response = await this.fetchImpl()(`${relay}${path}`, {
        method: 'GET',
        headers: { 'Attn-Admission': admission },
      });
      const raw = await response.text();
      if (response.status !== 200) throw new Error(`GET /devices failed: ${response.status}`);
      const parsed = JSON.parse(raw) as { devices?: Device[] };
      if (!Array.isArray(parsed.devices)) throw new Error('GET /devices returned invalid body');
      this.wsClient?.mergeDevices(parsed.devices);
      this.bootstrapDevices = [...(this.wsClient?.getDevices().values() ?? [])];
      this.peerMesh?.syncDevices(this.activeWebRtcDevices());
      // Local persistence is a cache — its failure must never reject the
      // refresh, because the presence-join path chains "mark peer online" on
      // this promise and a storage veto would freeze the roster at away.
      if (this.roomPolicy) {
        await this.persistDirectoryAndRoom(this.bootstrapDevices, this.roomPolicy).catch(() => undefined);
      }
    })();
    this.directoryRefresh = refresh;
    try {
      await refresh;
    } finally {
      if (this.directoryRefresh === refresh) this.directoryRefresh = null;
    }
  }

  private async handleEnvelopeAsync(decoded: DecodedEnvelope): Promise<void> {
    const { envelope, plaintext } = decoded;
    // Cursor/view presence is replaceable transport state. Persisting every
    // update here would recreate an unbounded event log in IndexedDB even
    // though the relay retains only the newest value per device.
    const replaceablePresence = envelope.kind === 'signal' && envelope.signalClass === 'presence';
    if (decoded.source === 'network' && !replaceablePresence) {
      if (this.storage && this.identity && this.storageWritesEnabled) {
        try {
          await this.storage.commitInbound(
            this.state.roomId!,
            this.identity.deviceId,
            envelope,
            decoded.serverSeq,
          );
        } catch (error) {
          if (!(error instanceof StorageConflictError)) throw error;
          // The relay room INSTANCE rotated under this roomId (stop/re-share
          // reuses ids; relay idle/expiry eviction rebuilds rooms): the new
          // instance restarts serverSeqs, so the stale local history binds
          // these sequences to the dead instance's envelopes. Left alone this
          // is a permanent deaf loop — commit fails before dispatch, the
          // socket recycles, the same frame conflicts again, and the client
          // never hears another event. Local history is a CACHE of the relay
          // log: purge it, rebind to the current instance, and let the
          // in-flight replay continue (UI dedup by eventId keeps this safe).
          const holder = globalThis as {
            __attnInboundErrors?: { at: number; code: string; message: string }[];
          };
          (holder.__attnInboundErrors ??= []).push({
            at: Date.now(),
            code: 'ATTN_ROOM_INSTANCE_ROTATED',
            message: 'stale local room history purged; resyncing from the current room instance',
          });
          await this.storage.resetRoomInboundHistory(this.state.roomId!);
          this.persistedCursor = 0;
          await this.storage.commitInbound(
            this.state.roomId!,
            this.identity.deviceId,
            envelope,
            decoded.serverSeq,
          );
        }
        this.persistedCursor = Math.max(this.persistedCursor, decoded.serverSeq);
        // attn-dgya doorbell: tell sibling tabs reading the same IndexedDB
        // that the durable review log advanced. Signals are transport
        // plumbing and snapshot blobs pair with their pointer events, so
        // only review events ring — anything else would just be noise.
        if (envelope.kind === 'event') this.ringReviewInboundDoorbell(this.state.roomId!);
      } else {
        this.volatileInbound.set(envelope.envelopeId, {
          envelope: structuredClone(envelope),
          serverSeq: decoded.serverSeq,
        });
      }
    }
    // Direct-first delivery must not suppress the later network durability
    // commit above. Only UI/control-plane dispatch is deduplicated here.
    if (this.dispatchedEnvelopeIds.has(envelope.envelopeId)) {
      zero(plaintext);
      return;
    }
    if (envelope.kind === 'event') {
      let parsed: { meta?: EventMeta; body?: ReviewEventBody; auth?: ReviewEvent['auth'] };
      try {
        parsed = JSON.parse(new TextDecoder().decode(plaintext));
      } catch {
        return;
      } finally {
        zero(plaintext);
      }
      const meta = parsed.meta;
      const body = parsed.body;
      const auth = parsed.auth;
      if (!meta || !body || !auth) return;
      const event: ReviewEvent = {
        meta: meta as EventMeta,
        body: body as ReviewEventBody,
        auth,
      };
      if (
        body.type === 'participant_joined' &&
        this.identity &&
        body.device.deviceId === this.identity.deviceId &&
        body.participant.participantId === this.identity.participantId
      ) {
        this.localAttestationRestored = true;
      }
      const store = await this.ensureStore();
      // Snapshot path — surface markdown for the editor + populate
      // reviewStore.snapshots so the existing UI can scope by snapshot.
      if (body.type === 'snapshot_created') {
        await this.absorbSnapshotCreated(store, meta as EventMeta, body);
        if (this.state.status === 'error') return;
      }
      store.applyEvent(event);
      this.rememberDispatchedEnvelope(envelope.envelopeId);
      return;
    }
    if (envelope.kind === 'snapshot_blob') {
      // Native bootstrap enqueues mailbox bytes before the pointer event, but
      // cache + pending queues make the receiver defensive to either order.
      const blobId = envelope.envelopeId;
      const waiting = this.pendingSnapshots.get(blobId);
      // Transparent gzip: the owner compresses the plaintext before sealing
      // when it wins; a decode failure here is treated exactly like a failed
      // plaintext parse below (invalid blob), never a crash.
      let inflated: Uint8Array;
      try {
        inflated = await decompressSnapshotIfNeeded(plaintext);
      } catch {
        inflated = plaintext;
      }
      let snapshot = parseBrowserSnapshotPlaintext(inflated);
      let snapshotBytes = snapshot ? new Uint8Array(inflated) : null;
      const wrapperIsR2 = snapshot === null && parseR2BlobRefPlaintext(inflated, envelope.envelopeId);
      if (inflated !== plaintext) zero(inflated);
      zero(plaintext);
      if (wrapperIsR2) {
        const keys = this.keys;
        const roomId = this.state.roomId;
        if (!keys || !roomId) return;
        let recovered: Uint8Array | null = null;
        try {
          recovered = await resolveBrowserR2Snapshot({
            relayUrl: validateBrowserRelayUrl(this.opts.relayUrl),
            roomId,
            admissionKey: keys.readAdmissionKey,
            protocolVersion: keys.version,
            snapshotKey: keys.snapshotKey,
            wrapper: envelope,
            fetchImpl: this.opts.r2FetchImpl ?? ((input, init) => fetch(input, init)),
            ...(this.storage
              ? {
                  sealedCache: {
                    getSealed: (storedRoomId: string, blobId: string) =>
                      this.storage?.getSealedBlob(storedRoomId, blobId),
                    putSealed: async (storedRoomId: string, blobId: string, sealed: Uint8Array) => {
                      await this.storage?.putSealedBlob(storedRoomId, blobId, sealed);
                    },
                  },
                }
              : {}),
          });
          const recoveredInflated = await decompressSnapshotIfNeeded(recovered);
          snapshot = parseBrowserSnapshotPlaintext(recoveredInflated);
          if (snapshot) snapshotBytes = new Uint8Array(recoveredInflated);
          if (recoveredInflated !== recovered) zero(recoveredInflated);
        } catch (error) {
          const message = error instanceof Error ? error.message : 'R2 snapshot recovery failed';
          if (this.state.snapshotContent === null) {
            this.fail('network', message);
          } else {
            // Keep already-rendered files usable, but do not silently turn the
            // failed large snapshot into a permanent content-less placeholder.
            this.setState({ authoringError: message });
          }
          return;
        } finally {
          if (recovered) zero(recovered);
        }
      }
      const cached = snapshot
        ? {
            snapshot,
            byteLength: snapshotBytes!.length,
            contentHash: contentHash(snapshotBytes!),
          }
        : null;
      snapshotBytes?.fill(0);
      if (!cached) {
        this.invalidSnapshotBlobIds.add(blobId);
        if (waiting && waiting.length > 0) {
          this.fail('network', 'Snapshot payload failed integrity validation');
        }
        return;
      }
      if (!waiting || waiting.length === 0) {
        this.snapshotBlobs.set(blobId, cached);
        this.rememberDispatchedEnvelope(envelope.envelopeId);
        return;
      }
      this.pendingSnapshots.delete(blobId);
      for (const pending of waiting) {
        await this.hydrateSnapshotBlob(pending.store, pending.meta, pending.body, cached);
      }
      this.rememberDispatchedEnvelope(envelope.envelopeId);
      return;
    }
    if (envelope.kind === 'signal') {
      let payload: BrowserSignalingPayload;
      try {
        payload = parseBrowserSignalingPayload(plaintext, envelope.deviceId);
      } catch {
        return;
      } finally {
        zero(plaintext);
      }
      if (decoded.source === 'direct' && payload.kind !== 'collab') return;
      if (
        payload.kind !== 'collab' &&
        envelope.target?.deviceId !== this.identity?.deviceId
      ) {
        return;
      }
      const sender = this.bootstrapDevices.find((device) => device.deviceId === envelope.deviceId);
      if (!sender || sender.participantId !== envelope.authorId) return;
      if (sender.client !== 'attn-native' && sender.client !== 'attn-browser') return;
      if (payload.kind === 'collab') {
        if (envelope.target !== null && envelope.target !== undefined) return;
        if (sender.deviceId === this.identity?.deviceId) return;
        const message = parseCollabWireMessage(payload.payload);
        if (!message || !this.inboundCollabAllowed(message, sender)) return;
        await this.dispatchCollabOnce({
          envelopeId: envelope.envelopeId,
          source: decoded.source,
          payload: payload.payload,
          sender: structuredClone(sender),
        });
        return;
      }
      if (!this.peerMesh) {
        if (this.pendingSignals.length < 64) {
          this.pendingSignals.push(payload);
          this.rememberDispatchedEnvelope(envelope.envelopeId);
        }
        return;
      }
      try {
        await this.peerMesh.handleSignal(payload);
        this.rememberDispatchedEnvelope(envelope.envelopeId);
      } catch {
        this.setState({ directError: 'direct_signal_rejected' });
      }
      return;
    }
    zero(plaintext);
  }

  private async dispatchCollabOnce(delivery: BrowserCollabDelivery): Promise<void> {
    // A direct delivery and its durable network echo may overlap. Wait for the
    // active callback: success suppresses the echo, while rejection lets the
    // authenticated network/replay copy try again.
    while (!this.dispatchedEnvelopeIds.has(delivery.envelopeId)) {
      const active = this.collabDispatches.get(delivery.envelopeId);
      if (!active) break;
      if (await active) return;
    }
    if (this.dispatchedEnvelopeIds.has(delivery.envelopeId)) return;

    let settle!: (succeeded: boolean) => void;
    const pending = new Promise<boolean>((resolve) => { settle = resolve; });
    this.collabDispatches.set(delivery.envelopeId, pending);
    let succeeded = false;
    try {
      await this.opts.onCollab?.(delivery);
      this.rememberDispatchedEnvelope(delivery.envelopeId);
      succeeded = true;
    } finally {
      settle(succeeded);
      if (this.collabDispatches.get(delivery.envelopeId) === pending) {
        this.collabDispatches.delete(delivery.envelopeId);
      }
    }
  }

  /**
   * Advisory cross-tab ring after a durable review-event commit: sibling
   * workspace tabs replay the shared IndexedDB log on ring (attn-dgya —
   * see browser-review-log.ts). A lost ring only delays them until the
   * next commit; storage stays the source of truth.
   */
  private ringReviewInboundDoorbell(roomId: string): void {
    const name = REVIEW_INBOUND_CHANNEL_PREFIX + roomId;
    // Same-tab first (attn-ij9y): BroadcastChannel never loops back to the
    // posting context, so the LEADER tab's own projection — which now owns
    // the store even for this tab — would never replay this commit without
    // an in-process ring. Followers get the cross-tab post below.
    ringLocalDoorbell(name);
    this.reviewInboundDoorbell ??= openBroadcastChannel(name);
    try {
      this.reviewInboundDoorbell?.postMessage({ roomId });
    } catch {
      // Channel closed or partitioned mid-post — advisory only.
    }
  }

  private rememberDispatchedEnvelope(envelopeId: string): void {
    this.dispatchedEnvelopeIds.add(envelopeId);
    if (this.dispatchedEnvelopeIds.size <= 4_096) return;
    const oldest = this.dispatchedEnvelopeIds.values().next().value as string | undefined;
    if (oldest !== undefined) this.dispatchedEnvelopeIds.delete(oldest);
  }

  private async absorbSnapshotCreated(
    store: ReviewStoreSink,
    meta: EventMeta,
    body: Extract<ReviewEventBody, { type: 'snapshot_created' }>,
  ): Promise<void> {
    if (body.inlineSnapshot) {
      try {
        await this.hydrateSnapshot(store, meta, body, validateSnapshotPlaintext(body.inlineSnapshot));
      } catch {
        this.fail('network', 'Snapshot payload failed schema validation');
      }
      return;
    }
    const blobRef = body.encryptedBlobRef;
    if (!blobRef || (blobRef.storage !== 'mailbox' && blobRef.storage !== 'r2')) return;
    if (this.invalidSnapshotBlobIds.delete(blobRef.blobId)) {
      this.fail('network', 'Snapshot payload failed integrity validation');
      return;
    }
    const cached = this.snapshotBlobs.get(blobRef.blobId);
    if (cached) {
      this.snapshotBlobs.delete(blobRef.blobId);
      await this.hydrateSnapshotBlob(store, meta, body, cached);
      return;
    }
    const waiting = this.pendingSnapshots.get(blobRef.blobId) ?? [];
    if (!waiting.some((pending) => pending.body.snapshotId === body.snapshotId)) {
      waiting.push({ store, meta, body });
      this.pendingSnapshots.set(blobRef.blobId, waiting);
    }
  }

  private async hydrateSnapshotBlob(
    store: ReviewStoreSink,
    meta: EventMeta,
    body: Extract<ReviewEventBody, { type: 'snapshot_created' }>,
    cached: CachedSnapshotBlob,
  ): Promise<void> {
    const blobRef = body.encryptedBlobRef;
    if (
      !blobRef ||
      (blobRef.storage !== 'mailbox' && blobRef.storage !== 'r2') ||
      blobRef.byteLength !== cached.byteLength ||
      blobRef.contentHash !== cached.contentHash
    ) {
      this.fail('network', 'Snapshot payload does not match its signed reference');
      return;
    }
    await this.hydrateSnapshot(store, meta, body, cached.snapshot);
  }

  private async hydrateSnapshot(
    store: ReviewStoreSink,
    meta: EventMeta,
    body: Extract<ReviewEventBody, { type: 'snapshot_created' }>,
    inline: SnapshotPlaintext,
  ): Promise<void> {
    const snapshot: ReviewSnapshot = {
      roomId: meta.roomId,
      fileId: body.fileId,
      snapshotId: body.snapshotId,
      ownerDisplayPath: body.ownerDisplayPath,
      parentSnapshotId: body.parentSnapshotId,
      createdAt: meta.createdAt,
      createdBy: meta.authorId,
      baseHash: body.baseHash,
      byteLength: body.encryptedBlobRef?.byteLength ?? 0,
      docType: inline.docType,
      encryptedBlobRef: body.encryptedBlobRef,
    };
    if (inline.docType === 'markdown' || inline.docType === 'html') {
      const raw = new TextEncoder().encode(inline.content);
      if (contentHash(raw) !== body.baseHash) {
        raw.fill(0);
        this.fail('network', 'Snapshot document content does not match its signed base hash');
        return;
      }
      if (inline.docType === 'markdown' && inline.anchorIndex !== undefined) {
        try {
          const builder = this.opts.anchorIndexBuilder
            ?? (await import('./browser-anchor-index')).buildCanonicalAnchorIndex;
          const rebuilt = await builder(raw, body.snapshotId);
          if (!canonicalValuesEqual(rebuilt, inline.anchorIndex)) {
            raw.fill(0);
            this.fail('network', 'Snapshot anchor index does not match canonical document anchors');
            return;
          }
        } catch {
          raw.fill(0);
          this.fail('network', 'Snapshot anchor index could not be verified');
          return;
        }
      }
      snapshot.byteLength = raw.length;
      raw.fill(0);
      snapshot.content = inline.content;
      if (inline.docType === 'markdown') snapshot.anchorIndex = inline.anchorIndex;
      this.setState({
        snapshotContent: inline.content,
        snapshotDocType: inline.docType,
        snapshotId: body.snapshotId,
        fileId: body.fileId,
      });
    } else if (inline.docType === 'asset') {
      const raw = decodeCanonicalBase64Url(inline.content);
      if (contentHash(raw) !== body.baseHash) {
        raw.fill(0);
        this.fail('network', 'Snapshot asset content does not match its signed base hash');
        return;
      }
      snapshot.byteLength = raw.length;
      snapshot.mediaType = inline.mediaType;
      raw.fill(0);
    } else {
      const canonical = toCanonicalBytes(inline.manifest);
      if (contentHash(canonical) !== body.baseHash) {
        canonical.fill(0);
        this.fail('network', 'Workspace manifest does not match its signed base hash');
        return;
      }
      snapshot.byteLength = canonical.length;
      canonical.fill(0);
      const bindings = this.workspaceManifestBindingStatus(inline.manifest.entries);
      if (bindings.invalidPath !== undefined) {
        this.fail(
          'network',
          `Workspace manifest entry failed integrity validation: ${bindings.invalidPath}`,
        );
        return;
      }
      if (bindings.missing) {
        this.pendingWorkspaceManifests.set(body.snapshotId, { store, meta, body, inline });
        return;
      }
      this.pendingWorkspaceManifests.delete(body.snapshotId);
      snapshot.workspaceManifest = inline.manifest;
    }
    store.applySnapshot(snapshot);
    if (inline.docType !== 'workspace_manifest') {
      this.hydratedEntries.set(body.snapshotId, {
        fileId: body.fileId,
        path: body.ownerDisplayPath ?? '',
        kind: inline.docType,
        mediaType: inline.docType === 'asset' ? inline.mediaType : undefined,
        byteLength: snapshot.byteLength,
        contentHash: body.baseHash,
      });
      await this.retryPendingWorkspaceManifests();
      if (this.state.status === 'error') return;
    }
    // Assets/manifests are retained as inert metadata and never selected for rendering.
    if (inline.docType === 'markdown' || inline.docType === 'html') {
      store.setCurrentFile(body.fileId);
      store.setCurrentSnapshot(body.snapshotId);
    }
  }

  private workspaceManifestBindingStatus(
    entries: readonly WorkspaceManifestEntry[],
  ): { missing: boolean; invalidPath?: string } {
    let missing = false;
    for (const entry of entries) {
      const hydrated = this.hydratedEntries.get(entry.snapshotId);
      if (!hydrated) {
        missing = true;
        continue;
      }
      if (
        hydrated.fileId !== entry.fileId ||
        hydrated.path !== entry.path ||
        hydrated.kind !== entry.kind ||
        hydrated.byteLength !== entry.byteLength ||
        hydrated.contentHash !== entry.contentHash ||
        hydrated.mediaType !== entry.mediaType
      ) {
        return { missing, invalidPath: entry.path };
      }
    }
    return { missing };
  }

  private async retryPendingWorkspaceManifests(): Promise<void> {
    const pending = [...this.pendingWorkspaceManifests.values()].sort((left, right) =>
      left.meta.createdAt - right.meta.createdAt ||
      left.body.snapshotId.localeCompare(right.body.snapshotId),
    );
    for (const item of pending) {
      if (!this.pendingWorkspaceManifests.has(item.body.snapshotId)) continue;
      await this.hydrateSnapshot(item.store, item.meta, item.body, item.inline);
      if (this.state.status === 'error') return;
    }
  }

  private handleTerminal(err: WsTerminalError): void {
    let kind: BrowserSessionError['kind'];
    switch (err.kind) {
      case 'admission_rejected':
        kind = 'admission_rejected';
        break;
      case 'room_deleted':
        kind = 'room_deleted';
        break;
      case 'room_expired':
        kind = 'room_expired';
        break;
      case 'cursor_too_old':
        kind = 'cursor_too_old';
        break;
      default:
        kind = 'network';
    }
    if ((kind === 'room_deleted' || kind === 'room_expired') && this.storage && this.state.roomId) {
      void this.storage.forgetRoom(this.state.roomId).catch(() => undefined);
    }
    this.fail(kind, err.message);
  }

  private handleOutboxTerminal(err: BrowserOutboxError): void {
    const code = err.code.toUpperCase();
    if (code.includes('ADMISSION') || code.includes('UNAUTHORIZED')) {
      queueMicrotask(() => this.fail('admission_rejected', err.message));
      return;
    }
    if (code.includes('NOT_FOUND') || code.includes('DELETED')) {
      queueMicrotask(() => this.fail('room_deleted', err.message));
      return;
    }
    if (code.includes('EXPIRED')) {
      queueMicrotask(() => this.fail('room_expired', err.message));
      return;
    }
    this.setState({ authoringReady: false, authoringError: err.message });
  }
}

interface PendingSnapshot {
  store: ReviewStoreSink;
  meta: EventMeta;
  body: Extract<ReviewEventBody, { type: 'snapshot_created' }>;
}

interface PendingWorkspaceManifest extends PendingSnapshot {
  inline: Extract<SnapshotPlaintext, { docType: 'workspace_manifest' }>;
}

interface CachedSnapshotBlob {
  snapshot: SnapshotPlaintext;
  byteLength: number;
  contentHash: string;
}

/** Strict wire parser exported for native/browser protocol conformance tests. */
export function parseBrowserSnapshotPlaintext(bytes: Uint8Array): SnapshotPlaintext | null {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
  try {
    return validateSnapshotPlaintext(value);
  } catch {
    return null;
  }
}

interface HydratedEntryMetadata {
  fileId: string;
  path: string;
  kind: 'markdown' | 'html' | 'asset';
  mediaType?: string;
  byteLength: number;
  contentHash: string;
}

function canonicalValuesEqual(left: unknown, right: unknown): boolean {
  const leftBytes = toCanonicalBytes(left);
  const rightBytes = toCanonicalBytes(right);
  if (leftBytes.length !== rightBytes.length) return false;
  return leftBytes.every((byte, index) => byte === rightBytes[index]);
}

function parseR2BlobRefPlaintext(bytes: Uint8Array, envelopeId: string): boolean {
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
    candidate.storage === 'r2' &&
    candidate.blobId === envelopeId &&
    Number.isSafeInteger(candidate.byteLength) &&
    (candidate.byteLength as number) >= 0 &&
    typeof candidate.contentHash === 'string'
  );
}

function randomOpaqueId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

// Re-exports so the entry point and tests have one import location.
export type { Device, RoomPolicy };
// Suppress unused-export warning while the EventId import is referenced only
// for documentation of the shape we surface.
export type { EventId };
