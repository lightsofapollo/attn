// Browser-side WebSocket client for the Phase 6 hosted review client.
//
// Mirrors the Rust client in `src/review/transport/mailbox/ws.rs`. We open a
// WebSocket to `wss://<relay>/v2/rooms/<roomId>/socket?device_id=<deviceId>`
// with the admission HMAC carried in `Sec-WebSocket-Protocol` (the browser
// can't set custom headers on a WS handshake — see relay-spec.md §WebSocket
// Protocol).
//
// What this module DOES:
//   - Connect with admission subprotocol.
//   - Maintain a `devices` cache populated from the `hello` frame so signature
//     verification has the public signing keys it needs.
//   - On `envelope` frames: aeadOpen + verifyEventSignature + dispatch a
//     decoded payload to `onEnvelope`. The decrypt/verify happens here so the
//     UI consumer never sees ciphertext or invalid signatures.
//   - Exponential backoff reconnect on 1xxx / transient drops.
//   - Map close codes 4000-4005 to typed errors via `onTerminal`.
//
// What this module does NOT do:
//   - Sign outbound events (lives in attn-nnj.9.4 with PoW).
//   - Persist cursors. Caller passes in the starting `after` seq.
//   - Snapshot R2 download. Snapshot blobs surface via `onEnvelope` and the
//     caller decides what to do.
//
// Run the tests with:
//
//   cd web && npx tsx src/lib/review/browser-ws.test.ts

import { ed25519 } from '@noble/curves/ed25519.js';
import {
  AeadError,
  SignatureError,
  aeadOpen,
  base64UrlDecode,
  decodePublicSigningKey,
  deriveEventId,
  signingKeyId,
  toCanonicalBytes,
  verifyEventSignature,
  type EnvelopeAad,
  type SignableMetaShape,
} from './browser-crypto';
import { validateSignalTarget } from './browser-signaling';

// ---------------------------------------------------------------------------
// Wire types (mirror `ws.rs::ServerFrame` / `ClientFrame` and
// `model.rs::MailboxEnvelope` / `RoomPolicy` / `Device`).
// ---------------------------------------------------------------------------

export type EnvelopeKind = 'event' | 'snapshot_blob' | 'signal';

export interface MailboxEnvelope {
  /**
   * The relay omits protocol version and room id because both are implicit in
   * the v2 room subscription. Test fixtures and direct callers may still
   * provide them, so keep the fields as optional wire metadata.
   */
  v?: number;
  roomId?: string;
  envelopeId: string;
  serverSeq?: number;
  authorId: string;
  deviceId: string;
  createdAt: number;
  expiresAt: number;
  kind: EnvelopeKind;
  /** Relay-normalized broadcast envelopes use an explicit null target. */
  target?: { deviceId: string } | null;
  /** base64url-no-pad. */
  nonce: string;
  /** base64url-no-pad of `ciphertext || 16-byte Poly1305 tag`. */
  ciphertext: string;
  ciphertextBytes: number;
}

export interface RoomPolicy {
  mode: 'live' | 'async' | 'hybrid';
  maxPeers: number;
  maxSnapshotBytes: number;
  maxEventBytes: number;
  maxEvents: number;
  expiresAt: number;
  powBits: number;
  deleteEventsAfterOwnerAck: boolean;
  allowBrowser: boolean;
  allowRemoteAgents: boolean;
}

export interface Device {
  deviceId: string;
  participantId: string;
  publicEncryptionKey: string;
  publicSigningKey: string;
  client: 'attn-native' | 'attn-browser' | 'agent-cli';
  kind: 'owner' | 'reviewer' | 'agent';
  selfSignature: string;
  registeredAt?: number;
  createdAt?: number;
}

export type ServerFrame =
  | {
      type: 'hello';
      serverSeq: number;
      policy: RoomPolicy;
      devices: Device[];
      onlineDeviceIds?: string[];
      missedSignalEnvelopeIds?: string[];
    }
  | {
      type: 'envelope';
      envelope: MailboxEnvelope;
      serverSeq: number;
    }
  | {
      type: 'presence';
      event: 'join' | 'leave';
      deviceId: string;
      participantId: string;
    }
  | { type: 'policy_changed'; policy: RoomPolicy }
  | { type: 'ping'; ts: number }
  | { type: 'error'; code: string; message?: string; resyncFromSeq?: number };

export type ClientFrame =
  | { type: 'subscribe'; after: number }
  | { type: 'pong'; ts: number };

// ---------------------------------------------------------------------------
// Close codes (mirror `ws.rs::close_codes`).
// ---------------------------------------------------------------------------

