// Browser-side review session orchestrator (attn-nnj.9.4).
//
// Stitches together the lower-level pieces built in 9.2 / 9.3:
//
//   - `browser-invite.ts` — parse + strip the `#key=…` fragment.
//   - `browser-crypto.ts`  — HKDF + admission HMAC + AAD AEAD + signature verify.
//   - `browser-ws.ts`      — encrypted mailbox WebSocket transport.
//
// The session is a thin reviewer-only surface:
//   1. Parse + strip the invite fragment from `location.hash`.
//   2. Derive `RoomKeys` and `roomId` from `roomSecret`.
//   3. Generate an in-memory `(deviceId, signingKeyPair, encryptionKeyPair)`.
//      No persistence whatsoever — reload requires re-paste.
//   4. POST `/v2/rooms/:roomId/devices` with `kind: "reviewer"` + admission HMAC
//      + selfSignature + PoW. The PoW miner lives in `browser-pow.ts`; we
//      stub a simple synchronous miner here as a placeholder for 9.4. The
//      real Web-Worker miner lands in a follow-up issue.
//   5. Open the `BrowserWsClient` and pump decoded envelopes into the global
//      `reviewStore`. The store already knows how to render comments,
//      suggestions, ambiguous/stale anchors, and snapshots via the existing
//      Phase 2 components — see `web/src/lib/ReviewMargin.svelte`.
//
// What this module deliberately leaves out:
//
//   - Outbound comment / suggestion authoring. The composer components do the
//     anchor build + IPC dispatch in native; we'll layer browser POST
//     `/envelopes` on top via a separate `browser-outbox.ts` once 9.5 lands.
//     For now the Svelte composers stay mounted but their submit handlers
//     route through a no-op in the browser shell.
//   - Snapshot R2 download. We surface `SnapshotCreated` envelopes inline
//     (`inlineSnapshot`); R2-hosted snapshots show "snapshot not available"
//     in the UI until 9.x wires `GET /blobs/:id`.
//   - Reconnect cursor persistence. The WS client tracks `afterSeq` in
//     memory only — reload restarts at 0.
//
// Tests: `browser-session.test.ts`. Run with:
//
//   cd web && npx tsx src/lib/review/browser-session.test.ts

import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hmac } from '@noble/hashes/hmac.js';
import { reviewStore } from './store.svelte';
import {
  base64UrlEncode,
  buildAdmissionSubprotocol,
  deriveRoomId,
  deriveRoomKeys,
  signingKeyId,
  toCanonicalBytes,
  type RoomKeys,
} from './browser-crypto';
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
  type WebSocketLike,
  type WsTerminalError,
  type RoomPolicy,
} from './browser-ws';
import type {
  EventId,
  EventMeta,
  FileId,
  ReviewEvent,
  ReviewEventBody,
  ReviewSnapshot,
  SnapshotId,
  RoomId,
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
  /** Ed25519 secret key bytes (64). Held only in JS memory. */
  signingSecret: Uint8Array;
  /** Ed25519 public key bytes (32). */
  signingPublic: Uint8Array;
  /** Placeholder X25519 public key (32 bytes of zeros for now). */
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
  /** Markdown bytes recovered from the latest SnapshotCreated. */
  snapshotMarkdown: string | null;
  /** Snapshot id of the latest snapshot we have markdown for. */
  snapshotId: SnapshotId | null;
  /** File id of the latest snapshot we have markdown for. */
  fileId: FileId | null;
  /** Tagged error, or null when status is healthy. */
  error: BrowserSessionError | null;
}

export interface BrowserSessionOptions {
  /** Window-like for parsing the invite from location.hash. */
  window?: BrowserWindowLike;
  /**
   * Override the invite URL (used by tests). Takes precedence over the
   * window fragment when provided.
   */
  inviteUrl?: string;
  /** Relay base URL (default `https://attn.dev`). */
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
  /** Inject a pre-built identity (tests want deterministic keys). */
  identity?: BrowserDeviceIdentity;
  /** Optional state observer — called on every state mutation. */
  onState?: (state: BrowserSessionState) => void;
}

