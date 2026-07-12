<!--
  Hosted command palette (⌘K). The hosted app had no palette; this is a
  self-contained one styled with the hosted chrome tokens (not shadcn), wired
  to the editor's real actions. Filter, ↑↓, ↵, Esc; focus restores on close.
-->
<script lang="ts" module>
  export interface HostedCommand {
    id: string;
    label: string;
    hint?: string;
    keywords?: string;
    run: () => void;
  }
</script>

<script lang="ts">
  interface Props {
    open: boolean;
    commands: HostedCommand[];
  }
  let { open = $bindable(false), commands }: Props = $props();

  let query = $state('');
  let selected = $state(0);
  let inputEl = $state<HTMLInputElement | undefined>();
  let prevFocus: HTMLElement | null = null;

  const filtered = $derived(
    query.trim() === ''
      ? commands
      : commands.filter((c) => `${c.label} ${c.keywords ?? ''}`.toLowerCase().includes(query.trim().toLowerCase())),
  );

  $effect(() => {
    if (!open) return;
    prevFocus = document.activeElement as HTMLElement | null;
    query = '';
    selected = 0;
    queueMicrotask(() => inputEl?.focus());
    return () => {
      (prevFocus?.isConnected ? prevFocus : null)?.focus?.();
    };
  });

  $effect(() => {
    // Keep the selection in range as the filter narrows.
    void filtered;
    if (selected >= filtered.length) selected = Math.max(0, filtered.length - 1);
  });

  function run(cmd: HostedCommand | undefined): void {
    if (!cmd) return;
    open = false;
    cmd.run();
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      open = false;
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      selected = Math.min(selected + 1, filtered.length - 1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      selected = Math.max(selected - 1, 0);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      run(filtered[selected]);
    }
  }
</script>

{#if open}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="cmdk-veil" onclick={() => (open = false)}></div>
  <div class="cmdk" role="dialog" tabindex="-1" aria-modal="true" aria-label="Command palette" onkeydown={onKeydown}>
    <input
      bind:this={inputEl}
      bind:value={query}
      type="text"
      class="cmdk-input"
      placeholder="Type a command…"
      autocomplete="off"
      spellcheck="false"
      role="combobox"
      aria-expanded="true"
      aria-controls="cmdk-list"
      aria-activedescendant={filtered[selected] ? `cmdk-${filtered[selected].id}` : undefined}
    />
    <ul class="cmdk-list" id="cmdk-list" role="listbox">
      {#each filtered as cmd, i (cmd.id)}
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <li
          id={`cmdk-${cmd.id}`}
          class="cmdk-item"
          class:selected={i === selected}
          role="option"
          aria-selected={i === selected}
          onmouseenter={() => (selected = i)}
          onclick={() => run(cmd)}
        >
          <span class="cmdk-label">{cmd.label}</span>
          {#if cmd.hint}<span class="cmdk-hint">{cmd.hint}</span>{/if}
        </li>
      {:else}
        <li class="cmdk-empty">No matching command.</li>
      {/each}
    </ul>
    <div class="cmdk-foot">
      <span><kbd>↑↓</kbd> navigate</span><span><kbd>↵</kbd> run</span><span><kbd>esc</kbd> close</span>
    </div>
  </div>
{/if}

<style>
  .cmdk-veil {
    position: fixed;
    inset: 0;
    z-index: 70;
    background: var(--overlay-veil);
  }
  .cmdk {
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
    animation: cmdk-in 140ms var(--ease);
  }
  @keyframes cmdk-in {
    from { opacity: 0; transform: translateX(-50%) translateY(6px); }
  }
  .cmdk-input {
    width: 100%;
    border: 0;
    outline: 0;
    background: transparent;
    padding: 15px 18px;
    font: 500 1rem var(--sans);
    color: var(--ink);
    border-bottom: 1px solid var(--rule);
  }
  .cmdk-input::placeholder { color: var(--hosted-muted); }
  .cmdk-list {
    list-style: none;
    margin: 0;
    padding: 7px 8px;
    max-height: min(60vh, 24rem);
    overflow-y: auto;
  }
  .cmdk-item {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 9px 10px;
    border-radius: 8px;
    font: 500 0.9rem var(--sans);
    color: var(--ink);
    cursor: pointer;
  }
  .cmdk-item.selected { background: color-mix(in oklch, var(--ink) 8%, transparent); }
  .cmdk-hint { margin-left: auto; color: var(--hosted-muted); font-size: 0.78rem; }
  .cmdk-empty { padding: 2rem 10px; text-align: center; color: var(--hosted-muted); font-size: 0.85rem; }
  .cmdk-foot {
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
    background: var(--paper);
  }
</style>
