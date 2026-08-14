// Bounded, lossy workspace-scoped collaboration signals (attn-whdh).
//
// This is the only browser-tab transport for live review presence: cursors
// and room rosters. It is intentionally not a doorbell and never opens
// BrowserStorage, so it cannot become an alternate durable review authority.
// LocalCollab retains its own channel for document handshakes, seeds, and
// ProseMirror steps.

import {
  parseCollabWireMessage,
  type CollabWireMessage,
} from '../prosemirror/collab-controller';
import {
  REVIEW_EPHEMERA_CHANNEL_PREFIX,
  openBroadcastChannel,
} from '../tab-channels';

const MAX_WORKSPACE_ID_BYTES = 512;
const MAX_SENDER_ID_BYTES = 256;
const MAX_PEERS = 64;
const MAX_PEER_ID_BYTES = 256;

export type BrowserReviewEphemeraPeerKind = 'owner' | 'reviewer' | 'agent';

/** A bounded projection of the live room roster. */
export interface BrowserReviewEphemeraPeer {
  participantId: string;
  deviceId: string;
  kind: BrowserReviewEphemeraPeerKind;
  online: boolean;
}

/**
 * Cursor origins make the relay path explicit without giving the local bus a
 * document-authority role. A local tab's cursor is sent to the owner session;
 * room and owner cursors are rendered by follower tabs.
 */
export type BrowserReviewEphemeraCursorSource = 'local-tab' | 'owner' | 'room';

export type BrowserReviewEphemeraSignal =
  | { kind: 'presence'; peers: readonly BrowserReviewEphemeraPeer[] }
  | {
      kind: 'cursor';
      source: BrowserReviewEphemeraCursorSource;
      /** A fully validated ProseMirror cursor wire message. */
      payload: string;
    };

export interface BrowserReviewEphemeraMessage {
  workspaceId: string;
  senderId: string;
  signal: BrowserReviewEphemeraSignal;
}

interface BrowserReviewEphemeraEnvelope extends BrowserReviewEphemeraMessage {
  v: 1;
}

/** Small injectable BroadcastChannel surface for deterministic tests. */
export interface BrowserReviewEphemeraChannel {
  postMessage(message: unknown): void;
  close(): void;
  onmessage: ((event: { data: unknown }) => void) | null;
}

export interface BrowserReviewEphemeraBusOptions {
  workspaceId: string;
  senderId: string;
  /** Test seam. Browser production uses the workspace-scoped channel. */
  channel?: BrowserReviewEphemeraChannel | null;
}

function bytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

function boundedId(value: unknown, maxBytes: number): value is string {
  return typeof value === 'string' && value.length > 0 && bytes(value) <= maxBytes;
}

function isPeer(value: unknown): value is BrowserReviewEphemeraPeer {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const peer = value as Partial<BrowserReviewEphemeraPeer>;
  return boundedId(peer.participantId, MAX_PEER_ID_BYTES)
    && boundedId(peer.deviceId, MAX_PEER_ID_BYTES)
    && (peer.kind === 'owner' || peer.kind === 'reviewer' || peer.kind === 'agent')
    && typeof peer.online === 'boolean';
}

function validCursor(payload: unknown): payload is string {
  if (typeof payload !== 'string') return false;
  const wire: CollabWireMessage | null = parseCollabWireMessage(payload);
  return wire?.kind === 'cursor';
}

function parseSignal(value: unknown): BrowserReviewEphemeraSignal | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const signal = value as Partial<BrowserReviewEphemeraSignal>;
  if (signal.kind === 'presence') {
    if (!Array.isArray(signal.peers) || signal.peers.length > MAX_PEERS) return null;
    return signal.peers.every(isPeer)
      ? { kind: 'presence', peers: signal.peers.map((peer) => ({ ...peer })) }
      : null;
  }
  if (signal.kind === 'cursor') {
    if (
      (signal.source !== 'local-tab' && signal.source !== 'owner' && signal.source !== 'room')
      || !validCursor(signal.payload)
    ) return null;
    return { kind: 'cursor', source: signal.source, payload: signal.payload };
  }
  return null;
}

