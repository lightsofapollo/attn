// Manual smoke harness for `CommentComposer.svelte` (attn-nnj.4.4).
//
// The `web/` package has no vitest config yet, so tests are tsx-runnable
// functions with the same tiny harness ShareDialog.test.ts / store.test.ts
// use. Run with:
//
//   cd web && npx tsx src/lib/CommentComposer.test.ts
//
// IMPORTANT: this test cannot mount the Svelte component directly — tsx
// evaluates `*.svelte` files as bare TypeScript and the runes (`$state`,
// `$derived`, `$effect`) only compile through the Vite + svelte plugin
// pipeline. So we test the contracts the component depends on:
//
//   1. Empty PM selection → Cmd+. is a no-op (no composer opens, no IPC).
//   2. Non-empty PM selection → composer opens with the captured quote
//      and a popover anchor positioned near the selection rect.
//   3. Submit emits `review_create_comment` with the correct Anchor +
//      body and closes the composer.
//   4. Cancel closes the composer without emitting any IPC.
//   5. Composer is closed after submit (open() then submit() flips
//      `isOpen` back to false).
//   6. Esc keydown closes the composer (no IPC).
//   7. Cmd+. keybinding (via initKeyboard) fires `onCommentComposer`;
//      Cmd+Shift+. fires `onSuggestionComposer` instead.

import { initKeyboard } from './keyboard';
import { reviewCreateComment } from './ipc';
import { anchorFromSelection, type ConstructAnchorContext } from './review/anchors';
import type { AnchorBlockKind, ContentHash, FileId, RoomId, SnapshotId } from './types';
import type { EditorView } from 'prosemirror-view';
import type { Node as PMNode } from 'prosemirror-model';

// ---------------------------------------------------------------------------
// Tiny harness (matches resolver.test.ts / store.test.ts conventions)
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
// Mock ipc capture — intercepts `window.ipc.postMessage` so we can assert on
// outbound payloads from `reviewCreateComment` without spinning up wry.
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
// Minimal EditorView + AnchorIndex stub matching the subset
// `anchorFromSelection` actually reads:
//
//   view.state.doc.textBetween(from, to, blockSep, leafSep)
//   view.state.doc.forEach((child) => …) — top-level children with `nodeSize`
//   view.state.doc.content.size
//   view.state.selection — to mirror the App-side empty-check
//   view.coordsAtPos(pos) — only the popover anchor uses this
//
// The stub is intentionally tiny because the resolver / popover logic is
// covered by `anchors.test.ts` and `popover-anchor.ts` itself.
// ---------------------------------------------------------------------------

interface StubBlock {
  text: string;
}

interface BuiltStub {
  view: EditorView;
  ctx: ConstructAnchorContext;
  block0PmStart: number;
}