/** Minimal fetch shape — avoids depending on lib.dom.d.ts in TS tests. */
export interface FetchLikeInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface FetchLikeResponse {
  status: number;
  /** Read the body as text. */
  text(): Promise<string>;
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

  return {
    deviceId: 'br-' + base64UrlEncode(idBytes),
    participantId: 'br-' + base64UrlEncode(partBytes),
    signingSecret: secretKey,
    signingPublic: publicKey,
    // Placeholder for X25519 — browser-side encrypted DataChannel is out of
    // scope for 9.4. Spec only requires a publicEncryptionKey field for
    // `POST /devices`; the relay does not verify it for `kind="reviewer"`.
    publicEncryptionKey: new Uint8Array(32),
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
  // Canonical request bytes: METHOD || "\n" || PATH || "\n" || "" || "\n" || SHA-256(body)
  const bodyHash = sha256(body);
  const enc = new TextEncoder();
  const m = enc.encode(method.toUpperCase());
  const p = enc.encode(urlPath);
  const canon = new Uint8Array(m.length + 1 + p.length + 1 + 1 + bodyHash.length);
  let off = 0;
  canon.set(m, off);
  off += m.length;
  canon[off++] = 0x0a;
  canon.set(p, off);
  off += p.length;
  canon[off++] = 0x0a;
  // Empty query line
  canon[off++] = 0x0a;
  canon.set(bodyHash, off);
  // Use hmac-sha256 via the same noble path as buildAdmissionSubprotocol.
  // The shape is identical to the WS subprotocol HMAC (just packaged in an
  // HTTP header rather than a comma-separated subprotocol token).
  const tag = hmac(sha256, admissionKey, canon);
  return `v2.${base64UrlEncode(tag)}`;
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
    snapshotMarkdown: null,
    snapshotId: null,
    fileId: null,
    error: null,
  };
  private identity: BrowserDeviceIdentity | null = null;
  private wsClient: BrowserWsClient | null = null;
  private keys: RoomKeys | null = null;

  constructor(opts: BrowserSessionOptions = {}) {
    this.opts = opts;
  }

