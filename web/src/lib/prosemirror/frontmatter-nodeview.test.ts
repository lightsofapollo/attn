// Frontmatter card: round-trip + rebuilt-on-the-primitive contract
// (attn-vlmz.3.3).
//
// Run with:
//
//   cd web && npx tsx src/lib/prosemirror/frontmatter-nodeview.test.ts
//
// Two invariants, and they are independent:
//
//   1. BYTE-EXACT ROUND-TRIP (cases 1-4). `serialize(parse(md)) === md` for
//      frontmatter blocks. This is a property of schema.ts — the parser stores
//      the raw block in `frontmatter.value` and the serializer writes those
//      bytes back — and the NodeView is display-only, so rebuilding the card
//      cannot touch it. These cases exist to PROVE that rather than assert it:
//      they pin the invariant against the shape of the YAML that most tempts a
//      renderer to normalise (nesting, blank lines, comments, `---` inside a
//      value, trailing whitespace).
//
//   2. THE CARD IS BUILT ON THE SHARED PRIMITIVE (cases 5-9). The NodeView
//      reaches for the global `document`, as every NodeView in this directory
//      does, so `withFakeDocument` swaps in the stub from
//      components/ui/accordion/fake-dom.ts and the REAL `frontmatterNodeView`
//      runs against it. These assert the accordion's ARIA/keyboard/teardown
//      wiring reached the card, and that no <details>/<summary> survives.

import { markdownParser, markdownSerializer } from '../schema';
import type { Node as PmNode } from 'prosemirror-model';
import { FakeElement, clearFocusLog, withFakeDocument } from '../components/ui/accordion/fake-dom';
import { frontmatterNodeView, metaLine, summarize } from './frontmatter-nodeview';