/** Parse untrusted BroadcastChannel input; no malformed signal reaches UI. */
export function parseBrowserReviewEphemeraMessage(
  value: unknown,
  workspaceId: string,
): BrowserReviewEphemeraMessage | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const envelope = value as Partial<BrowserReviewEphemeraEnvelope>;
  if (
    envelope.v !== 1
    || envelope.workspaceId !== workspaceId
    || !boundedId(envelope.workspaceId, MAX_WORKSPACE_ID_BYTES)
    || !boundedId(envelope.senderId, MAX_SENDER_ID_BYTES)
  ) return null;
  const signal = parseSignal(envelope.signal);
  return signal
    ? { workspaceId, senderId: envelope.senderId, signal }
    : null;
}

function defaultChannel(workspaceId: string): BrowserReviewEphemeraChannel | null {
  // The browser app owns this optimization. Do not let Node/test imports open
  // ambient process-wide BroadcastChannels accidentally.
  if (typeof window === 'undefined') return null;
  return openBroadcastChannel(
    `${REVIEW_EPHEMERA_CHANNEL_PREFIX}${workspaceId}`,
  ) as unknown as BrowserReviewEphemeraChannel | null;
}

/**
 * A one-workspace ephemeral bus. It delivers same-tab subscribers directly
 * because BroadcastChannel omits its posting context, then sends the bounded
 * signal to sibling contexts. It never persists, retries, or replays data.
 */
export class BrowserReviewEphemeraBus {
  private readonly options: BrowserReviewEphemeraBusOptions;
  private readonly channel: BrowserReviewEphemeraChannel | null;
  private readonly subscribers = new Set<(message: BrowserReviewEphemeraMessage) => void>();
  private closed = false;

  constructor(options: BrowserReviewEphemeraBusOptions) {
    if (
      !boundedId(options.workspaceId, MAX_WORKSPACE_ID_BYTES)
      || !boundedId(options.senderId, MAX_SENDER_ID_BYTES)
    ) throw new Error('workspace-scoped ephemera ids are invalid');
    this.options = options;
    this.channel = options.channel === undefined ? defaultChannel(options.workspaceId) : options.channel;
    if (this.channel) this.channel.onmessage = (event) => this.receive(event.data);
  }

  get available(): boolean {
    return this.channel !== null;
  }

  subscribe(listener: (message: BrowserReviewEphemeraMessage) => void): () => void {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  /** Publish an advisory signal. It is never written to a review log. */
  publish(signal: BrowserReviewEphemeraSignal): void {
    if (this.closed) return;
    const normalized = parseSignal(signal);
    if (!normalized) return;
    const message: BrowserReviewEphemeraMessage = {
      workspaceId: this.options.workspaceId,
      senderId: this.options.senderId,
      signal: normalized,
    };
    this.notify(message);
    try {
      this.channel?.postMessage({ v: 1, ...message } satisfies BrowserReviewEphemeraEnvelope);
    } catch {
      // Presence is deliberately lossy. The next movement/roster tick heals it.
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.subscribers.clear();
    if (this.channel) {
      this.channel.onmessage = null;
      this.channel.close();
    }
  }

  private receive(value: unknown): void {
    if (this.closed) return;
    const message = parseBrowserReviewEphemeraMessage(value, this.options.workspaceId);
    if (!message || message.senderId === this.options.senderId) return;
    this.notify(message);
  }

  private notify(message: BrowserReviewEphemeraMessage): void {
    for (const subscriber of [...this.subscribers]) {
      try {
        subscriber(message);
      } catch {
        // An ephemeral consumer must never block other tabs' presence updates.
      }
    }
  }
}