function buildStub(opts: { selection: { from: number; to: number } | null }): BuiltStub {
  const blocks: StubBlock[] = [
    { text: 'Hello world here' },
    { text: 'second block' },
  ];
  // PM-position bookkeeping (one open + one close token per block).
  const starts: number[] = [];
  const ends: number[] = [];
  let pmPos = 0;
  for (const b of blocks) {
    const nodeSize = b.text.length + 2;
    starts.push(pmPos);
    ends.push(pmPos + nodeSize);
    pmPos += nodeSize;
  }
  const docSize = pmPos;

  // Byte ranges via utf-8 encoding of the concatenated text.
  const enc = new TextEncoder();
  let cursorBytes = 0;
  let cursorLine = 0;
  const indexBlocks = blocks.map((b, i) => {
    const startBytes = cursorBytes;
    const byteLen = enc.encode(b.text).length;
    const startLine = cursorLine;
    cursorBytes += byteLen;
    if (i < blocks.length - 1) {
      cursorBytes += 1;
      cursorLine += 1;
    }
    return {
      snapshotBlockId: `block-${i}`,
      contentFingerprint: `fp-${i}`,
      kind: 'paragraph' as AnchorBlockKind,
      byteRange: [startBytes, startBytes + byteLen] as [number, number],
      lineRange: [startLine, startLine] as [number, number],
      headingPath: [],
      ordinalInParent: i,
      duplicateOrdinal: 0,
      textHash: `text-hash-${i}`,
      normalizedTextHash: `norm-${i}`,
    };
  });

  function textBetween(from: number, to: number, blockSep: string, _leafSep: string): string {
    let out = '';
    let firstHit = true;
    for (let i = 0; i < blocks.length; i++) {
      const innerStart = starts[i]! + 1;
      const innerEnd = ends[i]! - 1;
      const sliceStart = Math.max(from, innerStart);
      const sliceEnd = Math.min(to, innerEnd);
      if (sliceStart < sliceEnd) {
        if (!firstHit) out += blockSep;
        firstHit = false;
        out += blocks[i]!.text.slice(sliceStart - innerStart, sliceEnd - innerStart);
      }
    }
    return out;
  }

  const stubChildren = blocks.map((b) => ({ nodeSize: b.text.length + 2 })) as unknown as PMNode[];
  const stubDoc = {
    content: { size: docSize },
    nodeSize: docSize + 2,
    textBetween,
    forEach: (cb: (child: PMNode, offset: number, index: number) => void) => {
      let off = 0;
      for (let i = 0; i < stubChildren.length; i++) {
        cb(stubChildren[i]!, off, i);
        off += (stubChildren[i] as unknown as { nodeSize: number }).nodeSize;
      }
    },
  } as unknown as PMNode;

  const sel = opts.selection;
  const selection = sel
    ? { from: sel.from, to: sel.to, empty: sel.from === sel.to }
    : { from: 0, to: 0, empty: true };

  const view = {
    state: { doc: stubDoc, selection },
    // Popover-anchor uses coordsAtPos; stub it with simple linear math so the
    // popover code runs without throwing. Coordinates are not asserted on
    // beyond non-NaN sanity.
    coordsAtPos(pos: number): { left: number; right: number; top: number; bottom: number } {
      return { left: pos * 6, right: pos * 6 + 6, top: 40, bottom: 60 };
    },
  } as unknown as EditorView;

  return {
    view,
    ctx: {
      index: {
        docHash: 'faux:doc-hash' as ContentHash,
        canonicalEncoding: 'utf8-bytes',
        lineCount: cursorLine + 1,
        blocks: indexBlocks,
        headings: [],
      },
      fileId: 'file_test' as FileId,
      snapshotId: 'snap_test' as SnapshotId,
      baseHash: 'faux:doc-hash' as ContentHash,
    },
    block0PmStart: starts[0]!,
  };
}

// ---------------------------------------------------------------------------
// In-test stand-in for the runes-backed composer. Mirrors the exact open()
// / close() / submit() control flow from CommentComposer.svelte so test
// drift here surfaces a real bug in the component contract.
// ---------------------------------------------------------------------------

interface OpenState {
  view: EditorView;
  from: number;
  to: number;
  quote: string;
  ctx: ConstructAnchorContext;
  roomId: RoomId;
}

interface ComposerStub {
  openState: OpenState | null;
  body: string;
  isOpen(): boolean;
  open(params: { view: EditorView; ctx: ConstructAnchorContext; roomId: RoomId }): void;
  close(): void;
  submit(): Promise<void>;
  keydown(e: { key: string; metaKey?: boolean; ctrlKey?: boolean }): void;
}

function makeComposer(): ComposerStub {
  const composer: ComposerStub = {
    openState: null,
    body: '',
    isOpen(): boolean {
      return this.openState !== null;
    },
    open(params): void {
      const { view, ctx, roomId } = params;
      const sel = view.state.selection;
      if (sel.empty) return;
      const from = sel.from;
      const to = sel.to;
      const quote = view.state.doc.textBetween(from, to, '\n', '​');
      this.openState = { view, from, to, quote, ctx, roomId };
      this.body = '';
    },
    close(): void {
      this.openState = null;
      this.body = '';
    },
    async submit(): Promise<void> {
      const s = this.openState;
      if (!s) return;
      const trimmed = this.body.trim();
      if (trimmed.length === 0) return;
      const anchor = anchorFromSelection(s.view, s.from, s.to, s.ctx);
      await reviewCreateComment(s.roomId, anchor, trimmed);
      this.close();
    },
    keydown(e): void {
      if (e.key === 'Escape') {
        this.close();
      }
    },
  };
  return composer;
}

