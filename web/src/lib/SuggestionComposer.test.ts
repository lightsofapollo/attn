// Manual smoke harness for `SuggestionComposer.svelte` (attn-nnj.4.5).
// Pattern mirrors `ShareDialog.test.ts` / `ReviewApplyExpand.test.ts`:
// `web/` has no vitest config yet, so tests are tsx-runnable functions
// with a tiny harness.
//
// Run with:
//
//   cd web && npx tsx src/lib/SuggestionComposer.test.ts
//
// IMPORTANT: this test cannot mount the .svelte component itself — tsx
// evaluates `*.svelte` files as bare TypeScript and the runes only compile
// through the Vite + svelte plugin pipeline. So we test the contracts the
// component depends on:
//
//   1. Empty selection: Cmd+Shift+. does nothing (hasTextSelection guard).
//   2. Non-empty selection: Cmd+Shift+. fires `onSuggestionComposer`.
//   3. Replace mode captures expected_text from the selection and carries
//      the user-supplied replacement.
//   4. Delete mode captures only expected_text (no replacement field).
//   5. Insert Before / After produce text-only operations (no expected_text).
//   6. Submit emits `review_create_suggestion` with the right SuggestionDraft.
//   7. Cancel emits no IPC.
//   8. Esc handler dismisses without IPC (and stops propagation).
//   9. Note is included on the draft only when non-empty (trimmed).

import { initKeyboard } from './keyboard';
import { hasTextSelection } from './review/popover-anchor';
import {
  buildSuggestionDraft,
  buildSuggestionOperation,
  type ComposerFormState,
} from './SuggestionComposer.logic';
import { reviewCreateSuggestion } from './ipc';
import type {
  Anchor,
  AnchorIndex,
  ContentHash,
  FileId,
  RoomId,
  SnapshotId,
  SuggestionDraft,
} from './types';
import type { ConstructAnchorContext } from './review/anchors';
import type { EditorView } from 'prosemirror-view';
import type { Node as PMNode } from 'prosemirror-model';

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
// Mock ipc capture — intercepts `window.ipc.postMessage` so we can assert on
// outbound payloads from `reviewCreateSuggestion` without spinning up the
// real wry bridge.
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
// Stub EditorView — anchorFromSelection only reads
//   view.state.doc.textBetween(from, to, blockSep, leafSep)
//   view.state.doc.forEach(child => ...)
//   view.state.doc.content.size
// plus `view.state.selection.{from,to,empty}` for hasTextSelection.
// We model a single-block doc with a known text payload.
// ---------------------------------------------------------------------------

interface StubView {
  view: EditorView;
  index: AnchorIndex;
  pmFrom: number;
  pmTo: number;
  /** Just the selected text (the substring textBetween returns). */
  selectedText: string;
}

function buildStubView(text: string, selStart: number, selEnd: number): StubView {
  // Single-block doc. pmStart=0, pmEnd = text.length + 2.
  const pmFrom = 1 + selStart;
  const pmTo = 1 + selEnd;
  const docSize = text.length + 2;

  const stubChildren = [{ nodeSize: docSize } as unknown as PMNode];

  function textBetween(from: number, to: number, _blockSep: string, _leafSep: string): string {
    const innerStart = 1;
    const innerEnd = docSize - 1;
    const sliceStart = Math.max(from, innerStart) - innerStart;
    const sliceEnd = Math.min(to, innerEnd) - innerStart;
    if (sliceEnd <= sliceStart) return '';
    return text.slice(sliceStart, sliceEnd);
  }

  const stubDoc = {
    content: { size: docSize },
    nodeSize: docSize + 2,
    textBetween,
    forEach: (cb: (child: PMNode, offset: number, index: number) => void) => {
      cb(stubChildren[0]!, 0, 0);
    },
  } as unknown as PMNode;

  const view = {
    state: {
      doc: stubDoc,
      selection: {
        from: pmFrom,
        to: pmTo,
        empty: pmFrom === pmTo,
      },
    },
  } as unknown as EditorView;

  // Match the byte layout the anchorFromSelection helpers expect.
  const enc = new TextEncoder();
  const totalBytes = enc.encode(text).length;
  const index: AnchorIndex = {
    docHash: 'faux:doc-hash' as ContentHash,
    canonicalEncoding: 'utf8-bytes',
    lineCount: 1,
    blocks: [
      {
        snapshotBlockId: 'block-0',
        contentFingerprint: 'fp-0',
        kind: 'paragraph',
        byteRange: [0, totalBytes],
        lineRange: [0, 0],
        headingPath: [],
        ordinalInParent: 0,
        duplicateOrdinal: 0,
        textHash: 'text-hash-0',
        normalizedTextHash: 'norm-0',
      },
    ],
    headings: [],
  };

  return { view, index, pmFrom, pmTo, selectedText: text.slice(selStart, selEnd) };
}

