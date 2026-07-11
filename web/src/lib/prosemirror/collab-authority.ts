// Owner-as-authority collaborative editing core (live co-typing).
//
// Real-time co-editing uses `prosemirror-collab`, which assumes a single
// central authority that linearizes every client's steps. Under attn's E2E
// encryption the relay only ever sees ciphertext, so it CANNOT be that
// authority. Instead the **document owner's webview** is the authority and
// the relay is a dumb, ordered, encrypted step-pipe:
//
//   reviewer edits ──steps──▶ owner daemon ──▶ owner webview (THIS authority)
//        ▲                                              │
//        └────────── authoritative steps ◀──────────────┘  (broadcast to all)
//
// This module is the transport-agnostic heart of that loop. It holds the
// canonical document + ordered step log and decides accept/reject exactly
// like the `prosemirror-collab` "Authority" example, plus the step
// (de)serialization that lets steps cross the wire as JSON. Everything here
// is pure — no IPC, no encryption — so it can be unit-tested in isolation and
// reused unchanged whether steps arrive over mailbox or a WebRTC channel.
//
// Spec: planning/collab/ (live channel). prosemirror-collab docs:
// https://prosemirror.net/docs/guide/#collab

import type { Node as PmNode } from 'prosemirror-model';
import { Step } from 'prosemirror-transform';

import { schema } from '../schema';

/**
 * A reviewer's (or the owner's own editor's) batch of unconfirmed steps,
 * submitted to the authority. Mirrors `prosemirror-collab`'s
 * `sendableSteps()` output with steps serialized to JSON for the wire.
 */
export interface CollabSubmission {
  /** Stable per-editor id (so the authority can attribute + confirm steps). */
  clientID: string | number;
  /** The authority version these steps are based on. */
  version: number;
  /** `Step.toJSON()` for each step, in order. */
  steps: unknown[];
}

/**
 * An authoritative, ordered batch the owner broadcasts to every participant.
 * `startVersion` is the authority version the batch begins at, so a client
 * can drop steps it already has (broadcasts are at-least-once).
 */
export interface CollabBroadcast {
  startVersion: number;
  steps: unknown[];
  clientIDs: Array<string | number>;
}

/**
 * Workspace-key-sealed persistence payload for one file authority. The base
 * document is deliberately omitted: callers already bind it to `epoch` via
 * the published snapshot, and restore must supply that authenticated base.
 */
export interface CollabCheckpoint {
  v: 1;
  epoch: string;
  version: number;
  steps: unknown[];
  clientIDs: Array<string | number>;
}

/** Candidate state produced without mutating the live authority. */
export interface PreparedCollabBatch {
  readonly expectedVersion: number;
  readonly nextDoc: PmNode;
  readonly steps: readonly Step[];
  readonly clientIDs: ReadonlyArray<string | number>;
  readonly checkpoint: CollabCheckpoint;
}

/** Serialize an array of steps for the wire. */
export function serializeSteps(steps: readonly Step[]): unknown[] {
  return steps.map((step) => step.toJSON());
}

/**
 * Rehydrate steps from the wire against the shared markdown schema. Both
 * daemons compile the SAME `schema` instance, so `Step.fromJSON` round-trips
 * exactly. Throws if a step is malformed (caller surfaces as a resync).
 */
export function deserializeSteps(json: readonly unknown[]): Step[] {
  return json.map((entry) => Step.fromJSON(schema, entry));
}

/** Result of offering a submission to the authority. */
export interface ReceiveResult {
  /**
   * `true` if the steps were based on the current version and applied;
   * `false` if the client was behind (it must receive the intervening
   * broadcast, rebase, and resubmit — the standard collab retry).
   */
  accepted: boolean;
  /** The authority version after this call (unchanged when rejected). */
  version: number;
}

/**
 * The owner-side collaborative authority for one shared document. Holds the
 * canonical doc + the full ordered step log. Pure: it neither encrypts nor
 * transmits — the owner's webview wires {@link receiveSteps} to inbound
 * submissions and broadcasts {@link stepsSince} back out.
 */
export class CollabAuthority {
  readonly epoch: string;
  private currentDoc: PmNode;
  private readonly steps: Step[] = [];
  private readonly stepClientIDs: Array<string | number> = [];

  constructor(doc: PmNode, epoch = 'legacy') {
    if (epoch.length === 0)
      throw new Error('collab authority epoch is required');
    this.epoch = epoch;
    this.currentDoc = doc;
  }

  /**
   * Restore an authority by replaying every checkpoint step against the
   * authenticated base document. Validation is all-or-nothing: malformed
   * metadata, an epoch mismatch, or any non-applying step throws before an
   * authority is returned.
   */
  static fromCheckpoint(
    doc: PmNode,
    epoch: string,
    checkpoint: CollabCheckpoint,
  ): CollabAuthority {
    validateCheckpoint(checkpoint, epoch);
    const restored = new CollabAuthority(doc, epoch);
    const steps = deserializeSteps(checkpoint.steps);
    let nextDoc = doc;
    for (const step of steps) {
      let applied;
      try {
        applied = step.apply(nextDoc);
      } catch {
        throw new Error(
          'collab checkpoint step does not apply to base document',
        );
      }
      if (!applied.doc)
        throw new Error(
          'collab checkpoint step does not apply to base document',
        );
      nextDoc = applied.doc;
    }
    restored.currentDoc = nextDoc;
    restored.steps.push(...steps);
    restored.stepClientIDs.push(...checkpoint.clientIDs);
    return restored;
  }

