// Live co-typing controller — the glue between the editor, the session
// controllers (CollabHost/CollabClient), and the encrypted signal transport.
//
// Role is decided once at construction:
//   * Owner   → hosts the CollabAuthority and is also its own client. Inbound
//     `submit` messages are fed to the host; accepted batches broadcast out as
//     `broadcast` messages and replay into the owner's editor.
//   * Reviewer→ a plain client. Local steps go out as `submit`; inbound
//     `broadcast` messages are applied (rebasing local work).
//
// On the wire every message is a CollabWireMessage JSON string (the daemon
// shuttles it opaquely as a SignalingPayload::Collab). This module owns that
// envelope; the session controllers below it stay transport-free.

import type { Node as PmNode } from 'prosemirror-model';

import {
  CollabAuthority,
  type CollabBroadcast,
  type CollabSubmission,
} from './collab-authority';
import { CollabClient, CollabHost, type EditorBridge } from './collab-session';
import type { FileId, SnapshotId } from '../types';

export interface CollabPeerLocation {
  fileId?: FileId;
  snapshotId?: SnapshotId;
  path?: string;
}

/** A remote participant's live caret, keyed by their collab clientID. */
export interface RemoteCursor {
  clientID: string;
  /** Caret position in document coordinates. */
  head: number;
  /** Human label shown next to the caret (e.g. "Owner"). */
  label: string;
  /** CSS color for the caret + label chip. */
  color: string;
  /** Current shared-file location, carried with cursor presence. */
  location?: CollabPeerLocation;
}

/** Tagged wire envelope carried inside a SignalingPayload::Collab payload. */
export type CollabWireMessage =
  | { kind: 'submit'; submission: CollabSubmission }
  | { kind: 'broadcast'; broadcast: CollabBroadcast }
  | { kind: 'cursor'; cursor: RemoteCursor };

/** Sends an already-serialized wire message to the room. */
export type SendSignalFn = (payload: string) => void;

/**
 * Drives one editor's participation in a live co-typing session. Construct
 * with the editor bridge, the local role, and a transport `send`; then call
 * {@link onLocalChange} after each local transaction and {@link onInbound}
 * for each `reviewCollab` payload from the daemon.
 */
export class CollabController {
  private readonly isOwner: boolean;
  private readonly send: SendSignalFn;
  private readonly client: CollabClient;
  private readonly host: CollabHost | null;
  private readonly selfClientId: string;
  private readonly selfLabel: string;
  private readonly selfColor: string;
  private readonly onRemoteCursors: ((cursors: RemoteCursor[]) => void) | null;
  private readonly getLocation: (() => CollabPeerLocation | null) | null;
  private readonly onPeerLocation: ((deviceId: string, location: CollabPeerLocation) => void) | null;
  private readonly remoteCursors = new Map<string, RemoteCursor>();
  // clientID → sender deviceId, so a peer's caret can be cleared on leave
  // (presence frames identify peers by deviceId, cursors by collab clientID).
  private readonly cursorDevice = new Map<string, string>();

  constructor(opts: {
    bridge: EditorBridge;
    isOwner: boolean;
    /** Seed doc for the authority (owner only) — must equal the editor's v0 doc. */
    initialDoc: PmNode;
    send: SendSignalFn;
    /** This editor's collab clientID — stamped on outgoing cursor messages. */
    selfClientId: string;
    /** Label + color for this participant's caret as seen by others. */
    selfLabel: string;
    selfColor: string;
    /** Notified whenever the remote-cursor set changes (drives decorations). */
    onRemoteCursors?: (cursors: RemoteCursor[]) => void;
    /** Reads the current shared-file location when sending cursor presence. */
    getLocation?: () => CollabPeerLocation | null;
    /** Notified when a remote cursor reports its current shared-file location. */
    onPeerLocation?: (deviceId: string, location: CollabPeerLocation) => void;
  }) {
    this.isOwner = opts.isOwner;
    this.send = opts.send;
    this.selfClientId = opts.selfClientId;
    this.selfLabel = opts.selfLabel;
    this.selfColor = opts.selfColor;
    this.onRemoteCursors = opts.onRemoteCursors ?? null;
    this.getLocation = opts.getLocation ?? null;
    this.onPeerLocation = opts.onPeerLocation ?? null;

    if (opts.isOwner) {
      const authority = new CollabAuthority(opts.initialDoc);
      this.host = new CollabHost(authority, (b) => this.broadcastOut(b));
      // The owner's own editor submits straight to the local host (no wire).
      this.client = new CollabClient(opts.bridge, (sub) => this.host!.onSubmission(sub));
      this.host.attachOwnerClient(this.client);
    } else {
      this.host = null;
      // A reviewer's submissions cross the wire to the owner.
      this.client = new CollabClient(opts.bridge, (sub) => this.submitOut(sub));
    }
  }