export const CLOSE_NORMAL = 1000;
export const CLOSE_ADMISSION_INVALID = 4000;
export const CLOSE_ROOM_DELETED = 4001;
export const CLOSE_ROOM_EXPIRED = 4002;
export const CLOSE_RATE_LIMIT = 4003;
export const CLOSE_PEER_CAP = 4004;
export const CLOSE_CURSOR_TOO_OLD = 4005;

// ---------------------------------------------------------------------------
// Reconnect tuning (mirror `ws.rs` RECONNECT_INITIAL_MS / RECONNECT_MAX_MS).
// ---------------------------------------------------------------------------

export const RECONNECT_INITIAL_MS = 1_000;
export const RECONNECT_MAX_MS = 60_000;

// ---------------------------------------------------------------------------
// Typed errors.
// ---------------------------------------------------------------------------

export type WsTerminalErrorKind =
  | 'admission_rejected'
  | 'room_deleted'
  | 'room_expired'
  | 'cursor_too_old';

export class WsTerminalError extends Error {
  readonly kind: WsTerminalErrorKind;
  readonly closeCode: number;
  readonly resyncFromSeq?: number;
  constructor(kind: WsTerminalErrorKind, closeCode: number, message: string, resyncFromSeq?: number) {
    super(message);
    this.name = 'WsTerminalError';
    this.kind = kind;
    this.closeCode = closeCode;
    if (resyncFromSeq !== undefined) this.resyncFromSeq = resyncFromSeq;
  }
}

// ---------------------------------------------------------------------------
// Decoded envelope payload pushed to the consumer.
// ---------------------------------------------------------------------------

export interface DecodedEnvelope {
  envelope: MailboxEnvelope;
  serverSeq: number;
  /** Network delivery advances the cursor after commit; replay never does. */
  source: 'network' | 'replay' | 'direct';
  /** Plaintext bytes recovered from `aeadOpen`. */
  plaintext: Uint8Array;
}

// ---------------------------------------------------------------------------
// Client options.
// ---------------------------------------------------------------------------

export interface BrowserWsCallbacks {
  /** Called once per successful connect on the `hello` frame. */
  onHello?: (
    frame: Extract<ServerFrame, { type: 'hello' }>,
    devices: Map<string, Device>,
  ) => void;
  /**
   * Called with each decrypted+verified envelope. The implementation is
   * responsible for routing on `envelope.kind` (event / snapshot_blob /
   * signal). Skipped envelopes (decrypt fail, signature fail, unknown signer)
   * surface via `onError` instead.
   */
  onEnvelope?: (decoded: DecodedEnvelope) => void | Promise<void>;
  /** Allows the session to refresh GET /devices and retry an unknown signer. */
  onUnknownSigner?: (
    envelope: MailboxEnvelope,
    serverSeq: number,
    signingKeyId: string,
  ) => void | Promise<void>;
  /** Called when the relay or our parser surfaces a non-terminal error. */
  onError?: (code: string, message: string) => void;
  /** Called on every socket close — terminal or transient. */
  onClose?: (closeCode: number, reason: string) => void;
  /** Called on terminal close codes (4000/4001/4002 + cursor-too-old). */
  onTerminal?: (err: WsTerminalError) => void;
  /** Called with presence join/leave frames. */
  onPresence?: (event: 'join' | 'leave', deviceId: string, participantId: string) => void;
  /** Called on policy_changed frames (rare, but tracked). */
  onPolicyChanged?: (policy: RoomPolicy) => void;
}

export interface BrowserWsOptions {
  /** Room bound to this subscription; restores relay-implicit AAD metadata. */
  roomId: string;
  /** Local device identity used for pre-decrypt signal anti-redirect checks. */
  localDeviceId: string;
  /** Full WS URL including scheme (`wss://…/v2/rooms/<roomId>/socket?…`). */
  url: string;
  /** Admission subprotocol value (`"attn.v2, hmac.<…>"`). */
  subprotocol: string;
  /** Starting sequence the client subscribes from (load from local cursor). */
  afterSeq: number;
  /** 32-byte AEAD key for `kind:"event"` envelopes. */
  eventKey: Uint8Array;
  /** 32-byte AEAD key for `kind:"snapshot_blob"` envelopes. */
  snapshotKey: Uint8Array;
  /** 32-byte AEAD key for `kind:"signal"` envelopes. */
  signalingKey: Uint8Array;
  /** Pre-seeded device cache (e.g. from a prior session). Empty Map by default. */
  initialDevices?: Map<string, Device>;
  /** Callback bundle. */
  callbacks?: BrowserWsCallbacks;
  /**
   * Optional WebSocket factory — tests inject a Node `WebSocket` impl. In a
   * browser, leave undefined and we use the global `WebSocket` constructor.
   */
  webSocketFactory?: (url: string, protocols: string | string[]) => WebSocketLike;
  /** Override initial reconnect delay (ms) — tests use this to keep fast. */
  reconnectInitialMs?: number;
  /** Override max reconnect delay (ms). */
  reconnectMaxMs?: number;
}

