// Contract tests for the shared accordion primitive (attn-vlmz.3.2).
//
// Run with:  cd web && npx tsx src/lib/components/ui/accordion/accordion.test.ts
// (or via `npm test`, which runs every src/**/*.test.ts under Node+tsx).
//
// `web/` has no jsdom and no vitest — see scripts/run-tests.mjs — so the
// accordion was deliberately split so that everything worth asserting is
// reachable without a browser:
//
//   * accordion-model.ts is pure. Cases 1-6 call it directly.
//   * accordion-core.ts touches only a dozen DOM methods, implemented by the
//     stub in ./fake-dom.ts. Cases 7-13 run the REAL core against that stub,
//     so the click/keyboard/ARIA/teardown behaviour under test is production
//     code, not a re-description of it.
//
// Case 12 is the one the follow-up issue (attn-vlmz.3.3) depends on: it
// rehearses the full ProseMirror NodeView lifecycle — build imperative DOM,
// wire it, interact, then `destroy()` — and asserts that teardown leaves zero
// listeners behind. ProseMirror recreates NodeViews on every document swap,
// so "no listener survives destroy()" is the leak-safety contract.

import {
  attachAccordion,
  createAccordionDom,
  type AccordionItemSpec,
} from './accordion-core';
import {
  accordionContentClass,
  accordionTriggerClass,
} from './accordion-styles';
import {
  FakeElement,
  clearFocusLog,
  createFakeElement,
  fakeDocument,
  focusLog,
} from './fake-dom';
import {
  accordionItemIds,
  applyToggle,
  contentAttributes,
  nextTriggerIndex,
  normalizeValue,
  triggerAttributes,
} from './accordion-model';

// ---------------------------------------------------------------------------
// Tiny harness (mirrors ShareChip.test.ts / ReviewApplyExpand.test.ts)
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

// ---------------------------------------------------------------------------
// DOM stub (shared with the frontmatter NodeView test — see ./fake-dom.ts)
// ---------------------------------------------------------------------------

const element = createFakeElement;

/** Build N bare items the way a caller who owns their own markup would. */
function buildItems(
  values: string[],
  disabled: string[] = [],
): { root: FakeElement; specs: AccordionItemSpec[]; parts: Map<string, FakeElement> } {
  const root = element('div');
  const parts = new Map<string, FakeElement>();
  const specs = values.map((value) => {
    const item = element('div');
    const trigger = element('button');
    trigger.className = `trigger-${value}`;
    const content = element('div');
    item.appendChild(trigger);
    item.appendChild(content);
    root.appendChild(item);
    parts.set(`${value}:trigger`, trigger);
    parts.set(`${value}:content`, content);
    parts.set(`${value}:item`, item);
    return {
      value,
      trigger: trigger as unknown as HTMLElement,
      content: content as unknown as HTMLElement,
      item: item as unknown as HTMLElement,
      disabled: disabled.includes(value),
    } satisfies AccordionItemSpec;
  });
  return { root, specs, parts };
}

// ---------------------------------------------------------------------------
// 1-3. Open-set semantics
// ---------------------------------------------------------------------------

defineCase('1. normalizeValue collapses every input shape to an open-set', () => {
  assertEq(normalizeValue(undefined, 'single'), [], 'undefined');
  assertEq(normalizeValue(null, 'multiple'), [], 'null');
  assertEq(normalizeValue('a', 'single'), ['a'], 'bare string');
  assertEq(normalizeValue(['a', 'b'], 'single'), ['a'], 'single truncates');
  assertEq(normalizeValue(['a', 'b'], 'multiple'), ['a', 'b'], 'multiple keeps');
  assertEq(normalizeValue(['a', 'a', ''], 'multiple'), ['a'], 'dedupes and drops empties');
});

defineCase('2. single mode keeps at most one open; collapsible gates self-close', () => {
  assertEq(applyToggle([], 'a', 'single'), ['a'], 'open from empty');
  assertEq(applyToggle(['a'], 'b', 'single'), ['b'], 'opening b closes a');
  assertEq(applyToggle(['a'], 'a', 'single', true), [], 'collapsible closes itself');
  assertEq(applyToggle(['a'], 'a', 'single', false), ['a'], 'non-collapsible stays open');
});