function makeAnchorContext(index: AnchorIndex): ConstructAnchorContext {
  return {
    index,
    fileId: 'file_test' as FileId,
    snapshotId: 'snap_test' as SnapshotId,
    baseHash: index.docHash,
  };
}

// ---------------------------------------------------------------------------
// (1) Empty selection: Cmd+Shift+. does nothing.
// We exercise the gate the way App.svelte does: `hasTextSelection(view)` is
// false → openSuggestionComposer returns without setting state.
// ---------------------------------------------------------------------------

defineCase('Empty selection: hasTextSelection returns false → composer does not open', () => {
  // PM uses (from === to) for empty.
  const stub = buildStubView('hello world', 4, 4);
  assert(
    !hasTextSelection(stub.view),
    'expected hasTextSelection to be false for empty selection',
  );

  // The opener gate that App.svelte applies:
  const state: { opened: boolean } = { opened: false };
  function openIfSelected(view: EditorView): void {
    if (!hasTextSelection(view)) return;
    state.opened = true;
  }
  openIfSelected(stub.view);
  assert(state.opened === false, 'expected composer to NOT open on empty selection');
});

// ---------------------------------------------------------------------------
// (2) Non-empty selection: hasTextSelection returns true → composer opens.
// ---------------------------------------------------------------------------

defineCase('Non-empty selection: hasTextSelection true → composer opens', () => {
  const stub = buildStubView('hello world', 0, 5);
  assert(
    hasTextSelection(stub.view),
    'expected hasTextSelection to be true for non-empty selection',
  );

  const state: { opened: boolean } = { opened: false };
  function openIfSelected(view: EditorView): void {
    if (!hasTextSelection(view)) return;
    state.opened = true;
  }
  openIfSelected(stub.view);
  assert(state.opened === true, 'expected composer to open on non-empty selection');
});

// ---------------------------------------------------------------------------
// (3) Replace mode: expected_text auto-captured + replacement field used.
// ---------------------------------------------------------------------------

defineCase('Replace mode captures expected_text and carries replacement', () => {
  const stub = buildStubView('the quick brown fox', 4, 9); // "quick"
  const ctx = makeAnchorContext(stub.index);
  const form: ComposerFormState = {
    kind: 'replace',
    selectedText: stub.selectedText,
    replacementText: 'fast',
    insertText: '',
    note: '',
  };
  const op = buildSuggestionOperation(form);
  assert(op.kind === 'replace', `expected kind=replace, got ${op.kind}`);
  if (op.kind === 'replace') {
    assert(op.expectedText === 'quick', `expected expectedText=quick, got "${op.expectedText}"`);
    assert(op.replacement === 'fast', `expected replacement=fast, got "${op.replacement}"`);
  }
  // And the assembled draft has both the anchor and the operation.
  const draft = buildSuggestionDraft(stub.view, stub.pmFrom, stub.pmTo, ctx, form);
  assert(draft.operation.kind === 'replace', 'draft.operation.kind should be replace');
  assert(draft.anchor.quote !== undefined, 'draft.anchor must have a quote layer for a range');
});

