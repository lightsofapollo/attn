<script lang="ts">
  import * as Command from '$lib/components/ui/command';
  import { Kbd, KbdGroup } from '$lib/components/ui/kbd';
  import KeyboardIcon from '@lucide/svelte/icons/keyboard';

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
        { keys: ['\u2190'], description: 'Previous file' },
        { keys: ['\u2192'], description: 'Next file' },
        { keys: [mod, 'F'], description: 'Find in document' },
        { keys: [mod, 'P'], description: 'Command palette' },
      ],
    },
    {
      label: 'Editing',
      shortcuts: [
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
        { keys: [mod, '+'], description: 'Increase font size' },
        { keys: [mod, '-'], description: 'Decrease font size' },
        { keys: [mod, '0'], description: 'Reset font size' },
        { keys: [mod, '/'], description: 'Show shortcuts' },
      ],
    },
  ];
</script>

<Command.Dialog
  bind:open
  title="Keyboard Shortcuts"
  description="Browse and filter shortcuts"
  class="font-sans"
>
  <Command.Input
    class="font-sans text-[0.97rem] tracking-[0.01em] placeholder:tracking-normal"
    placeholder="Filter shortcuts..."
  />
  <Command.List class="max-h-[min(70vh,36rem)] px-2 pb-2 pt-1">
    <Command.Empty class="font-sans py-10 text-muted-foreground">
      No shortcuts match that filter.
    </Command.Empty>
    {#each groups as group}
      <Command.Group
        heading={group.label}
        class="font-sans [&_[data-command-group-heading]]:text-muted-foreground/90 [&_[data-command-group-heading]]:px-2 [&_[data-command-group-heading]]:py-1 [&_[data-command-group-heading]]:font-semibold [&_[data-command-group-heading]]:tracking-[0.08em] [&_[data-command-group-heading]]:uppercase"
      >
        {#each group.shortcuts as shortcut}
          <Command.Item
            value={`${group.label} ${shortcut.description} ${shortcut.keys.join(' ')}`}
            class="group/item rounded-md border border-transparent px-2 py-2.5 aria-selected:border-border aria-selected:bg-accent/70"
          >
            <div class="flex min-w-0 flex-1 items-center gap-2.5">
              <span class="bg-muted/70 text-muted-foreground inline-flex size-6 shrink-0 items-center justify-center rounded-sm border border-border/60 transition-colors group-aria-selected/item:bg-background">
                <KeyboardIcon class="size-3.5 shrink-0 opacity-85" />
              </span>
              <div class="flex min-w-0 flex-1 items-center justify-between gap-3">
                <span class="truncate text-[0.96rem] font-medium leading-none tracking-[0.01em]">
                  {shortcut.description}
                </span>
                <KbdGroup class="shrink-0">
                  {#each shortcut.keys as key}
                    <Kbd class="bg-background/80">{key}</Kbd>
                  {/each}
                </KbdGroup>
              </div>
            </div>
          </Command.Item>
        {/each}
      </Command.Group>
    {/each}
  </Command.List>
  <div class="border-border/70 text-muted-foreground bg-muted/35 flex items-center justify-between border-t px-3 py-2 font-sans text-xs">
    <span>Press again to close</span>
    <KbdGroup>
      <Kbd>{mod}</Kbd>
      <Kbd>/</Kbd>
    </KbdGroup>
  </div>
</Command.Dialog>
