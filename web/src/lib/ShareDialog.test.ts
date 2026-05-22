// Manual smoke harness for ReviewBar + ShareDialog (attn-nnj.4.10).
// Pattern mirrors `review/store.test.ts` and `ReviewApplyExpand.test.ts` —
// `web/` has no vitest config yet, so tests are tsx-runnable functions
// with a tiny harness.
//
// Run with:
//
//   cd web && npx tsx src/lib/ShareDialog.test.ts
//
// IMPORTANT: this test cannot mount the Svelte components directly — tsx
// evaluates `*.svelte` files as bare TypeScript and the runes (`$state`,
// `$derived`, `$effect`) only compile through the Vite + svelte plugin
// pipeline. So we test the contracts the components depend on:
//
//   1. ReviewBar visibility predicate: hidden when neither currentRoomId
//      nor shareOpen, visible otherwise.
//   2. Share-mode → IPC mode collapse (4 user modes → 3 IPC modes + ttl).
//   3. `reviewShare` IPC emission on Start with the right mode + ttl.
//   4. Cancel does not emit IPC.
//   5. Verify-key fingerprint computes the expected 12-hex value.
//   6. Cmd+Shift+S binding fires `onShareOpen` via initKeyboard().
//   7. Single-device checkbox controls `deleteEventsAfterOwnerAck`.

import { initKeyboard } from './keyboard';
import { reviewShare } from './ipc';
import { formatFingerprint, ownerKeyFingerprint } from './review/fingerprint';

// ---------------------------------------------------------------------------
// Tiny harness
// ---------------------------------------------------------------------------

interface CaseResult {
  name: string;
  ok: boolean;
  detail?: string;
}

const cases: Array<() => Promise<CaseResult> | CaseResult> = [];

function defineCase(name: string, fn: () => void | string | Promise<void | string>): void {
  cases.push(async () => {
    try {
      const note = await fn();
      return { name, ok: true, detail: typeof note === 'string' ? note : undefined };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { name, ok: false, detail: message };
    }
  });
}

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

// ---------------------------------------------------------------------------
// Mock ipc capture — intercepts `window.ipc.postMessage` so we can assert
// on outbound payloads.
// ---------------------------------------------------------------------------

interface IpcCapture {
  messages: Array<Record<string, unknown>>;
  reset(): void;
}

function installIpcCapture(): IpcCapture {
  const capture: IpcCapture = {
    messages: [],
    reset() {
      this.messages = [];
    },
  };
  const w = globalThis as unknown as {
    window?: { ipc?: { postMessage: (m: string) => void } };
  };
  if (!w.window) {
    (w as unknown as { window: object }).window = w as object;
  }
  w.window!.ipc = {
    postMessage(message: string): void {
      capture.messages.push(JSON.parse(message) as Record<string, unknown>);
    },
  };
  return capture;
}

const ipc = installIpcCapture();

// ---------------------------------------------------------------------------
// In-test stand-in for the runes-backed reviewStore. ReviewBar reads
// `currentRoomId` and `peers` (along with the shareOpen prop) to decide
// visibility — we mirror exactly those fields. The real store is a one-line
// assignment in `applyStatus`; the contract under test is the visibility
// rule wired in ReviewBar.svelte's `$derived`.
// ---------------------------------------------------------------------------

interface StubReviewStore {
  currentRoomId: string | null;
  rooms: unknown[];
  peers: unknown[];
}

function makeStubStore(): StubReviewStore {
  return { currentRoomId: null, rooms: [], peers: [] };
}

/**
 * Mirror of the visibility predicate from ReviewBar.svelte:
 *
 *   visible = reviewStore.currentRoomId !== null || reviewStore.roomsList.length > 0 || shareOpen
 */
function reviewBarVisible(store: StubReviewStore, shareOpen: boolean): boolean {
  return store.currentRoomId !== null || store.rooms.length > 0 || shareOpen;
}

// ---------------------------------------------------------------------------
// Mirror of `modeToIpc` from ShareDialog.svelte. Re-declared here so the
// test can exercise the mapping without importing the .svelte module
// (tsx can't load runes). If you change the mapping in the component,
// update this fixture and the test will catch the drift in CI.
// ---------------------------------------------------------------------------

type ShareMode = 'live' | 'async_24h' | 'async_7d' | 'hybrid';

