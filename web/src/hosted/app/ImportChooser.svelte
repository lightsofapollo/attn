<script lang="ts">
  import Files from '@lucide/svelte/icons/files';
  import FolderOpen from '@lucide/svelte/icons/folder-open';
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu';

  interface Props {
    label?: string;
    hint?: string;
    variant?: 'sidebar' | 'canvas' | 'sheet';
    onChooseFiles?: () => void;
    onChooseFolder?: () => void;
  }

  let {
    label = 'Add files',
    hint = 'or drop them here',
    variant = 'sidebar',
    onChooseFiles,
    onChooseFolder,
  }: Props = $props();

  let open = $state(false);

  function choose(callback: (() => void) | undefined): void {
    open = false;
    callback?.();
  }
</script>

<DropdownMenu.Root bind:open>
  <DropdownMenu.Trigger
    class={`import-chooser-trigger import-chooser-trigger--${variant}`}
    data-slot="import-chooser"
    data-action={variant === 'sidebar' ? 'add-assets' : undefined}
    aria-label={label}
    aria-haspopup="menu"
    aria-expanded={open}
  >
    {#if variant === 'sidebar'}
      <svg class="hosted-sidebar-add-glyph" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 5v14M5 12h14" />
      </svg>
      <span class="hosted-sidebar-add-label">{label}</span>
      {#if hint}<span class="hosted-sidebar-add-hint">{hint}</span>{/if}
    {:else}
      <span class="import-chooser-trigger-copy">{label}</span>
    {/if}
  </DropdownMenu.Trigger>
  <DropdownMenu.Content align={variant === 'sidebar' ? 'start' : 'center'} class="import-chooser-menu">
    <DropdownMenu.Label>Bring in</DropdownMenu.Label>
    <DropdownMenu.Item onSelect={() => choose(onChooseFiles)}>
      <Files class="size-4" aria-hidden="true" />
      <span class="import-chooser-item-copy">
        <strong>Files</strong>
        <small>Choose one or more files</small>
      </span>
    </DropdownMenu.Item>
    <DropdownMenu.Item onSelect={() => choose(onChooseFolder)}>
      <FolderOpen class="size-4" aria-hidden="true" />
      <span class="import-chooser-item-copy">
        <strong>Folder</strong>
        <small>Keep the folder structure</small>
      </span>
    </DropdownMenu.Item>
  </DropdownMenu.Content>
</DropdownMenu.Root>
