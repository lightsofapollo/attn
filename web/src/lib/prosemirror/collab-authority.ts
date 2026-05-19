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
  private currentDoc: PmNode;
  private readonly steps: Step[] = [];
  private readonly stepClientIDs: Array<string | number> = [];

  constructor(doc: PmNode) {
    this.currentDoc = doc;
  }

  /** The canonical document at the latest version. */
  get doc(): PmNode {
    return this.currentDoc;
  }

  /** Monotonic version — equal to the number of accepted steps. */
  get version(): number {
    return this.steps.length;
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
    if (version !== this.version) {
      return { accepted: false, version: this.version };
    }
    for (const step of steps) {
      const applied = step.apply(this.currentDoc);
      if (!applied.doc) {
        // A step that doesn't apply cleanly against the canonical doc is a
        // protocol violation (corruption / schema drift). Reject the whole
        // batch rather than persist a partial, divergent state.
        return { accepted: false, version: this.version };
      }
      this.currentDoc = applied.doc;
      this.steps.push(step);
      this.stepClientIDs.push(clientID);
    }
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
