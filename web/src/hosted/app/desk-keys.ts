// Who owns a keystroke on the desk (attn-1l2f.4).
//
// The desk listens on `svelte:window`, so its shortcuts see every keydown on
// the page — including ones aimed at a focused button or link. Arrow keys are
// safe there (no control claims them), but Enter is the activation key for
// every control on the row: New, Import, Rename, Delete, the workspace link.
//
// Once ↓ had moved the selection, the desk's Enter handler ran for those too
// and called preventDefault, so Tab → Delete → Enter silently opened a
// workspace instead of asking to delete one, and keyboard-only users lost
// button activation entirely until the selection cleared.
//
// `typingInField` (INPUT/TEXTAREA/contenteditable) is the right gate for "/"
// and the arrows and stays where it is. Enter needs the stricter question,
// which is what this module answers.
//
// The node shape is structural rather than `HTMLElement` so the rule can be
// driven directly by a test; real elements satisfy it as they are.

export interface DeskKeyTarget {
  tagName: string;
  isContentEditable?: boolean;
  getAttribute?: (name: string) => string | null;
  parentElement?: DeskKeyTarget | null;
}

/** Elements that act on Enter themselves. */
const INTERACTIVE_TAGS = new Set([
  'A',
  'BUTTON',
  'INPUT',
  'OPTION',
  'SELECT',
  'SUMMARY',
  'TEXTAREA',
]);

/** ARIA roles that promise the same activation contract. */
const INTERACTIVE_ROLES = new Set([
  'button',
  'checkbox',
  'link',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'radio',
  'switch',
  'tab',
  'textbox',
]);

function isInteractive(node: DeskKeyTarget): boolean {
  const tag = node.tagName?.toUpperCase();
  if (tag === 'A') {
    // A bare <a> without href is a span with underlines, not a control.
    return node.getAttribute?.('href') != null;
  }
  if (tag !== undefined && INTERACTIVE_TAGS.has(tag)) return true;
  if (node.isContentEditable === true) return true;
  const role = node.getAttribute?.('role');
  return role != null && INTERACTIVE_ROLES.has(role);
}

/**
 * Whether the desk's Enter-to-open shortcut owns this keydown.
 *
 * True for the desk surface itself (body, the list, a plain container) and for
 * the filter field, where Enter has no native action and "type to filter, press
 * Enter" is the advertised path (attn-a9f7.1.1). False whenever focus sits on
 * or inside a control that activates on Enter — that keystroke is the control's.
 */
export function deskEnterOpensSelection(
  target: DeskKeyTarget | null | undefined,
  filterInput: unknown,
): boolean {
  // A keydown with no element target belongs to the document, i.e. the desk.
  if (target === null || target === undefined) return true;
  if (filterInput !== undefined && filterInput !== null && target === filterInput) return true;
  for (let node: DeskKeyTarget | null | undefined = target; node; node = node.parentElement) {
    if (isInteractive(node)) return false;
  }
  return true;
}