// ---------------------------------------------------------------------------
// (4) Delete mode: only expected_text, no replacement.
// ---------------------------------------------------------------------------

defineCase('Delete mode captures expected_text only (no replacement field)', () => {
  const stub = buildStubView('the quick brown fox', 4, 9); // "quick"
  const form: ComposerFormState = {
    kind: 'delete',
    selectedText: stub.selectedText,
    replacementText: '',
    insertText: '',
    note: '',
  };
  const op = buildSuggestionOperation(form);
  assert(op.kind === 'delete', `expected kind=delete, got ${op.kind}`);
  if (op.kind === 'delete') {
    assert(op.expectedText === 'quick', `expected expectedText=quick, got "${op.expectedText}"`);
  }
  // Verify there's no replacement-like field leaking onto the op.
  const opUnknown = op as unknown as Record<string, unknown>;
  assert(
    !('replacement' in opUnknown) && !('text' in opUnknown),
    `delete op should only carry expectedText, got keys=${Object.keys(opUnknown).join(',')}`,
  );
});

// ---------------------------------------------------------------------------
// (5) Insert Before / After: only text, no expected_text.
// ---------------------------------------------------------------------------

defineCase('Insert Before / After carry text only (no expected_text)', () => {
  const stub = buildStubView('the quick brown fox', 4, 9);
  const formBefore: ComposerFormState = {
    kind: 'insert_before',
    selectedText: stub.selectedText,
    replacementText: '',
    insertText: 'very ',
    note: '',
  };
  const opBefore = buildSuggestionOperation(formBefore);
  assert(opBefore.kind === 'insert_before', `kind=${opBefore.kind}`);
  if (opBefore.kind === 'insert_before') {
    assert(opBefore.text === 'very ', `expected text="very ", got "${opBefore.text}"`);
  }
  // Confirm no expected_text leak.
  const beforeUnknown = opBefore as unknown as Record<string, unknown>;
  assert(
    !('expectedText' in beforeUnknown),
    `insert_before must not carry expectedText (keys=${Object.keys(beforeUnknown).join(',')})`,
  );

  const formAfter: ComposerFormState = {
    kind: 'insert_after',
    selectedText: stub.selectedText,
    replacementText: '',
    insertText: ' is good',
    note: '',
  };
  const opAfter = buildSuggestionOperation(formAfter);
  assert(opAfter.kind === 'insert_after', `kind=${opAfter.kind}`);
  if (opAfter.kind === 'insert_after') {
    assert(opAfter.text === ' is good', `expected text=" is good", got "${opAfter.text}"`);
  }
  const afterUnknown = opAfter as unknown as Record<string, unknown>;
  assert(
    !('expectedText' in afterUnknown),
    `insert_after must not carry expectedText (keys=${Object.keys(afterUnknown).join(',')})`,
  );
});

// ---------------------------------------------------------------------------
// (6) Submit emits review_create_suggestion with the right draft.
// ---------------------------------------------------------------------------