defineCase('3. multiple mode toggles independently', () => {
  assertEq(applyToggle([], 'a', 'multiple'), ['a'], 'open a');
  assertEq(applyToggle(['a'], 'b', 'multiple'), ['a', 'b'], 'open b alongside');
  assertEq(applyToggle(['a', 'b'], 'a', 'multiple'), ['b'], 'close a only');
});

// ---------------------------------------------------------------------------
// 4-5. Roving focus (WAI-ARIA accordion keyboard pattern)
// ---------------------------------------------------------------------------

defineCase('4. arrow/Home/End move focus, wrapping when loop is on', () => {
  const three = [{}, {}, {}];
  assertEq(nextTriggerIndex('ArrowDown', 0, three), 1, 'down');
  assertEq(nextTriggerIndex('ArrowDown', 2, three), 0, 'down wraps');
  assertEq(nextTriggerIndex('ArrowUp', 0, three), 2, 'up wraps');
  assertEq(nextTriggerIndex('Home', 2, three), 0, 'home');
  assertEq(nextTriggerIndex('End', 0, three), 2, 'end');
  assertEq(nextTriggerIndex('ArrowLeft', 0, three), null, 'vertical pattern ignores left/right');
  assertEq(nextTriggerIndex('a', 0, three), null, 'plain keys pass through');
});

defineCase('5. disabled triggers are skipped, and loop:false clamps', () => {
  const withDisabled = [{}, { disabled: true }, {}];
  assertEq(nextTriggerIndex('ArrowDown', 0, withDisabled), 2, 'skips the disabled middle');
  assertEq(nextTriggerIndex('ArrowUp', 2, withDisabled), 0, 'skips it upward too');
  assertEq(nextTriggerIndex('ArrowUp', 0, withDisabled, false), null, 'no wrap at the top');
  assertEq(nextTriggerIndex('ArrowDown', 2, withDisabled, false), null, 'no wrap at the bottom');
  assertEq(nextTriggerIndex('End', 0, [{ disabled: true }]), null, 'all-disabled set has nowhere to go');
});

// ---------------------------------------------------------------------------
// 6. ARIA contract
// ---------------------------------------------------------------------------

defineCase('6. trigger/panel are cross-referenced, and a closed panel is inert', () => {
  const ids = accordionItemIds('fm', 'front matter');
  assertEq(ids.triggerId, 'fm-trigger-front-matter', 'ids slugify the value');

  const openTrigger = triggerAttributes(ids, true);
  assertEq(openTrigger['aria-expanded'], 'true', 'expanded');
  assertEq(openTrigger['aria-controls'], ids.contentId, 'points at its panel');
  assertEq(openTrigger.type, 'button', 'native activation semantics');

  const closedTrigger = triggerAttributes(ids, false, true);
  assertEq(closedTrigger['aria-expanded'], 'false', 'collapsed');
  assertEq(closedTrigger['aria-disabled'], 'true', 'disabled is announced');

  const openPanel = contentAttributes(ids, true);
  assertEq(openPanel.role, 'region', 'panel is a region');
  assertEq(openPanel['aria-labelledby'], ids.triggerId, 'labelled by its trigger');
  assertEq(openPanel.inert, null, 'open panel is reachable');

  // The load-bearing one: the panel stays in the DOM so 0fr->1fr can animate,
  // so `inert` is what must keep collapsed content out of the tab order.
  assertEq(contentAttributes(ids, false).inert, '', 'closed panel is inert');
});

// ---------------------------------------------------------------------------
// 7-11. The real core against the DOM stub
// ---------------------------------------------------------------------------

defineCase('7. attachAccordion applies the full ARIA wiring up front', () => {
  const { root, specs, parts } = buildItems(['a', 'b']);
  const controller = attachAccordion(root as unknown as HTMLElement, specs, {
    idPrefix: 'acc',
    value: 'a',
  });

  assertEq(root.getAttribute('role'), null, 'root takes no role (headings own that)');
  assertEq(root.getAttribute('data-slot'), 'accordion', 'root is automation-addressable');
  assertEq(root.getAttribute('data-orientation'), 'vertical', 'orientation is declared');

  const triggerA = parts.get('a:trigger') as FakeElement;
  const contentA = parts.get('a:content') as FakeElement;
  assertEq(triggerA.getAttribute('aria-expanded'), 'true', 'seeded open');
  assertEq(triggerA.getAttribute('aria-controls'), contentA.getAttribute('id'), 'cross-referenced');
  assertEq(contentA.getAttribute('data-state'), 'open', 'panel state');
  assertEq(contentA.hasAttribute('inert'), false, 'open panel not inert');

  const contentB = parts.get('b:content') as FakeElement;
  assertEq(contentB.hasAttribute('inert'), true, 'closed sibling is inert');
  assertEq((parts.get('b:item') as FakeElement).getAttribute('data-state'), 'closed', 'item styling hook');
  assertEq(controller.value, ['a'], 'controller reports the open set');
  controller.destroy();
});

