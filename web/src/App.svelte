<script lang="ts">
  import type { AppMode, ContentPayload, FileEntry, PlanStructure, UpdatePayload } from './lib/types';
  import { initKeyboard } from './lib/keyboard';
  import { editSave } from './lib/ipc';
  import Viewer from './lib/Viewer.svelte';
  import Sidebar from './lib/Sidebar.svelte';
  import '../styles/base.css';

  let mode: AppMode = $state('read');
  let html = $state('');
  let rawMarkdown = $state('');
  let structure: PlanStructure = $state({ phases: [], tasks: [], file_refs: [] });
  let filePath = $state('');
  let fileTree: FileEntry[] = $state([]);
  let editContent = $state('');

  let hasSidebar = $derived(fileTree.length > 0);

  function registerIpcHandlers(): void {
    window.__attn__ = {
      setContent(data: ContentPayload) {
        html = data.html;
        rawMarkdown = data.rawMarkdown;
        structure = data.structure;
        filePath = data.filePath;
        if (data.fileTree) {
          fileTree = data.fileTree;
        }
      },
      updateContent(data: UpdatePayload) {
        html = data.html;
        rawMarkdown = data.rawMarkdown;
        structure = data.structure;
      },
    };
  }

  function toggleEdit(): void {
    if (mode === 'read') {
      editContent = rawMarkdown;
      mode = 'edit';
    } else {
      editSave(editContent);
      mode = 'read';
    }
  }

  function cancelEdit(): void {
    mode = 'read';
  }

  function handleEditKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      cancelEdit();
    } else if (e.key === 's' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      editSave(editContent);
      mode = 'read';
    }
  }

  $effect(() => {
    registerIpcHandlers();
    const cleanup = initKeyboard({
      getMode: () => mode,
      onEditToggle: toggleEdit,
    });
    return cleanup;
  });
</script>

<div class="layout" class:with-sidebar={hasSidebar}>
  {#if hasSidebar}
    <Sidebar entries={fileTree} />
  {/if}

  <main>
    {#if mode === 'read'}
      <Viewer {html} />
    {:else}
      <!-- svelte-ignore a11y_autofocus -->
      <textarea
        class="editor"
        bind:value={editContent}
        onkeydown={handleEditKeydown}
        autofocus
      ></textarea>
    {/if}
  </main>
</div>

<style>
  .layout {
    display: flex;
    height: 100vh;
    overflow: hidden;
  }

  .layout.with-sidebar :global(nav.sidebar) {
    width: 240px;
    flex-shrink: 0;
    border-right: 1px solid var(--border);
    overflow-y: auto;
  }

  main {
    flex: 1;
    overflow-y: auto;
  }

  .editor {
    width: 100%;
    height: 100%;
    padding: 3rem 2rem;
    max-width: 72ch;
    margin: 0 auto;
    display: block;
    background: var(--bg);
    color: var(--fg);
    border: none;
    outline: none;
    resize: none;
    font-family: 'SF Mono', 'Fira Code', 'JetBrains Mono', Menlo, Consolas, monospace;
    font-size: 0.9rem;
    line-height: 1.7;
  }
</style>
