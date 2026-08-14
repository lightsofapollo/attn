<script module lang="ts">
  import {
    RAIL_WIDTH_MIN_PX,
    RAIL_WIDTH_PX,
    clampRailWidth,
    railResizeMax,
  } from './review/rail-mode';

  // Read at MODULE LOAD, deliberately, and this is load-bearing.
  //
  // `App.svelte` deletes `window.__attn_init__` the first time it reads it
  // (`loadInitPayload`), so anything that wants a value out of that payload has
  // to take it before then. A `<script module>` block runs when this module is
  // evaluated — and since App imports this component statically, ESM evaluates
  // us before App's own body, let alone before an App instance runs an effect.
  // Moving this read into the instance script would put it after the delete.
  //
  // This is an established pattern here, not a trick: `lib/ipc.ts` captures
  // `ipcToken` from the same payload at module load for exactly this reason.
  // The difference is that `ipc.ts` also has `setIpcToken()` as a belt-and-braces
  // setter App calls explicitly; we have no such fallback, because adding one
  // would mean editing App. So the ordering here is the only thing holding the
  // read up, and it fails SILENTLY if broken — the capture just reads
  // `undefined` and every launch quietly starts at 320px, which looks like a
  // prefs bug in a different file. `review/rail-width-init-order.test.ts`
  // asserts the ordering against the compiled output so that cannot happen
  // unnoticed.
  //
  // The payload is absent, or lacks the field, in four situations — all of
  // which want the default: the hosted browser build (no daemon, nothing under
  // src/hosted/ writes a payload), the `npm run dev:browser` mock IPC (writes a
  // payload, has never carried `railWidth`), the Node test environment (no
  // `window`), and any daemon predating the field. The expression is total
  // across all of them and cannot throw. `clampRailWidth` runs here too — the
  // daemon gates the value already, but this module is also reachable from a
  // build that never had a daemon to do the gating.
  const initialRailWidth: number = (() => {
    if (typeof window === 'undefined') return RAIL_WIDTH_PX.expanded;
    const stored = (window as { __attn_init__?: { railWidth?: unknown } }).__attn_init__
      ?.railWidth;
    return typeof stored === 'number' ? clampRailWidth(stored) : RAIL_WIDTH_PX.expanded;
  })();
</script>

