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

/**
 * Tagged wire envelope carried inside a SignalingPayload::Collab payload.
 *
 * Every document message (`submit`/`broadcast`) is scoped to a `fileId`: a
 * folder share is a room with N independently co-edited files, each with its
 * own authority on the owner. `resync` is a client→owner request for a file's
 * full step log (sent when a participant opens/switches to a file): the owner
 * replies with a `broadcast` at `startVersion: 0`, which the at-least-once
 * `receive()` skip logic makes idempotent for peers already caught up. Cursors
 * are presence and carry their file location inside the cursor itself.
 */
export type CollabWireMessage =
  | { kind: 'submit'; fileId: FileId; submission: CollabSubmission }
  | { kind: 'broadcast'; fileId: FileId; broadcast: CollabBroadcast }
  | { kind: 'resync'; fileId: FileId }
  | { kind: 'cursor'; cursor: RemoteCursor };

/** Sends an already-serialized wire message to the room. */
export type SendSignalFn = (payload: string) => void;

/**
 * Drives a participant's live co-typing across every file in a room. A room is
 * a SET of files (a folder share is N files); each file is independently
 * co-edited, so the owner hosts one {@link CollabAuthority} PER file and any
 * participant can edit any file.
 *
 * The editor only ever shows ONE file at a time, so this controller binds the
 * editor to the *active* file via {@link setActiveFile} (call it on first
 * activation and on every file switch):
 *   * Owner   → keeps a lazily-grown `Map<fileId, CollabHost>`. The active
 *     file's host gets the owner's editor as its owner-client; inbound steps
 *     for ANY file are routed to that file's host (created on demand from
 *     {@link getSeedDoc}) even when the owner is looking elsewhere, so a
 *     reviewer editing file B while the owner edits file A Just Works.
 *   * Reviewer→ a single wire client for the active file; outgoing steps are
 *     tagged with that fileId, inbound broadcasts for other files are ignored,
 *     and a `resync` is requested whenever it (re)binds a file.
 *
 * Switching/joining always re-seeds the editor at v0 from the file's base
 * snapshot under a FRESH clientID, then replays the file's full step log
 * (locally for the owner, via `resync` for a reviewer) — so the owner's own
 * past steps in the log rebase in as remote edits rather than colliding with
 * non-existent unconfirmed steps.
 */
export class CollabController {
  private readonly isOwner: boolean;
  private readonly send: SendSignalFn;
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

  // Owner: one authority/host per shared file, grown lazily. Reviewer: unused.
  private readonly hosts = new Map<FileId, CollabHost>();
  // Owner: seeds an authority for a file the owner hasn't opened (a reviewer
  // submitted/resynced it first). Returns that file's base-snapshot doc.
  private readonly getSeedDoc: ((fileId: FileId) => PmNode | null) | null;

  // The file the editor currently shows + its client (owner: the active host's
  // owner-client; reviewer: the wire client). Null until setActiveFile.
  private activeFileId: FileId | null = null;
  private activeClient: CollabClient | null = null;

