<!--
  AgentFeedbackBar — the single row pinned to the bottom of the expanded
  comment rail while the room has comments marked "for agent".

  Left to right: the "Agent Comments" label, a count bubble for the current
  copy scope, then (pushed right) a scope toggle and a copy-all button. The
  parent owns the scope, the counts and the clipboard write; this component
  only renders the row, swaps the copy glyph for a check after a successful
  copy, and shows the clipboard fallback above the row when the write was
  blocked. The parent decides whether the bar exists at all — see
  `describeAgentFeedbackBar` in `./review/agent-feedback-bar`.

  The state the row carries is never colour-only: the scope toggle changes
  glyph AND title, the copied state changes glyph AND title and announces
  itself to assistive tech, and the disabled copy button is dimmed AND inert.
-->

<script lang="ts">
  import { onDestroy } from 'svelte';
  import CheckIcon from '@lucide/svelte/icons/check';
  import CopyIcon from '@lucide/svelte/icons/copy';
  import FileIcon from '@lucide/svelte/icons/file';
  import FolderOpenIcon from '@lucide/svelte/icons/folder-open';

  import {
    AGENT_FEEDBACK_BAR_LABEL,
    COPIED_TITLE,
    COPY_ALL_TITLE,
    SCOPE_TOGGLE_LABEL,
    describeAgentFeedbackBar,
    nextFeedbackScope,
    type FeedbackScope,
  } from './review/agent-feedback-bar';
  import {
    createCopyFeedbackController,
    type CopyFeedbackAction,
  } from './review/copy-feedback-port';

  interface Props {
    scope: FeedbackScope;
    /** Marked threads in the current scope — the bubble and copy-all target. */
    count: number;
    /** Marked threads across the whole room — the bar's trigger. */
    projectCount: number;
    /** Error text (e.g. "Clipboard access was blocked"). Never a success notice. */
    notice?: string;
    /** The packet to show in a read-only textarea when the clipboard was blocked. */
    fallback?: string;
    onScopeChange: (scope: FeedbackScope) => void;
    /** Resolves `true` when the packet reached the clipboard. */
    onCopyAll: CopyFeedbackAction;
  }

  let {
    scope,
    count,
    projectCount,
    notice = '',
    fallback = '',
    onScopeChange,
    onCopyAll,
  }: Props = $props();

  const model = $derived(describeAgentFeedbackBar({ scope, scopeCount: count, projectCount }));

  let copied = $state(false);
  const copyController = createCopyFeedbackController((next) => {
    copied = next;
  });
  onDestroy(() => copyController.dispose());

  function handleCopyAll(): void {
    if (model.copyDisabled) return;
    void copyController.run(onCopyAll);
  }
</script>

{#if model.visible}
  <section class="afb" data-slot="agent-feedback-dock" aria-label={AGENT_FEEDBACK_BAR_LABEL}>
    {#if notice}
      <p class="afb-notice" role="status">{notice}</p>
    {/if}
    {#if fallback}
      <textarea
        class="afb-fallback"
        readonly
        value={fallback}
        aria-label="Agent feedback packet"
        onclick={(event) => event.currentTarget.select()}
      ></textarea>
    {/if}
    <div class="afb-bar" data-slot="agent-feedback-bar">
      <span class="afb-label">{AGENT_FEEDBACK_BAR_LABEL}</span>
      <span class="afb-count" data-slot="agent-feedback-count" aria-label={`${model.count} in scope`}>
        {model.count}
      </span>
      <span class="afb-spacer" aria-hidden="true"></span>
      <button
        type="button"
        class="afb-btn"
        data-action="feedback-scope"
        data-scope={model.scope}
        aria-label={SCOPE_TOGGLE_LABEL}
        aria-pressed={model.projectScope}
        title={model.scopeTitle}
        onclick={() => onScopeChange(nextFeedbackScope(model.scope))}
      >
        {#if model.scopeIcon === 'folder-open'}
          <FolderOpenIcon size={14} aria-hidden="true" />
        {:else}
          <FileIcon size={14} aria-hidden="true" />
        {/if}
      </button>
      <button
        type="button"
        class="afb-btn"
        data-action="copy-all-feedback"
        data-copied={copied}
        aria-label={copied ? COPIED_TITLE : COPY_ALL_TITLE}
        title={copied ? COPIED_TITLE : COPY_ALL_TITLE}
        disabled={model.copyDisabled}
        onclick={handleCopyAll}
      >
        {#if copied}
          <CheckIcon size={14} strokeWidth={2.5} aria-hidden="true" />
        {:else}
          <CopyIcon size={14} aria-hidden="true" />
        {/if}
      </button>
      <span class="afb-sr-only" role="status" aria-live="polite" data-slot="copy-all-feedback-status">
        {copied ? COPIED_TITLE : ''}
      </span>
    </div>
  </section>
{/if}

<style>
  /* Chrome on the rail's plane, like the tray and the cards: a hairline
     above, the card surface behind (opaque enough to sit over the document
     in the hosted overlay rail, where the rail itself is transparent). */
  .afb {
    display: flex;
    flex-direction: column;
    border-top: 1px solid var(--panel-border, var(--border));
    background: var(--review-card-surface, var(--background));
    color: var(--foreground);
    font-family: var(--sans, system-ui, sans-serif);
  }

  .afb-bar {
    display: flex;
    align-items: center;
    gap: 6px;
    min-height: 40px;
    padding: 0 12px;
  }

  .afb-label {
    font-size: 0.75rem;
    font-weight: 600;
    letter-spacing: 0.01em;
    white-space: nowrap;
  }

  .afb-count {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 18px;
    height: 18px;
    padding: 0 6px;
    border-radius: 999px;
    background: var(--primary);
    color: var(--primary-foreground);
    font-size: 0.6875rem;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    line-height: 1;
  }

  .afb-spacer {
    flex: 1;
  }

  .afb-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    flex-shrink: 0;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--muted-foreground);
    cursor: pointer;
    transition: background-color 120ms ease, color 120ms ease;
  }

  .afb-btn:hover:not(:disabled),
  .afb-btn[aria-pressed='true'] {
    background: var(--accent);
    color: var(--foreground);
  }

  .afb-btn:focus-visible {
    outline: 2px solid var(--ring);
    outline-offset: 1px;
  }

  .afb-btn:disabled {
    opacity: 0.45;
    cursor: default;
  }

  .afb-btn[data-copied='true'] {
    color: var(--foreground);
  }

  .afb-notice {
    margin: 0;
    padding: 8px 12px 0;
    color: var(--muted-foreground);
    font-size: 0.6875rem;
    line-height: 1.3;
  }

  .afb-fallback {
    box-sizing: border-box;
    width: calc(100% - 24px);
    min-height: 76px;
    margin: 6px 12px 2px;
    resize: vertical;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--background);
    color: var(--foreground);
    padding: 6px;
    font: 0.66rem/1.35 ui-monospace, SFMono-Regular, Menlo, monospace;
  }

  /* Visually hidden, still announced — the check glyph must not be the
     only carrier of "copied". */
  .afb-sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    padding: 0;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
    border: 0;
  }
</style>