// ---------------------------------------------------------------------------
// Minimal WebSocket interface — narrow enough that we can drop in the
// `ws` package's WebSocket in Node tests and the browser `WebSocket` in
// production without an adapter shim.
// ---------------------------------------------------------------------------

export interface WebSocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

// ---------------------------------------------------------------------------
// BrowserWsClient.
// ---------------------------------------------------------------------------

/**
 * Connection state for inspection in tests.
 */
export type BrowserWsState = 'idle' | 'connecting' | 'open' | 'closing' | 'closed' | 'terminated';

export class BrowserWsClient {
  private readonly opts: BrowserWsOptions;
  private readonly callbacks: BrowserWsCallbacks;
  private readonly initialMs: number;
  private readonly maxMs: number;
  private readonly factory: (url: string, protocols: string | string[]) => WebSocketLike;

  // Mutable state.
  private socket: WebSocketLike | null = null;
  private state: BrowserWsState = 'idle';
  private backoffMs: number;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private cancelled = false;
  private afterSeq: number;
  /** Map keyed by `signingKeyId(publicSigningKey)` → Device. */
  private readonly devices: Map<string, Device>;
  private readonly deviceKeyIds = new Map<string, string>();
  private readonly attestedSigners = new Set<string>();
  /** Serial import boundary: ciphertext commit + UI dispatch stay serverSeq ordered. */
  private inboundQueue: Promise<void> = Promise.resolve();
  private inboundBlocked = false;

  constructor(opts: BrowserWsOptions) {
    if (opts.roomId.length === 0) throw new Error('roomId must not be empty');
    if (opts.localDeviceId.length === 0) throw new Error('localDeviceId must not be empty');
    if (opts.eventKey.length !== 32) throw new Error('eventKey must be 32 bytes');
    if (opts.snapshotKey.length !== 32) throw new Error('snapshotKey must be 32 bytes');
    if (opts.signalingKey.length !== 32) throw new Error('signalingKey must be 32 bytes');
    this.opts = opts;
    this.callbacks = opts.callbacks ?? {};
    this.initialMs = opts.reconnectInitialMs ?? RECONNECT_INITIAL_MS;
    this.maxMs = opts.reconnectMaxMs ?? RECONNECT_MAX_MS;
    this.backoffMs = this.initialMs;
    this.afterSeq = opts.afterSeq;
    this.devices = new Map();
    this.factory =
      opts.webSocketFactory ??
      ((url, protocols) => {
        // Use the browser-global WebSocket. Node 22+/browsers both expose
        // this constructor with the standard `(url, protocols)` shape.
        return new (globalThis as unknown as {
          WebSocket: new (url: string, protocols: string | string[]) => WebSocketLike;
        }).WebSocket(url, protocols);
      });
    if (opts.initialDevices) this.ingestDevices([...opts.initialDevices.values()]);
  }

  /** Current connection state — useful for tests and UI status. */
  getState(): BrowserWsState {
    return this.state;
  }

  /** Cached device records keyed by signingKeyId. */
  getDevices(): ReadonlyMap<string, Device> {
    return this.devices;
  }

  /** Last network sequence whose consumer commit completed successfully. */
  getAfterSeq(): number {
    return this.afterSeq;
  }

  /** Merge an authenticated GET /devices response into the signer cache. */
  mergeDevices(devices: Device[]): void {
    this.ingestDevices(devices);
  }

  /** Retry a previously rejected ciphertext after its signer directory refresh. */
  retryEnvelope(envelope: MailboxEnvelope, serverSeq: number): void {
    if (this.cancelled) return;
    this.enqueueEnvelope(envelope, serverSeq, 'network');
  }

  /**
   * Rebuild UI/auth state from a previously committed sealed envelope.
   * Replays pass through the exact decrypt/signature/authorization pipeline,
   * but never raise the subscription cursor above the separately persisted
   * contiguous cursor floor.
   */
  replayEnvelope(envelope: MailboxEnvelope, serverSeq: number): Promise<void> {
    if (this.cancelled) throw new Error('client already closed');
    const run = this.inboundQueue.then(() => this.ingestEnvelope(envelope, serverSeq, 'replay'));
    this.inboundQueue = run.catch(() => undefined);
    return run;
  }