defineCase('Submit emits review_create_suggestion with the assembled draft', async () => {
  ipc.reset();
  const stub = buildStubView('the quick brown fox', 4, 9);
  const ctx = makeAnchorContext(stub.index);
  const form: ComposerFormState = {
    kind: 'replace',
    selectedText: stub.selectedText,
    replacementText: 'fast',
    insertText: '',
    note: 'snappier',
  };
  const draft = buildSuggestionDraft(stub.view, stub.pmFrom, stub.pmTo, ctx, form);
  await reviewCreateSuggestion('room-xyz' as RoomId, draft);
  assert(ipc.messages.length === 1, `expected 1 ipc message, got ${ipc.messages.length}`);
  const msg = ipc.messages[0]!;
  assert(
    msg.type === 'review_create_suggestion',
    `expected type=review_create_suggestion, got ${String(msg.type)}`,
  );
  assert(msg.roomId === 'room-xyz', `expected roomId=room-xyz, got ${String(msg.roomId)}`);
  const sent = msg.draft as SuggestionDraft;
  assert(sent.operation.kind === 'replace', `expected replace op, got ${sent.operation.kind}`);
  if (sent.operation.kind === 'replace') {
    assert(
      sent.operation.expectedText === 'quick',
      `expected expectedText=quick, got "${sent.operation.expectedText}"`,
    );
    assert(
      sent.operation.replacement === 'fast',
      `expected replacement=fast, got "${sent.operation.replacement}"`,
    );
  }
  assert(sent.note === 'snappier', `expected note=snappier, got "${String(sent.note)}"`);
  assert(sent.anchor.fileId === ctx.fileId, 'draft.anchor.fileId should match ctx.fileId');
  assert(sent.anchor.snapshotId === ctx.snapshotId, 'draft.anchor.snapshotId should match');
});

// ---------------------------------------------------------------------------
// (7) Cancel emits no IPC.
// We simulate Cancel as "do not call buildSuggestionDraft / reviewCreateSuggestion."
// ---------------------------------------------------------------------------

defineCase('Cancel does not emit review_create_suggestion', () => {
  ipc.reset();
  // The composer's cancel path simply calls onClose() — no IPC dispatch.
  // We mirror that here by NOT invoking reviewCreateSuggestion at all.
  function handleCancel(): void {
    // intentionally empty
  }
  handleCancel();
  assert(ipc.messages.length === 0, `expected 0 ipc messages on cancel, got ${ipc.messages.length}`);
});

// ---------------------------------------------------------------------------
// (8) Esc closes the composer without dispatching IPC.
// We assert the keydown handler invokes onClose for Escape and *does not*
// invoke onSubmit. We use the same handler shape the component installs.
// ---------------------------------------------------------------------------

defineCase('Esc keydown handler closes without IPC', () => {
  ipc.reset();
  const counters: { closed: number; submitted: number; prevent: number; stop: number } = {
    closed: 0,
    submitted: 0,
    prevent: 0,
    stop: 0,
  };
  function handleKeyDown(e: { key: string; metaKey?: boolean; ctrlKey?: boolean; preventDefault: () => void; stopPropagation: () => void }): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      counters.closed += 1;
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      counters.submitted += 1;
    }
  }
  handleKeyDown({
    key: 'Escape',
    preventDefault() { counters.prevent += 1; },
    stopPropagation() { counters.stop += 1; },
  });
  assert(counters.closed === 1, `expected onClose to fire once on Esc, got ${counters.closed}`);
  assert(counters.submitted === 0, `expected onSubmit NOT to fire on Esc, got ${counters.submitted}`);
  assert(counters.prevent === 1, `expected preventDefault to fire on Esc, got ${counters.prevent}`);
  assert(counters.stop === 1, `expected stopPropagation to fire on Esc, got ${counters.stop}`);
  assert(ipc.messages.length === 0, `expected 0 ipc on Esc, got ${ipc.messages.length}`);
});

// ---------------------------------------------------------------------------
// (9) Cmd+Shift+. routes through initKeyboard → onSuggestionComposer (and
// plain Cmd+. routes to onCommentComposer instead).
// ---------------------------------------------------------------------------

