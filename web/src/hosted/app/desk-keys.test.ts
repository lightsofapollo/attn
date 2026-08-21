// attn-1l2f.4 — Enter on the desk must not pre-empt a focused control.
//
// The desk's keydown handler is on the window, so it sees Enter aimed at the
// New / Import / Rename / Delete buttons and at the workspace link. Once ↓ had
// set a selection, it preventDefault'ed all of them and opened the selected
// workspace instead — Tab → Delete → Enter silently opened a document.

import { deskEnterOpensSelection, type DeskKeyTarget } from './desk-keys';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

let failures = 0;
function check(label: string, actual: unknown, expected: unknown): void {
  if (actual === expected) {
    console.log(`  ok  ${label}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL ${label}\n       expected ${String(expected)}, got ${String(actual)}`);
}

/** A minimal element: the fields the rule actually reads. */
function el(
  tagName: string,
  attrs: Record<string, string> = {},
  parent: DeskKeyTarget | null = null,
): DeskKeyTarget {
  return {
    tagName,
    isContentEditable: attrs.contenteditable === 'true',
    getAttribute: (name: string) => attrs[name] ?? null,
    parentElement: parent,
  };
}

const body = el('BODY');
const deskList = el('UL', {}, body);
const row = el('DIV', { class: 'workspace-row' }, deskList);
const filterInput = el('INPUT', { type: 'text' }, deskList);

// The desk surface owns Enter — this is the ↓-then-Enter promise.
check('body', deskEnterOpensSelection(body, filterInput), true);
check('the list container', deskEnterOpensSelection(deskList, filterInput), true);
check('a plain row container', deskEnterOpensSelection(row, filterInput), true);
check('no target at all (document-level keydown)', deskEnterOpensSelection(null, filterInput), true);
check('the filter field, where Enter has no native action', deskEnterOpensSelection(filterInput, filterInput), true);

// Controls own their own Enter.
check('the Delete button', deskEnterOpensSelection(el('BUTTON', {}, row), filterInput), false);
check('the Rename button', deskEnterOpensSelection(el('BUTTON', { 'data-action': 'rename' }, row), filterInput), false);
check('the workspace link', deskEnterOpensSelection(el('A', { href: '/app/w/ws1/a.md' }, row), filterInput), false);
check('a label inside a button', deskEnterOpensSelection(el('SPAN', {}, el('BUTTON', {}, row)), filterInput), false);
check('the rename input', deskEnterOpensSelection(el('INPUT', { class: 'rename-input' }, row), filterInput), false);
check('a select', deskEnterOpensSelection(el('SELECT', {}, row), filterInput), false);
check('a summary', deskEnterOpensSelection(el('SUMMARY', {}, row), filterInput), false);
check('a role=button div', deskEnterOpensSelection(el('DIV', { role: 'button' }, row), filterInput), false);
check('a role=menuitem div', deskEnterOpensSelection(el('DIV', { role: 'menuitem' }, row), filterInput), false);
check('a contenteditable region', deskEnterOpensSelection(el('DIV', { contenteditable: 'true' }, row), filterInput), false);

// An anchor without href is decoration, not a control.
check('an <a> with no href', deskEnterOpensSelection(el('A', {}, row), filterInput), true);

// No filter field yet (empty desk): the surface still owns Enter, and a
// control still does not.
check('body with no filter field mounted', deskEnterOpensSelection(body, undefined), true);
check('a button with no filter field mounted', deskEnterOpensSelection(el('BUTTON', {}, row), undefined), false);

// The pre-fix rule, for contrast: it only asked "is this a text field?", so it
// answered yes for every button and link above.
function preFixGate(target: DeskKeyTarget, filter: unknown): boolean {
  const typing = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable === true;
  return !typing || target === filter;
}
assert(
  preFixGate(el('BUTTON', {}, row), filterInput) === true,
  'sanity: the pre-fix gate did claim Enter on a focused button',
);
assert(
  deskEnterOpensSelection(el('BUTTON', {}, row), filterInput) === false,
  'and the fixed gate does not',
);

console.log(`desk-keys: ${failures === 0 ? 'all cases passed' : `${failures} failed`}`);
if (failures > 0) process.exit(1);