  /**
   * Verify/decrypt an exact encrypted envelope received over the bound
   * DataChannel. It shares this client's signer cache and serialized inbound
   * boundary, but never advances the relay cursor.
   */
  ingestDirectEnvelope(envelope: MailboxEnvelope): Promise<void> {
    if (this.cancelled) throw new Error('client already closed');
    const run = this.inboundQueue.then(() => this.ingestEnvelope(envelope, 0, 'direct'));
    this.inboundQueue = run.catch(() => undefined);
    return run;
  }

  /** Start the connection loop. Idempotent; safe to call once. */
  start(): void {
    if (this.cancelled) throw new Error('client already closed');
    if (this.state !== 'idle') return;
    this.openOnce();
  }

  /**
   * Close the connection and stop reconnecting. The client cannot be reused
   * after `close()` — create a new one.
   */
  close(code: number = CLOSE_NORMAL, reason = 'client close'): void {
    this.cancelled = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.state = 'terminated';
    try {
      this.socket?.close(code, reason);
    } catch {
      // ignore — connection may already be torn down.
    }
    this.socket = null;
  }

  private openOnce(): void {
    if (this.cancelled) return;
    this.state = 'connecting';
    let ws: WebSocketLike;
    try {
      // Per relay-spec §WebSocket Protocol the subprotocol VALUE looks like
      // `"attn.v2, hmac.<base64url>"` and the server expects to see two
      // tokens. The WebSocket constructor accepts a list of protocol
      // strings; we split on comma so the browser sends the header per
      // RFC 6455 §4.1 (comma-separated values).
      const protocols = this.opts.subprotocol.split(',').map((p) => p.trim()).filter((p) => p.length > 0);
      ws = this.factory(this.opts.url, protocols);
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      this.scheduleReconnect(`ws constructor: ${m}`);
      return;
    }
    this.socket = ws;
    ws.onopen = () => this.handleOpen();
    ws.onmessage = (ev) => this.handleMessage(ev.data);
    ws.onclose = (ev) => this.handleClose(ev.code, ev.reason);
    ws.onerror = () => {
      // Browsers don't expose useful error detail. We rely on the close
      // event to drive reconnect; emit a non-terminal error for telemetry.
      this.callbacks.onError?.('ATTN_WS_ERROR', 'socket error');
    };
  }

  private handleOpen(): void {
    this.state = 'open';
    // Send subscribe { after: lastSeenSeq }.
    const frame: ClientFrame = { type: 'subscribe', after: this.afterSeq };
    try {
      this.socket?.send(JSON.stringify(frame));
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      this.callbacks.onError?.('ATTN_WS_SEND', `send subscribe: ${m}`);
      // The close handler will fire shortly; reconnect path takes over.
    }
  }

  private handleMessage(data: unknown): void {
    if (typeof data !== 'string') {
      // Binary frames are reserved per spec — drop quietly.
      this.callbacks.onError?.('ATTN_WS_BINARY', 'binary frame received (reserved)');
      return;
    }
    let frame: ServerFrame;
    try {
      frame = JSON.parse(data) as ServerFrame;
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      this.callbacks.onError?.('ATTN_WS_DECODE', `decode frame: ${m}`);
      return;
    }
    this.routeFrame(frame);
  }

  private routeFrame(frame: ServerFrame): void {
    switch (frame.type) {
      case 'hello':
        this.ingestDevices(frame.devices);
        this.callbacks.onHello?.(frame, this.devices);
        return;
      case 'envelope':
        this.enqueueEnvelope(frame.envelope, frame.serverSeq, 'network');
        return;
      case 'presence':
        this.callbacks.onPresence?.(frame.event, frame.deviceId, frame.participantId);
        return;
      case 'policy_changed':
        this.callbacks.onPolicyChanged?.(frame.policy);
        return;
      case 'ping': {
        // Reply with `pong { ts }` so the server keeps hibernation reset.
        const pong: ClientFrame = { type: 'pong', ts: frame.ts };
        try {
          this.socket?.send(JSON.stringify(pong));
        } catch {
          // Drop — close path will retry.
        }
        return;
      }
      case 'error': {
        const message = frame.message ?? '';
        this.callbacks.onError?.(frame.code, message);
        if (frame.code === 'ATTN_CURSOR_TOO_OLD') {
          // The relay follows with close 4005; we don't wait — initiate the
          // disconnect ourselves so the consumer maps it to CursorTooOld
          // immediately. Tracked via the close path so onTerminal still fires.
          this.cancelled = true;
          this.state = 'terminated';
          const err = new WsTerminalError(
            'cursor_too_old',
            CLOSE_CURSOR_TOO_OLD,
            `cursor too old (resyncFromSeq=${frame.resyncFromSeq ?? 0})`,
            frame.resyncFromSeq ?? 0,
          );
          this.callbacks.onTerminal?.(err);
          try {
            this.socket?.close(CLOSE_CURSOR_TOO_OLD, 'cursor too old');
          } catch {
            // ignore
          }
        }
        return;
      }
    }
  }