<script lang="ts">
  import type { Snippet } from 'svelte';
  import PanelRightClose from '@lucide/svelte/icons/panel-right-close';
  import PanelRightOpen from '@lucide/svelte/icons/panel-right-open';
  import { SidebarInset, SidebarProvider } from '$lib/components/ui/sidebar';
  import type { RailMode } from './review/rail-mode';
  import { railWidthChange } from './ipc';
  import UnreadBadge from './UnreadBadge.svelte';

  interface Props {
    sidebar: Snippet;
    content: Snippet;
    rail: Snippet;
    banner?: Snippet;
    chrome?: Snippet;
    railMode: RailMode;
    panelOpen: boolean;
    unreadCount?: number;
    onToggleRail?: () => void;
    onRailWheel?: (deltaY: number) => void;
    /** The shared top header already owns the comments toggle. */
    railToggleInHeader?: boolean;
    class?: string;
  }

  let {
    sidebar,
    content,
    rail,
    banner,
    chrome,
    railMode,
    panelOpen,
    unreadCount = 0,
    onToggleRail,
    onRailWheel,
    railToggleInHeader = false,
    class: className = '',
  }: Props = $props();

  // The rail is a DOCKED panel, not a floating margin.
  //
  // It used to be a transparent stretch of paper that "hugged" the prose
  // (Theme v2, attn-ll9): an IntersectionObserver watched for wide blocks and
  // slid the whole aside left via translateX so cards sat nearer their
  // anchors. That only worked while the rail was invisible. Now that the panel
  // carries its own surface, the hug and the surface are mutually exclusive —
  // a translated panel either tears a strip of bare paper off the window edge,
  // or (if the paint is extended to cover it) balloons to 500px+ on a wide
  // display, because the shift distance grows with the viewport. A panel the
  // user is meant to recognize as open has to hold one edge, so the hug and
  // its three observers are gone rather than left running to compute a
  // transform nothing applies.
  //
  // What the user gets instead is control of the width (attn-11g4.2). The rail
  // holds the right edge and the LEFT edge is draggable, which is the same
  // affordance a docked panel has everywhere else, and unlike the hug it is
  // the user's decision rather than a heuristic about the content.

  // --- Rail resize (attn-11g4.2) ---------------------------------------------
  //
  // Only the expanded rail resizes. `collapsed` is a 48px chip gutter sized to
  // a 28px avatar plus clearance; widening it would just misalign the chips.
  // `railWidth` therefore always means "the expanded width" and survives a
  // collapse/expand cycle untouched.
  let railWidth = $state(initialRailWidth);
  let dragging = $state(false);
  /** Content row width, for the fraction-of-row cap. `bind:clientWidth` puts a
   *  ResizeObserver on the row, so this tracks window and sidebar changes
   *  without a second observer of our own. */
  let rowWidth = $state(0);
  let handleEl = $state<HTMLDivElement | undefined>(undefined);

  let dragStartX = 0;
  let dragStartWidth = 0;
  let persistTimer: ReturnType<typeof setTimeout> | undefined;
  let restoreUserSelect = '';
  let restoreWebkitUserSelect = '';
  let restoreCursor = '';

  const resizeMax = $derived(railResizeMax(rowWidth));
  /** The stored width is clamped against the ABSOLUTE bounds for rendering,
   *  not against `resizeMax`. A narrow window must not quietly rewrite a width
   *  the user chose on a wide one — the row-relative cap only binds what a
   *  live drag or keypress can reach. */
  const expandedWidth = $derived(clampRailWidth(railWidth));
  const railWidthPx = $derived(
    railMode === 'expanded' ? expandedWidth : RAIL_WIDTH_PX[railMode],
  );

  /** Write-behind for keyboard nudges: arrow-key repeat would otherwise write
   *  prefs.json once per keydown. Drag end and reset flush immediately. */
  function schedulePersist(): void {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => railWidthChange(expandedWidth), 200);
  }

  function persistNow(): void {
    clearTimeout(persistTimer);
    railWidthChange(expandedWidth);
  }

  /** Suppress selection and pin the resize cursor for the whole window while a
   *  drag is live. `preventDefault()` on pointerdown already stops the
   *  compatibility mousedown that would start a selection, but the pointer
   *  spends the drag over the *document*, and without this the cursor flickers
   *  back to a text caret every time it crosses the prose. */
  function lockPointerAffordances(): void {
    if (typeof document === 'undefined') return;
    const style = document.body.style;
    restoreUserSelect = style.userSelect;
    restoreWebkitUserSelect = style.getPropertyValue('-webkit-user-select');
    restoreCursor = style.cursor;
    style.userSelect = 'none';
    // WKWebView still wants the prefix for a reliable global suppression.
    style.setProperty('-webkit-user-select', 'none');
    style.cursor = 'col-resize';
  }

  function unlockPointerAffordances(): void {
    if (typeof document === 'undefined') return;
    const style = document.body.style;
    style.userSelect = restoreUserSelect;
    if (restoreWebkitUserSelect) {
      style.setProperty('-webkit-user-select', restoreWebkitUserSelect);
    } else {
      style.removeProperty('-webkit-user-select');
    }
    style.cursor = restoreCursor;
  }

  function onHandlePointerDown(event: PointerEvent): void {
    // Primary button only — a right-click or a two-finger tap should reach the
    // context menu, not start a resize we never see the end of.
    if (event.button !== 0 || railMode !== 'expanded') return;
    event.preventDefault();
    dragging = true;
    dragStartX = event.clientX;
    dragStartWidth = expandedWidth;
    // Pointer capture, not window listeners: the drag keeps receiving moves
    // when the pointer leaves the handle (which it does immediately), and the
    // browser guarantees us a pointerup or pointercancel to unwind on.
    handleEl?.setPointerCapture(event.pointerId);
    lockPointerAffordances();
  }

  function onHandlePointerMove(event: PointerEvent): void {
    if (!dragging) return;
    // The rail is docked RIGHT, so leftward travel is a wider rail.
    railWidth = clampRailWidth(dragStartWidth + (dragStartX - event.clientX), resizeMax);
  }

  function endDrag(event: PointerEvent): void {
    if (!dragging) return;
    dragging = false;
    if (handleEl?.hasPointerCapture(event.pointerId)) {
      handleEl.releasePointerCapture(event.pointerId);
    }
    unlockPointerAffordances();
    persistNow();
  }

  /** Double-click the handle to restore the default width — the conventional
   *  splitter reset, and the only one available to a pointer-only user. */
  function resetRailWidth(): void {
    railWidth = clampRailWidth(RAIL_WIDTH_PX.expanded, resizeMax);
    persistNow();
  }

  /**
   * Keyboard resize, per the ARIA window-splitter pattern: the handle is a
   * focusable `separator` carrying `aria-valuenow`, so arrows move it and
   * Home/End reach the bounds. Enter restores the default, which is the
   * keyboard twin of the double-click.
   *
   * ArrowLeft widens because the handle is on the rail's left edge: the key
   * moves the separator, not the value.
   */
  function onHandleKeyDown(event: KeyboardEvent): void {
    if (railMode !== 'expanded') return;
    const step = event.shiftKey ? 64 : 16;
    let next: number;
    switch (event.key) {
      case 'ArrowLeft':
        next = expandedWidth + step;
        break;
      case 'ArrowRight':
        next = expandedWidth - step;
        break;
      case 'Home':
        next = RAIL_WIDTH_MIN_PX;
        break;
      case 'End':
        next = resizeMax;
        break;
      case 'Enter':
        next = RAIL_WIDTH_PX.expanded;
        break;
      default:
        return;
    }
    event.preventDefault();
    railWidth = clampRailWidth(next, resizeMax);
    schedulePersist();
  }

  // The body-level cursor and selection locks are global side effects, so they
  // need an owner that outlives any single pointer sequence. Teardown only —
  // the effect body reads nothing and runs once.
  $effect(() => () => {
    clearTimeout(persistTimer);
    if (dragging) unlockPointerAffordances();
  });
