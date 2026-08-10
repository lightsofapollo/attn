// Guards the ScrollArea root/viewport sizing contract that makes a tall dialog
// body scroll instead of being clipped (attn-11g4.1.1 — the unscrollable share
// modal).
//
// The bug: the viewport used `size-full` (`height: 100%`), which only resolves
// against a root whose height is definite. DialogContent bounds its column with
// `max-h-[85vh]` and height auto, so the root's flex-resolved height is NOT
// definite, `height: 100%` fell back to `auto`, the viewport grew to its full
// content height (scrollHeight === clientHeight, nothing to scroll) and the
// overflow was clipped by the dialog's `overflow-hidden`. Sizing the viewport
// by flex instead makes it track the root's used height in every case.
//
// THESE ASSERTIONS DO NOT PROVE THE LAYOUT WORKS. They are source-contract
// checks: this suite runs under plain Node (`scripts/run-tests.mjs`) with no
// DOM and no layout engine, so all it can do is pin the class contract the
// layout depends on, and fail loudly if someone reverts to `size-full`.
//
// The proof that a scrollable box actually results — a dialog taller than the
// window scrolling to its last element, measured in a real engine against the
// real compiled CSS — lives in `web/e2e/dialog-scroll.spec.ts`. Change the
// classes below and you must re-run that spec, not just this file.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

interface CaseResult { name: string; ok: boolean; detail?: string }
const cases: Array<() => Promise<CaseResult>> = [];

function defineCase(name: string, fn: () => void | Promise<void>): void {
  cases.push(async () => {
    try {
      await fn();
      return { name, ok: true };
    } catch (error) {
      return { name, ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  });
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const source = (relative: string): string => fs.readFileSync(path.join(here, relative), 'utf8');

/**
 * The class list of the element carrying `data-slot="<slot>"`.
 *
 * Scans the attribute value with brace matching rather than a regex: the
 * classes sit in a multi-line `class={cn(…)}` and a lazy regex would happily
 * run past the end of one element into the next one's class list.
 */
function slotClasses(markup: string, slot: string): string {
  const anchor = markup.indexOf(`data-slot="${slot}"`);
  assert(anchor !== -1, `no element carries data-slot="${slot}"`);
  const at = markup.indexOf('class=', anchor);
  assert(at !== -1, `element data-slot="${slot}" has no class attribute`);
  const start = at + 'class='.length;

  if (markup[start] === '"') {
    const end = markup.indexOf('"', start + 1);
    assert(end !== -1, `unterminated class attribute on data-slot="${slot}"`);
    return markup.slice(start + 1, end);
  }

  assert(markup[start] === '{', `unexpected class attribute syntax on data-slot="${slot}"`);
  let depth = 0;
  for (let i = start; i < markup.length; i += 1) {
    if (markup[i] === '{') depth += 1;
    else if (markup[i] === '}') {
      depth -= 1;
      if (depth === 0) return markup.slice(start + 1, i);
    }
  }
  throw new Error(`unterminated class expression on data-slot="${slot}"`);
}

defineCase('scroll-area root is a flex column so the viewport can be flex-sized', () => {
  const classes = slotClasses(source('scroll-area.svelte'), 'scroll-area');
  assert(/\bflex\b/.test(classes), 'root must be display:flex');
  assert(/\bflex-col\b/.test(classes), 'root must be a column so the viewport stacks vertically');
});

defineCase('scroll-area viewport is a shrinkable flex item, never a percentage height', () => {
  const classes = slotClasses(source('scroll-area.svelte'), 'scroll-area-viewport');
  assert(
    /\bflex-auto\b/.test(classes),
    'viewport must be flex-auto — it tracks the root height even when that height is indefinite',
  );
  assert(
    /\bmin-h-0\b/.test(classes),
    'viewport needs min-h-0 or its content floor prevents it shrinking to the bounded root',
  );
  assert(
    !/\b(size-full|h-full|h-\[100%\])\b/.test(classes),
    'viewport must not size by percentage height: it cannot resolve against a flex-sized root',
  );
});

defineCase('a bounded dialog hands its constraint to the scroll area', () => {
  const dialog = source('../dialog/dialog-content.svelte');
  const content = slotClasses(dialog, 'dialog-content');
  assert(/max-h-\[85vh\]/.test(content), 'dialog must be bounded against the window');
  assert(/\bflex-col\b/.test(content), 'dialog must be a column so the scroll area is the flexible row');
  assert(/\boverflow-hidden\b/.test(content), 'dialog must clip to its rounded frame');
  assert(
    /<ScrollArea class="min-h-0 flex-1">/.test(dialog),
    'the dialog body must sit in a ScrollArea that absorbs the leftover height',
  );
});

defineCase('the dialog close button stays outside the scrolling body', () => {
  const dialog = source('../dialog/dialog-content.svelte');
  const bodyStart = dialog.indexOf('<ScrollArea');
  const bodyEnd = dialog.indexOf('</ScrollArea>');
  const closeAt = dialog.indexOf('DialogPrimitive.Close');
  assert(bodyStart !== -1 && bodyEnd !== -1 && closeAt !== -1, 'dialog structure changed');
  assert(
    closeAt > bodyEnd,
    'the close affordance must be pinned to the dialog frame, not scroll away with the body',
  );
});

async function run(): Promise<void> {
  let failed = 0;
  for (const execute of cases) {
    const result = await execute();
    if (result.ok) console.log(`  ok  ${result.name}`);
    else {
      failed += 1;
      console.error(`  FAIL ${result.name}\n        ${result.detail}`);
    }
  }
  console.log(`\n${cases.length - failed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

void run();
