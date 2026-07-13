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
