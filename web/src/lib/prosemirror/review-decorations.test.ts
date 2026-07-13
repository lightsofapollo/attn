// Manual test harness for `review-decorations.ts` (planning issue
// attn-nnj.4.6).
//
// Mirrors the conventions used by `review/resolver.test.ts` and
// `review/store.test.ts`: pure functions, no framework, raw tsx. Run with:
//
//   cd web && npx tsx src/lib/prosemirror/review-decorations.test.ts
//
// IMPORTANT: we cannot import `store.svelte.ts` (which the plugin file
// pulls in transitively) because tsx evaluates the `$state`/`$derived`
// rune calls as bare identifiers. To dodge that, this harness imports the
// pure builder via a *direct* `tsx` module reference and provides a tiny
// `window.document` stub used only by the `+N more` widget. The builder
// itself never touches the runes — it takes a pre-flattened `inputs`
// object — so the import side-effects of `store.svelte.ts` are the only
// thing in the way.
//
// We patch `globalThis` with `document.createElement` before the SUT
// loads so the widget builder works without a real DOM.

// ---------------------------------------------------------------------------
// Minimal DOM stub (only what the +N more widget uses)
// ---------------------------------------------------------------------------

interface StubElement {
  tagName: string;
  className: string;
  textContent: string;
  style: Record<string, string>;
  attributes: Map<string, string>;
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
}

function makeStubElement(tagName: string): StubElement {
  const attrs = new Map<string, string>();
  return {
    tagName,
    className: '',
    textContent: '',
    style: {},
    attributes: attrs,
    setAttribute(name: string, value: string): void {
      attrs.set(name, value);
    },
    getAttribute(name: string): string | null {
      return attrs.get(name) ?? null;
    },
  };
}

const fakeGlobals = globalThis as unknown as {
  document?: {
    createElement(tag: string): StubElement;
    documentElement: StubElement;
  };
  window?: unknown;
  navigator?: { userAgent: string; platform: string };
};

if (!fakeGlobals.document) {
  fakeGlobals.document = {
    createElement: (tag: string) => makeStubElement(tag),
    documentElement: makeStubElement('html'),
  };
}
if (!fakeGlobals.window) {
  fakeGlobals.window = fakeGlobals;
}
if (!fakeGlobals.navigator) {
  fakeGlobals.navigator = { userAgent: 'node-test', platform: 'node' };
}

// Stub `$state` / `$derived` so the rune-using store module loads under
// raw tsx. The plugin we test never goes through these — it takes the
// resolution map / event list as plain inputs — but the module-level
// singleton in `store.svelte.ts` runs at import time. The stub treats
// `$state(v)` as the identity function.
type DerivedRune = (<T>(value: T) => T) & { by: <T>(fn: () => T) => T };
const fakeRunes = globalThis as unknown as {
  $state?: <T>(value: T) => T;
  $derived?: DerivedRune;
};
if (typeof fakeRunes.$state !== 'function') {
  fakeRunes.$state = <T>(value: T): T => value;
}
if (typeof fakeRunes.$derived !== 'function') {
  // Identity for `$derived(expr)`; `$derived.by(fn)` evaluates `fn` once. The
  // store's module-init runs these against its empty initial state, which is
  // all this test needs (it drives `buildReviewDecorations` with plain inputs).
  const derived = (<T>(value: T): T => value) as DerivedRune;
  derived.by = <T>(fn: () => T): T => fn();
  fakeRunes.$derived = derived;
}

// ---------------------------------------------------------------------------
// SUT — loaded via dynamic import so the rune + DOM stubs above land in
// `globalThis` BEFORE the rune-using `store.svelte.ts` module evaluates.
// (Static imports are hoisted; dynamic imports respect program order.)
// ---------------------------------------------------------------------------

import type {
  Anchor,
  EventId,
  ReviewAnchorResolutionUpdate,
  ReviewEvent,
  ResolvedAnchor,
} from '../types';

type SutModule = typeof import('./review-decorations');
type StoreModule = typeof import('../review/store.svelte');

const sutModule: SutModule = await import('./review-decorations');
const storeModule: StoreModule = await import('../review/store.svelte');

const { buildReviewDecorations, __testing__ } = sutModule;
const { reviewStore } = storeModule;

// ---------------------------------------------------------------------------
// Tiny harness
// ---------------------------------------------------------------------------

interface CaseResult {
  name: string;
  ok: boolean;
  detail?: string;
}

const cases: Array<() => CaseResult> = [];

