<script lang="ts">
  import type { FileEntry } from './types';
  import { navigate } from './ipc';

  interface Props {
    entries: FileEntry[];
  }

  let { entries }: Props = $props();

  function handleNavigate(path: string): void {
    navigate(path);
  }

  function handleKeydown(e: KeyboardEvent, path: string): void {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handleNavigate(path);
    }
  }
</script>

<nav class="sidebar">
  <ul>
    {#each entries as entry}
      <li>
        <span
          class="dir-entry"
          class:dir={entry.isDir}
          role="button"
          tabindex="0"
          onclick={() => handleNavigate(entry.path)}
          onkeydown={(e) => handleKeydown(e, entry.path)}
        >
          {entry.isDir ? `${entry.name}/` : entry.name}
        </span>
      </li>
    {/each}
  </ul>
</nav>

<style>
  .sidebar {
    padding: 1rem;
  }

  ul {
    list-style: none;
    padding: 0;
  }

  li {
    margin: 0;
  }
</style>
