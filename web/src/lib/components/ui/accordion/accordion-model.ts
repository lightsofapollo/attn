// Pure accordion logic — no DOM, no Svelte. Everything here is a function of
// its inputs so it can be tested under plain `tsx` (web/ has no jsdom; see
// scripts/run-tests.mjs), and so the Svelte wrapper and the imperative
// ProseMirror binder provably share ONE behaviour rather than two lookalikes.
//
// Behaviour follows the WAI-ARIA Accordion pattern:
//   - triggers are buttons inside a heading-equivalent, wired
//     aria-expanded / aria-controls -> a role="region" panel
//   - Enter/Space activate (native <button> semantics — not re-implemented)
//   - ArrowDown/ArrowUp move focus between triggers, Home/End jump to the
//     ends, disabled triggers are skipped
//   - the pattern's vertical orientation only; a horizontal accordion is not
//     a shape this app has a use for.

export type AccordionType = 'single' | 'multiple';

/** Keys that activate a trigger. Native <button> handles these itself; the
 *  list exists so a non-button trigger (or a test) can ask. */
export const ACTIVATION_KEYS: readonly string[] = [' ', 'Enter'];

/** Keys the accordion consumes for roving focus. Anything else is left alone
 *  so the host (ProseMirror, a dialog, the editor) still sees it. */
export const NAVIGATION_KEYS: readonly string[] = [
  'ArrowDown',
  'ArrowUp',
  'Home',
  'End',
];

export interface NavigableTrigger {
  disabled?: boolean;
}

/**
 * Normalize the many shapes a caller may pass for `value` into the internal
 * open-set. `single` keeps at most one entry.
 */
export function normalizeValue(
  value: string | string[] | null | undefined,
  type: AccordionType,
): string[] {
  const list = value == null ? [] : Array.isArray(value) ? value.slice() : [value];
  const deduped = list.filter((v, i) => v !== '' && list.indexOf(v) === i);
  return type === 'single' ? deduped.slice(0, 1) : deduped;
}

/**
 * The open-set after activating `value`.
 *
 * `collapsible` only bites in `single` mode: false means the open item cannot
 * be closed by clicking its own trigger (a tab-strip-ish accordion), which is
 * the one place the pattern's two variants differ observably.
 */
export function applyToggle(
  open: readonly string[],
  value: string,
  type: AccordionType,
  collapsible = true,
): string[] {
  const isOpen = open.includes(value);
  if (type === 'single') {
    if (isOpen) return collapsible ? [] : [value];
    return [value];
  }
  return isOpen ? open.filter((v) => v !== value) : [...open, value];
}

/**
 * Index of the trigger that should receive focus for `key`, or null when the
 * key is not ours. Disabled triggers are skipped; `loop` wraps the ends
 * (the APG lists wrapping as optional — it is on by default here because the
 * sets are short and wrapping is what every sibling menu in this app does).
 */
export function nextTriggerIndex(
  key: string,
  current: number,
  triggers: readonly NavigableTrigger[],
  loop = true,
): number | null {
  const count = triggers.length;
  if (count === 0) return null;

  const enabledFrom = (start: number, step: number): number | null => {
    for (let i = 0; i < count; i += 1) {
      let index = start + i * step;
      if (loop) {
        index = ((index % count) + count) % count;
      } else if (index < 0 || index >= count) {
        return null;
      }
      if (!triggers[index]?.disabled) return index;
    }
    return null;
  };

  switch (key) {
    case 'ArrowDown':
      return enabledFrom(current + 1, 1);
    case 'ArrowUp':
      return enabledFrom(current - 1, -1);
    case 'Home':
      return enabledFrom(0, 1);
    case 'End':
      return enabledFrom(count - 1, -1);
    default:
      return null;
  }
}

export interface AccordionItemIds {
  triggerId: string;
  contentId: string;
}

/** Stable, collision-resistant ids derived from the item value. Two
 *  accordions on one page get different prefixes (see `nextAccordionId`). */
export function accordionItemIds(prefix: string, value: string): AccordionItemIds {
  const slug = value.replace(/[^A-Za-z0-9_-]+/g, '-');
  return { triggerId: `${prefix}-trigger-${slug}`, contentId: `${prefix}-content-${slug}` };
}

let idCounter = 0;

/** Per-instance id prefix. Not crypto — just unique within a document. */
export function nextAccordionId(base = 'accordion'): string {
  idCounter += 1;
  return `${base}-${idCounter}`;
}

/** Reset for deterministic tests. */
export function resetAccordionIds(): void {
  idCounter = 0;
}

export type AttrMap = Record<string, string | null>;

/** ARIA + data attributes for a trigger. `null` means "remove the attribute". */
export function triggerAttributes(
  ids: AccordionItemIds,
  open: boolean,
  disabled = false,
): AttrMap {
  return {
    id: ids.triggerId,
    type: 'button',
    'aria-expanded': open ? 'true' : 'false',
    'aria-controls': ids.contentId,
    'aria-disabled': disabled ? 'true' : null,
    disabled: disabled ? '' : null,
    'data-slot': 'accordion-trigger',
    'data-state': open ? 'open' : 'closed',
    'data-disabled': disabled ? '' : null,
  };
}

/**
 * ARIA + data attributes for the panel.
 *
 * `data-state` is what closes it: the panel's stylesheet turns `closed` into
 * `display: none` with no transition in the path, so the collapsed size is a
 * fact about state rather than the end value of an animation (accordion-
 * styles.ts explains what happened when it was the latter).
 *
 * `inert` is the second lock, and it is not redundant: `display` is the one
 * thing a consumer can override through `Accordion.Content`'s `class` prop, and
 * a panel that is merely invisible must still not hand the keyboard a tab stop
 * it cannot see. That failure — focusable content behind a collapsed panel —
 * is the classic accordion bug, so it is guarded by an attribute rather than by
 * a stylesheet.
 */
export function contentAttributes(
  ids: AccordionItemIds,
  open: boolean,
): AttrMap {
  return {
    id: ids.contentId,
    role: 'region',
    'aria-labelledby': ids.triggerId,
    'data-slot': 'accordion-content',
    'data-state': open ? 'open' : 'closed',
    inert: open ? null : '',
  };
}

/** Data attributes for the item wrapper (styling hooks only). */
export function itemAttributes(open: boolean, disabled = false): AttrMap {
  return {
    'data-slot': 'accordion-item',
    'data-state': open ? 'open' : 'closed',
    'data-disabled': disabled ? '' : null,
  };
}

/** Data attributes for the root. */
export function rootAttributes(type: AccordionType): AttrMap {
  return {
    'data-slot': 'accordion',
    'data-orientation': 'vertical',
    'data-accordion-type': type,
  };
}
