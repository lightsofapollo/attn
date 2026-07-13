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
  type CollabCheckpoint,
  type CollabSubmission,
} from './collab-authority';
import { CollabClient, CollabHost, type EditorBridge } from './collab-session';
import type { FileId, SnapshotId } from '../types';

export interface CollabPeerLocation {
  fileId?: FileId;
  snapshotId?: SnapshotId;
  path?: string;
}

export interface CollabAuthoritySeed {
  /** Published snapshot generation that authenticated `doc`. */
  epoch: string;
  baseSnapshotId: string;
  doc: PmNode;
  checkpoint: CollabCheckpoint | null;
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
  | {
      kind: 'submit';
      fileId: FileId;
      epoch: string;
      submission: CollabSubmission;
    }
  | {
      kind: 'broadcast';
      fileId: FileId;
      epoch: string;
      broadcast: CollabBroadcast;
    }
  | { kind: 'resync'; fileId: FileId; epoch: string }
  | { kind: 'cursor'; cursor: RemoteCursor };

export const MAX_COLLAB_WIRE_BYTES = 262_144;
const MAX_COLLAB_STEPS = 1_024;
const MAX_WIRE_ID_CHARS = 256;

/** Sends an already-serialized wire message to the room. */
export type SendSignalFn = (payload: string) => unknown;

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
  /** Mutable: the NamePrompt can rename the user AFTER collab starts —
   *  see `setSelfLabel`. */
  private selfLabel: string;
  private readonly selfColor: string;
  /** Last caret head broadcast, so a label change can re-announce the
   *  caret in place instead of waiting for the next caret move. */
  private lastCursorHead: number | null = null;
  private readonly onRemoteCursors: ((cursors: RemoteCursor[]) => void) | null;
  private readonly getLocation: (() => CollabPeerLocation | null) | null;
  private readonly onPeerLocation:
    | ((deviceId: string, location: CollabPeerLocation) => void)
    | null;
  private readonly remoteCursors = new Map<string, RemoteCursor>();
  // clientID → sender deviceId, so a peer's caret can be cleared on leave
  // (presence frames identify peers by deviceId, cursors by collab clientID).
  private readonly cursorDevice = new Map<string, string>();

  // Owner: one authority/host per shared file, grown lazily. Reviewer: unused.
  private readonly hosts = new Map<
    FileId,
    { epoch: string; host: CollabHost }
  >();
  // Owner: seeds an authority for a file the owner hasn't opened (a reviewer
  // submitted/resynced it first). Returns that file's base-snapshot doc.
  private readonly getSeedDoc: ((fileId: FileId) => PmNode | null) | null;
  private readonly getAuthorityEpoch:
    | ((fileId: FileId) => string | null)
    | null;
  private readonly getAuthoritySeed:
    | ((fileId: FileId, epoch: string) => CollabAuthoritySeed | null)
    | null;
  private readonly persistCheckpoint:
    | ((
        fileId: FileId,
        epoch: string,
        checkpoint: CollabCheckpoint,
        expectedVersion: number,
      ) => Promise<void>)
    | null;
  private readonly onEpochMismatch:
    | ((fileId: FileId, expected: string, received: string) => void)
    | null;
  private readonly onAuthorityPaused:
    | ((fileId: FileId, reason: string) => void)
    | null;
  private readonly isAuthorityDevice: ((deviceId: string) => boolean) | null;

