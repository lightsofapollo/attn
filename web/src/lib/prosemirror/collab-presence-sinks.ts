import { untrack } from 'svelte';

import type {
  CollabController,
  CollabPeerLocation,
  RemoteCursor,
} from './collab-controller';

type PresenceSinkController = Pick<
  CollabController,
  | 'setRemoteCursorSink'
  | 'setPeerLocationSink'
  | 'setPeerLocationExpirySink'
  | 'setLocationSource'
>;

export interface CollabPresenceSinks {
  onRemoteCursors: (cursors: RemoteCursor[]) => void;
  onPeerLocation: (deviceId: string, location: CollabPeerLocation) => void;
  onPeerLocationExpired: (deviceId: string) => void;
  getLocation: () => CollabPeerLocation | null;
}

/**
 * Attach the shell's late-bound presence bridges without leaking synchronous
 * replay reads into the caller's Svelte effect dependencies.
 *
 * Both cursor and peer-location setters replay retained presence immediately.
 * Their callbacks update editor/store state, so attaching them inside an
 * effect's tracking window makes that effect depend on state it just changed
 * and can recurse until Svelte's update-depth guard fires.
 */
export function attachCollabPresenceSinks(
  controller: PresenceSinkController,
  sinks: CollabPresenceSinks,
  // Node resolves `svelte` to its SSR entry, whose untrack is intentionally a
  // no-op. Keep this narrow injection seam so the standalone test can supply
  // the client runtime implementation used by the browser build.
  runUntracked: typeof untrack = untrack,
): () => void {
  runUntracked(() => {
    controller.setRemoteCursorSink(sinks.onRemoteCursors);
    controller.setPeerLocationSink(sinks.onPeerLocation);
    controller.setPeerLocationExpirySink(sinks.onPeerLocationExpired);
    controller.setLocationSource(sinks.getLocation);
  });

  return () => {
    runUntracked(() => {
      controller.setRemoteCursorSink(null);
      controller.setPeerLocationSink(null);
      controller.setPeerLocationExpirySink(null);
      controller.setLocationSource(null);
    });
  };
}