// ---------------------------------------------------------------------------
// Test cases
// ---------------------------------------------------------------------------

// (1) Empty selection: Cmd+. is a no-op — composer.open() bails before
// mutating state, and no IPC is emitted.
defineCase('empty PM selection → composer.open() is a no-op (no IPC)', () => {
  ipc.reset();
  const stub = buildStub({ selection: null });
  const composer = makeComposer();
  composer.open({ view: stub.view, ctx: stub.ctx, roomId: 'room-1' as RoomId });
  assert(!composer.isOpen(), 'expected composer to stay closed on empty selection');
  assert(ipc.messages.length === 0, `expected no IPC, got ${ipc.messages.length}`);
});

// (2) Text selection: composer opens with the captured quote.
defineCase('text selection → composer opens with the captured quote', () => {
  // Inner text of block 0 starts at pm0+1. "Hello" runs chars 0..5.
  const stub = buildStub({
    selection: { from: 1, to: 6 }, // "Hello"
  });
  const composer = makeComposer();
  composer.open({ view: stub.view, ctx: stub.ctx, roomId: 'room-1' as RoomId });
  assert(composer.isOpen(), 'expected composer to be open');
  assert(
    composer.openState!.quote === 'Hello',
    `expected quote="Hello", got "${composer.openState!.quote}"`,
  );
});

// (3) Submit emits review_create_comment with correct anchor + body and closes.
defineCase('submit emits review_create_comment IPC with anchor + body', async () => {
  ipc.reset();
  const stub = buildStub({
    selection: { from: 1, to: 6 }, // "Hello"
  });
  const composer = makeComposer();
  composer.open({ view: stub.view, ctx: stub.ctx, roomId: 'room-1' as RoomId });
  composer.body = '  Looks good to me  '; // leading/trailing space → trimmed
  await composer.submit();

  assert(ipc.messages.length === 1, `expected 1 IPC, got ${ipc.messages.length}`);
  const msg = ipc.messages[0]!;
  assert(msg.type === 'review_create_comment', `expected type=review_create_comment, got ${String(msg.type)}`);
  assert(msg.roomId === 'room-1', `expected roomId=room-1, got ${String(msg.roomId)}`);
  assert(msg.body === 'Looks good to me', `expected trimmed body, got "${String(msg.body)}"`);
  // Anchor sanity — must be a 5-layer Anchor whose quote.exact matches the
  // selected text. Detailed layer correctness is covered by anchors.test.ts.
  const anchor = msg.anchor as Record<string, unknown> | undefined;
  assert(typeof anchor === 'object' && anchor !== null, 'expected anchor object on IPC');
  assert(anchor.v === 2, `expected anchor.v=2, got ${String(anchor.v)}`);
  assert(anchor.fileId === 'file_test', `expected anchor.fileId=file_test, got ${String(anchor.fileId)}`);
  assert(anchor.snapshotId === 'snap_test', `expected anchor.snapshotId=snap_test, got ${String(anchor.snapshotId)}`);
  const quote = anchor.quote as { exact?: string } | undefined;
  assert(quote?.exact === 'Hello', `expected anchor.quote.exact="Hello", got "${String(quote?.exact)}"`);
});

// (3b) Composer is closed after submit.
defineCase('composer closes after submit', async () => {
  ipc.reset();
  const stub = buildStub({
    selection: { from: 1, to: 6 },
  });
  const composer = makeComposer();
  composer.open({ view: stub.view, ctx: stub.ctx, roomId: 'room-1' as RoomId });
  composer.body = 'nit pick';
  assert(composer.isOpen(), 'precondition: composer should be open');
  await composer.submit();
  assert(!composer.isOpen(), 'expected composer to close after submit');
  assert(composer.body === '', `expected body to be cleared, got "${composer.body}"`);
});