// ---------------------------------------------------------------------------
// Tiny harness (mirrors embedded-svg-roundtrip.test.ts)
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
      return { name, ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  });
}

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function assertEq<T>(actual: T, expected: T, msg: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${msg}: expected ${b}, got ${a}`);
}

function parse(md: string): PmNode {
  const doc = markdownParser.parse(md);
  assert(doc !== null, 'parser returned null');
  return doc;
}

function roundTrip(md: string): string {
  return markdownSerializer.serialize(parse(md));
}

function frontmatterValue(md: string): string {
  let found: string | null = null;
  parse(md).descendants((n) => {
    if (n.type.name === 'frontmatter') found = String(n.attrs.value ?? '');
    return found === null;
  });
  assert(found !== null, 'no frontmatter node was parsed');
  return found as unknown as string;
}

/** Build the real NodeView against the DOM stub. */
function renderCard(raw: string) {
  return withFakeDocument(() => {
    const node = { attrs: { value: raw } } as unknown as PmNode;
    const view = frontmatterNodeView(node);
    return { view, dom: view.dom as unknown as FakeElement };
  });
}

// ---------------------------------------------------------------------------
// 1-4. Byte-exact round-trip (the hard invariant)
// ---------------------------------------------------------------------------

defineCase('1. a plain frontmatter block round-trips byte-exact', () => {
  const md = '---\ntitle: Hello\nauthor: Ada\n---\n\nBody text.';
  assertEq(roundTrip(md), md, 'round-trip');
});

defineCase('2. nesting, comments, blank lines and odd spacing all survive', () => {
  // Everything here is something the renderer flattens for display: the
  // summariser collapses `deploy:`s children to "2 fields" and drops the
  // comment and the blank line entirely. None of that may reach the file.
  const md = [
    '---',
    '# a comment the card never shows',
    'title:    Spaced   Out   ',
    'deploy:',
    '  region: syd',
    '  replicas: 3',
    '',
    'tags: [a, b]',
    '---',
    '',
    'Body.',
  ].join('\n');
  assertEq(roundTrip(md), md, 'round-trip');

  // And the display layer really did flatten it, so the round-trip above is
  // load-bearing rather than vacuous.
  const { pairs } = summarize(frontmatterValue(md));
  assertEq(
    pairs.map((p) => p.key),
    ['title', 'deploy', 'tags'],
    'the card shows three top-level keys',
  );
  assertEq(pairs[1].value, '1 field', 'nested block collapsed to a hint (see case 5)');
});

defineCase('3. a `---` inside a value does not truncate the block', () => {
  const md = '---\nrule: "--- not a fence ---"\n---\n\nBody.';
  assertEq(roundTrip(md), md, 'round-trip');
  assertEq(frontmatterValue(md), 'rule: "--- not a fence ---"', 'raw value is intact');
});

defineCase('4. the raw attr is the exact block body, not the rendered pairs', () => {
  const raw = 'title:    Spaced   Out   \nnested:\n  a: 1';
  const md = `---\n${raw}\n---\n\nBody.`;
  assertEq(frontmatterValue(md), raw, 'attr holds the source bytes verbatim');
  // The rendered value is lossy on purpose — proving the two are different is
  // what makes case 1-3 meaningful.
  const { pairs } = summarize(raw);
  assert(pairs[0].value === 'Spaced   Out', 'display value is trimmed');
  assert(pairs[0].value !== raw.split('\n')[0], 'display value != source line');
});

// ---------------------------------------------------------------------------
// 5-6. Summarisation preserved exactly
// ---------------------------------------------------------------------------

defineCase('5. summarize() behaviour is unchanged by the rebuild', () => {
  assertEq(summarize('').count, 0, 'empty block');
  assertEq(summarize('title: Hi').pairs, [{ key: 'title', value: 'Hi' }], 'simple pair');
  assertEq(summarize('key:').pairs, [{ key: 'key', value: '' }], 'valueless key');

  const nested = summarize('a:\n  x: 1\n  y: 2\nb: 3');
  assertEq(nested.count, 2, 'nested children are not counted as keys');
  assertEq(summarize('a:\n  x: 1').pairs[0].value, '1 field', 'singular hint');

  // PRE-EXISTING QUIRK, pinned deliberately rather than fixed. `summarize`
  // writes the hint with `last.value = last.value || …`, so once the first
  // nested line has set "1 field" the value is truthy and every later line is
  // a no-op — a nested block of any depth reads "1 field", never "2 fields".
  // attn-vlmz.3.3 is a mechanism swap (details → shared accordion) and must
  // not change what the card displays, so this stays as-is. Worth its own
  // issue; changing it here would be an undeclared behaviour change.
  assertEq(nested.pairs[0].value, '1 field', 'plural hint never appears (quirk, preserved)');

  assertEq(summarize('  orphan: 1').count, 0, 'indented line with no parent is ignored');
});

defineCase('6. the meta line still prefers author/name, then counts fields', () => {
  const withAuthor = summarize('title: T\nauthor: Ada');
  assertEq(metaLine(withAuthor.pairs, withAuthor.count), 'author: Ada · 2 fields', 'author wins');

  const withName = summarize('name: Ada\ntitle: T');
  assertEq(metaLine(withName.pairs, withName.count), 'name: Ada · 2 fields', 'name also matches');

  const plain = summarize('title: T');
  assertEq(metaLine(plain.pairs, plain.count), '1 field', 'singular, no author');
  assertEq(metaLine([], 0), '0 fields', 'empty block');
});

// ---------------------------------------------------------------------------
// 7-9. The card is genuinely the shared primitive
// ---------------------------------------------------------------------------

defineCase('7. the rendered card is an accordion, with no <details> left', () => {
  const { dom } = renderCard('title: Hello\nauthor: Ada');

  assertEq(dom.findAll('details').length, 0, 'the hand-rolled <details> is gone');
  assertEq(dom.findAll('summary').length, 0, 'and its <summary>');
  assert(dom.classList.contains('frontmatter-card'), 'card identity class kept for CSS');
  assertEq(dom.getAttribute('data-slot'), 'accordion', 'wired by the shared primitive');
  assertEq(dom.contentEditable, 'false', 'display-only');

  const trigger = dom.findAll('button')[0];
  assert(trigger !== undefined, 'the trigger is a real <button>');
  assertEq(trigger.getAttribute('aria-expanded'), 'false', 'starts folded, as before');
  assertEq(
    trigger.getAttribute('aria-controls'),
    dom.findByClass('grid')[0]?.getAttribute('id'),
    'trigger points at its panel',
  );

  assertEq(dom.findByClass('frontmatter-label')[0]?.textContent, 'Frontmatter', 'label');
  assertEq(
    dom.findByClass('frontmatter-meta')[0]?.textContent,
    'author: Ada · 2 fields',
    'meta line keeps the card typography, not the primitive default',
  );
  assert(
    !(dom.findByClass('frontmatter-meta')[0]?.className ?? '').includes('ml-auto'),
    'meta is not pushed to the right edge',
  );
});

defineCase('8. the key/value grid is rendered, unpadded by the primitive', () => {
  const { dom } = renderCard('title: Hello\ndeploy:\n  region: syd');
  const dl = dom.findByClass('frontmatter-pairs')[0];
  assert(dl !== undefined, 'the dl survived');
  assertEq(dl.findAll('dt').map((n) => n.textContent), ['title', 'deploy'], 'keys');
  assertEq(dl.findAll('dd').map((n) => n.textContent), ['Hello', '1 field'], 'values');

  // bodyClass: '' — .frontmatter-pairs owns its padding; the primitive must
  // not stack its own on top.
  const panel = dom.findByClass('grid')[0];
  const body = panel.children[0].children[0];
  assertEq(body.className, '', 'panel body is unstyled by the primitive');
  assertEq(body.children[0], dl, 'and holds the dl directly');
});

defineCase('9. the card toggles, and destroy() releases every listener', () => {
  clearFocusLog();
  const { view, dom } = renderCard('title: Hello');
  const trigger = dom.findAll('button')[0];
  const panel = dom.findByClass('grid')[0];

  assertEq(panel.getAttribute('data-state'), 'closed', 'folded initially');
  assert(panel.hasAttribute('inert'), 'folded content is out of the tab order');

  trigger.fire('click');
  assertEq(trigger.getAttribute('aria-expanded'), 'true', 'unfolds');
  assertEq(panel.getAttribute('data-state'), 'open', 'panel opened');
  assert(!panel.hasAttribute('inert'), 'open content is reachable');

  trigger.fire('click');
  assertEq(panel.getAttribute('data-state'), 'closed', 'and folds again');

  // Arrow keys must be swallowed rather than reaching the editor's keymap —
  // the same reason stopEvent is now `() => true`.
  assert(trigger.fire('keydown', { key: 'ArrowDown' }).defaultPrevented, 'ArrowDown consumed');
  assertEq(view.stopEvent?.(new Event('keydown')), true, 'NodeView stops every event');
  assertEq(view.ignoreMutation?.({} as MutationRecord), true, 'and ignores mutations');

  const live = dom.listenerCount();
  assert(live > 0, 'wired while alive');
  view.destroy?.();
  assertEq(dom.listenerCount(), 0, 'destroy() left nothing behind');
  view.destroy?.();
  assertEq(dom.listenerCount(), 0, 'destroy() is idempotent');

  return `${live} listeners while alive, 0 after destroy`;
});

// ---------------------------------------------------------------------------

function runAllCases(): void {
  const results = cases.map((run) => run());
  for (const result of results) {
    console.log(
      `${result.ok ? 'PASS' : 'FAIL'}  ${result.name}${result.detail ? ` — ${result.detail}` : ''}`,
    );
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} frontmatter cases passed.`);
  if (failed.length > 0) process.exit(1);
}

runAllCases();