  /**
   * Merge a hello-frame device list into the cache, keyed by signingKeyId so
   * subsequent signature verification is O(1) by key id.
   */
  private ingestDevices(list: Device[]): void {
    for (const d of list) {
      try {
        const pk = decodePublicSigningKey(d.publicSigningKey);
        const signature = base64UrlDecode(d.selfSignature);
        if (signature.length !== 64 || !ed25519.verify(signature, registrationBytes(d), pk)) {
          throw new Error('selfSignature does not match the registered device');
        }
        const kid = signingKeyId(pk);
        const boundKeyId = this.deviceKeyIds.get(d.deviceId);
        if (boundKeyId && boundKeyId !== kid) {
          throw new Error('deviceId is already bound to another signing key');
        }
        const existing = this.devices.get(kid);
        if (existing && !sameRegistration(existing, d)) {
          throw new Error('immutable device registration changed');
        }
        this.devices.set(kid, d);
        this.deviceKeyIds.set(d.deviceId, kid);
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        this.callbacks.onError?.(
          'ATTN_WS_DEVICE',
          `device ${d.deviceId} has invalid publicSigningKey: ${m}`,
        );
      }
    }
  }

  /**
   * Decrypt + verify an envelope and push the decoded form to `onEnvelope`.
   * Per-envelope failures surface as `ATTN_INBOUND` errors and do NOT drop
   * the connection — matches `ws.rs::handle_text_frame`.
   */
  private enqueueEnvelope(
    envelope: MailboxEnvelope,
    serverSeq: number,
    source: DecodedEnvelope['source'],
  ): void {
    if (this.inboundBlocked || this.cancelled) return;
    const run = this.inboundQueue.then(() => this.ingestEnvelope(envelope, serverSeq, source));
    this.inboundQueue = run.catch((error: unknown) => {
      this.inboundBlocked = true;
      const message = error instanceof Error ? error.message : String(error);
      this.callbacks.onError?.('ATTN_INBOUND_COMMIT', `durable inbound commit failed: ${message}`);
      // Force a transient reconnect. The cursor was deliberately not advanced,
      // so the same encrypted frame is replayed after local durability recovers.
      try {
        this.socket?.close(1011, 'inbound commit failed');
      } catch {
        // The transport may already be closing; its normal close path retries.
      }
    });
  }

  private async ingestEnvelope(
    envelope: MailboxEnvelope,
    serverSeq: number,
    source: DecodedEnvelope['source'],
  ): Promise<void> {
    if (envelope.v !== undefined && envelope.v !== 2) {
      this.callbacks.onError?.('ATTN_INBOUND', `unsupported envelope version ${envelope.v}`);
      return;
    }
    if (envelope.roomId !== undefined && envelope.roomId !== this.opts.roomId) {
      this.callbacks.onError?.('ATTN_INBOUND', 'envelope room does not match subscription');
      return;
    }
    // `target` is intentionally excluded from AEAD AAD. Reject any signal
    // that is not explicitly addressed to this browser before decoding its
    // nonce/ciphertext, preventing relay target rewrite or fan-out.
    if (envelope.kind === 'signal' && !validateSignalTarget(envelope, this.opts.localDeviceId)) {
      this.callbacks.onError?.('ATTN_INBOUND', 'signal target does not match local device');
      return;
    }

    // Pick the AEAD key based on the envelope kind.
    const key =
      envelope.kind === 'event'
        ? this.opts.eventKey
        : envelope.kind === 'snapshot_blob'
          ? this.opts.snapshotKey
          : this.opts.signalingKey;

    // Reconstruct the AAD bytes from the cleartext routing metadata.
    const aad: EnvelopeAad = {
      v: 2,
      roomId: this.opts.roomId,
      envelopeId: envelope.envelopeId,
      kind: envelope.kind,
      authorId: envelope.authorId,
      deviceId: envelope.deviceId,
      createdAt: envelope.createdAt,
    };

    let nonceBytes: Uint8Array;
    let ctBytes: Uint8Array;
    try {
      nonceBytes = base64UrlDecode(envelope.nonce);
      ctBytes = base64UrlDecode(envelope.ciphertext);
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      this.callbacks.onError?.('ATTN_INBOUND', `envelope decode: ${m}`);
      return;
    }
    if (nonceBytes.length !== 24 || ctBytes.length !== envelope.ciphertextBytes) {
      nonceBytes.fill(0);
      ctBytes.fill(0);
      this.callbacks.onError?.('ATTN_INBOUND', 'envelope encoded length does not match metadata');
      return;
    }

    let plaintext: Uint8Array;
    try {
      plaintext = aeadOpen(key, nonceBytes, ctBytes, aad);
    } catch (err) {
      if (err instanceof AeadError) {
        this.callbacks.onError?.('ATTN_INBOUND', `aead open failed for ${envelope.envelopeId}`);
        return;
      }
      throw err;
    }

    // Only `event` envelopes carry a signed (meta, body, auth). Snapshot
    // blobs and signaling payloads have their own per-kind shapes that the
    // consumer parses. We verify event signatures here so a bad envelope is
    // dropped before it reaches UI state.
    if (envelope.kind === 'event') {
      const verified = await this.verifyEventPlaintext(envelope, serverSeq, plaintext);
      if (!verified) {
        plaintext.fill(0);
        return;
      }
    }

    try {
      await this.callbacks.onEnvelope?.({ envelope, serverSeq, source, plaintext });
    } catch (error) {
      plaintext.fill(0);
      throw error;
    }

    // Network frames advance only after the consumer's durable commit + UI
    // dispatch resolves. Stored replays are intentionally cursor-neutral.
    if (source === 'network' && serverSeq > this.afterSeq) this.afterSeq = serverSeq;
  }