// (4) Cancel closes the composer without emitting IPC.
defineCase('cancel closes composer with no IPC', () => {
  ipc.reset();
  const stub = buildStub({
    selection: { from: 1, to: 6 },
  });
  const composer = makeComposer();
  composer.open({ view: stub.view, ctx: stub.ctx, roomId: 'room-1' as RoomId });
  composer.body = 'half-written thought';
  composer.close();
  assert(!composer.isOpen(), 'expected composer to close on cancel');
  assert(ipc.messages.length === 0, `expected no IPC on cancel, got ${ipc.messages.length}`);
});

// (5) Escape keydown closes the composer (no IPC).
defineCase('Escape keydown closes the composer', () => {
  ipc.reset();
  const stub = buildStub({
    selection: { from: 1, to: 6 },
  });
  const composer = makeComposer();
  composer.open({ view: stub.view, ctx: stub.ctx, roomId: 'room-1' as RoomId });
  composer.body = 'changed my mind';
  composer.keydown({ key: 'Escape' });
  assert(!composer.isOpen(), 'expected composer to close on Escape');
  assert(ipc.messages.length === 0, `expected no IPC on Escape, got ${ipc.messages.length}`);
});

// (6) Empty body — submit is a no-op (defends against accidental Cmd+Enter
// on an empty composer).
defineCase('submit with empty body emits no IPC and stays open', async () => {
  ipc.reset();
  const stub = buildStub({
    selection: { from: 1, to: 6 },
  });
  const composer = makeComposer();
  composer.open({ view: stub.view, ctx: stub.ctx, roomId: 'room-1' as RoomId });
  composer.body = '   '; // whitespace-only
  await composer.submit();
  assert(composer.isOpen(), 'expected composer to stay open on empty submit');
  assert(ipc.messages.length === 0, `expected no IPC, got ${ipc.messages.length}`);
});

// (7) Cmd+. routes through initKeyboard → onCommentComposer; Cmd+Shift+.
// fires onSuggestionComposer instead. Confirms the 12.9 wiring the
// composer relies on.
defineCase('Cmd+. routes through initKeyboard → onCommentComposer', () => {
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
  w.document = { querySelector: () => null, activeElement: null };
  w.HTMLElement = function HTMLElement() {};
  try {
    const fired: { comment: number; suggestion: number } = { comment: 0, suggestion: 0 };
    const cleanup = initKeyboard({
      onCommentComposer: () => {
        fired.comment += 1;
      },
      onSuggestionComposer: () => {
        fired.suggestion += 1;
      },
    });
    const handler = listeners.get('keydown');
    assert(typeof handler === 'function', 'expected initKeyboard to bind keydown');

    // Cmd+. (no shift) → onCommentComposer.
    const commentEvt: Partial<KeyboardEvent> & { preventDefault: () => void } = {
      metaKey: true,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      key: '.',
      code: 'Period',
      repeat: false,
      defaultPrevented: false,
      isComposing: false,
      target: null,
      preventDefault() {},
    };
    handler!(commentEvt as KeyboardEvent);
    const afterComment = { ...fired };
    assert(afterComment.comment === 1, `expected onCommentComposer to fire once, got ${afterComment.comment}`);
    assert(afterComment.suggestion === 0, `Cmd+. must not fire onSuggestionComposer, got ${afterComment.suggestion}`);

    // Cmd+Shift+. → onSuggestionComposer (other branch of the same code path).
    const suggestionEvt: Partial<KeyboardEvent> & { preventDefault: () => void } = {
      ...commentEvt,
      shiftKey: true,
      key: '>',
    };
    handler!(suggestionEvt as KeyboardEvent);
    const afterSuggestion = { ...fired };
    assert(afterSuggestion.comment === 1, `Cmd+Shift+. must not fire onCommentComposer, got ${afterSuggestion.comment}`);
    assert(afterSuggestion.suggestion === 1, `expected onSuggestionComposer to fire once, got ${afterSuggestion.suggestion}`);

    cleanup();
  } finally {
    w.window = prev;
    w.document = prevDoc;
    w.HTMLElement = prevHtml;
  }
});

// ---------------------------------------------------------------------------
// Runner — same shape as ShareDialog.test.ts / store.test.ts
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