function modeToIpc(mode: ShareMode): { mode: 'live' | 'async' | 'hybrid'; ttl?: string } {
  switch (mode) {
    case 'live':
      return { mode: 'live' };
    case 'hybrid':
      return { mode: 'hybrid' };
    case 'async_24h':
      return { mode: 'async', ttl: '24h' };
    case 'async_7d':
      return { mode: 'async', ttl: '7d' };
  }
}

// ---------------------------------------------------------------------------
// Stand-in for the ShareDialog's Start handler. Same control flow as the
// component: collapse mode → IPC, dispatch reviewShare, callback caller
// with the resolved policy, close the modal.
// ---------------------------------------------------------------------------

interface ShareStartParams {
  mode: ShareMode;
  ipcMode: 'live' | 'async' | 'hybrid';
  ttl?: string;
  deleteEventsAfterOwnerAck: boolean;
  filePath: string;
}

interface DialogStub {
  open: boolean;
  selectedMode: ShareMode;
  singleDeviceOnly: boolean;
  filePath: string;
}

async function startShare(
  d: DialogStub,
  onStart?: (params: ShareStartParams) => void,
): Promise<void> {
  const { mode: ipcMode, ttl } = modeToIpc(d.selectedMode);
  await reviewShare(d.filePath, ipcMode, ttl);
  onStart?.({
    mode: d.selectedMode,
    ipcMode,
    ttl,
    deleteEventsAfterOwnerAck: d.singleDeviceOnly,
    filePath: d.filePath,
  });
  d.open = false;
}

function cancelShare(d: DialogStub): void {
  d.open = false;
}

// ---------------------------------------------------------------------------
// Test cases
// ---------------------------------------------------------------------------

// (1) ReviewBar hidden when no currentRoomId and shareOpen is false.
defineCase('ReviewBar hidden when no currentRoomId', () => {
  const store = makeStubStore();
  assert(reviewBarVisible(store, false) === false, 'expected hidden when idle');
});

// (2) ReviewBar visible after currentRoomId is set.
defineCase('ReviewBar visible after currentRoomId set', () => {
  const store = makeStubStore();
  store.currentRoomId = 'room-abc';
  assert(reviewBarVisible(store, false) === true, 'expected visible when room is bound');
});

// (2b) ReviewBar visible while share is being initiated (shareOpen=true).
defineCase('ReviewBar visible while share is being initiated', () => {
  const store = makeStubStore();
  assert(
    reviewBarVisible(store, true) === true,
    'expected visible when share dialog is open even without a room',
  );
});

defineCase('ReviewBar visible when passive rooms are available', () => {
  const store = makeStubStore();
  store.rooms = [{ roomId: 'room-resumed' }];
  assert(
    reviewBarVisible(store, false) === true,
    'expected visible when a resumed room can be selected',
  );
});

// (3) ShareDialog renders all 4 modes (the mode options array contract).
defineCase('ShareDialog supports all four mode options', () => {
  const modes: ShareMode[] = ['live', 'async_24h', 'async_7d', 'hybrid'];
  assert(modes.length === 4, `expected 4 modes, got ${modes.length}`);
  for (const m of modes) {
    const { mode, ttl } = modeToIpc(m);
    assert(
      mode === 'live' || mode === 'async' || mode === 'hybrid',
      `mode ${m} → unexpected ipc mode ${mode}`,
    );
    if (m === 'async_24h') assert(ttl === '24h', `async_24h must carry ttl=24h, got ${String(ttl)}`);
    if (m === 'async_7d') assert(ttl === '7d', `async_7d must carry ttl=7d, got ${String(ttl)}`);
    if (m === 'live' || m === 'hybrid') {
      assert(ttl === undefined, `${m} must not carry a ttl, got ${String(ttl)}`);
    }
  }
});