  /**
   * Parse the decrypted event payload (canonical-JSON of `{ meta, body, auth }`)
   * and verify the Ed25519 signature against the cached device record.
   *
   * Returns `true` on success; emits an `ATTN_INBOUND` error and returns
   * `false` on any failure (drops the envelope, keeps the socket up).
   */
  private async verifyEventPlaintext(
    envelope: MailboxEnvelope,
    serverSeq: number,
    plaintext: Uint8Array,
  ): Promise<boolean> {
    const envelopeId = envelope.envelopeId;
    let event: { meta?: SignableMetaShape; body?: unknown; auth?: { signature: string; signingKeyId: string } };
    try {
      event = JSON.parse(new TextDecoder().decode(plaintext)) as typeof event;
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      this.callbacks.onError?.('ATTN_INBOUND', `event JSON parse (${envelopeId}): ${m}`);
      return false;
    }
    const meta = event.meta;
    const auth = event.auth;
    if (!meta || !auth || typeof auth.signature !== 'string' || typeof auth.signingKeyId !== 'string') {
      this.callbacks.onError?.('ATTN_INBOUND', `event missing meta/auth (${envelopeId})`);
      return false;
    }
    if (
      meta.v !== 2 ||
      typeof meta.eventId !== 'string' ||
      meta.roomId !== this.opts.roomId ||
      meta.authorId !== envelope.authorId ||
      meta.deviceId !== envelope.deviceId ||
      meta.createdAt !== envelope.createdAt
    ) {
      this.callbacks.onError?.('ATTN_INBOUND', `event metadata binding failed (${envelopeId})`);
      return false;
    }
    let device = this.devices.get(auth.signingKeyId);
    if (!device) {
      this.callbacks.onError?.(
        'ATTN_INBOUND',
        `unknown signer for ${envelopeId} (signingKeyId=${auth.signingKeyId})`,
      );
      await this.callbacks.onUnknownSigner?.(envelope, serverSeq, auth.signingKeyId);
      device = this.devices.get(auth.signingKeyId);
      // A successful authenticated refresh that still omits the signer proves
      // the envelope invalid. A transient refresh must reject so the ordered
      // queue reconnects without advancing beyond this sequence.
      if (!device) return false;
    }
    if (device.deviceId !== meta.deviceId || device.participantId !== meta.authorId) {
      this.callbacks.onError?.('ATTN_INBOUND', `event signer identity binding failed (${envelopeId})`);
      return false;
    }
    let pubKey: Uint8Array;
    try {
      pubKey = decodePublicSigningKey(device.publicSigningKey);
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      this.callbacks.onError?.('ATTN_INBOUND', `cached device pubKey decode (${envelopeId}): ${m}`);
      return false;
    }
    try {
      verifyEventSignature(meta, event.body, auth, pubKey);
    } catch (err) {
      if (err instanceof SignatureError) {
        this.callbacks.onError?.('ATTN_INBOUND', `signature verify failed for ${envelopeId}: ${err.message}`);
        return false;
      }
      throw err;
    }
    let recomputedEventId: string;
    try {
      recomputedEventId = deriveEventId(meta, event.body);
    } catch {
      this.callbacks.onError?.('ATTN_INBOUND', `event id derivation failed (${envelopeId})`);
      return false;
    }
    if (recomputedEventId !== meta.eventId) {
      this.callbacks.onError?.('ATTN_INBOUND', `event id mismatch (${envelopeId})`);
      return false;
    }
    if (!this.authorizeEvent(auth.signingKeyId, meta, event.body, device)) {
      this.callbacks.onError?.('ATTN_INBOUND', `event capability authorization failed (${envelopeId})`);
      return false;
    }
    return true;
  }

