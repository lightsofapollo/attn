// Cross-tab BroadcastChannel names shared between the app shells and the
// storage/collab layers. Kept OUTSIDE src/lib/review/ deliberately: shells in
// the app entry's static graph may name these channels (to listen for lease
// releases or local co-editing hubs) without pulling the review/storage graph
// past the route-bundle gate (scripts/check-route-bundles.mjs).

/** Fenced writer-lease doorbell (see review/browser-workspace-lease.ts). */
export const LEASE_CHANNEL_NAME = 'attn-workspace-lease';

/** Local multi-tab co-editing wire, suffixed with the workspaceId
 * (see review/browser-local-collab.ts). */
export const LOCAL_COLLAB_CHANNEL_PREFIX = 'attn:local-collab:v1:';

/**
 * Review inbound-log doorbell, suffixed with the roomId. The workspace
 * lease holder's live session rings it after each durable review-event
 * commit; sibling tabs of the same profile replay the shared IndexedDB
 * log on ring (attn-dgya: a second/reopened tab showed doc content but no
 * comment threads). Advisory only — storage stays the source of truth.
 */
export const REVIEW_INBOUND_CHANNEL_PREFIX = 'attn:review-inbound:v1:';

/**
 * Share-record doorbell, suffixed with the workspaceId (attn-kobw). The
 * sharing coordinator rings it after every durable share-record mutation
 * (publish, republish, room re-provision, revoke, erase) so the workspace
 * review projection in EVERY tab re-discovers roomId/bindings from storage —
 * following a room rotation instead of hydrating a dead room. Advisory only;
 * the share records in IndexedDB stay the source of truth.
 */
export const SHARE_RECORDS_CHANNEL_PREFIX = 'attn:share-records:v1:';

/**
 * Construct a BroadcastChannel, treating an unavailable and a
 * policy-restricted API identically: the constructor itself can throw (e.g.
 * under third-party storage partitioning) even when the global exists.
 * Channels are advisory doorbells everywhere in attn — storage stays the
 * source of truth — so every consumer degrades to `null` instead of letting
 * a throwing constructor abort app or component startup.
 */
export function openBroadcastChannel(name: string): BroadcastChannel | null {
  if (typeof BroadcastChannel === 'undefined') return null;
  try {
    return new BroadcastChannel(name);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Same-tab doorbell delivery (attn-ij9y). BroadcastChannel NEVER delivers a
// message back to the posting context, but the single-projection architecture
// needs exactly that: the leader tab's live session commits durably and rings,
// and the leader tab's OWN projection must replay immediately (not wait for a
// sibling tab's next ring). Ring helpers therefore pair every broadcast with
// this in-process listener registry.
// ---------------------------------------------------------------------------

const localDoorbellListeners = new Map<string, Set<() => void>>();

/** Deliver a doorbell ring to same-tab subscribers of `name`. */
export function ringLocalDoorbell(name: string): void {
  const listeners = localDoorbellListeners.get(name);
  if (!listeners) return;
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // Doorbells are advisory; a throwing subscriber never blocks the rest.
    }
  }
}

/** Subscribe to same-tab rings of `name`. Returns the disposer. */
export function subscribeLocalDoorbell(name: string, listener: () => void): () => void {
  let listeners = localDoorbellListeners.get(name);
  if (!listeners) {
    listeners = new Set();
    localDoorbellListeners.set(name, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) localDoorbellListeners.delete(name);
  };
}

/**
 * One-shot ring: same-tab subscribers first, then a broadcast to sibling
 * tabs. Used by infrequent doorbells (share records); high-frequency ringers
 * (the review-inbound doorbell) keep their own persistent channel and call
 * `ringLocalDoorbell` beside it.
 */
export function ringDoorbell(name: string): void {
  ringLocalDoorbell(name);
  const channel = openBroadcastChannel(name);
  if (!channel) return;
  try {
    // Posted messages are queued to the destination contexts immediately;
    // closing the source channel afterwards does not revoke them.
    channel.postMessage({ name });
  } catch {
    // Advisory only.
  }
  channel.close();
}