  // The file the editor currently shows + its client (owner: the active host's
  // owner-client; reviewer: the wire client). Null until setActiveFile.
  private activeFileId: FileId | null = null;
  private activeEpoch: string | null = null;
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
    /** Published snapshot id that defines the authority generation per file. */
    getAuthorityEpoch?: (fileId: FileId) => string | null;
    /** Atomically returns the authenticated published base and its checkpoint. */
    getAuthoritySeed?: (
      fileId: FileId,
      epoch: string,
    ) => CollabAuthoritySeed | null;
    /** Owner-only durable checkpoint sink; resolves before any broadcast. */
    persistCheckpoint?: (
      fileId: FileId,
      epoch: string,
      checkpoint: CollabCheckpoint,
      expectedVersion: number,
    ) => Promise<void>;
    /** Notifies the shell that a peer is bound to another published snapshot. */
    onEpochMismatch?: (
      fileId: FileId,
      expected: string,
      received: string,
    ) => void;
    /** Surfaces a fail-closed checkpoint error so the shell can pause visibly. */
    onAuthorityPaused?: (fileId: FileId, reason: string) => void;
    /** Reviewer-only authenticated directory check for owner broadcasts. */
    isAuthorityDevice?: (deviceId: string) => boolean;
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
    this.getAuthorityEpoch = opts.getAuthorityEpoch ?? null;
    this.getAuthoritySeed = opts.getAuthoritySeed ?? null;
    this.persistCheckpoint = opts.persistCheckpoint ?? null;
    this.onEpochMismatch = opts.onEpochMismatch ?? null;
    this.onAuthorityPaused = opts.onAuthorityPaused ?? null;
    this.isAuthorityDevice = opts.isAuthorityDevice ?? null;
    this.onRemoteCursors = opts.onRemoteCursors ?? null;
    this.getLocation = opts.getLocation ?? null;
    this.onPeerLocation = opts.onPeerLocation ?? null;
  }

  /** The file the local editor is currently bound to (null before setActiveFile). */
  get activeFile(): FileId | null {
    return this.activeFileId;
  }

  /**
   * Owner: the live authority document for a hosted file, or null when no
   * authority exists for it. Lets a persistence layer serialize the canonical
   * doc (e.g. the local multi-tab hub committing headless files).
   */
  authorityDoc(fileId: FileId): PmNode | null {
    return this.hosts.get(fileId)?.host.authority.doc ?? null;
  }

  /** The active file's authority/local version, for diagnostics. */
  get version(): number {
    if (this.isOwner) {
      const entry = this.activeFileId
        ? this.hosts.get(this.activeFileId)
        : undefined;
      return entry ? entry.host.version : 0;
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
  setActiveFile(fileId: FileId, bridge: EditorBridge, epoch?: string): void {
    const nextEpoch = this.resolveEpoch(fileId, epoch);
    if (this.isOwner) {
      if (!isLegacyEpoch(fileId, nextEpoch)) {
        const authenticated = this.getAuthoritySeed?.(fileId, nextEpoch) ?? null;
        if (
          !authenticated ||
          authenticated.epoch !== nextEpoch ||
          authenticated.baseSnapshotId !== nextEpoch ||
          !bridge.getState().doc.eq(authenticated.doc)
        ) {
          throw new Error('owner editor does not match its authenticated collab base');
        }
      }
      if (this.activeFileId !== null && this.activeFileId !== fileId) {
        this.hosts.get(this.activeFileId)?.host.attachOwnerClient(null);
      }
      const host = this.hostFor(fileId, nextEpoch, () => bridge.getState().doc);
      const client = new CollabClient(bridge, (sub) =>
        this.submitToHost(fileId, host, sub),
      );
      host.attachOwnerClient(client);
      this.activeFileId = fileId;
      this.activeEpoch = nextEpoch;
      this.activeClient = client;
      // Catch the freshly-seeded (v0) editor up to the authority's current doc.
      client.receive(host.authority.stepsSince(0));
    } else {
      const client = new CollabClient(bridge, (sub) =>
        this.submitOut(fileId, sub),
      );
      this.activeFileId = fileId;
      this.activeEpoch = nextEpoch;
      this.activeClient = client;
      this.resyncOut(fileId);
    }
  }

  /** Owner: the host for `fileId`, created from `seed()` (the v0 doc) if new. */
  private hostFor(
    fileId: FileId,
    epoch: string,
    seed: () => PmNode,
  ): CollabHost {
    let entry = this.hosts.get(fileId);
    if (entry !== undefined && entry.epoch !== epoch) {
      entry.host.attachOwnerClient(null);
      this.hosts.delete(fileId);
      entry = undefined;
    }
    if (entry === undefined) {
      let baseDoc: PmNode;
      let checkpoint: CollabCheckpoint | null;
      if (isLegacyEpoch(fileId, epoch)) {
        baseDoc = seed();
        checkpoint = null;
      } else {
        const authenticated = this.getAuthoritySeed?.(fileId, epoch) ?? null;
        if (
          !authenticated ||
          authenticated.epoch !== epoch ||
          authenticated.baseSnapshotId !== epoch
        ) {
          throw new Error('authenticated collab authority seed is unavailable');
        }
        baseDoc = authenticated.doc;
        checkpoint = authenticated.checkpoint;
      }
      const authority = checkpoint
        ? CollabAuthority.fromCheckpoint(baseDoc, epoch, checkpoint)
        : new CollabAuthority(baseDoc, epoch);
      const host = new CollabHost(
        authority,
        (broadcast) => this.broadcastOut(fileId, epoch, broadcast),
        this.persistCheckpoint
          ? (checkpoint, expectedVersion) =>
              this.persistCheckpoint!(
                fileId,
                epoch,
                checkpoint,
                expectedVersion,
              )
          : undefined,
      );
      entry = { epoch, host };
      this.hosts.set(fileId, entry);
    }
    return entry.host;
  }

  /** Call after every local editor transaction; ships unconfirmed steps. */
  onLocalChange(): void {
    this.activeClient?.syncUp();
  }

  /** Re-establish reviewer catch-up after a transport reconnect. */
  onTransportConnected(): void {
    if (!this.isOwner && this.activeFileId !== null)
      this.resyncOut(this.activeFileId);
  }

  /**
   * Broadcast this editor's caret position to the room. Sent on the same
   * signal channel as steps but OUTSIDE the authority — cursors are presence,
   * not document mutations. Every participant (owner + reviewers) both sends
   * and receives these.
   */
  broadcastCursor(head: number): void {
    this.lastCursorHead = head;
    const location = this.getLocation?.() ?? undefined;
    void this.sendWire({
      kind: 'cursor',
      cursor: {
        clientID: this.selfClientId,
        head,
        label: this.selfLabel,
        color: this.selfColor,
        ...(location ? { location } : {}),
      },
    }).catch(() => undefined);
  }

  /**
   * Update the caret label mid-session. The onboarding NamePrompt fires
   * AFTER a room is entered, so the construction-time label (the git/OS
   * default) goes stale the moment the user picks a real name — peers'
   * caret chips kept showing the old name. Re-broadcasts the last caret
   * position so the rename lands immediately instead of on the next
   * caret move.
   */
  setSelfLabel(label: string): void {
    const trimmed = label.trim();
    if (trimmed.length === 0 || trimmed === this.selfLabel) return;
    this.selfLabel = trimmed;
    if (this.lastCursorHead !== null) {
      this.broadcastCursor(this.lastCursorHead);
    }
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
    const msg = parseCollabWireMessage(payload, (fileId) => {
      const expected = this.isOwner
        ? this.resolveEpoch(fileId)
        : fileId === this.activeFileId
          ? this.activeEpoch
          : null;
      return expected && isLegacyEpoch(fileId, expected) ? expected : null;
    });
    if (!msg) return;
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
      const expectedEpoch = this.resolveEpoch(msg.fileId);
      if (msg.epoch !== expectedEpoch) {
        this.onEpochMismatch?.(msg.fileId, expectedEpoch, msg.epoch);
        return;
      }
      // Route to the file's host, creating it on demand if a reviewer reached
      // a file before the owner opened it. `getSeedDoc` yields its v0 base.
      if (msg.kind === 'submit') {
        const host = this.ownerHostFor(msg.fileId, expectedEpoch);
        if (host) this.submitToHost(msg.fileId, host, msg.submission);
      } else if (msg.kind === 'resync') {
        const host = this.ownerHostFor(msg.fileId, expectedEpoch);
        if (host)
          void this.broadcastOut(
            msg.fileId,
            expectedEpoch,
            host.authority.stepsSince(0),
          ).catch(() => undefined);
      }
    } else {
      // A reviewer only tracks the file in its editor; ignore other files'
      // steps (it re-seeds + resyncs when it switches to them).
      if (msg.kind === 'broadcast' && msg.fileId === this.activeFileId) {
        // The E2EE room admits multiple signing devices, but only a device
        // registered as owner may linearize authoritative document steps.
        // Missing directory context fails closed.
        if (!this.isAuthorityDevice?.(fromDeviceId)) return;
        const expectedEpoch = this.activeEpoch ?? this.resolveEpoch(msg.fileId);
        if (msg.epoch !== expectedEpoch) {
          this.onEpochMismatch?.(msg.fileId, expectedEpoch, msg.epoch);
          return;
        }
        if (this.activeClient?.receive(msg.broadcast) === false)
          this.resyncOut(msg.fileId);
      }
    }
  }

  /**
   * Owner: the existing host for `fileId`, or one freshly seeded from
   * {@link getSeedDoc} (a reviewer reached this file first). `null` if we have
   * no base snapshot for it yet — the sender will resync once we publish one.
   */
  private ownerHostFor(fileId: FileId, epoch: string): CollabHost | null {
    const existing = this.hosts.get(fileId);
    if (existing?.epoch === epoch) return existing.host;
    if (!isLegacyEpoch(fileId, epoch)) {
      try {
        return this.hostFor(fileId, epoch, () => {
          throw new Error('non-legacy authority cannot use an unauthenticated seed');
        });
      } catch {
        return null;
      }
    }
    const seedDoc = this.getSeedDoc?.(fileId) ?? null;
    if (seedDoc === null) return null;
    return this.hostFor(fileId, epoch, () => seedDoc);
  }

  private submitToHost(
    fileId: FileId,
    host: CollabHost,
    submission: CollabSubmission,
  ): void {
    void host
      .onSubmission(submission)
      .then((result) => {
        if (result.status === 'paused') {
          this.onAuthorityPaused?.(
            fileId,
            host.pauseReason ?? 'collaboration checkpoint persistence failed',
          );
        }
      })
      .catch((error: unknown) => {
        this.onAuthorityPaused?.(
          fileId,
          error instanceof Error ? error.message : 'collaboration authority failed',
        );
      });
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

  private submitOut(
    fileId: FileId,
    submission: CollabSubmission,
  ): Promise<void> {
    const epoch = this.activeEpoch ?? this.resolveEpoch(fileId);
    return this.sendWire({
      kind: 'submit',
      fileId,
      epoch,
      submission,
    });
  }

  private broadcastOut(
    fileId: FileId,
    epoch: string,
    broadcast: CollabBroadcast,
  ): Promise<void> {
    return this.sendWire({
      kind: 'broadcast',
      fileId,
      epoch,
      broadcast,
    });
  }

  private resyncOut(fileId: FileId): void {
    const epoch = this.activeEpoch ?? this.resolveEpoch(fileId);
    void this.sendWire({
      kind: 'resync',
      fileId,
      epoch,
    }).catch(() => undefined);
  }

  private sendWire(message: CollabWireMessage): Promise<void> {
    try {
      return Promise.resolve(this.send(JSON.stringify(message))).then(
        () => undefined,
      );
    } catch (error) {
      return Promise.reject(error);
    }
  }

  private resolveEpoch(fileId: FileId, explicit?: string): string {
    const epoch =
      explicit ?? this.getAuthorityEpoch?.(fileId) ?? `legacy:${fileId}`;
    if (!boundedString(epoch, MAX_WIRE_ID_CHARS, false)) {
      throw new Error('collab authority epoch is invalid');
    }
    return epoch;
  }
}

/** Parse untrusted room-member input without allowing exceptions into UI code. */
export function parseCollabWireMessage(
  payload: string,
  legacyEpochForFile?: (fileId: FileId) => string | null,
): CollabWireMessage | null {
  if (
    typeof payload !== 'string' ||
    byteLength(payload) > MAX_COLLAB_WIRE_BYTES
  )
    return null;
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    return null;
  }
  if (!isRecord(value) || typeof value.kind !== 'string') return null;
  if (value.kind === 'cursor') return parseCursor(value);
  if (
    value.kind !== 'submit' &&
    value.kind !== 'broadcast' &&
    value.kind !== 'resync'
  )
    return null;
  if (!wireId(value.fileId)) return null;
  const fileId = value.fileId as FileId;
  const suppliedEpoch = value.epoch;
  const epoch = wireId(suppliedEpoch)
    ? suppliedEpoch
    : suppliedEpoch === undefined
      ? legacyEpochForFile?.(fileId) ?? null
      : null;
  if (!epoch || !wireId(epoch)) return null;
  const hasEpoch = suppliedEpoch !== undefined;
  if (value.kind === 'resync') {
    if (
      !hasExactKeys(
        value,
        hasEpoch ? ['kind', 'fileId', 'epoch'] : ['kind', 'fileId'],
      )
    )
      return null;
    return { kind: 'resync', fileId, epoch };
  }
  if (value.kind === 'submit') {
    if (
      !hasExactKeys(
        value,
        hasEpoch
          ? ['kind', 'fileId', 'epoch', 'submission']
          : ['kind', 'fileId', 'submission'],
      )
    )
      return null;
    const submission = parseSubmission(value.submission);
    return submission ? { kind: 'submit', fileId, epoch, submission } : null;
  }
  if (
    !hasExactKeys(
      value,
      hasEpoch
        ? ['kind', 'fileId', 'epoch', 'broadcast']
        : ['kind', 'fileId', 'broadcast'],
    )
  )
    return null;
  const broadcast = parseBroadcast(value.broadcast);
  return broadcast ? { kind: 'broadcast', fileId, epoch, broadcast } : null;
}