  private authorizeEvent(
    signingKeyId: string,
    meta: SignableMetaShape,
    body: unknown,
    registered: Device,
  ): boolean {
    if (!isRecord(body) || typeof body.type !== 'string') return false;
    if (body.type === 'participant_joined') {
      if (!validParticipantAttestation(meta, body, registered)) return false;
      this.attestedSigners.add(signingKeyId);
      return true;
    }
    if (body.type === 'room_created') {
      return (
        registered.kind === 'owner' &&
        body.roomId === meta.roomId &&
        body.createdBy === meta.authorId
      );
    }
    // The relay only grants kind=owner when the registration key matches the
    // room-creation key. That signed directory record is sufficient owner
    // attestation; reviewers/agents must first publish their encrypted
    // ParticipantJoined self-attestation before authoring findings.
    if (registered.kind !== 'owner' && !this.attestedSigners.has(signingKeyId)) return false;
    return eventAllowedForRole(body, registered, meta);
  }

  private handleClose(code: number, reason: string): void {
    this.inboundBlocked = false;
    const wasCancelled = this.cancelled;
    this.callbacks.onClose?.(code, reason);

    // Map close codes 4000-4005 to terminal errors. 4005 may have already
    // been classified in the `error` frame path above — in that case we
    // already emitted onTerminal and won't reconnect.
    const terminal = mapTerminalCode(code, reason);
    if (terminal) {
      // For 4005 the error frame path already emitted onTerminal and marked
      // cancelled. Avoid double-emit.
      if (!wasCancelled && terminal.kind !== 'cursor_too_old') {
        this.cancelled = true;
        this.callbacks.onTerminal?.(terminal);
      }
      this.state = 'terminated';
      this.socket = null;
      return;
    }

    if (this.cancelled) {
      this.state = 'terminated';
      this.socket = null;
      return;
    }

    // Transient drop → schedule reconnect.
    this.scheduleReconnect(`close ${code}: ${reason}`);
  }

  private scheduleReconnect(_reason: string): void {
    this.socket = null;
    if (this.cancelled) {
      this.state = 'terminated';
      return;
    }
    this.state = 'closed';
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, this.maxMs);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openOnce();
    }, delay);
  }

  // Test-only — expose backoff for assertions.
  /** @internal */
  _currentBackoffMs(): number {
    return this.backoffMs;
  }
}

function mapTerminalCode(code: number, reason: string): WsTerminalError | null {
  switch (code) {
    case CLOSE_ADMISSION_INVALID:
      return new WsTerminalError('admission_rejected', code, reason || 'admission rejected');
    case CLOSE_ROOM_DELETED:
      return new WsTerminalError('room_deleted', code, reason || 'room deleted');
    case CLOSE_ROOM_EXPIRED:
      return new WsTerminalError('room_expired', code, reason || 'room expired');
    case CLOSE_CURSOR_TOO_OLD:
      return new WsTerminalError('cursor_too_old', code, reason || 'cursor too old', 0);
    default:
      return null;
  }
}

function registrationBytes(device: Device): Uint8Array {
  return toCanonicalBytes({
    client: device.client,
    deviceId: device.deviceId,
    kind: device.kind,
    participantId: device.participantId,
    publicEncryptionKey: device.publicEncryptionKey,
    publicSigningKey: device.publicSigningKey,
  });
}

