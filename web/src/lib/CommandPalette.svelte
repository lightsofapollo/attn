<script lang="ts">
  import type { TreeNode, FileType } from './types';
  import * as Command from '$lib/components/ui/command/index.js';
  import { Kbd } from '$lib/components/ui/kbd';
  import FileIcon from '@lucide/svelte/icons/file';
  import FileTextIcon from '@lucide/svelte/icons/file-text';
  import ImageIcon from '@lucide/svelte/icons/image';
  import VideoIcon from '@lucide/svelte/icons/video';
  import MusicIcon from '@lucide/svelte/icons/music';

  interface Props {
    open: boolean;
    fileTree: TreeNode[];
    onSelect: (path: string) => void;
  }

  let { open = $bindable(false), fileTree, onSelect }: Props = $props();

  interface FlatFile {
    name: string;
    path: string;
    dir: string;
    fileType: FileType;
  }

  function flattenTree(nodes: TreeNode[], parentDir = ''): FlatFile[] {
    const result: FlatFile[] = [];
    for (const node of nodes) {
      if (node.isDir && node.children) {
        const nextParent = parentDir ? `${parentDir}/${node.name}` : node.name;
        result.push(...flattenTree(node.children, nextParent));
      } else if (!node.isDir) {
        result.push({
          name: node.name,
          path: node.path,
          dir: parentDir,
          fileType: node.fileType,
        });
      }
    }
    return result;
  }

  let files = $derived(flattenTree(fileTree));
  const isMac = navigator.platform.includes('Mac');
  const mod = isMac ? '\u2318' : 'Ctrl';

  // Group files by directory and sort for stable visual scan order.
  let grouped = $derived.by(() => {
    const groups: Record<string, FlatFile[]> = {};
    for (const file of files) {
      const key = file.dir || '/';
      if (!groups[key]) groups[key] = [];
      groups[key].push(file);
    }
    return Object
      .entries(groups)
      .map(([dir, entries]) => [
        dir,
        [...entries].sort((a, b) => a.name.localeCompare(b.name)),
      ] as const)
      .sort(([a], [b]) => a.localeCompare(b));
  });

  function handleSelect(path: string): void {
    open = false;
    onSelect(path);
  }

  function iconForType(fileType: FileType): typeof FileIcon {
    switch (fileType) {
      case 'markdown': return FileTextIcon;
      case 'image': return ImageIcon;
      case 'video': return VideoIcon;
      case 'audio': return MusicIcon;
      default: return FileIcon;
    }
  }

  function dirLabel(dir: string): string {
    return dir === '/' ? 'root' : dir;
  }
</script>

<Command.Dialog bind:open title="Open File" description="Search files to open">
  <Command.Input
    class="font-sans text-[0.97rem] tracking-[0.01em] placeholder:tracking-normal"
    placeholder="Search files..."
  />
  <Command.List class="max-h-[min(62vh,34rem)] px-2 pb-2 pt-1">
    <Command.Empty class="font-sans py-10 text-muted-foreground">
      No matching files in this workspace.
    </Command.Empty>
    {#each grouped as [dir, groupFiles] (dir)}
      <Command.Group
        heading={dirLabel(dir)}
        class="font-sans [&_[data-command-group-heading]]:text-muted-foreground/90 [&_[data-command-group-heading]]:px-2 [&_[data-command-group-heading]]:py-1 [&_[data-command-group-heading]]:font-semibold [&_[data-command-group-heading]]:tracking-[0.08em] [&_[data-command-group-heading]]:uppercase"
      >
        {#each groupFiles as file (file.path)}
          {@const Icon = iconForType(file.fileType)}
          <Command.Item
            value={file.path}
            class="group/item font-sans rounded-md border border-transparent px-2 py-2.5 aria-selected:border-border aria-selected:bg-accent/70"
            onSelect={() => handleSelect(file.path)}
          >
            <span class="bg-muted/70 text-muted-foreground inline-flex size-6 shrink-0 items-center justify-center rounded-sm border border-border/60 transition-colors aria-selected:bg-background">
              <Icon class="size-3.5 shrink-0 opacity-90" />
            </span>
            <span class="min-w-0 flex-1 truncate text-[0.96rem] font-medium leading-none tracking-[0.01em]">
              {file.name}
            </span>
            {#if file.dir}
              <span class="text-muted-foreground/90 max-w-[45%] truncate rounded-sm border border-border/70 bg-background/65 px-1.5 py-0.5 font-mono text-[0.7rem] leading-none">
                {file.dir}
              </span>
            {/if}
          </Command.Item>
        {/each}
      </Command.Group>
    {/each}
  </Command.List>
  <div class="border-border/70 text-muted-foreground bg-muted/25 flex items-center justify-between border-t px-3 py-2 font-sans text-xs">
    <span>Open files quickly</span>
    <span class="inline-flex items-center gap-1.5">
      <Kbd>{mod}</Kbd>
      <Kbd>P</Kbd>
    </span>
  </div>
</Command.Dialog>