function parseSubmission(value: unknown): CollabSubmission | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['clientID', 'version', 'steps'])
  )
    return null;
  if (!clientId(value.clientID) || !nonNegativeInteger(value.version))
    return null;
  if (!Array.isArray(value.steps) || value.steps.length > MAX_COLLAB_STEPS)
    return null;
  return {
    clientID: value.clientID,
    version: value.version,
    steps: value.steps,
  };
}

function parseBroadcast(value: unknown): CollabBroadcast | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['startVersion', 'steps', 'clientIDs'])
  )
    return null;
  if (!nonNegativeInteger(value.startVersion)) return null;
  if (
    !Array.isArray(value.steps) ||
    !Array.isArray(value.clientIDs) ||
    value.steps.length > MAX_COLLAB_STEPS ||
    value.steps.length !== value.clientIDs.length ||
    !value.clientIDs.every(clientId)
  )
    return null;
  return {
    startVersion: value.startVersion,
    steps: value.steps,
    clientIDs: value.clientIDs,
  };
}

function parseCursor(value: Record<string, unknown>): CollabWireMessage | null {
  if (!hasExactKeys(value, ['kind', 'cursor']) || !isRecord(value.cursor))
    return null;
  const cursor = value.cursor;
  if (!hasOnlyKeys(cursor, ['clientID', 'head', 'label', 'color', 'location']))
    return null;
  if (
    typeof cursor.clientID !== 'string' ||
    !wireId(cursor.clientID) ||
    !nonNegativeInteger(cursor.head) ||
    !boundedString(cursor.label, 256, true) ||
    !boundedString(cursor.color, 64, false)
  )
    return null;
  const location = parseLocation(cursor.location);
  if (cursor.location !== undefined && location === null) return null;
  return {
    kind: 'cursor',
    cursor: {
      clientID: cursor.clientID,
      head: cursor.head,
      label: cursor.label,
      color: cursor.color,
      ...(location ? { location } : {}),
    },
  };
}