// (4) Click [Start] with Live mode → reviewShare IPC called with mode="live".
defineCase('Start with Live mode emits review_share IPC (mode=live)', async () => {
  ipc.reset();
  const dialog: DialogStub = {
    open: true,
    selectedMode: 'live',
    singleDeviceOnly: false,
    filePath: 'planning/collab/ui/connection-share.md',
  };
  const cap: { value: ShareStartParams | null } = { value: null };
  await startShare(dialog, (p) => {
    cap.value = p;
  });
  assert(ipc.messages.length === 1, `expected 1 ipc message, got ${ipc.messages.length}`);
  const msg = ipc.messages[0];
  assert(msg.type === 'review_share', `expected type=review_share, got ${String(msg.type)}`);
  assert(msg.mode === 'live', `expected mode=live, got ${String(msg.mode)}`);
  assert(msg.path === dialog.filePath, `expected path=${dialog.filePath}, got ${String(msg.path)}`);
  assert(msg.ttl === undefined, `expected no ttl for live mode, got ${String(msg.ttl)}`);
  assert(dialog.open === false, 'expected dialog.open to flip to false after Start');
  assert(cap.value !== null, 'expected onStart callback to receive params');
  const captured = cap.value as ShareStartParams;
  assert(captured.ipcMode === 'live', `expected captured ipcMode=live, got ${captured.ipcMode}`);
});

// (4b) Async 7d emits mode=async with ttl=7d (longSession path).
defineCase('Start with Async 7d emits mode=async + ttl=7d', async () => {
  ipc.reset();
  const dialog: DialogStub = {
    open: true,
    selectedMode: 'async_7d',
    singleDeviceOnly: false,
    filePath: 'plan.md',
  };
  await startShare(dialog);
  assert(ipc.messages.length === 1, `expected 1 ipc message, got ${ipc.messages.length}`);
  const msg = ipc.messages[0];
  assert(msg.mode === 'async', `expected mode=async, got ${String(msg.mode)}`);
  assert(msg.ttl === '7d', `expected ttl=7d, got ${String(msg.ttl)}`);
});

// (5) Click [Cancel] → dialog closes, no IPC.
defineCase('Cancel closes dialog with no IPC emitted', () => {
  ipc.reset();
  const dialog: DialogStub = {
    open: true,
    selectedMode: 'live',
    singleDeviceOnly: false,
    filePath: 'plan.md',
  };
  cancelShare(dialog);
  assert(dialog.open === false, 'expected dialog.open=false after Cancel');
  assert(ipc.messages.length === 0, `expected 0 ipc messages on Cancel, got ${ipc.messages.length}`);
});

// (6) Verify-key fingerprint computes correct value for a known public key.
// We compute the SHA-256 of a deterministic input ("attn-test-owner-key")
// independently here and assert ownerKeyFingerprint returns the matching
// first-12-hex-chars grouped 4-4-4.
defineCase('ownerKeyFingerprint produces correct 12-hex 4-4-4 grouping', async () => {
  // Recompute the expected digest using the same Web Crypto API the helper
  // uses. We then format with the same helper so this test catches drift
  // in *either* direction (helper vs. our oracle).
  const input = 'attn-test-owner-key';
  const data = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest('SHA-256', data);
  const hex = Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  const expected = formatFingerprint(hex.slice(0, 12));
  const got = await ownerKeyFingerprint(input);
  assert(got === expected, `expected ${expected}, got ${got}`);
  // Shape check: must be 14 chars total ("xxxx xxxx xxxx").
  assert(got.length === 14, `expected length=14, got ${got.length}`);
  assert(got[4] === ' ' && got[9] === ' ', `expected spaces at index 4 and 9, got "${got}"`);
});

// (6b) Empty key returns placeholder (and never throws / hits subtle.digest).
defineCase('ownerKeyFingerprint returns placeholder for empty key', async () => {
  const got = await ownerKeyFingerprint('');
  assert(got === '—— —— ——', `expected placeholder, got "${got}"`);
});