  /** Current state snapshot — UI binds against this. */
  getState(): BrowserSessionState {
    return this.state;
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
      if (this.opts.inviteUrl) {
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
    reviewStore.currentRoomId = invite.roomId;

    // 3. Identity (injected or freshly generated).
    this.identity = this.opts.identity ?? generateBrowserIdentity();

    // 4. POST /devices.
    this.setState({ status: 'registering_device' });
    try {
      await this.registerDevice(invite.roomId, roomKeys);
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      this.fail('device_register', m);
      return;
    }

    // 5. Open the WS.
    this.setState({ status: 'connecting' });
    this.openWs(invite.roomId, roomKeys);
  }

  /** Tear down the WS and stop reconnecting. Safe to call multiple times. */
  close(): void {
    if (this.wsClient) {
      try {
        this.wsClient.close();
      } catch {
        // ignore
      }
      this.wsClient = null;
    }
    this.setState({ status: 'terminated' });
  }

  // -----------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------

  private setState(patch: Partial<BrowserSessionState>): void {
    this.state = { ...this.state, ...patch };
    this.opts.onState?.(this.state);
  }

  private fail(kind: BrowserSessionError['kind'], message: string): void {
    this.setState({ status: 'error', error: { kind, message } });
  }

  private async registerDevice(roomId: string, keys: RoomKeys): Promise<void> {
    if (!this.identity) throw new Error('identity missing');
    const body = buildRegisterDeviceBody(this.identity);
    const bodyJson = JSON.stringify(body);
    const bodyBytes = new TextEncoder().encode(bodyJson);
    const path = `/v2/rooms/${roomId}/devices`;
    const admission = admissionHeaderValue(keys.admissionKey, 'POST', path, bodyBytes);
    const relay = (this.opts.relayUrl ?? 'https://attn.dev').replace(/\/+$/, '');
    const url = `${relay}${path}`;
    const headers: Record<string, string> = {
      'content-type': 'application/json; charset=utf-8',
      'Attn-Admission': admission,
      // 9.4 placeholder — the real Web-Worker PoW miner lands later. The
      // relay rejects with 403 `ATTN_POW_REQUIRED` if the token is missing
      // or invalid; tests inject their own value via `powToken`.
      'Attn-PoW': this.opts.powToken ?? 'v2.placeholder.0.0',
    };
    const fetchImpl =
      this.opts.fetchImpl ??
      (async (u, init) => {
        const r = await (globalThis as unknown as {
          fetch: (u: string, i: FetchLikeInit) => Promise<{ status: number; text: () => Promise<string> }>;
        }).fetch(u, init);
        return r as FetchLikeResponse;
      });
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
    const relay = (this.opts.relayUrl ?? 'https://attn.dev').replace(/\/+$/, '');
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
      url,
      subprotocol,
      afterSeq: 0,
      eventKey: keys.eventKey,
      snapshotKey: keys.snapshotKey,
      signalingKey: keys.signalingKey,
      webSocketFactory: this.opts.webSocketFactory,
      reconnectInitialMs: this.opts.reconnectInitialMs,
      reconnectMaxMs: this.opts.reconnectMaxMs,
      callbacks: {
        onHello: () => {
          this.setState({ status: 'connected' });
        },
        onEnvelope: (decoded) => this.handleEnvelope(decoded),
        onTerminal: (err) => this.handleTerminal(err),
        onError: (_code, _msg) => {
          // Non-fatal — keep status as-is. Could surface as a toast later.
        },
      },
    });
    this.wsClient.start();
  }

  private handleEnvelope(decoded: DecodedEnvelope): void {
    const { envelope, plaintext } = decoded;
    if (envelope.kind === 'event') {
      let parsed: { meta?: EventMeta; body?: ReviewEventBody };
      try {
        parsed = JSON.parse(new TextDecoder().decode(plaintext));
      } catch {
        return;
      }
      const meta = parsed.meta;
      const body = parsed.body;
      if (!meta || !body) return;
      // Build a minimal ReviewEvent (auth omitted from the local store copy —
      // the WS client already verified the signature before dispatch).
      const event: ReviewEvent = {
        meta: meta as EventMeta,
        body: body as ReviewEventBody,
        // `auth` is required by the type. We synthesize a placeholder; the
        // store doesn't read it but TS does.
        auth: { signature: '', signingKeyId: '' },
      };
      // Snapshot path — surface markdown for the editor + populate
      // reviewStore.snapshots so the existing UI can scope by snapshot.
      if (body.type === 'snapshot_created') {
        this.absorbSnapshotCreated(meta as EventMeta, body);
      }
      reviewStore.applyEvent(event);
      return;
    }
    if (envelope.kind === 'snapshot_blob') {
      // R2-hosted snapshots arrive here as the decrypted blob bytes. The
      // 9.4 surface treats them as inline markdown for the latest known
      // snapshot. The full inline/R2 routing lands later.
      return;
    }
    // Signal envelopes are out of scope for the browser reviewer surface.
  }

  private absorbSnapshotCreated(
    meta: EventMeta,
    body: Extract<ReviewEventBody, { type: 'snapshot_created' }>,
  ): void {
    const inline = body.inlineSnapshot;
    if (!inline) {
      // R2-hosted snapshot — leave snapshotMarkdown null; UI shows
      // "snapshot not available."
      return;
    }
    this.setState({
      snapshotMarkdown: inline.markdown,
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
      byteLength: new TextEncoder().encode(inline.markdown).length,
      markdown: inline.markdown,
      anchorIndex: inline.anchorIndex,
    };
    reviewStore.applySnapshot(snapshot);
    reviewStore.setCurrentFile(body.fileId);
    reviewStore.setCurrentSnapshot(body.snapshotId);
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
    this.setState({ status: 'error', error: { kind, message: err.message } });
  }
}

// Re-exports so the entry point and tests have one import location.
export type { Device, RoomPolicy };
// Suppress unused-export warning while the EventId import is referenced only
// for documentation of the shape we surface.
export type { EventId };
