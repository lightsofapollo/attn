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

/** Tagged wire envelope carried inside a SignalingPayload::Collab payload. */
export type CollabWireMessage =
  | { kind: 'submit'; submission: CollabSubmission }
  | { kind: 'broadcast'; broadcast: CollabBroadcast };

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

  constructor(opts: {
    bridge: EditorBridge;
    isOwner: boolean;
    /** Seed doc for the authority (owner only) — must equal the editor's v0 doc. */
    initialDoc: PmNode;
    send: SendSignalFn;
  }) {
    this.isOwner = opts.isOwner;
    this.send = opts.send;

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
   * Handle an inbound wire message. The owner consumes `submit`s (and ignores
   * `broadcast` echoes it authored); a reviewer consumes `broadcast`s (and
   * ignores other reviewers' `submit`s, since it isn't the authority).
   */
  onInbound(payload: string): void {
    let msg: CollabWireMessage;
    try {
      msg = JSON.parse(payload) as CollabWireMessage;
    } catch {
      return; // malformed — drop (a resync will recover live state)
    }
    if (this.isOwner) {
      if (msg.kind === 'submit') this.host!.onSubmission(msg.submission);
    } else {
      if (msg.kind === 'broadcast') this.client.receive(msg.broadcast);
    }
  }

  private submitOut(submission: CollabSubmission): void {
    this.send(JSON.stringify({ kind: 'submit', submission } satisfies CollabWireMessage));
  }

  private broadcastOut(broadcast: CollabBroadcast): void {
    this.send(JSON.stringify({ kind: 'broadcast', broadcast } satisfies CollabWireMessage));
  }
}