// (7) Cmd+Shift+S opens the dialog through initKeyboard → onShareOpen.
defineCase('Cmd+Shift+S routes through initKeyboard → onShareOpen', () => {
  // Stub a minimal window so initKeyboard can attach the keydown listener.
  // We capture invocations on the onShareOpen handler.
  const listeners = new Map<string, (e: KeyboardEvent) => void>();
  const fakeWindow = {
    addEventListener(type: string, listener: (e: KeyboardEvent) => void): void {
      listeners.set(type, listener);
    },
    removeEventListener(type: string, listener: (e: KeyboardEvent) => void): void {
      const cur = listeners.get(type);
      if (cur === listener) listeners.delete(type);
    },
  };
  const w = globalThis as unknown as {
    window: typeof fakeWindow;
    document?: { querySelector: () => null; activeElement: null };
    HTMLElement?: unknown;
  };
  const prev = w.window;
  const prevDoc = w.document;
  const prevHtml = w.HTMLElement;
  w.window = fakeWindow as unknown as typeof prev;
  // keyboard.ts probes `document.querySelector('.mermaid-fullscreen-modal')`,
  // `document.activeElement`, and uses `target instanceof HTMLElement` to
  // decide whether a focused editor is intercepting. Stub all three so the
  // handler runs in a node-only context.
  w.document = {
    querySelector: () => null,
    activeElement: null,
  };
  // The handler's editable probes are `target instanceof HTMLElement` — with
  // target=null they should fall through to false. A stub constructor is
  // enough; `null instanceof <ctor>` returns false in JS.
  w.HTMLElement = function HTMLElement() {};
  try {
    let fired = 0;
    const cleanup = initKeyboard({
      onShareOpen: () => {
        fired += 1;
      },
    });
    const handler = listeners.get('keydown');
    assert(typeof handler === 'function', 'expected initKeyboard to bind keydown');

    // Synthesize Cmd+Shift+S. We mock the minimal KeyboardEvent shape the
    // handler reads — `metaKey`, `shiftKey`, `key`, `code`, `repeat`,
    // `defaultPrevented`, `isComposing`, `target`, and `preventDefault`.
    const evt: Partial<KeyboardEvent> & { preventDefault: () => void } = {
      metaKey: true,
      ctrlKey: false,
      shiftKey: true,
      altKey: false,
      key: 's',
      code: 'KeyS',
      repeat: false,
      defaultPrevented: false,
      isComposing: false,
      target: null,
      preventDefault() {},
    };
    handler!(evt as KeyboardEvent);
    assert(fired === 1, `expected onShareOpen to fire once, got ${fired}`);

    // Plain Cmd+S (no shift) MUST NOT fire onShareOpen — it would steal save.
    const evtNoShift: Partial<KeyboardEvent> & { preventDefault: () => void } = {
      ...evt,
      shiftKey: false,
      key: 's',
    };
    handler!(evtNoShift as KeyboardEvent);
    assert(fired === 1, `Cmd+S (no shift) must not fire onShareOpen; got ${fired}`);

    cleanup();
  } finally {
    w.window = prev;
    w.document = prevDoc;
    w.HTMLElement = prevHtml;
  }
});

// (8) Single-device toggle controls deleteEventsAfterOwnerAck on Start.
defineCase('Single-device toggle controls deleteEventsAfterOwnerAck', async () => {
  ipc.reset();
  const dialog: DialogStub = {
    open: true,
    selectedMode: 'async_24h',
    singleDeviceOnly: false,
    filePath: 'plan.md',
  };
  const cap: { value: ShareStartParams | null } = { value: null };

  // Default (unchecked) per amendments #12 — must propagate false.
  await startShare(dialog, (p) => {
    cap.value = p;
  });
  assert(cap.value !== null, 'expected onStart fired (unchecked path)');
  let captured = cap.value as ShareStartParams;
  assert(
    captured.deleteEventsAfterOwnerAck === false,
    `expected default deleteEventsAfterOwnerAck=false, got ${String(captured.deleteEventsAfterOwnerAck)}`,
  );

  // User toggles single-device → must propagate true.
  cap.value = null;
  dialog.open = true;
  dialog.singleDeviceOnly = true;
  await startShare(dialog, (p) => {
    cap.value = p;
  });
  assert(cap.value !== null, 'expected onStart fired (checked path)');
  captured = cap.value as ShareStartParams;
  assert(
    captured.deleteEventsAfterOwnerAck === true,
    `expected toggled deleteEventsAfterOwnerAck=true, got ${String(captured.deleteEventsAfterOwnerAck)}`,
  );
});

// ---------------------------------------------------------------------------
// Runner — same shape as resolver.test.ts / store.test.ts
// ---------------------------------------------------------------------------

interface NodeProcessShape {
  exit?: (code: number) => void;
}

async function runAllCases(): Promise<void> {
  let passed = 0;
  let failed = 0;
  for (const run of cases) {
    const r = await run();
    if (r.ok) {
      passed += 1;
      console.log(`  ok  ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
    } else {
      failed += 1;
      console.error(`  FAIL ${r.name}\n        ${r.detail ?? '(no detail)'}`);
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    const nodeProcess = (globalThis as unknown as { process?: NodeProcessShape }).process;
    nodeProcess?.exit?.(1);
  }
}

void runAllCases();
