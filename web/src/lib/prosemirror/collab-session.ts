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

import {
  getVersion,
  receiveTransaction,
  sendableSteps,
} from 'prosemirror-collab';
import type { EditorState, Transaction } from 'prosemirror-state';

import {
  CollabAuthority,
  deserializeSteps,
  serializeSteps,
  type CollabBroadcast,
  type CollabCheckpoint,
  type CollabSubmission,
  type PreparedCollabBatch,
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
export type SubmitFn = (submission: CollabSubmission) => unknown;

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
    try {
      const pending = this.submit({
        clientID: sendable.clientID,
        version: sendable.version,
        steps: serializeSteps(sendable.steps),
      });
      if (
        pending !== null &&
        typeof pending === 'object' &&
        'then' in pending &&
        typeof pending.then === 'function'
      ) {
        void Promise.resolve(pending).catch(() => {
          this.inflight = false;
        });
      }
    } catch {
      this.inflight = false;
    }
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
    const end = broadcast.startVersion + broadcast.steps.length;
    if (!Number.isSafeInteger(end) || end < have) return false;
    const skip = have - broadcast.startVersion;
    if (skip < 0) {
      // Gap: a batch we haven't seen the predecessors of. Don't apply out of
      // order — surface for resync.
      return false;
    }
    let steps;
    try {
      steps = deserializeSteps(broadcast.steps).slice(skip);
    } catch {
      return false;
    }
    const clientIDs = broadcast.clientIDs.slice(skip);
    if (steps.length > 0) {
      try {
        const state = this.bridge.getState();
        this.bridge.apply(receiveTransaction(state, steps, clientIDs));
      } catch {
        return false;
      }
    }
    // The batch confirmed (or superseded) whatever we had in flight.
    this.inflight = false;
    this.syncUp();
    return true;
  }
}

/** Broadcasts an accepted batch to every participant. */
export type BroadcastFn = (broadcast: CollabBroadcast) => void | Promise<void>;

/** Persists a candidate checkpoint before the live authority may advance. */
export type PersistCheckpointFn = (
  checkpoint: CollabCheckpoint,
  expectedVersion: number,
) => Promise<void>;

export interface HostSubmissionResult {
  status: 'accepted' | 'catchup' | 'invalid' | 'paused';
  version: number;
}

/**
 * Owner-side session host. Wraps the {@link CollabAuthority}: every inbound
 * submission (from a reviewer over the wire, or from the owner's own editor
 * in-process) is offered to the authority; an accepted batch is broadcast to
 * all participants and replayed into the owner's own editor.
 */
export class CollabHost {
  readonly authority: CollabAuthority;
  private readonly broadcast: BroadcastFn;
  private readonly persistCheckpoint: PersistCheckpointFn | null;
  private ownerClient: CollabClient | null = null;
  private serial: Promise<unknown> = Promise.resolve();
  private persistenceError: Error | null = null;

  constructor(
    authority: CollabAuthority,
    broadcast: BroadcastFn,
    persistCheckpoint?: PersistCheckpointFn,
  ) {
    this.authority = authority;
    this.broadcast = broadcast;
    this.persistCheckpoint = persistCheckpoint ?? null;
  }

  /** The current authority version. */
  get version(): number {
    return this.authority.version;
  }

  /** A persistence failure pauses this host until it is rebuilt/restored. */
  get paused(): boolean {
    return this.persistenceError !== null;
  }

  get pauseReason(): string | null {
    return this.persistenceError?.message ?? null;
  }

  /**
   * Register the owner's own editor as a client so accepted batches are
   * applied locally (confirming the owner's own steps and surfacing reviewer
   * edits in the owner's editor). Pass `null` to DETACH — used when the owner
   * navigates away from this file: the authority keeps accepting reviewers'
   * steps in the background, but there's no live editor to replay them into
   * (replaying into a destroyed view would throw), so we drop the owner-client
   * until the owner returns and re-attaches a fresh one.
   */
  attachOwnerClient(client: CollabClient | null): void {
    this.ownerClient = client;
  }

