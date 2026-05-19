// Live co-typing session controllers — the orchestration layer above
// CollabAuthority.
//
// Two roles, both transport-agnostic (the wire is injected so this is
// DOM-free and unit-testable, and identical whether steps ride mailbox
// `signal` envelopes today or a WebRTC DataChannel later):
//
//   * CollabClient — every participant's editor. Pushes local unconfirmed
//     steps toward the authority (one batch in flight at a time) and applies
//     authoritative broadcasts, rebasing local work on top.
//   * CollabHost — the OWNER only. Wraps CollabAuthority: linearizes inbound
//     submissions and broadcasts the accepted batch to everyone (including
//     the owner's own editor, which is itself a CollabClient).
//
// Spec: planning/collab/ (live channel) + ./collab-authority.ts.

import { getVersion, receiveTransaction, sendableSteps } from 'prosemirror-collab';
import type { EditorState, Transaction } from 'prosemirror-state';

import {
  CollabAuthority,
  deserializeSteps,
  serializeSteps,
  type CollabBroadcast,
  type CollabSubmission,
} from './collab-authority';

/**
 * Minimal editor handle the client drives. Editor.svelte implements this over
 * its `EditorView` (`getState = () => view.state`, `apply = (tr) =>
 * view.dispatch(tr)`); tests implement it over a mutable `EditorState`. Kept
 * deliberately tiny so the controller never imports `prosemirror-view`.
 */
export interface EditorBridge {
  getState(): EditorState;
  apply(tr: Transaction): void;
}

/** Sends a local submission toward the authority (owner). */
export type SubmitFn = (submission: CollabSubmission) => void;

/**
 * Per-editor live-typing controller. Owns the "one batch in flight" discipline
 * that keeps `prosemirror-collab` happy: we don't send a new submission until
 * the authority's broadcast confirms (or rebases) the last one.
 */
export class CollabClient {
  private readonly bridge: EditorBridge;
  private readonly submit: SubmitFn;
  private inflight = false;

  constructor(bridge: EditorBridge, submit: SubmitFn) {
    this.bridge = bridge;
    this.submit = submit;
  }

  /** Current confirmed collab version of the local editor. */
  get version(): number {
    return getVersion(this.bridge.getState());
  }

  /**
   * Call after every local transaction. If there are unconfirmed steps and
   * nothing is in flight, ship them toward the authority.
   */
  syncUp(): void {
    if (this.inflight) return;
    const sendable = sendableSteps(this.bridge.getState());
    if (!sendable) return;
    this.inflight = true;
    this.submit({
      clientID: sendable.clientID,
      version: sendable.version,
      steps: serializeSteps(sendable.steps),
    });
  }

  /**
   * Apply an authoritative broadcast. Broadcasts are at-least-once and carry
   * `startVersion`, so we drop any prefix we already have, then
   * `receiveTransaction` (which rebases our unconfirmed steps and recognizes
   * our own confirmed steps by clientID). Re-checks for more to send after the
   * rebase.
   *
   * Returns `false` if the broadcast starts AFTER our version (we're missing
   * steps — the caller should request a resync); the normal in-order WS
   * delivery path never hits this.
   */
  receive(broadcast: CollabBroadcast): boolean {
    const have = this.version;
    const skip = have - broadcast.startVersion;
    if (skip < 0) {
      // Gap: a batch we haven't seen the predecessors of. Don't apply out of
      // order — surface for resync.
      return false;
    }
    const steps = deserializeSteps(broadcast.steps).slice(skip);
    const clientIDs = broadcast.clientIDs.slice(skip);
    if (steps.length > 0) {
      const state = this.bridge.getState();
      this.bridge.apply(receiveTransaction(state, steps, clientIDs));
    }
    // The batch confirmed (or superseded) whatever we had in flight.
    this.inflight = false;
    this.syncUp();
    return true;
  }
}

/** Broadcasts an accepted batch to every participant. */
export type BroadcastFn = (broadcast: CollabBroadcast) => void;

/**
 * Owner-side session host. Wraps the {@link CollabAuthority}: every inbound
 * submission (from a reviewer over the wire, or from the owner's own editor
 * in-process) is offered to the authority; an accepted batch is broadcast to
 * all participants and replayed into the owner's own editor.
 */
export class CollabHost {
  readonly authority: CollabAuthority;
  private readonly broadcast: BroadcastFn;
  private ownerClient: CollabClient | null = null;

  constructor(authority: CollabAuthority, broadcast: BroadcastFn) {
    this.authority = authority;
    this.broadcast = broadcast;
  }

  /** The current authority version. */
  get version(): number {
    return this.authority.version;
  }

  /**
   * Register the owner's own editor as a client so accepted batches are
   * applied locally (confirming the owner's own steps and surfacing reviewer
   * edits in the owner's editor).
   */
  attachOwnerClient(client: CollabClient): void {
    this.ownerClient = client;
  }

  /**
   * Offer a submission to the authority. On acceptance, broadcast the new
   * batch to the room and replay it into the owner's editor. A rejected
   * (stale) submission is a no-op — the sender will catch up via earlier
   * broadcasts and resubmit.
   */
  onSubmission(submission: CollabSubmission): void {
    const before = this.authority.version;
    const result = this.authority.receiveSteps(
      submission.version,
      deserializeSteps(submission.steps),
      submission.clientID,
    );
    if (!result.accepted) return;
    const batch = this.authority.stepsSince(before);
    this.broadcast(batch);
    this.ownerClient?.receive(batch);
  }
}
