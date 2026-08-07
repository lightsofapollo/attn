// The accordion's visual system, as plain Tailwind class strings.
//
// Why strings in a .ts file instead of classes inline in the .svelte files:
// the other consumer is a ProseMirror NodeView built with
// `document.createElement` (see accordion-core.ts), which cannot render a
// Svelte component. Both consumers import from here, so Paper/Ink theming and
// the motion signature are defined ONCE. `src/app.css` declares
// `@source "./**/*.{svelte,ts}"`, so Tailwind scans this file and generates
// every utility below — but only because they are written as whole static
// literals. Never build a class name by concatenation here.
//
// Motion: `--t` (140ms) and `--ease` from src/tokens.css — the app's single
// signature. `motion-reduce:transition-none` states the reduced-motion
// intent locally (instant, never a half-drawn reveal) rather than relying
// only on the global override in styles/base.css.
//
// Theming: every colour is a semantic token (`border`, `foreground`,
// `muted-foreground`, `accent`, `ring`), so Paper and Ink both come from
// tokens.css. The one place the themes are deliberately told apart is the
// hover wash, which is halved in Ink exactly as the ghost button does.

/** Root list. */
export const accordionRootClass = 'w-full';

/** One disclosure row. Hairline rules between items, none after the last. */
export const accordionItemClass = 'border-border border-b last:border-b-0';

/**
 * The focusable header button. `group/accordion-trigger` is what lets the
 * chevron rotate off the trigger's own `data-state`.
 */
export const accordionTriggerClass =
  'group/accordion-trigger flex w-full flex-1 items-center gap-2 rounded-md px-3 py-2.5 text-left text-sm font-medium ' +
  'text-foreground outline-none transition-colors duration-[var(--t)] ease-[var(--ease)] motion-reduce:transition-none ' +
  'cursor-pointer select-none hover:bg-accent dark:hover:bg-accent/50 ' +
  'focus-visible:ring-ring/50 focus-visible:ring-[3px] ' +
  'disabled:pointer-events-none disabled:opacity-50 data-[disabled]:pointer-events-none data-[disabled]:opacity-50';

/** Chevron. Points right when closed, down-ish (90deg) when open. */
export const accordionChevronClass =
  'text-muted-foreground size-3.5 shrink-0 transition-transform duration-[var(--t)] ease-[var(--ease)] ' +
  'motion-reduce:transition-none group-data-[state=open]/accordion-trigger:rotate-90';

/** Optional trailing summary text in the header (kept quiet). */
export const accordionTriggerMetaClass = 'text-muted-foreground ml-auto text-xs font-normal';

/**
 * The animating panel.
 *
 * Height is animated with the `grid-template-rows: 0fr -> 1fr` technique
 * rather than a measured pixel height: it needs no JS measurement, so the
 * imperative NodeView path and the Svelte path behave identically, and it
 * degrades to an instant snap under `prefers-reduced-motion` instead of
 * animating to a wrong height.
 */
export const accordionContentClass =
  'grid grid-rows-[0fr] transition-[grid-template-rows] duration-[var(--t)] ease-[var(--ease)] ' +
  'motion-reduce:transition-none data-[state=open]:grid-rows-[1fr]';

/** Inner clip. The 0fr row only reads as collapsed because of this. */
export const accordionContentInnerClass = 'overflow-hidden';

/** Padding for panel body content. Applied by consumers, not by the panel,
 *  so a consumer can opt out (a table or a full-bleed block). */
export const accordionContentBodyClass = 'px-3 pt-0.5 pb-3 text-sm';