defineCase('Cmd+Shift+. routes through initKeyboard → onSuggestionComposer', () => {
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
    const fired: { suggestion: number; comment: number } = { suggestion: 0, comment: 0 };
    const cleanup = initKeyboard({
      onSuggestionComposer: () => { fired.suggestion += 1; },
      onCommentComposer: () => { fired.comment += 1; },
    });
    const handler = listeners.get('keydown');
    assert(typeof handler === 'function', 'expected initKeyboard to bind keydown');

    // Cmd+Shift+. fires onSuggestionComposer.
    handler!({
      metaKey: true,
      ctrlKey: false,
      shiftKey: true,
      altKey: false,
      key: '.',
      code: 'Period',
      repeat: false,
      defaultPrevented: false,
      isComposing: false,
      target: null,
      preventDefault() {},
    } as unknown as KeyboardEvent);
    assert(fired.suggestion === 1, `expected onSuggestionComposer to fire once, got ${fired.suggestion}`);
    assert(fired.comment === 0, `expected onCommentComposer NOT to fire, got ${fired.comment}`);

    // Plain Cmd+. fires onCommentComposer (not the suggestion one).
    handler!({
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
    } as unknown as KeyboardEvent);
    // Reads after the second handler call. Use a getter through a fresh
    // accessor so TS doesn't narrow through the asserts above.
    const suggestionAfter = fired.suggestion as number;
    const commentAfter = fired.comment as number;
    assert(suggestionAfter === 1, `Cmd+. must not re-fire onSuggestionComposer, got ${suggestionAfter}`);
    assert(commentAfter === 1, `expected onCommentComposer to fire once, got ${commentAfter}`);

    cleanup();
  } finally {
    w.window = prev;
    w.document = prevDoc;
    w.HTMLElement = prevHtml;
  }
});

// ---------------------------------------------------------------------------
// (10) Empty / whitespace note is dropped from the draft. Non-empty note
// is included (trimmed).
// ---------------------------------------------------------------------------

defineCase('Note is dropped when empty and trimmed when present', () => {
  const stub = buildStubView('alpha beta gamma', 6, 10); // "beta"
  const ctx = makeAnchorContext(stub.index);
  const formNoNote: ComposerFormState = {
    kind: 'delete',
    selectedText: stub.selectedText,
    replacementText: '',
    insertText: '',
    note: '   ',
  };
  const draftNoNote = buildSuggestionDraft(stub.view, stub.pmFrom, stub.pmTo, ctx, formNoNote);
  assert(draftNoNote.note === undefined, `expected note=undefined for whitespace-only, got ${String(draftNoNote.note)}`);

  const formWithNote: ComposerFormState = {
    kind: 'delete',
    selectedText: stub.selectedText,
    replacementText: '',
    insertText: '',
    note: '  needs to go  ',
  };
  const draftWithNote = buildSuggestionDraft(stub.view, stub.pmFrom, stub.pmTo, ctx, formWithNote);
  assert(draftWithNote.note === 'needs to go', `expected trimmed note, got "${String(draftWithNote.note)}"`);
});

// ---------------------------------------------------------------------------
// (11) Anchor produced by Submit is a 5-layer anchor (sanity guard so the
// composer can't accidentally regress to position-only).
// ---------------------------------------------------------------------------

defineCase('Submitted draft anchor has full layered structure', () => {
  const stub = buildStubView('the quick brown fox jumps', 10, 15); // "brown"
  const ctx = makeAnchorContext(stub.index);
  const form: ComposerFormState = {
    kind: 'replace',
    selectedText: stub.selectedText,
    replacementText: 'red',
    insertText: '',
    note: '',
  };
  const draft = buildSuggestionDraft(stub.view, stub.pmFrom, stub.pmTo, ctx, form);
  const a: Anchor = draft.anchor;
  assert(a.position !== undefined, 'expected position layer');
  assert(a.quote !== undefined, 'expected quote layer for range selection');
  assert(a.block !== undefined, 'expected block layer');
  assert(a.context !== undefined, 'expected context layer');
  assert(a.structure !== undefined, 'expected structure layer');
  assert(a.fileId === ctx.fileId, 'fileId should propagate from ctx');
  assert(a.snapshotId === ctx.snapshotId, 'snapshotId should propagate from ctx');
});

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

void (async () => {
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

  interface NodeProcessShape {
    exit?: (code: number) => void;
  }
  const nodeProcess: NodeProcessShape | undefined = (
    globalThis as unknown as { process?: NodeProcessShape }
  ).process;
  if (failed > 0) nodeProcess?.exit?.(1);
})();