  /** Authority/local version, for diagnostics. */
  get version(): number {
    return this.host ? this.host.version : this.client.version;
  }

  /** Call after every local editor transaction; ships unconfirmed steps. */
  onLocalChange(): void {
    this.client.syncUp();
  }

  /**
   * Broadcast this editor's caret position to the room. Sent on the same
   * signal channel as steps but OUTSIDE the authority — cursors are presence,
   * not document mutations. Every participant (owner + reviewers) both sends
   * and receives these.
   */
  broadcastCursor(head: number): void {
    const location = this.getLocation?.() ?? undefined;
    this.send(
      JSON.stringify({
        kind: 'cursor',
        cursor: {
          clientID: this.selfClientId,
          head,
          label: this.selfLabel,
          color: this.selfColor,
          ...(location ? { location } : {}),
        },
      } satisfies CollabWireMessage),
    );
  }

  /**
   * Handle an inbound wire message from `fromDeviceId` (the daemon stamps the
   * sender's deviceId on every CollabSignal). The owner consumes `submit`s
   * (and ignores `broadcast` echoes it authored); a reviewer consumes
   * `broadcast`s (and ignores other reviewers' `submit`s, since it isn't the
   * authority). Cursors record their sender device so they can be cleared when
   * that device leaves.
   */
  onInbound(payload: string, fromDeviceId: string): void {
    let msg: CollabWireMessage;
    try {
      msg = JSON.parse(payload) as CollabWireMessage;
    } catch {
      return; // malformed — drop (a resync will recover live state)
    }
    // Cursors are presence: every role consumes them (skipping our own).
    if (msg.kind === 'cursor') {
      if (msg.cursor.clientID === this.selfClientId) return;
      this.remoteCursors.set(msg.cursor.clientID, msg.cursor);
      this.cursorDevice.set(msg.cursor.clientID, fromDeviceId);
      if (msg.cursor.location !== undefined) {
        this.onPeerLocation?.(fromDeviceId, msg.cursor.location);
      }
      this.onRemoteCursors?.([...this.remoteCursors.values()]);
      return;
    }
    if (this.isOwner) {
      if (msg.kind === 'submit') this.host!.onSubmission(msg.submission);
    } else {
      if (msg.kind === 'broadcast') this.client.receive(msg.broadcast);
    }
  }

  /** Drop a single peer's cursor by collab clientID. */
  removeCursor(clientID: string): void {
    this.cursorDevice.delete(clientID);
    if (this.remoteCursors.delete(clientID)) {
      this.onRemoteCursors?.([...this.remoteCursors.values()]);
    }
  }

  /**
   * Drop every caret belonging to a device that left the room, so a departed
   * participant's cursor doesn't linger on screen for the rest of the session.
   */
  removeCursorsForDevice(deviceId: string): void {
    let changed = false;
    for (const [clientID, dev] of this.cursorDevice) {
      if (dev !== deviceId) continue;
      this.cursorDevice.delete(clientID);
      if (this.remoteCursors.delete(clientID)) changed = true;
    }
    if (changed) this.onRemoteCursors?.([...this.remoteCursors.values()]);
  }

  private submitOut(submission: CollabSubmission): void {
    this.send(JSON.stringify({ kind: 'submit', submission } satisfies CollabWireMessage));
  }

  private broadcastOut(broadcast: CollabBroadcast): void {
    this.send(JSON.stringify({ kind: 'broadcast', broadcast } satisfies CollabWireMessage));
  }
}
