// The standalone Node harness needs client reactivity, whose internal test
// entry point intentionally has no public declarations.
// @ts-expect-error -- test-only Svelte client runtime primitives.
import { effect_root, flush, get, mutable_source, render_effect, set, untrack } from 'svelte/internal/client';

import { attachCollabPresenceSinks } from './collab-presence-sinks';
import type { CollabPeerLocation, RemoteCursor } from './collab-controller';

let passed = 0;
let failed = 0;

function defineCase(name: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${error instanceof Error ? error.message : String(error)}`);
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

defineCase('synchronous retained-location replay is isolated from effect tracking', () => {
  const switchGeneration = mutable_source(0);
  const peerLocations = mutable_source<Record<string, CollabPeerLocation>>({});
  const retained = { fileId: 'file-a', path: 'a.md', caretHead: 4 } as CollabPeerLocation;
  let effectRuns = 0;

  const controller = {
    setRemoteCursorSink(sink: ((cursors: RemoteCursor[]) => void) | null): void {
      sink?.([]);
    },
    setPeerLocationSink(
      sink: ((deviceId: string, location: CollabPeerLocation) => void) | null,
    ): void {
      sink?.('reviewer-device', retained);
    },
    setPeerLocationExpirySink(_sink: ((deviceId: string) => void) | null): void {},
    setLocationSource(source: (() => CollabPeerLocation | null) | null): void {
      source?.();
    },
  };

  const destroy = effect_root(() => {
    render_effect(() => {
      get(switchGeneration);
      effectRuns += 1;
      return attachCollabPresenceSinks(controller, {
        onRemoteCursors: () => undefined,
        onPeerLocation: (deviceId, location) => {
          // Mirrors ReviewStore.notePeerLocation: read and replace the whole
          // reactive location record while the controller replays on attach.
          set(peerLocations, { ...get(peerLocations), [deviceId]: location });
        },
        onPeerLocationExpired: () => undefined,
        getLocation: () => retained,
      }, untrack);
    });
  });

  flush();
  assert(effectRuns === 1, `initial attach recursively ran the effect ${effectRuns} times`);

  set(switchGeneration, 1);
  flush();
  assert(effectRuns === 2, `file-switch reattach recursively ran the effect ${effectRuns} times`);
  assert(
    get(peerLocations)['reviewer-device']?.path === 'a.md',
    'retained peer location was not replayed',
  );
  destroy();
});

if (failed > 0) {
  console.error(`\n${failed} failed, ${passed} passed`);
  process.exit(1);
}
console.log(`\n${passed} passed`);
