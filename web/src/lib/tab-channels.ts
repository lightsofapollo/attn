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
