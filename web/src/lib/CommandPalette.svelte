<script lang="ts">
  import type { FileType, SearchResultItem } from './types';
  import * as Command from '$lib/components/ui/command/index.js';
  import { Kbd } from '$lib/components/ui/kbd';
  import FileIcon from '@lucide/svelte/icons/file';
  import FileTextIcon from '@lucide/svelte/icons/file-text';
  import ImageIcon from '@lucide/svelte/icons/image';
  import VideoIcon from '@lucide/svelte/icons/video';
  import MusicIcon from '@lucide/svelte/icons/music';

  interface Props {
    open: boolean;
    rootPath?: string;
    remoteSearchQuery?: string;
    remoteSearchItems?: SearchResultItem[];
    onSearchQuery?: (query: string) => void;
    onSelect: (path: string) => void;
  }

  let {
    open = $bindable(false),
    rootPath = '',
    remoteSearchQuery = '',
    remoteSearchItems = [],
    onSearchQuery,
    onSelect,
  }: Props = $props();
  let searchQuery = $state('');
  let searchDebounceHandle: ReturnType<typeof setTimeout> | undefined;

  interface FlatFile {
    name: string;
    path: string;
    dir: string;
    fileType: FileType;
  }

  const isMac = navigator.platform.includes('Mac');
  const mod = isMac ? '\u2318' : 'Ctrl';
  let normalizedSearch = $derived(searchQuery.trim().toLowerCase());
  let backendQueryAligned = $derived(remoteSearchQuery.trim().toLowerCase() === normalizedSearch);

  function normalizePath(path: string): string {
    return path.replace(/\\/g, '/');
  }

  function basename(path: string): string {
    const normalized = normalizePath(path);
    const parts = normalized.split('/').filter(Boolean);
    return parts.at(-1) ?? normalized;
  }

  function dirname(path: string): string {
    const normalized = normalizePath(path);
    const parts = normalized.split('/').filter(Boolean);
    if (parts.length <= 1) return '/';
    return parts.slice(0, -1).join('/');
  }

  function relativePath(path: string, base: string): string {
    const normalizedPath = normalizePath(path);
    const normalizedBase = normalizePath(base).replace(/\/+$/, '');
    if (!normalizedBase) return normalizedPath;
    if (normalizedPath === normalizedBase) return '.';
    const prefix = `${normalizedBase}/`;
    if (normalizedPath.startsWith(prefix)) return normalizedPath.slice(prefix.length);
    return normalizedPath;
  }

  let backendFiles = $derived.by(() =>
    remoteSearchItems.map((item) => {
      const rel = relativePath(item.path, rootPath);
      return {
        name: basename(rel),
        path: item.path,
        dir: dirname(rel),
        fileType: item.fileType,
      } satisfies FlatFile;
    }),
  );

  let visibleFiles = $derived(
    backendQueryAligned ? backendFiles : [],
  );

  let grouped = $derived.by(() => {
    const groups: Record<string, FlatFile[]> = {};
    for (const file of visibleFiles) {
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

  function queueSearch(query: string): void {
    if (!onSearchQuery) return;
    if (searchDebounceHandle) clearTimeout(searchDebounceHandle);
    searchDebounceHandle = setTimeout(() => {
      onSearchQuery(query.trim());
    }, 120);
  }

  function handleInput(event: Event): void {
    const next = (event.currentTarget as HTMLInputElement | null)?.value ?? '';
    searchQuery = next;
    queueSearch(next);
  }

  $effect(() => {
    if (open) return;
    searchQuery = '';
    if (searchDebounceHandle) {
      clearTimeout(searchDebounceHandle);
      searchDebounceHandle = undefined;
    }
    onSearchQuery?.('');
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

<Command.Dialog
  bind:open
  title="Open File"
  description="Search files to open"
  contentClass="top-[16vh] translate-y-0"
>
  <Command.Input
    bind:value={searchQuery}
    oninput={handleInput}
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
    {#if normalizedSearch.length > 0 && !backendQueryAligned}
      <div class="px-3 py-2 text-xs text-muted-foreground">Searching full project...</div>
    {/if}
  </Command.List>
  <div class="border-border/70 text-muted-foreground bg-muted/25 flex items-center justify-between border-t px-3 py-2 font-sans text-xs">
    <span>Open files quickly</span>
    <span class="inline-flex items-center gap-1.5">
      <Kbd>{mod}</Kbd>
      <Kbd>P</Kbd>
    </span>
  </div>
</Command.Dialog>