  constructor(opts: {
    isOwner: boolean;
    send: SendSignalFn;
    /** This editor's collab clientID — stamped on outgoing cursor messages. */
    selfClientId: string;
    /** Label + color for this participant's caret as seen by others. */
    selfLabel: string;
    selfColor: string;
    /** Owner only: base-snapshot doc for a file, to seed an authority lazily. */
    getSeedDoc?: (fileId: FileId) => PmNode | null;
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
    this.getSeedDoc = opts.getSeedDoc ?? null;
    this.onRemoteCursors = opts.onRemoteCursors ?? null;
    this.getLocation = opts.getLocation ?? null;
    this.onPeerLocation = opts.onPeerLocation ?? null;
  }

  /** The active file's authority/local version, for diagnostics. */
  get version(): number {
    if (this.isOwner) {
      const host = this.activeFileId ? this.hosts.get(this.activeFileId) : undefined;
      return host ? host.version : 0;
    }
    return this.activeClient ? this.activeClient.version : 0;
  }

  /**
   * Bind the editor to `fileId`. Call on first activation and on every file
   * switch. `bridge` wraps the editor, which the caller has just re-seeded at
   * collab v0 with this file's base-snapshot doc under a fresh clientID.
   *
   * Owner: detaches the previously-active host's owner-client (its authority
   * keeps running headless), then attaches a fresh owner-client to this file's
   * host and replays the authority's full log so the v0 editor catches up to
   * the current (possibly reviewer-advanced) document.
   *
   * Reviewer: drops the old client, makes a fresh wire client for this file,
   * and requests a resync so the owner replays the file's full log to it.
   */
  setActiveFile(fileId: FileId, bridge: EditorBridge): void {
    if (this.isOwner) {
      if (this.activeFileId !== null && this.activeFileId !== fileId) {
        this.hosts.get(this.activeFileId)?.attachOwnerClient(null);
      }
      const host = this.hostFor(fileId, () => bridge.getState().doc);
      const client = new CollabClient(bridge, (sub) => host.onSubmission(sub));
      host.attachOwnerClient(client);
      this.activeFileId = fileId;
      this.activeClient = client;
      // Catch the freshly-seeded (v0) editor up to the authority's current doc.
      client.receive(host.authority.stepsSince(0));
    } else {
      const client = new CollabClient(bridge, (sub) => this.submitOut(fileId, sub));
      this.activeFileId = fileId;
      this.activeClient = client;
      this.send(JSON.stringify({ kind: 'resync', fileId } satisfies CollabWireMessage));
    }
  }

  /** Owner: the host for `fileId`, created from `seed()` (the v0 doc) if new. */
  private hostFor(fileId: FileId, seed: () => PmNode): CollabHost {
    let host = this.hosts.get(fileId);
    if (host === undefined) {
      host = new CollabHost(new CollabAuthority(seed()), (b) => this.broadcastOut(fileId, b));
      this.hosts.set(fileId, host);
    }
    return host;
  }

  /** Call after every local editor transaction; ships unconfirmed steps. */
  onLocalChange(): void {
    this.activeClient?.syncUp();
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
      // Route to the file's host, creating it on demand if a reviewer reached
      // a file before the owner opened it. `getSeedDoc` yields its v0 base.
      if (msg.kind === 'submit') {
        this.ownerHostFor(msg.fileId)?.onSubmission(msg.submission);
      } else if (msg.kind === 'resync') {
        const host = this.ownerHostFor(msg.fileId);
        if (host) this.broadcastOut(msg.fileId, host.authority.stepsSince(0));
      }
    } else {
      // A reviewer only tracks the file in its editor; ignore other files'
      // steps (it re-seeds + resyncs when it switches to them).
      if (msg.kind === 'broadcast' && msg.fileId === this.activeFileId) {
        this.activeClient?.receive(msg.broadcast);
      }
    }
  }

  /**
   * Owner: the existing host for `fileId`, or one freshly seeded from
   * {@link getSeedDoc} (a reviewer reached this file first). `null` if we have
   * no base snapshot for it yet — the sender will resync once we publish one.
   */
  private ownerHostFor(fileId: FileId): CollabHost | null {
    const existing = this.hosts.get(fileId);
    if (existing) return existing;
    const seedDoc = this.getSeedDoc?.(fileId) ?? null;
    if (seedDoc === null) return null;
    return this.hostFor(fileId, () => seedDoc);
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

  private submitOut(fileId: FileId, submission: CollabSubmission): void {
    this.send(JSON.stringify({ kind: 'submit', fileId, submission } satisfies CollabWireMessage));
  }

  private broadcastOut(fileId: FileId, broadcast: CollabBroadcast): void {
    this.send(JSON.stringify({ kind: 'broadcast', fileId, broadcast } satisfies CollabWireMessage));
  }
}
