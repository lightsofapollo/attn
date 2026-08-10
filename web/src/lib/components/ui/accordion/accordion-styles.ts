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
// ---------------------------------------------------------------------------
// THE PANEL CARRIES NO TRANSITION. Read this before adding one back.
//
// The reveal used to be `grid-template-rows: 0fr -> 1fr` under
// `transition-[grid-template-rows]`. In WKWebView that stranded in BOTH
// directions (attn-bw2h.9): `data-state` flipped on trigger, item and panel,
// the `data-[state=open]:grid-rows-[1fr]` rule was generated with the higher
// specificity and later source order, and the computed `grid-template-rows`
// still did not follow — it sat at `0px` with 102px of content clipped, then
// after one toggle sat pinned at `101.546875px` across three more clean
// state flips.
//
// The tell is that the pinned value is a PIXEL length. Neither author
// declaration says that; `0fr` and `1fr` do not resolve to a stale
// `101.546875px` on their own. It is the transition's own interpolated
// output, living in the animation cascade origin — which outranks every
// author-origin declaration regardless of specificity. WebKit's `fr`
// interpolation for grid tracks neither invalidates the grid's layout as it
// runs nor retargets when the endpoints change underneath it, so once one of
// these transitions starts, the used track size is whatever the stalled
// animation holds and the author value `data-state` actually flips can never
// surface again. (Poking any inline style forced a fresh layout and the real
// value momentarily appeared — the same tell, from the other side.)
//
// So the disclosure's open-ness must not be a transition's end value at all.
// DESIGN.md's Truth Rule: "Pixels always equal state ... animation is
// enhancement, never the carrier of state", and its stated implementation is
// exactly what the panel does now — closed is `display: none` in plain CSS,
// keyed off `data-state`. No interpolation is involved in either direction,
// so there is nothing for the animation origin to pin.
//
// The reveal still animates, using the same idiom the dialog adopted after
// its own WKWebView stranding (see dialog-content.svelte): the from-value
// lives ONLY inside `@starting-style` (Tailwind's `starting:` variant), which
// is reachable only while a transition is actually running. The resting
// declarations are the visible ones. Disable transitions entirely — reduced
// motion, an engine that refuses, a strand — and every element resolves to
// its resting value, which is already the truth. That is the property the old
// `data-[state=closed]`-style from-value could never have.
//
// Rules for anything added here:
//   * the panel's `display` is the only thing that may depend on `data-state`;
//   * nothing on the panel or its inner may be transitioned toward a value
//     that state also controls;
//   * an entry animation states its from-value under `starting:` and nowhere
//     else. Never `transition-all` — that is how a size transition comes back.
// accordion.test.ts case 13 pins all three.
// ---------------------------------------------------------------------------
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
 * The panel. Its size is its state and nothing else: `display: none` when
 * closed, `display: block` when open, straight off `data-state`, with no
 * transition on this element at all. See the note at the top of this file for
 * why a transitioned height is not an option here.
 *
 * `overflow-hidden` masks the inner's entry motion (it used to live on the
 * inner, where it clipped the 0fr grid row; the box is the same one either
 * way, so nothing else changes). The panel is also the element the core marks
 * `inert` while closed.
 */
export const accordionContentClass = 'hidden overflow-hidden data-[state=open]:block';

/**
 * Entry enhancement, and only that. The panel is already the right size by the
 * time this runs, so a strand here cannot hide, resize or unmount anything.
 *
 * `starting:` is load-bearing in the negative sense: opacity 0 and the 4px
 * offset exist ONLY as `@starting-style` from-values, applied for the one
 * frame the panel goes from not-rendered to rendered. The resting declarations
 * — full opacity, no offset — are what this element resolves to whenever a
 * transition does not run, which is the whole guarantee. There is deliberately
 * no `data-[state=...]` variant here: state must not be able to hold this
 * element in a hidden-looking resting value.
 *
 * Close stays instant (no `transition-behavior: allow-discrete`): an exit
 * animation would make the panel outlive its own state.
 */
export const accordionContentInnerClass =
  'transition-[opacity,translate] duration-[var(--t)] ease-[var(--ease)] ' +
  'motion-reduce:transition-none starting:opacity-0 starting:-translate-y-1';

/** Padding for panel body content. Applied by consumers, not by the panel,
 *  so a consumer can opt out (a table or a full-bleed block). */
export const accordionContentBodyClass = 'px-3 pt-0.5 pb-3 text-sm';
