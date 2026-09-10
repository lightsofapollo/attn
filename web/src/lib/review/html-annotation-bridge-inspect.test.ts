// What the frame is told about annotate mode, message by message (attn-wrf3).
//
//   cd web && npx tsx src/lib/review/html-annotation-bridge-inspect.test.ts
//
// Annotate mode is OFF by default for every HTML document, a shared one
// included — the shell calls `setInspect(true)` only after the person presses
// the pinned toggle. These cases read the wire because the failure they guard
// is silent in shell state: a bridge that turned the frame's click-swallowing
// on by itself, or that let a reloaded frame keep a mode the shell had since
// turned off, looks fine from the shell and breaks every button in the page.

import { HtmlAnnotationBridge } from './html-annotation-bridge';
import { DOC_HELLO, DOC_PROTOCOL_VERSION } from './doc-protocol';

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

/* ————— a stand-in for the document frame (same shape as the hover test) ————— */

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

function inspectMessages(sent: Array<Record<string, unknown>>): boolean[] {
  return sent
    .filter((message) => message.type === 'inspect')
    .map((message) => message.enabled === true);
}

/* ————— cases ————— */

defineCase('a fresh frame is told the mode is off, and never told it is on', async () => {
  const h = await connectedBridge();
  try {
    await settle();
    const seen = inspectMessages(h.sent);
    assert(seen.length >= 1, 'the handshake states the mode explicitly');
    assert(seen.every((enabled) => enabled === false), `only "off" was sent: ${JSON.stringify(seen)}`);
  } finally {
    h.dispose();
  }
});

defineCase('the mode reaches the frame only after the shell turns it on', async () => {
  const h = await connectedBridge();
  try {
    await settle();
    const before = inspectMessages(h.sent).filter(Boolean).length;
    assertEqual(before, 0, 'nothing enabled the surface on load');

    h.bridge.setInspect(true);
    await settle();
    const after = inspectMessages(h.sent);
    assertEqual(after[after.length - 1], true, 'the press turned it on');

    h.bridge.setInspect(false);
    await settle();
    const off = inspectMessages(h.sent);
    assertEqual(off[off.length - 1], false, 'the second press turned it off');
  } finally {
    h.dispose();
  }
});

defineCase('a reloaded frame is told the mode the shell currently holds — on', async () => {
  const h = await connectedBridge();
  try {
    h.bridge.setInspect(true);
    await settle();
    h.sent.length = 0;

    // A watched document reloads in place; the person never pressed anything.
    await h.helloAgain();
    const replayed = inspectMessages(h.sent);
    assertEqual(replayed.length, 1, 'exactly one mode statement per handshake');
    assertEqual(replayed[0], true, 'and it is the mode the shell holds');
  } finally {
    h.dispose();
  }
});

defineCase('a reloaded frame is told the mode the shell currently holds — off, explicitly', async () => {
  // Why explicit false rather than silence: a frame that reloaded boots off
  // either way, but a frame that merely re-sent `hello` (a document script
  // fishing for a fresh port) keeps whatever state it had. Stating the mode
  // makes every handshake land the frame on the shell's record of it.
  const h = await connectedBridge();
  try {
    h.bridge.setInspect(true);
    await settle();
    h.bridge.setInspect(false);
    await settle();
    h.sent.length = 0;

    await h.helloAgain();
    const replayed = inspectMessages(h.sent);
    assertEqual(replayed.length, 1, 'exactly one mode statement per handshake');
    assertEqual(replayed[0], false, 'the frame is told "off", not left to remember');
  } finally {
    h.dispose();
  }
});

defineCase('a disposed bridge forgets the mode', async () => {
  const h = await connectedBridge();
  try {
    h.bridge.setInspect(true);
    await settle();
    h.bridge.dispose();
    // A new frame under a reused bridge object must not inherit "on": the
    // shells rebuild the bridge per frame, but the retained flag is what a
    // stale one would replay.
    h.bridge.connect();
    h.sent.length = 0;
    await h.helloAgain();
    const replayed = inspectMessages(h.sent);
    assert(replayed.every((enabled) => enabled === false), `off after dispose: ${JSON.stringify(replayed)}`);
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
  console.log(`html-annotation-bridge inspect: ${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) process.exit(1);
}

void runAllCases();
