// Cross-tab review-state drift assertion (attn-73xq, guard for attn-whdh).
//
// The single-projection architecture (attn-whdh) makes two tabs of one
// browser materialize identical review state by construction: every tab —
// leader or follower — replays the same durable log through the same
// WorkspaceReviewProjection. This module is the enforcement mechanism: in a
// dev build each tab periodically broadcasts a fingerprint of its review
// store for the active room, and warns LOUDLY if a sibling tab claims the
// same room at the same log position but a different thread set. A silent
// regression that reintroduces a role-dependent read path (the whole family
// of bugs this epic killed) becomes a console error the first time two tabs
// disagree — no user report required.
//
// Dev-only: it is a no-op in production (the fingerprint broadcast and the
// per-tick hashing are pure overhead once the architecture is trusted). The
// assertion never mutates state; it only observes and warns.

import { openBroadcastChannel } from '../tab-channels';

/** Tab-channel prefix (suffixed with workspaceId) for drift fingerprints. */
const DRIFT_CHANNEL_PREFIX = 'attn:review-drift:v1:';

/** Cheap 32-bit FNV-1a over a string — collisions are tolerable (a false
 *  match only misses a warning; a false mismatch is impossible for equal
 *  inputs). Not cryptographic. */
function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** The observable review-state a follower and leader MUST agree on. */
export interface ReviewDriftSource {
  currentRoomId: string | null;
  /** Every review event's (roomId, eventId), order-independent. */
  events: ReadonlyArray<{ meta: { roomId: string; eventId: string } }>;
}

/** A fingerprint of one tab's review store for its active room. */
export interface ReviewDriftFingerprint {
  roomId: string | null;
  /** Count of events scoped to `roomId`. */
  count: number;
  /** Order-independent hash of the room's event ids. */
  eventsHash: number;
}

/**
 * Compute the fingerprint. Order-independent (sums per-id hashes) so two tabs
 * that replayed the same events in a different arrival order still match —
 * the divergence we care about is a DIFFERENT SET of events, never ordering.
 */
export function computeReviewFingerprint(source: ReviewDriftSource): ReviewDriftFingerprint {
  const roomId = source.currentRoomId;
  if (roomId === null) return { roomId: null, count: 0, eventsHash: 0 };
  let count = 0;
  let eventsHash = 0;
  for (const event of source.events) {
    if (event.meta.roomId !== roomId) continue;
    count += 1;
    // XOR of per-id hashes: commutative, so arrival order does not matter.
    eventsHash = (eventsHash ^ fnv1a(event.meta.eventId)) >>> 0;
  }
  return { roomId, count, eventsHash };
}

/** True when two fingerprints for the SAME room disagree — a real drift. */
export function fingerprintsDrifted(
  a: ReviewDriftFingerprint,
  b: ReviewDriftFingerprint,
): boolean {
  // Only same-room fingerprints are comparable: a tab on a different room
  // (mid-rotation, or an unshared workspace) is expected to differ.
  if (a.roomId === null || b.roomId === null || a.roomId !== b.roomId) return false;
  return a.count !== b.count || a.eventsHash !== b.eventsHash;
}

interface DriftMessage {
  tabId: string;
  fingerprint: ReviewDriftFingerprint;
}

/**
 * Start the dev-only drift monitor for a workspace. Returns a disposer. The
 * caller supplies a `read` that snapshots the review store on demand (kept
 * out of this module so it never imports the runes store directly). No-op —
 * returns an inert disposer — outside a dev build.
 */
export function startReviewDriftMonitor(options: {
  workspaceId: string;
  read: () => ReviewDriftSource;
  /** Poll cadence; the store has no change event we can cheaply hook. */
  intervalMs?: number;
  /** Injected for tests; defaults to the module warn. */
  onDrift?: (self: ReviewDriftFingerprint, other: ReviewDriftFingerprint, otherTabId: string) => void;
  /** Test seam: force-enable outside a dev build. */
  enabled?: boolean;
}): () => void {
  const enabled = options.enabled ?? Boolean(import.meta.env?.DEV);
  if (!enabled) return () => undefined;
  const channel = openBroadcastChannel(DRIFT_CHANNEL_PREFIX + options.workspaceId);
  if (!channel) return () => undefined;

  const tabId = `drift-${fnv1a(`${options.workspaceId}:${performanceNow()}:${sequence()}`).toString(16)}`;
  const warn =
    options.onDrift ??
    ((self, other, otherTabId) => {
      console.error(
        '[attn drift] two tabs disagree on the same review room — the single-projection ' +
          'invariant (attn-whdh) is broken. Some read path is materializing review state ' +
          'off the shared durable log.',
        { self, other, otherTabId, tabId },
      );
    });

  const broadcast = (): void => {
    let fingerprint: ReviewDriftFingerprint;
    try {
      fingerprint = computeReviewFingerprint(options.read());
    } catch {
      return; // Never let the monitor throw into the poll loop.
    }
    try {
      channel.postMessage({ tabId, fingerprint } satisfies DriftMessage);
    } catch {
      // Advisory only.
    }
  };

  channel.onmessage = (event: MessageEvent): void => {
    const message = event.data as Partial<DriftMessage> | null;
    if (!message || typeof message.tabId !== 'string' || message.tabId === tabId) return;
    const other = message.fingerprint;
    if (!other || typeof other.count !== 'number') return;
    let self: ReviewDriftFingerprint;
    try {
      self = computeReviewFingerprint(options.read());
    } catch {
      return;
    }
    if (fingerprintsDrifted(self, other)) warn(self, other, message.tabId);
  };

  const interval = options.intervalMs ?? 2_000;
  const timer = setInterval(broadcast, interval);
  broadcast();

  return () => {
    clearInterval(timer);
    channel.onmessage = null;
    channel.close();
  };
}

// `Date.now`/`performance.now` are banned in workflow scripts but fine here —
// this is browser runtime code, not a resumable workflow. Kept behind tiny
// wrappers so the intent (a per-tab-unique id seed) reads clearly.
let seq = 0;
function sequence(): number {
  return (seq = (seq + 1) & 0xffff);
}
function performanceNow(): number {
  return typeof performance !== 'undefined' ? Math.floor(performance.now()) : 0;
}
