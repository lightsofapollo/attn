// What the frame is actually told, message by message (attn-ze60.4).
//
//   cd web && npx tsx src/lib/review/html-annotation-bridge-hover.test.ts
//
// THE FAILURE THIS PINS. `renderAnchors` is a full repaint of every anchor in
// its BASE state, and anchors re-render for reasons that have nothing to do
// with the pointer: a comment arrives over the wire, a card resolves, an edit
// remaps. When one of those landed while a card was hovered, the batch painted
// over the hover — and nothing put it back. The shells' hover effects watch the
// hovered card, not the anchor list, so they never re-ran; and even when they
// did, `setHoveredAnchor` returns early for an id it already holds. The card
// stayed lit, the document went dark, and only leaving and re-entering the card
// fixed it.
//
// These cases read the wire because the bug was invisible in the shell's state:
// every field said "hovered" while the frame had been told "default".

import { HtmlAnnotationBridge } from './html-annotation-bridge';
import { DOC_HELLO, DOC_PROTOCOL_VERSION, type RenderableAnchor } from './doc-protocol';

interface CaseResult {
  name: string;
  ok: boolean;
  detail?: string;
}

const cases: Array<() => Promise<CaseResult>> = [];

function defineCase(name: string, fn: () => Promise<void>): void {
  cases.push(async () => {
    try {
      await fn();
      return { name, ok: true };
    } catch (error) {
      return {
        name,
        ok: false,
        detail: error instanceof Error ? error.stack ?? error.message : String(error),
      };
    }
  });
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

/* ————— a stand-in for the document frame —————

   The bridge only ever touches two things on the outside: `window` (to hear the
   frame's hello) and `frame.contentWindow` (to hand over the private port).
   Both are small enough to fake, which is what makes the wire observable. */

function anchor(anchorId: string, state: RenderableAnchor['state']): RenderableAnchor {
  return {
    anchorId,
    state,
    html: {
      v: 1,
      target: 'element',
      cssSelector: `#${anchorId}`,
      context: { tagName: 'p', scopePreview: anchorId },
    },
  };
}

interface Harness {
  bridge: HtmlAnnotationBridge;
  /** Everything the frame has been sent, oldest first. */
  sent: Array<Record<string, unknown>>;
  /** Drop the frame and hand the bridge a fresh one, as a reload does. */
  helloAgain: () => Promise<void>;
  dispose: () => void;
}

async function connectedBridge(): Promise<Harness> {
  const listeners: Array<(event: unknown) => void> = [];
  const sent: Array<Record<string, unknown>> = [];
  const framePorts: MessagePort[] = [];

  const contentWindow = {
    postMessage: (_message: unknown, _origin: string, transfer: MessagePort[]) => {
      const port = transfer[0];
      port.onmessage = (event: MessageEvent) => void sent.push(event.data as Record<string, unknown>);
      port.start?.();
      framePorts.push(port);
    },
  };
  const frame = { contentWindow } as unknown as HTMLIFrameElement;

  (globalThis as { window?: unknown }).window = {
    addEventListener: (_type: string, fn: (event: unknown) => void) => void listeners.push(fn),
    removeEventListener: () => undefined,
  };

  const hello = async (): Promise<void> => {
    for (const fn of listeners) {
      fn({ source: contentWindow, data: { type: DOC_HELLO, v: DOC_PROTOCOL_VERSION } });
    }
    await settle();
  };

  const bridge = new HtmlAnnotationBridge(frame, {});
  bridge.connect();
  await hello();
  assert(bridge.connected, 'the handshake completed');

  return {
    bridge,
    sent,
    helloAgain: hello,
    dispose: () => {
      bridge.dispose();
      for (const port of framePorts) port.close();
    },
  };
}

/** Ports deliver asynchronously; let the queue drain. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** The last thing the frame was told about one anchor. */
function lastStateFor(sent: Array<Record<string, unknown>>, anchorId: string): string | undefined {
  let state: string | undefined;
  for (const message of sent) {
    if (message.type === 'setAnchorState' && message.anchorId === anchorId) {
      state = message.state as string;
    } else if (message.type === 'renderAnchors') {
      const anchors = message.anchors as RenderableAnchor[];
      const match = anchors.find((item) => item.anchorId === anchorId);
      if (match) state = match.state;
    }
  }
  return state;
}

/* ————— cases ————— */

defineCase('a re-render under the pointer leaves the anchor hovered', async () => {
  const h = await connectedBridge();
  try {
    h.bridge.renderAnchors([anchor('a', 'default'), anchor('b', 'default')]);
    h.bridge.setHoveredAnchor('a');
    await settle();
    assertEqual(lastStateFor(h.sent, 'a'), 'hovered', 'the hover reaches the frame');

    // A comment arrives; every anchor is repainted in its base state.
    h.bridge.renderAnchors([anchor('a', 'default'), anchor('b', 'default'), anchor('c', 'default')]);
    await settle();
    assertEqual(lastStateFor(h.sent, 'a'), 'hovered', 'and survives the repaint');
    assertEqual(lastStateFor(h.sent, 'b'), 'default', 'without spreading to its neighbours');
  } finally {
    h.dispose();
  }
});

defineCase('a resolved anchor keeps its hover, not its base state', async () => {
  // The base state is the thing `setHoveredAnchor` restores on exit, so a
  // repaint that leaks it through is the same bug wearing a different value.
  const h = await connectedBridge();
  try {
    h.bridge.renderAnchors([anchor('a', 'resolved')]);
    h.bridge.setHoveredAnchor('a');
    await settle();
    h.bridge.renderAnchors([anchor('a', 'resolved')]);
    await settle();
    assertEqual(lastStateFor(h.sent, 'a'), 'hovered', 'still hovered');

    h.bridge.setHoveredAnchor(null);
    await settle();
    assertEqual(lastStateFor(h.sent, 'a'), 'resolved', 'and returns to resolved on exit');
  } finally {
    h.dispose();
  }
});

defineCase('an anchor that leaves the document stops being the hovered one', async () => {
  const h = await connectedBridge();
  try {
    h.bridge.renderAnchors([anchor('a', 'default')]);
    h.bridge.setHoveredAnchor('a');
    await settle();

    // The comment was deleted; its anchor is gone from the batch.
    h.bridge.renderAnchors([anchor('b', 'default')]);
    await settle();
    const before = h.sent.length;
    // Nothing to re-assert, and the id must not linger: the early return in
    // setHoveredAnchor would then swallow a genuine re-hover of a reappearing
    // anchor.
    h.bridge.setHoveredAnchor('a');
    await settle();
    assert(h.sent.length > before, 'hovering it again is not swallowed as a repeat');
    assertEqual(lastStateFor(h.sent, 'a'), 'hovered', 'and reaches the frame');
  } finally {
    h.dispose();
  }
});

defineCase('a reloaded frame is told the hover along with the pins', async () => {
  const h = await connectedBridge();
  try {
    h.bridge.renderAnchors([anchor('a', 'default')]);
    h.bridge.setHoveredAnchor('a');
    await settle();

    // A watched document reloads in place. The pointer never moved.
    await h.helloAgain();
    const replayed = h.sent.filter((message) => message.type === 'renderAnchors');
    assert(replayed.length >= 2, 'the retained batch is replayed');
    assertEqual(lastStateFor(h.sent, 'a'), 'hovered', 'and so is the hover');
  } finally {
    h.dispose();
  }
});

async function runAllCases(): Promise<void> {
  let passed = 0;
  const failures: string[] = [];
  for (const run of cases) {
    const result = await run();
    if (result.ok) {
      passed += 1;
      console.log(`PASS ${result.name}`);
    } else {
      failures.push(result.name);
      console.error(`FAIL ${result.name}\n${result.detail ?? ''}`);
    }
  }
  console.log(`html-annotation-bridge hover: ${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) process.exit(1);
}

void runAllCases();