function defineCase(name: string, fn: () => void | string): void {
  cases.push(() => {
    try {
      const note = fn();
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
// Decoration shape helpers
//
// `Decoration.inline(from, to, attrs, spec)` stores its DOM attributes on
// `decoration.type.attrs` (`InlineType`). Widget decorations store the toDOM
// fn on `decoration.type.toDOM` (`WidgetType`). We probe these via structural
// duck-typing so the harness doesn't depend on ProseMirror's internal class
// names (`InlineType` is not exported).
// ---------------------------------------------------------------------------

interface AnyDecoration {
  from: number;
  to: number;
  type: {
    attrs?: Record<string, string>;
    toDOM?: unknown;
  };
}

function decorationAttrs(d: AnyDecoration): Record<string, string> {
  return d.type.attrs ?? {};
}

function decorationClass(d: AnyDecoration): string {
  return decorationAttrs(d)['class'] ?? '';
}

function isInlineDecoration(d: AnyDecoration): boolean {
  // Inline decorations carry an `attrs` map (a Record<string, string>);
  // widgets carry a `toDOM` (function or DOM node) and do not.
  return d.type.attrs !== undefined && d.type.toDOM === undefined;
}

function isWidgetDecoration(d: AnyDecoration): boolean {
  return d.type.toDOM !== undefined;
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

function makeAnchor(): Anchor {
  return {
    v: 2,
    fileId: 'file-1',
    snapshotId: 'snap-1',
    baseHash: 'hash-1',
    position: {
      byteRange: [0, 5],
      lineRange: [1, 1],
      pmRange: [1, 6],
    },
  };
}

function makeCommentEvent(eventId: EventId): ReviewEvent {
  return {
    meta: {
      v: 2,
      eventId,
      roomId: 'room-1',
      authorId: 'p-1',
      deviceId: 'd-1',
      createdAt: 0,
      parentEventIds: [],
    },
    body: {
      type: 'comment_created',
      threadId: `thread-${eventId}`,
      anchor: makeAnchor(),
      body: 'hello',
    },
    auth: { signature: 'sig', signingKeyId: 'k-1' },
  };
}

function makeSuggestionEvent(
  eventId: EventId,
  variant: 'replace' | 'delete' | 'insert_after' = 'replace',
): ReviewEvent {
  const operation =
    variant === 'delete'
      ? { kind: 'delete' as const, expectedText: 'foo' }
      : variant === 'insert_after'
        ? { kind: 'insert_after' as const, text: 'X' }
        : { kind: 'replace' as const, expectedText: 'foo', replacement: 'bar' };
  return {
    meta: {
      v: 2,
      eventId,
      roomId: 'room-1',
      authorId: 'p-1',
      deviceId: 'd-1',
      createdAt: 0,
      parentEventIds: [],
    },
    body: {
      type: 'suggestion_created',
      suggestionId: eventId,
      anchor: makeAnchor(),
      operation,
    },
    auth: { signature: 'sig', signingKeyId: 'k-1' },
  };
}

function exactResolution(
  eventId: EventId,
  pmFrom = 1,
  pmTo = 6,
): ReviewAnchorResolutionUpdate {
  const resolved: ResolvedAnchor = {
    status: 'exact',
    confidence: 1.0,
    currentRange: {
      byteRange: [0, 5],
      lineRange: [1, 1],
      pmRange: [pmFrom, pmTo],
    },
    reason: 'base_hash_match',
  };
  return { roomId: 'room-1', fileId: 'file-1', eventId, resolved };
}

function remappedResolution(
  eventId: EventId,
  confidence: number,
  pmFrom = 1,
  pmTo = 6,
): ReviewAnchorResolutionUpdate {
  const resolved: ResolvedAnchor = {
    status: 'remapped',
    confidence,
    currentRange: {
      byteRange: [0, 5],
      lineRange: [1, 1],
      pmRange: [pmFrom, pmTo],
    },
    reason: 'quote_match',
  };
  return { roomId: 'room-1', fileId: 'file-1', eventId, resolved };
}

function ambiguousResolution(eventId: EventId): ReviewAnchorResolutionUpdate {
  const resolved: ResolvedAnchor = {
    status: 'ambiguous',
    candidates: [
      {
        confidence: 0.8,
        currentRange: { byteRange: [0, 5], lineRange: [1, 1], pmRange: [1, 6] },
        reason: 'quote_match',
        preview: 'foo',
      },
      {
        confidence: 0.78,
        currentRange: { byteRange: [10, 15], lineRange: [2, 2], pmRange: [12, 17] },
        reason: 'quote_match',
        preview: 'bar',
      },
    ],
    reason: 'top_two_within_0.10',
  };
  return { roomId: 'room-1', fileId: 'file-1', eventId, resolved };
}

function staleResolution(eventId: EventId): ReviewAnchorResolutionUpdate {
  const resolved: ResolvedAnchor = { status: 'stale', reason: 'no_candidates' };
  return { roomId: 'room-1', fileId: 'file-1', eventId, resolved };
}

// ---------------------------------------------------------------------------
// Test cases
// ---------------------------------------------------------------------------

defineCase('empty resolutions → no decorations', () => {
  const decos = buildReviewDecorations({
    resolutions: {},
    events: [],
    docSize: 1000,
    focusEventId: null,
  });
  assert(decos.length === 0, `expected 0 decorations, got ${decos.length}`);
});

defineCase('exact comment → attn-review-comment class', () => {
  const decos = buildReviewDecorations({
    resolutions: { 'evt-1': exactResolution('evt-1') },
    events: [makeCommentEvent('evt-1')],
    docSize: 1000,
    focusEventId: null,
  });
  // Inline mark (index 0) + numbered anchor marker widget (mobile-only via CSS).
  assert(decos.length === 2, `expected 2 decorations (mark + marker), got ${decos.length}`);
  const cls = decorationClass(decos[0] as unknown as AnyDecoration);
  assert(
    cls.includes('attn-review-comment'),
    `expected class to include attn-review-comment, got "${cls}"`,
  );
  assert(
    !cls.includes('--moved'),
    `exact comment should NOT carry --moved modifier; got "${cls}"`,
  );
  // The second decoration is the numbered marker widget carrying the event id.
  const marker = decos[1] as unknown as AnyDecoration;
  assert(isWidgetDecoration(marker), 'expected a widget decoration for the anchor marker');
});

defineCase('remapped suggestion at 0.85 → underline/med-confidence class', () => {
  const decos = buildReviewDecorations({
    resolutions: { 'evt-2': remappedResolution('evt-2', 0.85) },
    events: [makeSuggestionEvent('evt-2')],
    docSize: 1000,
    focusEventId: null,
  });
  // Three decorations: the inline mark (index 0), the numbered anchor marker
  // widget, and the suggestion ghost-text widget. Marks are pushed before
  // widgets, so decos[0] is the mark.
  assert(decos.length === 3, `expected 3 decorations (mark + marker + ghost), got ${decos.length}`);
  const cls = decorationClass(decos[0] as unknown as AnyDecoration);
  assert(
    cls.includes('attn-review-suggestion--moved'),
    `expected --moved modifier, got "${cls}"`,
  );
  assert(
    cls.includes('attn-review-confidence--med'),
    `expected attn-review-confidence--med, got "${cls}"`,
  );
});

defineCase('high-confidence remapped (≥0.90) keeps the highlight treatment', () => {
  const decos = buildReviewDecorations({
    resolutions: { 'evt-90': remappedResolution('evt-90', 0.95) },
    events: [makeCommentEvent('evt-90')],
    docSize: 1000,
    focusEventId: null,
  });
  assert(decos.length === 2, 'expected 2 decorations (mark + marker)');
  const cls = decorationClass(decos[0] as unknown as AnyDecoration);
  assert(
    cls.includes('attn-review-comment') && !cls.includes('--moved'),
    `expected highlight only (no --moved); got "${cls}"`,
  );
});

defineCase('ambiguous resolution → NO inline decoration', () => {
  const decos = buildReviewDecorations({
    resolutions: { 'evt-amb': ambiguousResolution('evt-amb') },
    events: [makeCommentEvent('evt-amb')],
    docSize: 1000,
    focusEventId: null,
  });
  assert(decos.length === 0, `expected 0 decorations, got ${decos.length}`);
});

defineCase('stale resolution → NO inline decoration', () => {
  const decos = buildReviewDecorations({
    resolutions: { 'evt-stale': staleResolution('evt-stale') },
    events: [makeCommentEvent('evt-stale')],
    docSize: 1000,
    focusEventId: null,
  });
  assert(decos.length === 0, `expected 0 decorations, got ${decos.length}`);
});

defineCase('remapped below 0.70 → NO inline decoration', () => {
  const decos = buildReviewDecorations({
    resolutions: { 'evt-low': remappedResolution('evt-low', 0.5) },
    events: [makeCommentEvent('evt-low')],
    docSize: 1000,
    focusEventId: null,
  });
  assert(decos.length === 0, `expected 0 decorations for confidence < 0.7, got ${decos.length}`);
});

defineCase('suggestion delete operation → --deletion modifier', () => {
  const decos = buildReviewDecorations({
    resolutions: { 'evt-del': exactResolution('evt-del') },
    events: [makeSuggestionEvent('evt-del', 'delete')],
    docSize: 1000,
    focusEventId: null,
  });
  // Delete has no ghost text, so: inline mark + numbered marker widget.
  assert(decos.length === 2, 'expected 2 decorations (mark + marker)');
  const cls = decorationClass(decos[0] as unknown as AnyDecoration);
  assert(
    cls.includes('attn-review-suggestion--deletion'),
    `expected --deletion modifier, got "${cls}"`,
  );
});

defineCase('4 comments stacked at same range → 3 inline + 1 widget', () => {
  const resolutions: Record<string, ReviewAnchorResolutionUpdate> = {};
  const events: ReviewEvent[] = [];
  for (let i = 0; i < 4; i++) {
    const eventId = `evt-stack-${i}`;
    resolutions[eventId] = exactResolution(eventId);
    events.push(makeCommentEvent(eventId));
  }
  const decos = buildReviewDecorations({
    resolutions,
    events,
    docSize: 1000,
    focusEventId: null,
  });

  // 3 inline marks + 1 numbered marker widget + 1 "+N more" widget = 5.
  assert(decos.length === 5, `expected 5 decorations (3 inline + 2 widgets), got ${decos.length}`);

  let inlineCount = 0;
  let widgetCount = 0;
  for (const deco of decos as unknown as AnyDecoration[]) {
    if (isInlineDecoration(deco)) inlineCount += 1;
    else if (isWidgetDecoration(deco)) widgetCount += 1;
  }
  assert(
    inlineCount === 3,
    `expected 3 inline decorations, got ${inlineCount}`,
  );
  assert(
    widgetCount === 2,
    `expected 2 widget decorations (marker + overflow), got ${widgetCount}`,
  );
});

defineCase('focusEventId on click → store mutation reflected', () => {
  // Direct exercise of the setter API — equivalent to what the
  // `handleClick` DOM event handler dispatches when the user clicks an
  // inline mark in the editor.
  reviewStore.setFocusEventId('evt-focus');
  assert(
    reviewStore.focusEventId === 'evt-focus',
    `expected focusEventId=evt-focus, got ${String(reviewStore.focusEventId)}`,
  );

  reviewStore.setFocusEventId(null);
  assert(
    reviewStore.focusEventId === null,
    `expected focusEventId cleared, got ${String(reviewStore.focusEventId)}`,
  );
});

defineCase('focused event emits is-focused class on its mark', () => {
  const decos = buildReviewDecorations({
    resolutions: { 'evt-focus': exactResolution('evt-focus') },
    events: [makeCommentEvent('evt-focus')],
    docSize: 1000,
    focusEventId: 'evt-focus',
  });
  assert(decos.length === 2, 'expected 2 decorations (mark + marker)');
  const cls = decorationClass(decos[0] as unknown as AnyDecoration);
  assert(cls.includes('is-focused'), `expected is-focused class, got "${cls}"`);
});

defineCase('decoration attributes carry data-event-id and aria-label', () => {
  const decos = buildReviewDecorations({
    resolutions: { 'evt-attrs': exactResolution('evt-attrs') },
    events: [makeCommentEvent('evt-attrs')],
    docSize: 1000,
    focusEventId: null,
  });
  assert(decos.length === 2, 'expected 2 decorations (mark + marker)');
  const attrs = decorationAttrs(decos[0] as unknown as AnyDecoration);
  assert(
    attrs['data-event-id'] === 'evt-attrs',
    `expected data-event-id=evt-attrs, got ${attrs['data-event-id']}`,
  );
  assert(typeof attrs['aria-label'] === 'string' && attrs['aria-label'].length > 0, 'expected aria-label');
});

defineCase('event without matching ReviewEvent body → no decoration', () => {
  // Resolution present but no event in the log (e.g. event dropped from
  // the local buffer). The decoration plugin silently skips it; the
  // panel still surfaces orphan rows.
  const decos = buildReviewDecorations({
    resolutions: { 'evt-orphan': exactResolution('evt-orphan') },
    events: [],
    docSize: 1000,
    focusEventId: null,
  });
  assert(decos.length === 0, `expected 0 decorations for orphan event, got ${decos.length}`);
});

defineCase('OVERLAP_CAP constant equals 3 (design §5)', () => {
  assert(
    __testing__.OVERLAP_CAP === 3,
    `expected OVERLAP_CAP=3, got ${__testing__.OVERLAP_CAP}`,
  );
});

defineCase('HIGH_CONFIDENCE / INLINE_CUTOFF match amendments #15', () => {
  assert(
    __testing__.HIGH_CONFIDENCE === 0.9,
    `expected HIGH_CONFIDENCE=0.9, got ${__testing__.HIGH_CONFIDENCE}`,
  );
  assert(
    __testing__.INLINE_CUTOFF === 0.7,
    `expected INLINE_CUTOFF=0.7, got ${__testing__.INLINE_CUTOFF}`,
  );
});

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

interface NodeProcessShape {
  exit?: (code: number) => void;
}

function runAllCases(): void {
  let passed = 0;
  let failed = 0;
  for (const run of cases) {
    const r = run();
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

runAllCases();
