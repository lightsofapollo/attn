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
//   3. Generate an in-memory `(deviceId, signingKeyPair, encryptionKeyPair)`.
//      No persistence whatsoever — reload requires re-paste.
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
//   - Snapshot R2 download. Mailbox snapshot blobs are rehydrated here; R2
//     references remain unavailable until the authenticated blob fetch lands.
//   - Reconnect cursor persistence. The WS client tracks `afterSeq` in
//     memory only — reload restarts at 0.
//
// Tests: `browser-session.test.ts`. Run with:
//
//   cd web && npx tsx src/lib/review/browser-session.test.ts

import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import {
  base64UrlEncode,
  buildAdmissionHeader,
  buildAdmissionSubprotocol,
  contentHash,
  deriveRoomId,
  deriveRoomKeys,
  toCanonicalBytes,
  type RoomKeys,
} from './browser-crypto';
import { assembleBrowserEvent } from './browser-envelope';
import {
  BrowserOutbox,
  type BrowserOutboxError,
  type BrowserOutboxOptions,
  type BrowserOutboxResponse,
} from './browser-outbox';
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
import type {
  AnchorIndex,
  Anchor,
  Capability,
  DocType,
  EventId,
  EventMeta,
  FileId,
  ReviewEvent,
  ReviewEventBody,
  ReviewSnapshot,
  SnapshotId,
  RoomId,
  SuggestionDraft,
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

/**
 * Reactive snapshot of the session that the UI can render off of. Pure plain
 * object — we wire it into a `$state` field at the component layer.
 */
export interface BrowserSessionState {
  status: BrowserSessionStatus;
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
  /** Number of sealed event envelopes waiting for relay acknowledgement. */
  outboxPending: number;
  /** Last authoring transport error. Reading remains available. */
  authoringError: string | null;
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
  /** Sealed browser envelopes awaiting relay acknowledgement. */
  pendingOutbox?: unknown[];
}

export interface BrowserSessionOptions {
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
  /** Relay base URL. Required before any network operation. */
  relayUrl?: string;
  /**
   * Override `fetch` for the `POST /devices` call. Tests inject a stub.
   * Receives the full URL + RequestInit shape (browser-compatible).
   */
  fetchImpl?: (url: string, init: FetchLikeInit) => Promise<FetchLikeResponse>;
  /** Override the WebSocket factory (used by tests with Node `ws`). */
  webSocketFactory?: (url: string, protocols: string | string[]) => WebSocketLike;
  /** Override reconnect timing — tests want fast retries. */
  reconnectInitialMs?: number;
  reconnectMaxMs?: number;
  /** Override the PoW token (tests skip the miner). */
  powToken?: string;
  /** Override registration PoW minting (tests assert authenticated policy use). */
  registrationMintPow?: BrowserOutboxOptions['mintPow'];
  /** Override browser outbox PoW minting independently from registration. */
  outboxMintPow?: BrowserOutboxOptions['mintPow'];
  /** Human-readable encrypted ParticipantJoined display name. */
  displayName?: string;
  /** Inject a pre-built identity (tests want deterministic keys). */
  identity?: BrowserDeviceIdentity;
  /** Optional state observer — called on every state mutation. */
  onState?: (state: BrowserSessionState) => void;
  /**
   * Sink for review-event / snapshot dispatch. Defaults to the global
   * `reviewStore` runes singleton; tests pass a plain object so they can
   * run under tsx without loading `.svelte.ts` modules.
   */
  store?: ReviewStoreSink;
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

// ---------------------------------------------------------------------------
// POST /devices body — mirror of `bootstrap.rs::RegisterDeviceBody`.
// ---------------------------------------------------------------------------

interface RegisterDeviceBody {
  deviceId: string;
  participantId: string;
  publicSigningKey: string;
  publicEncryptionKey: string;
  client: 'attn-browser';
  kind: 'reviewer';
  selfSignature: string;
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
  };
  return toCanonicalBytes(unsigned);
}

/**
 * Build the `POST /v2/rooms/:roomId/devices` body, signing `selfSignature`
 * over the unsigned canonical form.
 */
export function buildRegisterDeviceBody(
  identity: BrowserDeviceIdentity,
): RegisterDeviceBody {
  const body: RegisterDeviceBody = {
    deviceId: identity.deviceId,
    participantId: identity.participantId,
    publicSigningKey: base64UrlEncode(identity.signingPublic),
    publicEncryptionKey: base64UrlEncode(identity.publicEncryptionKey),
    client: 'attn-browser',
    kind: 'reviewer',
    selfSignature: '',
  };
  const canonical = canonicalRegisterDeviceBytes(body);
  const sig = ed25519.sign(canonical, identity.signingSecret);
  body.selfSignature = base64UrlEncode(sig);
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
    status: 'idle',
    roomId: null,
    snapshotContent: null,
    snapshotDocType: 'markdown',
    snapshotId: null,
    fileId: null,
    error: null,
    authoringReady: false,
    outboxPending: 0,
    authoringError: null,
  };
  private identity: BrowserDeviceIdentity | null = null;
  private wsClient: BrowserWsClient | null = null;
  private keys: RoomKeys | null = null;
  private store: ReviewStoreSink | null;
  private powAbortController: AbortController | null = null;
  private outbox: BrowserOutbox | null = null;
  private joinEnvelopeId: string | null = null;
  private lastCreatedAt = 0;
  private roomPolicy: RoomPolicy | null = null;
  private bootstrapDevices: Device[] = [];
  private readonly snapshotBlobs = new Map<string, CachedSnapshotBlob>();
  private readonly invalidSnapshotBlobIds = new Set<string>();
  private readonly pendingSnapshots = new Map<string, PendingSnapshot[]>();
  private readonly signerRefreshAttempts = new Set<string>();
  private readonly pagehideTarget: BrowserWindowLike | null;
  private readonly pagehideHandler = (): void => this.close();

  constructor(opts: BrowserSessionOptions = {}) {
    this.opts = opts;
    this.store = opts.store ?? null;
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

  /** Current state snapshot — UI binds against this. */
  getState(): BrowserSessionState {
    return this.state;
  }

  async createComment(anchor: Anchor, body: string, threadId?: string): Promise<ReviewEvent> {
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
    if (threadId.length === 0) throw new Error('threadId cannot be empty');
    const identity = this.requireIdentity();
    return this.authorEvent({
      type: 'comment_resolved',
      threadId,
      resolvedBy: identity.participantId,
    });
  }

  async createSuggestion(draft: SuggestionDraft): Promise<ReviewEvent> {
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

  /**
   * Bring the session up. Returns when the WS is in `connected` state OR a
   * terminal error has been emitted. The state observer is called along the
   * way so the UI can render `Loading review…` / error states.
   */
  async start(): Promise<void> {
    if (this.state.status !== 'idle') return;
    this.setState({ status: 'parsing_invite' });

    // 1. Parse the invite (override > location.hash).
    let invite: ParsedInvite;
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
        if (!parsed) {
          this.fail('invite_invalid', 'no invite fragment in URL');
          return;
        }
        invite = parsed;
      }
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      this.fail('invite_invalid', m);
      return;
    }

    // 2. Derive keys and roomId. The derived `roomId` MUST match the
    //    invite's `roomId` — if it doesn't the URL is corrupted.
    let roomKeys: RoomKeys;
    let derivedRoomId: string;
    try {
      roomKeys = deriveRoomKeys(invite.roomSecret);
      derivedRoomId = deriveRoomId(invite.roomSecret);
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      this.fail('invite_invalid', `key derivation: ${m}`);
      zero(invite.roomSecret);
      return;
    }
    if (derivedRoomId !== invite.roomId) {
      this.fail(
        'invite_invalid',
        `roomId mismatch: derived ${derivedRoomId} vs invite ${invite.roomId}`,
      );
      zero(invite.roomSecret);
      return;
    }
    // Clobber the raw secret — only the subkeys are needed from here on.
    zero(invite.roomSecret);
    this.keys = roomKeys;
    this.setState({ roomId: invite.roomId });
    const store = await this.ensureStore();
    store.currentRoomId = invite.roomId;

    // 3. Identity (injected or freshly generated).
    this.identity = this.opts.identity ?? generateBrowserIdentity();

    // 4. Fetch the authenticated policy before mining registration PoW. Room
    // policy may require more than the protocol floor of 12 bits.
    this.setState({ status: 'registering_device' });
    try {
      const bootstrap = await this.fetchRoomBootstrap(invite.roomId, roomKeys);
      this.roomPolicy = bootstrap.policy;
      this.bootstrapDevices = bootstrap.devices;
      await this.registerDevice(invite.roomId, roomKeys, bootstrap.policy.powBits);
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

  /** Tear down transports and clobber in-memory keys. Safe to call repeatedly. */
  close(): void {
    this.detachPagehide();
    this.stopTransport();
    this.releaseSensitiveState();
    this.snapshotBlobs.clear();
    this.invalidSnapshotBlobIds.clear();
    this.pendingSnapshots.clear();
    this.signerRefreshAttempts.clear();
    this.clearStorePlaintext();
    this.setState({
      status: 'terminated',
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
    this.state = { ...this.state, ...patch };
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
    outbox.enqueue(assembled.envelope);
    const store = await this.ensureStore();
    store.applyEvent(assembled.event);
    void outbox.flushNow().catch(() => undefined);
    return assembled.event;
  }

  private async initializeAuthoring(policy: RoomPolicy): Promise<void> {
    this.roomPolicy = policy;
    if (this.outbox) {
      try {
        this.outbox.updatePolicy({
          powBits: policy.powBits,
          maxEventBytes: policy.maxEventBytes,
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
    if (!keys || !identity || !roomId || policy.expiresAt <= Date.now()) {
      this.setState({ authoringError: 'This review room is no longer writable.' });
      return;
    }
    const relayUrl = validateBrowserRelayUrl(this.opts.relayUrl);
    const mintPow =
      this.opts.outboxMintPow ??
      (this.opts.powToken === undefined ? undefined : async () => this.opts.powToken!);
    this.outbox = new BrowserOutbox({
      relayUrl,
      roomId,
      deviceId: identity.deviceId,
      admissionKey: keys.admissionKey,
      powBits: policy.powBits,
      maxEventBytes: policy.maxEventBytes,
      fetchImpl: async (url, init): Promise<BrowserOutboxResponse> =>
        this.fetchImpl()(url, init),
      ...(mintPow === undefined ? {} : { mintPow }),
      onlineTarget: this.pagehideTarget ?? undefined,
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
    });

    const createdAt = this.nextCreatedAt();
    const capabilities: Capability[] = [
      'read_snapshot',
      'write_comment',
      'write_suggestion',
      'resolve_comment',
    ];
    const joined: ReviewEventBody = {
      type: 'participant_joined',
      participant: {
        participantId: identity.participantId,
        displayName: this.opts.displayName?.trim() || 'Browser reviewer',
        kind: 'reviewer',
        publicSigningKey: base64UrlEncode(identity.signingPublic),
        capabilities,
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
    this.outbox.enqueue(assembled.envelope);
    const store = await this.ensureStore();
    store.applyEvent(assembled.event);
    void this.outbox.flushNow().catch(() => undefined);
  }

  private fail(kind: BrowserSessionError['kind'], message: string): void {
    this.detachPagehide();
    this.stopTransport();
    this.releaseSensitiveState();
    this.snapshotBlobs.clear();
    this.invalidSnapshotBlobIds.clear();
    this.pendingSnapshots.clear();
    this.signerRefreshAttempts.clear();
    this.clearStorePlaintext();
    this.setState({
      status: 'error',
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
    this.outbox?.close();
    this.outbox = null;
    this.joinEnvelopeId = null;
    this.roomPolicy = null;
    this.bootstrapDevices = [];
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
    if (this.keys) {
      zero(this.keys.rootKey);
      zero(this.keys.eventKey);
      zero(this.keys.snapshotKey);
      zero(this.keys.signalingKey);
      zero(this.keys.admissionKey);
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
    keys: RoomKeys,
  ): Promise<{ policy: RoomPolicy; devices: Device[] }> {
    const path = `/v2/rooms/${roomId}/devices`;
    const relay = validateBrowserRelayUrl(this.opts.relayUrl);
    const admission = admissionHeaderValue(keys.admissionKey, 'GET', path, new Uint8Array());
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
    if (!Number.isInteger(parsed.policy.powBits) || parsed.policy.powBits < 12 || parsed.policy.powBits > 24) {
      throw new Error('GET /devices returned invalid policy powBits');
    }
    return { policy: parsed.policy, devices: parsed.devices };
  }

  private async registerDevice(roomId: string, keys: RoomKeys, powBits: number): Promise<void> {
    if (!this.identity) throw new Error('identity missing');
    const body = buildRegisterDeviceBody(this.identity);
    const bodyJson = JSON.stringify(body);
    const bodyBytes = new TextEncoder().encode(bodyJson);
    const path = `/v2/rooms/${roomId}/devices`;
    const admission = admissionHeaderValue(keys.admissionKey, 'POST', path, bodyBytes);
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

  private openWs(roomId: string, keys: RoomKeys): void {
    if (!this.identity) throw new Error('identity missing');
    const relay = validateBrowserRelayUrl(this.opts.relayUrl);
    const url = buildWsUrl(relay, roomId, this.identity.deviceId);
    const path = socketPath(roomId);
    // The WS handshake admission HMAC is over METHOD=GET, path, empty body —
    // exactly what `buildAdmissionSubprotocol` produces (the `Sec-WebSocket-
    // Protocol` value carries it; browsers can't set custom headers on a WS
    // upgrade).
    const subprotocol = buildAdmissionSubprotocol(keys.admissionKey, 'GET', path, [
      ['device_id', this.identity.deviceId],
    ]);
    this.wsClient = new BrowserWsClient({
      roomId,
      url,
      subprotocol,
      afterSeq: 0,
      eventKey: keys.eventKey,
      snapshotKey: keys.snapshotKey,
      signalingKey: keys.signalingKey,
      initialDevices: new Map(
        this.bootstrapDevices.map((device, index) => [`bootstrap-${index}`, device]),
      ),
      webSocketFactory: this.opts.webSocketFactory,
      reconnectInitialMs: this.opts.reconnectInitialMs,
      reconnectMaxMs: this.opts.reconnectMaxMs,
      callbacks: {
        onHello: (frame) => {
          this.setState({ status: 'connected' });
          void this.initializeAuthoring(frame.policy);
        },
        onEnvelope: (decoded) => this.handleEnvelope(decoded),
        onUnknownSigner: (envelope, serverSeq) => {
          void this.refreshSignerAndRetry(roomId, keys, envelope, serverSeq);
        },
        onTerminal: (err) => this.handleTerminal(err),
        onError: (_code, _msg) => {
          // Non-fatal — keep status as-is. Could surface as a toast later.
        },
        onPolicyChanged: (policy) => {
          this.roomPolicy = policy;
          void this.initializeAuthoring(policy);
        },
      },
    });
    this.wsClient.start();
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
    keys: RoomKeys,
    envelope: MailboxEnvelope,
    serverSeq: number,
  ): Promise<void> {
    if (this.signerRefreshAttempts.has(envelope.envelopeId)) {
      if (this.state.snapshotContent === null) {
        this.fail('network', 'Could not verify the snapshot signer');
      }
      return;
    }
    this.signerRefreshAttempts.add(envelope.envelopeId);
    try {
      const path = `/v2/rooms/${roomId}/devices`;
      const relay = validateBrowserRelayUrl(this.opts.relayUrl);
      const admission = admissionHeaderValue(keys.admissionKey, 'GET', path, new Uint8Array());
      const response = await this.fetchImpl()(`${relay}${path}`, {
        method: 'GET',
        headers: { 'Attn-Admission': admission },
      });
      const raw = await response.text();
      if (response.status !== 200) throw new Error(`GET /devices failed: ${response.status}`);
      const parsed = JSON.parse(raw) as { devices?: Device[] };
      if (!Array.isArray(parsed.devices)) throw new Error('GET /devices returned invalid body');
      this.wsClient?.mergeDevices(parsed.devices);
      this.wsClient?.retryEnvelope(envelope, serverSeq);
    } catch {
      if (this.state.snapshotContent === null) {
        this.fail('network', 'Could not refresh participant signing keys');
      }
    }
  }

  private handleEnvelope(decoded: DecodedEnvelope): void {
    void this.handleEnvelopeAsync(decoded);
  }

  private async handleEnvelopeAsync(decoded: DecodedEnvelope): Promise<void> {
    const { envelope, plaintext } = decoded;
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
      const store = await this.ensureStore();
      // Snapshot path — surface markdown for the editor + populate
      // reviewStore.snapshots so the existing UI can scope by snapshot.
      if (body.type === 'snapshot_created') {
        this.absorbSnapshotCreated(store, meta as EventMeta, body);
        if (this.state.status === 'error') return;
      }
      store.applyEvent(event);
      return;
    }
    if (envelope.kind === 'snapshot_blob') {
      // Native bootstrap enqueues mailbox bytes before the pointer event, but
      // cache + pending queues make the receiver defensive to either order.
      const blobId = envelope.envelopeId;
      const waiting = this.pendingSnapshots.get(blobId);
      const snapshot = parseSnapshotPlaintext(plaintext);
      const cached = snapshot
        ? {
            snapshot,
            byteLength: plaintext.length,
            contentHash: contentHash(plaintext),
          }
        : null;
      zero(plaintext);
      if (!cached) {
        this.invalidSnapshotBlobIds.add(blobId);
        if (waiting && waiting.length > 0) {
          this.fail('network', 'Snapshot payload failed integrity validation');
        }
        return; // R2 wrappers contain a BlobRef, not plaintext.
      }
      if (!waiting || waiting.length === 0) {
        this.snapshotBlobs.set(blobId, cached);
        return;
      }
      this.pendingSnapshots.delete(blobId);
      for (const pending of waiting) {
        this.hydrateSnapshotBlob(pending.store, pending.meta, pending.body, cached);
      }
      return;
    }
    // Signal envelopes are out of scope for the browser reviewer surface.
  }

  private absorbSnapshotCreated(
    store: ReviewStoreSink,
    meta: EventMeta,
    body: Extract<ReviewEventBody, { type: 'snapshot_created' }>,
  ): void {
    if (body.inlineSnapshot) {
      this.hydrateSnapshot(store, meta, body, body.inlineSnapshot);
      return;
    }
    const blobRef = body.encryptedBlobRef;
    if (!blobRef || blobRef.storage !== 'mailbox') return;
    if (this.invalidSnapshotBlobIds.delete(blobRef.blobId)) {
      this.fail('network', 'Snapshot payload failed integrity validation');
      return;
    }
    const cached = this.snapshotBlobs.get(blobRef.blobId);
    if (cached) {
      this.snapshotBlobs.delete(blobRef.blobId);
      this.hydrateSnapshotBlob(store, meta, body, cached);
      return;
    }
    const waiting = this.pendingSnapshots.get(blobRef.blobId) ?? [];
    if (!waiting.some((pending) => pending.body.snapshotId === body.snapshotId)) {
      waiting.push({ store, meta, body });
      this.pendingSnapshots.set(blobRef.blobId, waiting);
    }
  }

  private hydrateSnapshotBlob(
    store: ReviewStoreSink,
    meta: EventMeta,
    body: Extract<ReviewEventBody, { type: 'snapshot_created' }>,
    cached: CachedSnapshotBlob,
  ): void {
    const blobRef = body.encryptedBlobRef;
    if (
      !blobRef ||
      blobRef.storage !== 'mailbox' ||
      blobRef.byteLength !== cached.byteLength ||
      blobRef.contentHash !== cached.contentHash
    ) {
      this.fail('network', 'Snapshot payload does not match its signed reference');
      return;
    }
    this.hydrateSnapshot(store, meta, body, cached.snapshot);
  }

  private hydrateSnapshot(
    store: ReviewStoreSink,
    meta: EventMeta,
    body: Extract<ReviewEventBody, { type: 'snapshot_created' }>,
    inline: SnapshotPlaintext,
  ): void {
    this.setState({
      snapshotContent: inline.content,
      snapshotDocType: inline.docType,
      snapshotId: body.snapshotId,
      fileId: body.fileId,
    });
    // Mirror the snapshot into the reviewStore so the existing UI can
    // scope-by-snapshot.
    const snapshot: ReviewSnapshot = {
      roomId: meta.roomId,
      fileId: body.fileId,
      snapshotId: body.snapshotId,
      parentSnapshotId: body.parentSnapshotId,
      createdAt: meta.createdAt,
      createdBy: meta.authorId,
      baseHash: body.baseHash,
      byteLength: new TextEncoder().encode(inline.content).length,
      docType: inline.docType,
      content: inline.content,
      anchorIndex: inline.anchorIndex,
      encryptedBlobRef: body.encryptedBlobRef,
    };
    store.applySnapshot(snapshot);
    store.setCurrentFile(body.fileId);
    store.setCurrentSnapshot(body.snapshotId);
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

interface SnapshotPlaintext {
  docType: DocType;
  content: string;
  anchorIndex?: AnchorIndex;
}

interface PendingSnapshot {
  store: ReviewStoreSink;
  meta: EventMeta;
  body: Extract<ReviewEventBody, { type: 'snapshot_created' }>;
}

interface CachedSnapshotBlob {
  snapshot: SnapshotPlaintext;
  byteLength: number;
  contentHash: string;
}

function parseSnapshotPlaintext(bytes: Uint8Array): SnapshotPlaintext | null {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as { docType?: unknown; content?: unknown; anchorIndex?: unknown };
  if (candidate.docType !== 'markdown' && candidate.docType !== 'html') return null;
  if (typeof candidate.content !== 'string') return null;
  if (
    candidate.anchorIndex !== undefined &&
    (typeof candidate.anchorIndex !== 'object' || candidate.anchorIndex === null)
  ) {
    return null;
  }
  return {
    docType: candidate.docType,
    content: candidate.content,
    ...(candidate.anchorIndex === undefined
      ? {}
      : { anchorIndex: candidate.anchorIndex as AnchorIndex }),
  };
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