function sameRegistration(a: Device, b: Device): boolean {
  return (
    a.deviceId === b.deviceId &&
    a.participantId === b.participantId &&
    a.publicEncryptionKey === b.publicEncryptionKey &&
    a.publicSigningKey === b.publicSigningKey &&
    a.client === b.client &&
    a.kind === b.kind &&
    a.selfSignature === b.selfSignature
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactCapabilities(value: unknown, kind: Device['kind']): boolean {
  if (!Array.isArray(value) || value.some((cap) => typeof cap !== 'string')) return false;
  const expected: Record<Device['kind'], string[]> = {
    owner: [
      'room_admin',
      'read_snapshot',
      'write_comment',
      'write_suggestion',
      'resolve_comment',
      'accept_suggestion',
      'publish_snapshot',
    ],
    reviewer: ['read_snapshot', 'write_comment', 'write_suggestion', 'resolve_comment'],
    agent: ['read_snapshot', 'write_comment', 'write_suggestion'],
  };
  const actual = [...value].sort();
  const grants = [...expected[kind]].sort();
  return actual.length === grants.length && actual.every((cap, index) => cap === grants[index]);
}

function validParticipantAttestation(
  meta: SignableMetaShape,
  body: Record<string, unknown>,
  registered: Device,
): boolean {
  const participant = body.participant;
  const device = body.device;
  if (!isRecord(participant) || !isRecord(device)) return false;
  return (
    meta.authorId === registered.participantId &&
    meta.deviceId === registered.deviceId &&
    participant.participantId === registered.participantId &&
    typeof participant.displayName === 'string' &&
    participant.kind === registered.kind &&
    participant.publicSigningKey === registered.publicSigningKey &&
    exactCapabilities(participant.capabilities, registered.kind) &&
    device.deviceId === registered.deviceId &&
    device.participantId === registered.participantId &&
    device.publicEncryptionKey === registered.publicEncryptionKey &&
    device.publicSigningKey === registered.publicSigningKey &&
    device.client === registered.client &&
    Number.isSafeInteger(device.createdAt)
  );
}

function eventAllowedForRole(
  body: Record<string, unknown>,
  registered: Device,
  meta: SignableMetaShape,
): boolean {
  switch (body.type) {
    case 'comment_created':
      return true;
    case 'suggestion_created':
      return true;
    case 'comment_resolved':
      return (registered.kind === 'owner' || registered.kind === 'reviewer')
        && body.resolvedBy === meta.authorId;
    case 'snapshot_created':
    case 'snapshot_superseded':
    case 'suggestion_accepted':
    case 'suggestion_rejected':
    case 'session_ended':
      return registered.kind === 'owner';
    case 'anchor_manually_resolved':
      return registered.kind === 'owner' && body.resolvedBy === meta.authorId;
    case 'presence_updated':
      return body.participantId === meta.authorId && body.deviceId === meta.deviceId;
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// URL helpers — mirror `ws.rs::build_ws_url` / `socket_path`.
// ---------------------------------------------------------------------------

/**
 * Compose `wss://<relay>/v2/rooms/:roomId/socket?device_id=:deviceId`.
 *
 * If `relayUrl` starts with `https://` it becomes `wss://`, `http://` becomes
 * `ws://`, otherwise the scheme is preserved (useful for tests passing
 * `ws://127.0.0.1:NNNN` directly).
 *
 * Uses RFC 3986 unreserved-only percent encoding (matches Rust
 * `ws.rs::rfc3986_encode` — `encodeURIComponent` would leave `!*'()` raw and
 * diverge from the admission HMAC canonicalisation).
 */
export function buildWsUrl(relayUrl: string, roomId: string, deviceId: string): string {
  const trimmed = relayUrl.replace(/\/+$/, '');
  let withScheme = trimmed;
  if (trimmed.startsWith('https://')) {
    withScheme = 'wss://' + trimmed.slice('https://'.length);
  } else if (trimmed.startsWith('http://')) {
    withScheme = 'ws://' + trimmed.slice('http://'.length);
  }
  const eRoom = rfc3986EncodeForUrl(roomId);
  const eDevice = rfc3986EncodeForUrl(deviceId);
  return `${withScheme}/v2/rooms/${eRoom}/socket?device_id=${eDevice}`;
}

function rfc3986EncodeForUrl(s: string): string {
  let out = '';
  const bytes = new TextEncoder().encode(s);
  for (const b of bytes) {
    const isUnreserved =
      (b >= 0x30 && b <= 0x39) ||
      (b >= 0x41 && b <= 0x5a) ||
      (b >= 0x61 && b <= 0x7a) ||
      b === 0x2d || b === 0x2e || b === 0x5f || b === 0x7e;
    if (isUnreserved) {
      out += String.fromCharCode(b);
    } else {
      out += '%' + b.toString(16).toUpperCase().padStart(2, '0');
    }
  }
  return out;
}

/** Path component used in the admission HMAC canonicalisation. */
export function socketPath(roomId: string): string {
  return `/v2/rooms/${roomId}/socket`;
}
