<!--
  Keyboard shortcut reference (attn-08fa.11).

  The hosted app scored its lowest heuristic marks on Help & Documentation and
  Recognition-over-Recall for the same reason: every accelerator it has —
  ⌘K, ⌘J, ⌘., ⌘⇧., "/" — was discoverable only by already knowing it. The one
  hint in the product is the editor placeholder, which is gone after the first
  keystroke. This is the reference, reachable from ⌘K and from "?".

  Deliberately a static list, not a settings surface: nothing here is
  rebindable, so it states rather than offers.
-->
<script lang="ts" module>
  export interface ShortcutGroup {
    title: string;
    items: Array<{ keys: string[]; label: string }>;
  }

  /** One source for the sheet and for anything that wants to cite a binding. */
  export const SHORTCUT_GROUPS: readonly ShortcutGroup[] = [
    {
      title: 'Anywhere',
      items: [
        { keys: ['⌘', 'K'], label: 'Command palette' },
        { keys: ['?'], label: 'This shortcut list' },
        { keys: ['Esc'], label: 'Close the topmost layer' },
      ],
    },
    {
      title: 'Review',
      items: [
        { keys: ['⌘', 'J'], label: 'Toggle the review rail' },
        { keys: ['⌘', '.'], label: 'Next comment' },
        { keys: ['⌘', '⇧', '.'], label: 'Previous comment' },
      ],
    },
    {
      title: 'Files',
      items: [
        { keys: ['/'], label: 'Filter the file list' },
        { keys: ['⌘', '+'], label: 'Larger text' },
        { keys: ['⌘', '−'], label: 'Smaller text' },
        { keys: ['⌘', '0'], label: 'Reset text size' },
      ],
    },
  ];
</script>

<script lang="ts">
  interface Props {
    open: boolean;
  }
  let { open = $bindable(false) }: Props = $props();

  let dialogEl = $state<HTMLDivElement | undefined>();
  let prevFocus: HTMLElement | null = null;

  $effect(() => {
    if (!open) return;
    prevFocus = document.activeElement as HTMLElement | null;
    queueMicrotask(() => dialogEl?.focus());
    // Focus returns where it came from, per the Topmost-Escape Rule.
    return () => {
      (prevFocus?.isConnected ? prevFocus : null)?.focus?.();
    };
  });

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      open = false;
    } else if (event.key === 'Tab') {
      // Nothing inside is focusable, so keep focus on the dialog rather than
      // letting it walk behind the veil while this claims to be modal.
      event.preventDefault();
      dialogEl?.focus();
    }
  }
</script>

{#if open}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="cmdk-veil" onclick={() => (open = false)}></div>
  <div
    bind:this={dialogEl}
    class="shortcuts"
    role="dialog"
    tabindex="-1"
    aria-modal="true"
    aria-label="Keyboard shortcuts"
    onkeydown={onKeydown}
  >
    <h2 class="shortcuts-title">Keyboard shortcuts</h2>
    <div class="shortcuts-groups">
      {#each SHORTCUT_GROUPS as group (group.title)}
        <section class="shortcuts-group">
          <h3 class="shortcuts-group-title">{group.title}</h3>
          <dl>
            {#each group.items as item (item.label)}
              <div class="shortcuts-row">
                <dt>
                  {#each item.keys as key (key)}<kbd class="kbd-chip">{key}</kbd>{/each}
                </dt>
                <dd>{item.label}</dd>
              </div>
            {/each}
          </dl>
        </section>
      {/each}
    </div>
    <div class="shortcuts-foot"><span><kbd>esc</kbd> close</span></div>
  </div>
{/if}

<!-- Deliberately mirrors CommandPalette's surface (same veil, radius, shadow,
     entry animation): both are ⌘K-family overlays, and two floating panels a
     keystroke apart should not read as two different materials. Svelte scopes
     component styles, so the values are restated rather than shared — every one
     of them is a token, so a palette change still moves both. -->
<style>
  .cmdk-veil {
    position: fixed;
    inset: 0;
    z-index: 70;
    background: var(--overlay-veil);
  }
  .shortcuts {
    position: fixed;
    z-index: 71;
    left: 50%;
    top: 15%;
    width: min(560px, calc(100vw - 40px));
    transform: translateX(-50%);
    background: var(--sheet-raised);
    border: 1px solid var(--rule);
    border-radius: 14px;
    box-shadow: var(--shadow-strong);
    overflow: hidden;
    font-family: var(--sans);
    animation: shortcuts-in 140ms var(--ease);
  }
  @keyframes shortcuts-in {
    from { opacity: 0; transform: translateX(-50%) translateY(6px); }
  }
  .shortcuts-title {
    margin: 0;
    padding: 15px 18px;
    border-bottom: 1px solid var(--rule);
    font: 600 1rem var(--sans);
    color: var(--ink);
  }
  .shortcuts-groups {
    /* Tall enough that the current list never scrolls at a normal window size —
       a reference you have to scroll to finish reading is a worse reference. */
    max-height: min(70vh, 34rem);
    overflow-y: auto;
    padding: 0.4rem 0.5rem 0.6rem;
  }
  .shortcuts-group {
    padding: 0.6rem 0.6rem 0.2rem;
  }
  /* The label step: uppercase, tracked, muted — the section marker used across
     the app's chrome. */
  .shortcuts-group-title {
    margin: 0 0 0.35rem;
    font: 600 0.7rem/1.2 var(--sans);
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--hosted-muted);
  }
  .shortcuts-group dl {
    margin: 0;
  }
  .shortcuts-row {
    display: flex;
    align-items: baseline;
    gap: 10px;
    padding: 5px 0;
  }
  .shortcuts-row dt {
    display: flex;
    flex: 0 0 auto;
    gap: 3px;
    min-width: 5.5rem;
  }
  .shortcuts-row dd {
    margin: 0;
    font: 500 0.9rem var(--sans);
    color: var(--ink);
  }
  .shortcuts-foot {
    display: flex;
    gap: 16px;
    padding: 9px 16px;
    border-top: 1px solid var(--rule);
    font: 500 0.75rem var(--sans);
    color: var(--hosted-muted);
  }
  kbd {
    font: 600 0.75rem var(--sans);
    padding: 1px 5px;
    border: 1px solid var(--rule);
    border-bottom-width: 2px;
    border-radius: 6px;
    color: var(--ink);
  }
</style>