function parseLocation(value: unknown): CollabPeerLocation | null | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || !hasOnlyKeys(value, ['fileId', 'snapshotId', 'path']))
    return null;
  if (value.fileId !== undefined && !wireId(value.fileId)) return null;
  if (value.snapshotId !== undefined && !wireId(value.snapshotId)) return null;
  if (value.path !== undefined && !boundedString(value.path, 1_024, true))
    return null;
  return {
    ...(value.fileId === undefined ? {} : { fileId: value.fileId as FileId }),
    ...(value.snapshotId === undefined
      ? {}
      : { snapshotId: value.snapshotId as SnapshotId }),
    ...(value.path === undefined ? {} : { path: value.path }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: string[],
): boolean {
  const actual = Object.keys(value);
  return (
    actual.length === expected.length && expected.every((key) => key in value)
  );
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: string[],
): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function wireId(value: unknown): value is string {
  return boundedString(value, MAX_WIRE_ID_CHARS, false);
}

function clientId(value: unknown): value is string | number {
  return (
    wireId(value) ||
    (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
  );
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function boundedString(
  value: unknown,
  maxBytes: number,
  allowEmpty: boolean,
): value is string {
  return (
    typeof value === 'string' &&
    (allowEmpty || value.length > 0) &&
    byteLength(value) <= maxBytes
  );
}

function isLegacyEpoch(fileId: FileId, epoch: string): boolean {
  return epoch === `legacy:${fileId}`;
}