  /** The canonical document at the latest version. */
  get doc(): PmNode {
    return this.currentDoc;
  }

  /** Monotonic version — equal to the number of accepted steps. */
  get version(): number {
    return this.steps.length;
  }

  /** Immutable serialized state suitable for workspace-key sealing. */
  exportCheckpoint(): CollabCheckpoint {
    return {
      v: 1,
      epoch: this.epoch,
      version: this.version,
      steps: serializeSteps(this.steps),
      clientIDs: [...this.stepClientIDs],
    };
  }

  /**
   * Validate and apply a complete batch against a temporary document. The
   * live document/log are untouched until {@link commitPrepared} is called.
   */
  prepareSteps(
    version: number,
    steps: readonly Step[],
    clientID: string | number,
  ): PreparedCollabBatch | null {
    if (version !== this.version) return null;
    if (steps.length === 0) return null;
    if (!validClientId(clientID)) return null;
    let nextDoc = this.currentDoc;
    for (const step of steps) {
      let applied;
      try {
        applied = step.apply(nextDoc);
      } catch {
        return null;
      }
      if (!applied.doc) return null;
      nextDoc = applied.doc;
    }
    const nextSteps = [...this.steps, ...steps];
    const nextClientIDs = [...this.stepClientIDs, ...steps.map(() => clientID)];
    return {
      expectedVersion: version,
      nextDoc,
      steps: [...steps],
      clientIDs: steps.map(() => clientID),
      checkpoint: {
        v: 1,
        epoch: this.epoch,
        version: nextSteps.length,
        steps: serializeSteps(nextSteps),
        clientIDs: nextClientIDs,
      },
    };
  }

  /** Commit a previously prepared batch, failing closed if state advanced. */
  commitPrepared(prepared: PreparedCollabBatch): void {
    if (prepared.expectedVersion !== this.version) {
      throw new Error('collab authority advanced before prepared batch commit');
    }
    this.currentDoc = prepared.nextDoc;
    this.steps.push(...prepared.steps);
    this.stepClientIDs.push(...prepared.clientIDs);
  }

  /**
   * Offer a client's steps. Accepts iff `version` matches the current
   * authority version (no concurrent batch slipped in first); otherwise the
   * client is stale and must catch up before resubmitting. Each accepted
   * step is applied to the canonical doc and appended to the log.
   */
  receiveSteps(
    version: number,
    steps: readonly Step[],
    clientID: string | number,
  ): ReceiveResult {
    const prepared = this.prepareSteps(version, steps, clientID);
    if (!prepared) return { accepted: false, version: this.version };
    this.commitPrepared(prepared);
    return { accepted: true, version: this.version };
  }

  /**
   * The authoritative steps a client at `version` is missing, ready to
   * broadcast. The client applies them via `receiveTransaction`, which also
   * recognizes its own steps (matched by `clientID`) as confirmation.
   */
  stepsSince(version: number): CollabBroadcast {
    return {
      startVersion: version,
      steps: serializeSteps(this.steps.slice(version)),
      clientIDs: this.stepClientIDs.slice(version),
    };
  }
}

function validateCheckpoint(checkpoint: CollabCheckpoint, epoch: string): void {
  if (!checkpoint || checkpoint.v !== 1)
    throw new Error('invalid collab checkpoint version');
  if (checkpoint.epoch !== epoch)
    throw new Error('collab checkpoint epoch mismatch');
  if (!Number.isSafeInteger(checkpoint.version) || checkpoint.version < 0) {
    throw new Error('invalid collab checkpoint version counter');
  }
  if (
    !Array.isArray(checkpoint.steps) ||
    !Array.isArray(checkpoint.clientIDs)
  ) {
    throw new Error('invalid collab checkpoint arrays');
  }
  if (
    checkpoint.steps.length !== checkpoint.clientIDs.length ||
    checkpoint.version !== checkpoint.steps.length
  ) {
    throw new Error('collab checkpoint log lengths do not match');
  }
  for (const clientID of checkpoint.clientIDs) {
    if (
      !(
        (typeof clientID === 'string' &&
          clientID.length > 0 &&
          new TextEncoder().encode(clientID).length <= 256) ||
        (typeof clientID === 'number' &&
          Number.isSafeInteger(clientID) &&
          clientID >= 0)
      )
    ) {
      throw new Error('invalid collab checkpoint client id');
    }
  }
}

function validClientId(clientID: string | number): boolean {
  return (
    (typeof clientID === 'string' &&
      clientID.length > 0 &&
      new TextEncoder().encode(clientID).length <= 256) ||
    (typeof clientID === 'number' &&
      Number.isSafeInteger(clientID) &&
      clientID >= 0)
  );
}