defineCase('8. clicking a trigger toggles it and reports through onValueChange', () => {
  const { root, specs, parts } = buildItems(['a', 'b']);
  const seen: string[][] = [];
  const controller = attachAccordion(root as unknown as HTMLElement, specs, {
    idPrefix: 'acc',
    onValueChange: (next) => seen.push(next),
  });

  (parts.get('a:trigger') as FakeElement).fire('click');
  assertEq(controller.value, ['a'], 'a opened');

  (parts.get('b:trigger') as FakeElement).fire('click');
  assertEq(controller.value, ['b'], 'single mode closed a');
  assertEq((parts.get('a:trigger') as FakeElement).getAttribute('aria-expanded'), 'false', 'a re-collapsed');

  (parts.get('b:trigger') as FakeElement).fire('click');
  assertEq(controller.value, [], 'collapsible closes b');
  assertEq(seen, [['a'], ['b'], []], 'every transition was reported once');
  controller.destroy();
});

defineCase('9. multiple mode, non-collapsible single, and disabled items', () => {
  const multi = buildItems(['a', 'b']);
  const multiController = attachAccordion(multi.root as unknown as HTMLElement, multi.specs, {
    type: 'multiple',
    idPrefix: 'm',
  });
  (multi.parts.get('a:trigger') as FakeElement).fire('click');
  (multi.parts.get('b:trigger') as FakeElement).fire('click');
  assertEq(multiController.value, ['a', 'b'], 'both open at once');
  multiController.destroy();

  const pinned = buildItems(['a', 'b']);
  const pinnedController = attachAccordion(pinned.root as unknown as HTMLElement, pinned.specs, {
    collapsible: false,
    value: 'a',
    idPrefix: 'p',
  });
  (pinned.parts.get('a:trigger') as FakeElement).fire('click');
  assertEq(pinnedController.value, ['a'], 'non-collapsible refuses to close the last one');
  pinnedController.destroy();

  const off = buildItems(['a', 'b'], ['b']);
  const offController = attachAccordion(off.root as unknown as HTMLElement, off.specs, { idPrefix: 'd' });
  assertEq((off.parts.get('b:trigger') as FakeElement).getAttribute('data-disabled'), '', 'flagged');
  (off.parts.get('b:trigger') as FakeElement).fire('click');
  assertEq(offController.value, [], 'a disabled trigger does nothing');
  offController.destroy();
});

defineCase('10. keyboard navigation moves focus between triggers', () => {
  clearFocusLog();
  const { root, specs, parts } = buildItems(['a', 'b', 'c'], ['b']);
  const controller = attachAccordion(root as unknown as HTMLElement, specs, { idPrefix: 'k' });

  const first = parts.get('a:trigger') as FakeElement;
  const last = parts.get('c:trigger') as FakeElement;

  const down = first.fire('keydown', { key: 'ArrowDown' });
  assert(down.defaultPrevented, 'ArrowDown is consumed, not leaked to the host');
  assertEq(focusLog, ['k-trigger-c'], 'skipped the disabled middle item');

  last.fire('keydown', { key: 'ArrowDown' });
  assertEq(focusLog.at(-1), 'k-trigger-a', 'wrapped to the top');

  last.fire('keydown', { key: 'Home' });
  assertEq(focusLog.at(-1), 'k-trigger-a', 'Home jumps to the first');

  first.fire('keydown', { key: 'End' });
  assertEq(focusLog.at(-1), 'k-trigger-c', 'End jumps to the last');

  const plain = first.fire('keydown', { key: 'x' });
  assert(!plain.defaultPrevented, 'unrelated keys pass through to the host editor');
  controller.destroy();
});

