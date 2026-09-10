<!--
  HtmlAnnotateToggle — the pinned note button that enters and leaves annotate
  mode on a rendered HTML document (attn-wrf3).

  Annotate mode is OFF by default for every HTML document, including one under
  review: the page stays fully interactive — its own links, buttons, tabs and
  inputs keep working — until the person asks to annotate. Pressing this turns
  the frame's element-inspection surface on (hover outline, breadcrumb chip,
  click-to-comment); pressing it again turns it off and hands the clicks back
  to the page. The mode stays on until the person turns it off — submitting or
  cancelling a note does not exit it.

  Shell-owned chrome rendered OUTSIDE the untrusted document frame
  (amendments.md #19/#20): the frame can neither draw nor press this, so the
  document cannot put itself into a mode that swallows its own clicks. Hosts
  render it inside the HtmlViewer wrapper — pinned to the viewport of the
  document, never to the window — so it stays clear of the rail and header.

  The shell gates the frame on `annotatable && active`; this component only
  reports the press. Existing pins keep rendering in both modes, and the
  text-selection Comment pill stays available in both.
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import MessageSquarePlusIcon from '@lucide/svelte/icons/message-square-plus';
  import { htmlAnnotateShortcutLabel } from './keyboard';

  interface Props {
    /** Annotate mode is on. */
    active: boolean;
    onToggle: () => void;
    /** Rendered nowhere when true — the document cannot take a comment. */
    hidden?: boolean;
    disabled?: boolean;
  }

  let { active, onToggle, hidden = false, disabled = false }: Props = $props();

  const shortcut = htmlAnnotateShortcutLabel();
  const label = $derived(active ? 'Done annotating' : 'Add a note');

  // A polite announcement on every CHANGE, and never on mount: reading
  // "Annotation off" to a screen reader the moment an HTML document opens
  // would describe a state nobody changed.
  let announcement = $state('');
  // The initial value only, on purpose: it is the baseline the first change
  // is measured against, so it must not track.
  let announced = untrack(() => active);
  $effect(() => {
    const next = active;
    if (next === announced) return;
    announced = next;
    announcement = next ? 'Annotation on' : 'Annotation off';
  });
</script>

{#if !hidden}
  <!-- Positioned by the host through the wrapper's own stacking context: the
       frame sits at z-0, the margin overlay a few steps above it, dialogs and
       the comment composer at z-40+. This lands between. The bottom inset is
       a custom property so a host with its own bottom chrome (the hosted
       mobile dock) can lift it clear without a second component. -->
  <div
    class="pointer-events-none absolute inset-x-0 bottom-0 z-30 flex justify-end"
    data-slot="html-annotate-toggle-slot"
  >
    <button
      type="button"
      class="html-annotate-toggle pointer-events-auto mr-4 inline-flex size-10 items-center justify-center rounded-full border shadow-lg transition-colors motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50 {active
        ? 'border-primary bg-primary text-primary-foreground hover:bg-primary/90'
        : 'border-border bg-popover text-muted-foreground hover:bg-accent hover:text-foreground'}"
      data-slot="html-annotate-toggle"
      data-active={active ? 'true' : 'false'}
      aria-pressed={active}
      aria-label={label}
      aria-keyshortcuts="Meta+Shift+N Control+Shift+N"
      title="{label} ({shortcut})"
      {disabled}
      onclick={onToggle}
    >
      <MessageSquarePlusIcon class="size-4" aria-hidden="true" />
    </button>
    <span class="sr-only" role="status" aria-live="polite" data-slot="html-annotate-toggle-status">
      {announcement}
    </span>
  </div>
{/if}

<style>
  /* The offset lives on the BUTTON, not the row, so `env()` composes with the
     host override: the hosted mobile dock lifts it by setting the property on
     any ancestor. */
  .html-annotate-toggle {
    margin-bottom: var(
      --html-annotate-toggle-bottom,
      calc(1rem + env(safe-area-inset-bottom, 0px))
    );
  }
</style>