</script>

<SidebarProvider class={`h-svh overflow-hidden ${className}`}>
  {@render sidebar()}
  <SidebarInset class="overflow-hidden">
    {@render chrome?.()}
    {@render banner?.()}
    <div
      class="relative flex min-h-0 flex-1 flex-row overflow-hidden"
      bind:clientWidth={rowWidth}
    >
      <div class="flex min-w-0 flex-1 flex-col overflow-hidden">
        {@render content()}
      </div>
      <!-- The margin is a surface, not an absence. It used to be painted
           `bg-background` with no border, on the Docs rule that an empty
           stretch beside the text is whitespace on the paper. In practice an
           open rail was indistinguishable from a wide right gutter — nothing
           told the user the panel was there, and toggling it read as the
           document changing width for no reason. It now sits on
           `--panel-surface` behind a hairline `--panel-border`, so "comments
           are open" is legible before a single card is on screen and the
           cards (a lighter `--review-card-surface`) read as floating on it.
           The rail still never scrolls; wheel forwards to the doc. -->
      {#if railMode !== 'hidden'}
        <aside
          class="right-rail relative flex shrink-0 flex-col overflow-hidden"
          style={`width: ${railWidthPx}px;`}
          data-state={panelOpen ? 'open' : 'closed'}
          data-mode={railMode}
          data-slot="right-rail"
          data-width={railWidthPx}
          data-default-width={RAIL_WIDTH_PX.expanded}
          data-resizing={dragging ? 'true' : 'false'}
          aria-label="Review margin"
          onwheel={(event) => onRailWheel?.(event.deltaY)}
        >
        {#if railMode === 'expanded'}
          <!-- The grab edge. It sits INSIDE the aside rather than straddling
               the hairline border, because the aside clips its overflow — a
               handle centered on the border would have its outer half cut off.
               10px of hit area a hair inside the seam is comfortable to catch
               without stealing visible width from the cards.

               Quiet by default: a 2px stub at the weight of the border it sits
               beside, present enough to be found, not loud enough to read as a
               control on a page of prose. Hover, focus and drag grow it. -->
          <!-- A focusable `separator` IS the ARIA window-splitter pattern: the
               role becomes a widget exactly when it is focusable, and
               `aria-valuenow` is only meaningful on that variant. Svelte's a11y
               rules model `separator` as always non-interactive and do not
               cover the splitter case, so both warnings are wrong here.
               Suppressed narrowly rather than fixed — dropping `tabindex` would
               delete keyboard resize, and a `<button>` cannot carry
               `aria-valuenow`. -->
          <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
          <div
            bind:this={handleEl}
            class="rail-resize"
            data-slot="rail-resize-handle"
            data-testid="rail-resize-handle"
            data-dragging={dragging ? 'true' : 'false'}
            role="separator"
            tabindex="0"
            aria-orientation="vertical"
            aria-label="Resize comments rail"
            aria-valuenow={expandedWidth}
            aria-valuemin={RAIL_WIDTH_MIN_PX}
            aria-valuemax={resizeMax}
            aria-valuetext={`Comments rail ${expandedWidth} pixels wide`}
            title="Drag to resize · double-click to reset · arrow keys to nudge"
            onpointerdown={onHandlePointerDown}
            onpointermove={onHandlePointerMove}
            onpointerup={endDrag}
            onpointercancel={endDrag}
            onlostpointercapture={endDrag}
            ondblclick={resetRailWidth}
            onkeydown={onHandleKeyDown}
          ></div>
        {/if}
          {#if railToggleInHeader}
            <div class="h-2 shrink-0" aria-hidden="true"></div>
          {:else}
            <div
              class={`flex h-10 shrink-0 items-center ${panelOpen ? 'justify-end pr-2' : 'justify-center'}`}
              data-slot="rail-header"
            >
              <button
                type="button"
                class="relative inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                data-slot="rail-toggle"
                data-state={panelOpen ? 'expanded' : 'collapsed'}
                aria-label={panelOpen ? 'Collapse comments rail' : 'Expand comments rail'}
                title={`${panelOpen ? 'Collapse' : 'Expand'} comments (⌘J)`}
                aria-expanded={panelOpen}
                onclick={() => onToggleRail?.()}
              >
                {#if panelOpen}
                  <PanelRightClose class="size-4" aria-hidden="true" />
                {:else}
                  <PanelRightOpen class="size-4" aria-hidden="true" />
                {/if}
                <UnreadBadge
                  count={unreadCount}
                  label="unread review updates"
                  class="absolute -right-1.5 -top-1.5"
                />
              </button>
            </div>
          {/if}
          <div class="relative mb-2 min-h-0 flex-1 overflow-hidden">
            {@render rail()}
          </div>
        </aside>
      {/if}
    </div>
  </SidebarInset>
</SidebarProvider>

<style>
  /* Painted only when the rail actually occupies space. At `hidden` the aside
     is 0px wide, and a border on a zero-width element is a 1px line of chrome
     down the edge of a document with no review on it. */
  .right-rail[data-mode='collapsed'],
  .right-rail[data-mode='expanded'] {
    /* Custom properties inherit past Svelte's style scoping, so this is also
       how the margin's chips learn what they are ringed against. */
    --rail-backdrop: var(--panel-surface);
    background: var(--rail-backdrop);
    border-left: 1px solid var(--panel-border);
    /* Stated, not inherited: the width is driven frame-by-frame from
       pointermove, and any transition on it would trail the cursor. The rail
       also changes width when it collapses, and that is a mode change the
       user asked for — it should land, not slide. */
    transition: none;
  }

  /* --- Resize handle (attn-11g4.2) ---------------------------------------
     Full-height strip pinned to the rail's inner left edge. `z-index` clears
     the margin's absolutely-positioned card slots; `touch-action: none` is
     what makes a touch drag resize instead of scroll. */
  .rail-resize {
    position: absolute;
    top: 0;
    bottom: 0;
    left: 0;
    width: 10px;
    z-index: 5;
    cursor: col-resize;
    touch-action: none;
    -webkit-user-select: none;
    user-select: none;
    background: transparent;
  }

  /* The affordance itself. Centered in the hit area so the pill reads as
     sitting just inside the seam rather than as a second border. */
  .rail-resize::after {
    content: '';
    position: absolute;
    left: 50%;
    top: 50%;
    width: 2px;
    height: 22px;
    transform: translate(-50%, -50%);
    border-radius: 9999px;
    background: var(--panel-border);
    /* Paint only — never size or position. A handle that moves under the
       cursor while you reach for it is worse than one you have to find. */
    transition:
      height 120ms ease-out,
      background-color 120ms ease-out;
  }

  .rail-resize:hover::after,
  .rail-resize:focus-visible::after,
  .rail-resize[data-dragging='true']::after {
    height: 48px;
    background: var(--muted-foreground);
  }

  /* Inset so the ring lands on the rail's own surface instead of being half
     clipped by the aside's overflow. 2px is the `micro` radius DESIGN.md
     assigns to focus rings, review marks and accent bars. */
  .rail-resize:focus-visible {
    outline: 2px solid var(--ring);
    outline-offset: -2px;
    border-radius: 2px;
  }
</style>