defineCase('11. setValue drives the DOM without re-wiring', () => {
  const { root, specs, parts } = buildItems(['a', 'b']);
  const seen: string[][] = [];
  const controller = attachAccordion(root as unknown as HTMLElement, specs, {
    idPrefix: 's',
    onValueChange: (next) => seen.push(next),
  });
  const before = root.listenerCount();

  controller.setValue('b');
  assertEq((parts.get('b:content') as FakeElement).getAttribute('data-state'), 'open', 'panel opened');
  assertEq(root.listenerCount(), before, 'no listeners added or lost');

  controller.setValue('b');
  assertEq(seen.length, 1, 'a no-op setValue does not re-notify');
  controller.destroy();
});

// ---------------------------------------------------------------------------
// 12-13. The ProseMirror NodeView contract (attn-vlmz.3.3 depends on this)
// ---------------------------------------------------------------------------

defineCase('12. NodeView lifecycle: build imperatively, interact, destroy clean', () => {
  clearFocusLog();

  // --- exactly what frontmatter-nodeview.ts will do -------------------------
  const dl = element('dl');
  const { element: dom, controller, bodies } = createAccordionDom(
    [
      {
        value: 'frontmatter',
        label: 'Frontmatter',
        meta: '3 fields',
        content: dl as unknown as Node,
      },
    ],
    { document: fakeDocument, idPrefix: 'frontmatter', type: 'single' },
  );
  const nodeView = {
    dom: dom as unknown as HTMLElement,
    ignoreMutation: () => true,
    stopEvent: () => true,
    destroy: () => controller.destroy(),
  };
  // -------------------------------------------------------------------------

  const root = dom as unknown as FakeElement;
  const buttons = root.findAll('button');
  assertEq(buttons.length, 1, 'one trigger was built');
  const trigger = buttons[0];
  assertEq(trigger.getAttribute('id'), 'frontmatter-trigger-frontmatter', 'ids honour the prefix');
  assertEq(trigger.getAttribute('aria-expanded'), 'false', 'starts folded');
  assert(trigger.className.includes('accordion-trigger'), 'trigger carries the group name');

  const body = bodies.get('frontmatter') as unknown as FakeElement;
  assertEq(body.children[0], dl, 'caller content is placed verbatim');

  trigger.fire('click');
  assertEq(controller.value, ['frontmatter'], 'the card unfolds on click');
  assertEq(nodeView.stopEvent(), true, 'the NodeView keeps ProseMirror out of its keymap');

  const live = root.listenerCount();
  assert(live > 0, 'the card is wired while alive');

  // ProseMirror recreates NodeViews on every document swap. Anything the core
  // added must come back off, or the editor leaks one wiring per swap.
  nodeView.destroy();
  assertEq(root.listenerCount(), 0, 'destroy() left no listener behind');
  nodeView.destroy();
  assertEq(root.listenerCount(), 0, 'destroy() is idempotent');

  trigger.fire('click');
  assertEq(controller.value, ['frontmatter'], 'a destroyed card no longer responds');

  return `${live} listeners while alive, 0 after destroy`;
});

defineCase('13. the motion + reduced-motion contract is in the shared class strings', () => {
  // These are asserted, not eyeballed, because BOTH consumers import them: a
  // regression here silently desyncs the NodeView from the Svelte components.
  assert(accordionContentClass.includes('grid-rows-[0fr]'), 'panel collapses via grid rows');
  assert(
    accordionContentClass.includes('data-[state=open]:grid-rows-[1fr]'),
    'panel expands via grid rows (no measured pixel height)',
  );
  assert(
    accordionContentClass.includes('duration-[var(--t)]')
      && accordionContentClass.includes('ease-[var(--ease)]'),
    'panel uses the single motion signature from tokens.css',
  );
  assert(
    accordionContentClass.includes('motion-reduce:transition-none'),
    'reduced motion is an instant snap, stated locally',
  );
  assert(
    accordionTriggerClass.includes('focus-visible:ring-[3px]'),
    'trigger keeps the app-wide focus ring',
  );
  assert(
    accordionTriggerClass.includes('dark:hover:bg-accent/50'),
    'Ink gets its own hover wash, not Paper’s',
  );
});

// ---------------------------------------------------------------------------

function runAllCases(): void {
  const results = cases.map((run) => run());
  for (const result of results) {
    const status = result.ok ? 'PASS' : 'FAIL';
    console.log(`${status}  ${result.name}${result.detail ? ` — ${result.detail}` : ''}`);
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} accordion cases passed.`);
  if (failed.length > 0) process.exit(1);
}

runAllCases();