  /**
   * Offer a submission to the authority. On acceptance, broadcast the new
   * batch to the room and replay it into the owner's editor. A rejected
   * (stale) submission is a no-op — the sender will catch up via earlier
   * broadcasts and resubmit.
   */
  onSubmission(submission: CollabSubmission): Promise<HostSubmissionResult> {
    // Preserve the existing synchronous fast path when no durable checkpoint
    // store is configured. Browser owners supply `persistCheckpoint`, which
    // uses the serialized path below.
    if (this.persistCheckpoint === null) {
      try {
        return Promise.resolve(this.processImmediate(submission));
      } catch {
        return Promise.resolve({ status: 'invalid', version: this.version });
      }
    }

    const task = this.serial.then(() => this.processPersisted(submission));
    // A rejected task must not poison the queue: the host itself enters a
    // terminal paused state and later submissions receive `paused`.
    this.serial = task.catch(() => undefined);
    return task;
  }

  private processImmediate(submission: CollabSubmission): HostSubmissionResult {
    if (this.persistenceError)
      return { status: 'paused', version: this.version };
    const prepared = this.prepare(submission);
    if (prepared === 'invalid')
      return { status: 'invalid', version: this.version };
    if (prepared === null) {
      void this.broadcastBestEffort(this.catchupFor(submission.version));
      return { status: 'catchup', version: this.version };
    }
    const before = this.authority.version;
    this.authority.commitPrepared(prepared);
    const batch = this.authority.stepsSince(before);
    this.ownerClient?.receive(batch);
    void this.broadcastBestEffort(batch);
    return { status: 'accepted', version: this.version };
  }

  private async processPersisted(
    submission: CollabSubmission,
  ): Promise<HostSubmissionResult> {
    if (this.persistenceError)
      return { status: 'paused', version: this.version };
    const prepared = this.prepare(submission);
    if (prepared === 'invalid')
      return { status: 'invalid', version: this.version };
    if (prepared === null) {
      await this.broadcastBestEffort(this.catchupFor(submission.version));
      return { status: 'catchup', version: this.version };
    }
    try {
      await this.persistCheckpoint!(
        prepared.checkpoint,
        prepared.expectedVersion,
      );
    } catch (error) {
      this.persistenceError =
        error instanceof Error ? error : new Error(String(error));
      return { status: 'paused', version: this.version };
    }
    const before = this.authority.version;
    this.authority.commitPrepared(prepared);
    const batch = this.authority.stepsSince(before);
    this.ownerClient?.receive(batch);
    // Persistence + authority commit are already durable. A transient
    // transport failure must not strand the owner's own editor in-flight;
    // peers recover through catch-up/resync.
    await this.broadcastBestEffort(batch);
    return { status: 'accepted', version: this.version };
  }

  private async broadcastBestEffort(broadcast: CollabBroadcast): Promise<void> {
    try {
      await this.broadcast(broadcast);
    } catch {
      // The checkpoint/authority is already durable. Peers recover through
      // their next resync; transport failure must not reject the host queue.
    }
  }

  private prepare(
    submission: CollabSubmission,
  ): PreparedCollabBatch | null | 'invalid' {
    if (submission.version !== this.version) return null;
    if (submission.steps.length === 0) return 'invalid';
    let steps;
    try {
      steps = deserializeSteps(submission.steps);
    } catch {
      return 'invalid';
    }
    return (
      this.authority.prepareSteps(
        submission.version,
        steps,
        submission.clientID,
      ) ?? 'invalid'
    );
  }

  private catchupFor(requestedVersion: number): CollabBroadcast {
    const from =
      Number.isSafeInteger(requestedVersion) &&
      requestedVersion >= 0 &&
      requestedVersion <= this.version
        ? requestedVersion
        : 0;
    return this.authority.stepsSince(from);
  }
}
