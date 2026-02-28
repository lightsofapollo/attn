<script lang="ts">
  import * as Dialog from '$lib/components/ui/dialog';
  import { Kbd } from '$lib/components/ui/kbd';

  let { open = $bindable(false) }: { open: boolean } = $props();

  const isMac = navigator.platform.includes('Mac');
  const mod = isMac ? '\u2318' : 'Ctrl';

  interface Shortcut {
    keys: string[];
    description: string;
  }

  interface ShortcutGroup {
    label: string;
    shortcuts: Shortcut[];
  }

  const groups: ShortcutGroup[] = [
    {
      label: 'Navigation',
      shortcuts: [
        { keys: ['j'], description: 'Scroll down' },
        { keys: ['k'], description: 'Scroll up' },
        { keys: ['Space'], description: 'Page down' },
        { keys: ['g'], description: 'Scroll to top' },
        { keys: ['G'], description: 'Scroll to bottom' },
        { keys: ['\u2190'], description: 'Previous file' },
        { keys: ['\u2192'], description: 'Next file' },
        { keys: [mod, 'F'], description: 'Find in document' },
        { keys: [mod, 'P'], description: 'Command palette' },
      ],
    },
    {
      label: 'Editing',
      shortcuts: [
        { keys: ['e'], description: 'Toggle edit mode' },
        { keys: [mod, 'S'], description: 'Save' },
        { keys: ['Esc'], description: 'Cancel edit' },
      ],
    },
    {
      label: 'Tabs',
      shortcuts: [
        { keys: [mod, 'W'], description: 'Close tab' },
        { keys: [mod, '['], description: 'Previous tab' },
        { keys: [mod, ']'], description: 'Next tab' },
      ],
    },
    {
      label: 'Other',
      shortcuts: [
        { keys: ['t'], description: 'Cycle theme' },
        { keys: ['q'], description: 'Quit' },
        { keys: [mod, '?'], description: 'Show shortcuts' },
      ],
    },
  ];
</script>

<Dialog.Root bind:open>
  <Dialog.Content class="sm:max-w-md">
    <Dialog.Header>
      <Dialog.Title>Keyboard Shortcuts</Dialog.Title>
    </Dialog.Header>
    <div class="grid gap-4">
      {#each groups as group}
        <div>
          <h3 class="text-muted-foreground mb-2 text-xs font-medium uppercase tracking-wide">
            {group.label}
          </h3>
          <div class="grid gap-1">
            {#each group.shortcuts as shortcut}
              <div class="flex items-center justify-between rounded px-2 py-1.5">
                <span class="text-sm">{shortcut.description}</span>
                <div class="flex items-center gap-1">
                  {#each shortcut.keys as key}
                    <Kbd>{key}</Kbd>
                  {/each}
                </div>
              </div>
            {/each}
          </div>
        </div>
      {/each}
    </div>
  </Dialog.Content>
</Dialog.Root>
