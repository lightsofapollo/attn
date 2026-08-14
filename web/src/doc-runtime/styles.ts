/**
 * Styles for the annotation chrome injected into the document frame.
 *
 * Shipped as a string rather than a stylesheet import because the runtime is
 * bundled to a single self-contained IIFE that gets injected into arbitrary
 * HTML — there is no build step on the far side and no second file to fetch.
 *
 * Everything is namespaced under `.attn-` and scoped to the injected layer, so
 * the document's own CSS and ours cannot collide. Tokens are inlined (not
 * inherited from the shell) because the frame is origin-isolated and shares no
 * stylesheet with it; the shell pushes theme changes over the `theme` message.
 */

export const RUNTIME_STYLES = `
.attn-layer {
  position: absolute;
  inset: 0;
  /* The layer spans the document but must never intercept the cursor — only
     its individually re-enabled children (pins, chips, the pill) do. */
  pointer-events: none;
  z-index: 2147483000;
  --attn-comment-accent: oklch(0.62 0.13 82);
  --attn-element-accent: oklch(0.55 0.11 235);
  --attn-surface: oklch(0.95 0.010 76);
  --attn-ink: oklch(0.14 0.008 55);
  --attn-border: oklch(0.14 0.008 55 / 22%);
  --attn-shadow: 0 8px 24px oklch(0.20 0.02 55 / 18%);
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
}

[data-attn-theme="ink"] .attn-layer {
  --attn-surface: oklch(0.24 0.012 60);
  --attn-ink: oklch(0.93 0.008 78);
  --attn-border: oklch(0.93 0.008 78 / 22%);
  --attn-shadow: 0 8px 24px oklch(0 0 0 / 45%);
}

/* Text highlights — CSS Custom Highlight API, so no wrapper spans are ever
   injected into the document's DOM. */
::highlight(attn-text) {
  background-color: oklch(0.82 0.13 85 / 30%);
}
::highlight(attn-text-active) {
  background-color: oklch(0.80 0.16 82 / 52%);
}

/* Element overlay. The fill is inert so text underneath a commented element
   stays selectable — you can always comment on something inside something
   already commented on. */
.attn-overlay {
  position: absolute;
  pointer-events: none;
  border-radius: 4px;
  border: 1.5px solid color-mix(in oklch, var(--attn-element-accent) 60%, transparent);
  background: color-mix(in oklch, var(--attn-element-accent) 8%, transparent);
  transition: background 120ms ease, border-color 120ms ease;
}
.attn-overlay[data-state="active"] {
  border-color: var(--attn-element-accent);
  background: color-mix(in oklch, var(--attn-element-accent) 16%, transparent);
}
.attn-overlay[data-state="resolved"] {
  border-style: dashed;
  opacity: 0.55;
}

/* Persistent marker for a committed comment: visible without hovering, so the
   document reads as annotated at a glance. */
.attn-pin {
  position: absolute;
  pointer-events: auto;
  display: grid;
  place-items: center;
  min-width: 20px;
  height: 20px;
  padding: 0 5px;
  border: 1px solid var(--attn-border);
  border-radius: 999px;
  background: var(--attn-element-accent);
  color: oklch(0.98 0.005 78);
  font-size: 11px;
  font-weight: 600;
  line-height: 1;
  cursor: pointer;
  box-shadow: var(--attn-shadow);
  transition: transform 120ms ease;
}
.attn-pin:hover,
.attn-pin[data-state="active"] {
  transform: scale(1.12);
}
.attn-pin[data-state="resolved"] {
  background: var(--attn-surface);
  color: var(--attn-ink);
}

/* The hover label: names what the cursor is pointing at, and its ancestors.
   The outer box is a HIT AREA, not the visible pill — the transparent bottom
   padding is a reach corridor between the label and the element it labels, so
   a cursor travelling up to the chip never passes over a third element that
   would re-target the hover and move the chip out from under it. Losing the
   chip mid-reach is exactly the bug this geometry exists to prevent. */
.attn-chip {
  position: absolute;
  display: none;
  pointer-events: auto;
  padding-bottom: 6px;
  max-width: min(90vw, 560px);
}
.attn-chip.is-visible { display: block; }

.attn-chip-body {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 2px;
  border: 1px solid var(--attn-border);
  border-radius: 8px;
  background: var(--attn-surface);
  box-shadow: var(--attn-shadow);
  font-size: 11px;
  line-height: 1.4;
}

.attn-chip-sep {
  flex: none;
  padding: 0 1px;
  color: var(--attn-ink);
  opacity: 0.4;
}

.attn-chip-seg {
  display: flex;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
  padding: 3px 7px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--attn-ink);
  font: inherit;
  cursor: pointer;
  white-space: nowrap;
}
.attn-chip-seg:hover { background: color-mix(in oklch, var(--attn-ink) 10%, transparent); }
.attn-chip-seg.is-current {
  background: var(--attn-element-accent);
  color: oklch(0.98 0.005 78);
}
.attn-chip-seg.is-current:hover {
  background: color-mix(in oklch, var(--attn-element-accent) 88%, black);
}
.attn-chip-title { font-weight: 600; }
.attn-chip-preview {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  opacity: 0.7;
  font-weight: 400;
}
.attn-chip-count {
  flex: none;
  padding: 0 5px;
  border-radius: 999px;
  background: var(--attn-comment-accent);
  color: oklch(0.98 0.005 78);
  font-size: 9px;
  font-weight: 700;
}

/* Hover preview of exactly what a scope would anchor to. */
.attn-outline {
  position: absolute;
  pointer-events: none;
  border: 1.5px dashed var(--attn-element-accent);
  border-radius: 4px;
  background: color-mix(in oklch, var(--attn-element-accent) 6%, transparent);
}

/* Floating "Comment" affordance raised by a text selection. */
.attn-pill {
  position: absolute;
  pointer-events: auto;
  display: none;
  align-items: center;
  gap: 6px;
  padding: 5px 12px;
  border: 1px solid var(--attn-border);
  border-radius: 999px;
  background: var(--attn-surface);
  color: var(--attn-ink);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  box-shadow: var(--attn-shadow);
}
.attn-pill.is-visible { display: inline-flex; }
.attn-pill::before {
  content: "";
  width: 8px;
  height: 8px;
  border-radius: 2px;
  background: var(--attn-comment-accent);
}

@media (prefers-reduced-motion: reduce) {
  .attn-overlay,
  .attn-pin { transition: none; }
}
`;
