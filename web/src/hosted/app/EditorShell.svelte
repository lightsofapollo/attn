<script lang="ts">
  import BottomSheet from './BottomSheet.svelte';
  import DegradedBanner from './DegradedBanner.svelte';
  import ShareSheet from './ShareSheet.svelte';
  import { AutosaveController } from './autosave';
  import { buildWorkspaceZip, triggerDownload, zipFileName } from './export-zip';
  import { expandPicked, toImportFiles, type PickedFile } from './import-files';
  import type {
    EditingSession,
    SaveState,
    StorageHealth,
    WorkspaceAppService,
    WorkspaceDetail,
    WorkspaceEntry,
  } from './types';
  import type EditorComponentType from '../../lib/Editor.svelte';

  interface Props {
    service: WorkspaceAppService;
    workspace: WorkspaceDetail;
    activePath: string | undefined;
    /** Decoded head body when the active entry is Markdown; null otherwise. */
    bodyText?: string | null;
    isNewDraft?: boolean;
  }

  const { service, workspace, activePath, bodyText = null, isNewDraft = false }: Props = $props();

  const health: StorageHealth = $derived(service.storageHealth());
  const activeEntry = $derived(
    workspace.entries.find((entry) => entry.path === activePath) ?? workspace.entries[0],
  );
  const markdownEntries = $derived(
    workspace.entries.filter((entry) => entry.presentation === 'editable'),
  );
  const assetEntries = $derived(
    workspace.entries.filter((entry) => entry.presentation !== 'editable'),
  );

  let shareOpen = $state(false);
  let filesSheetOpen = $state(false);
  let reviewSheetOpen = $state(false);
  let shareButton = $state<HTMLButtonElement | undefined>();
  let dockFilesButton = $state<HTMLButtonElement | undefined>();
  let dockReviewButton = $state<HTMLButtonElement | undefined>();

  // ————— editing (attn-7xl.3.3) —————
  // svelte-ignore state_referenced_locally — props seed the initial values.
  let displayText = $state<string | null>(bodyText);
  // svelte-ignore state_referenced_locally
  let saveState = $state<SaveState>(workspace.saveState);
  let editing = $state(false);
  let editDenied = $state(false);
  let editorLoading = $state(false);
  interface EditorExports {
    getMarkdown(): string;
    hasUnsavedChanges(): boolean;
    resetToMarkdown(nextMarkdown: string): void;
    commitSaved(): void;
    undoStep(): void;
    redoStep(): void;
    toggleBold(): void;
    toggleItalic(): void;
    toggleHeading(level: number): void;
    toggleBulletList(): void;
  }
  let EditorComponent = $state<typeof EditorComponentType | null>(null);
  let editorRef = $state<EditorExports | undefined>();
  // Watches every document change (onDirtyChange only fires on transitions).
  let changeWatcher = $state<unknown[]>([]);
  let session: EditingSession | null = null;
  let autosave: AutosaveController | null = null;
  // Durable commits completed this session — observable for tests/status.
  let commitCount = $state(0);

  // ————— multi-file rail state (attn-7xl.3.4) —————
  let addingMarkdown = $state(false);
  let newMarkdownPath = $state('');
  let renamingEntry = $state(false);
  let renameEntryValue = $state('');
  let confirmingEntryDelete = $state(false);
  let railError = $state<string | null>(null);
  let assetInput = $state<HTMLInputElement | undefined>();
  let previewUrl = $state<string | null>(null);

  // ————— iOS reader behaviors (attn-7xl.3.7) —————
  let canvasEl = $state<HTMLElement | undefined>();
  let lightboxOpen = $state(false);
  let lightboxTrigger: HTMLElement | null = null;

  // Per-workspace/file reading position: best-effort, explicit anchors win.
  const readPositionKey = $derived(
    `attn-read-pos:${workspace.id}:${activeEntry?.path ?? ''}`,
  );

  $effect(() => {
    const canvas = canvasEl;
    const key = readPositionKey;
    if (!canvas) return;
    // Mobile scrolls the page (iOS address-bar friendly); desktop scrolls the
    // canvas inside the pinned three-column layout.
    const mobile = window.matchMedia('(max-width: 900px)').matches;
    const scroller = mobile ? (document.scrollingElement as HTMLElement) : canvas;
    const listenTarget: EventTarget = mobile ? window : canvas;
    if (window.location.hash.length <= 1) {
      try {
        const saved = Number(sessionStorage.getItem(key) ?? '');
        if (Number.isFinite(saved) && saved > 0) scroller.scrollTop = saved;
      } catch {
        // Session storage may be blocked; reading position is best-effort.
      }
    }
    let ticking = false;
    const onScroll = (): void => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        ticking = false;
        try {
          sessionStorage.setItem(key, String(Math.round(scroller.scrollTop)));
        } catch {
          // best-effort
        }
      });
    };
    listenTarget.addEventListener('scroll', onScroll, { passive: true });
    return () => listenTarget.removeEventListener('scroll', onScroll);
  });

  let lightboxClose = $state<HTMLButtonElement | undefined>();

  // ————— iOS editing (attn-7xl.3.5) —————
  // The formatting bar rides directly above the visual keyboard using
  // visualViewport, never a guessed keyboard height.
  let editBarOffset = $state(0);
  let renamingTitle = $state(false);
  let titleValue = $state('');

  $effect(() => {
    if (!editing) {
      editBarOffset = 0;
      return;
    }
    const viewport = window.visualViewport;
    if (!viewport) return;
    const update = (): void => {
      editBarOffset = Math.max(
        0,
        window.innerHeight - viewport.height - viewport.offsetTop,
      );
    };
    update();
    viewport.addEventListener('resize', update);
    viewport.addEventListener('scroll', update);
    return () => {
      viewport.removeEventListener('resize', update);
      viewport.removeEventListener('scroll', update);
    };
  });

  async function commitTitleRename(): Promise<void> {
    renamingTitle = false;
    const next = titleValue.trim();
    if (next.length === 0 || next === workspace.name) return;
    try {
      await service.renameWorkspace(workspace.id, next);
      window.location.reload();
    } catch {
      // Rename failures surface on the next durable state read.
    }
  }

  /** Sheets must never stack under the keyboard: blur first (ios-ux §6). */
  function blurEditor(): void {
    (document.activeElement as HTMLElement | null)?.blur?.();
  }

  $effect(() => {
    if (lightboxOpen) lightboxClose?.focus();
  });

  function openLightbox(event: MouseEvent): void {
    lightboxTrigger = event.currentTarget as HTMLElement;
    lightboxOpen = true;
  }

  function closeLightbox(): void {
    lightboxOpen = false;
    lightboxTrigger?.focus();
  }

  // Inline preview: decrypt safe raster bytes into a short-lived blob URL.
  $effect(() => {
    const entry = activeEntry;
    if (!entry || entry.presentation !== 'preview') {
      previewUrl = null;
      return;
    }
    let cancelled = false;
    let url: string | null = null;
    void service.readEntryBytes(workspace.id, entry.path).then((result) => {
      if (!result || cancelled) return;
      const copy = new Uint8Array(result.bytes);
      const blob = new Blob([copy.buffer as ArrayBuffer], {
        type: result.mediaType ?? 'application/octet-stream',
      });
      url = URL.createObjectURL(blob);
      previewUrl = url;
    });
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
      previewUrl = null;
    };
  });

  async function createMarkdownFile(): Promise<void> {
    const raw = newMarkdownPath.trim();
    if (raw.length === 0) return;
    const path = /\.(?:md|markdown)$/iu.test(raw) ? raw : `${raw}.md`;
    railError = null;
    try {
      await service.createMarkdownEntry(workspace.id, path);
      window.location.assign(`/app/w/${workspace.id}/${path}`);
    } catch (error) {
      railError = error instanceof Error ? error.message : String(error);
    }
  }

  async function onAssetsPicked(): Promise<void> {
    const files = assetInput?.files;
    if (!files || files.length === 0) return;
    railError = null;
    try {
      const picked: PickedFile[] = [];
      for (const file of Array.from(files)) {
        picked.push({
          name: file.name,
          relativePath: (file as File & { webkitRelativePath?: string }).webkitRelativePath,
          type: file.type,
          bytes: new Uint8Array(await file.arrayBuffer()),
        });
      }
      await service.addAssetFiles(workspace.id, toImportFiles(await expandPicked(picked)));
      window.location.reload();
    } catch (error) {
      railError = error instanceof Error ? error.message : String(error);
    } finally {
      if (assetInput) assetInput.value = '';
    }
  }

  async function commitEntryRename(): Promise<void> {
    const entry = activeEntry;
    const target = renameEntryValue.trim();
    renamingEntry = false;
    if (!entry || target.length === 0 || target === entry.path) return;
    railError = null;
    try {
      await service.renameEntry(workspace.id, entry.path, target);
      window.location.assign(`/app/w/${workspace.id}/${target}`);
    } catch (error) {
      railError = error instanceof Error ? error.message : String(error);
    }
  }

  async function deleteActiveEntry(): Promise<void> {
    const entry = activeEntry;
    confirmingEntryDelete = false;
    if (!entry) return;
    railError = null;
    try {
      await service.deleteEntry(workspace.id, entry.path);
      window.location.assign(`/app/w/${workspace.id}`);
    } catch (error) {
      railError = error instanceof Error ? error.message : String(error);
    }
  }

  async function downloadActiveEntry(): Promise<void> {
    const entry = activeEntry;
    if (!entry) return;
    const result = await service.readEntryBytes(workspace.id, entry.path);
    if (!result) return;
    const basename = entry.path.split('/').pop() ?? entry.path;
    triggerDownload(document, basename, result.bytes, result.mediaType);
  }

  async function exportZip(): Promise<void> {
    railError = null;
    try {
      const files = await service.exportWorkspace(workspace.id);
      const zip = await buildWorkspaceZip(files);
      triggerDownload(document, zipFileName(workspace.name), zip, 'application/zip');
    } catch (error) {
      railError = error instanceof Error ? error.message : String(error);
    }
  }

  const canEdit = $derived(
    activeEntry?.presentation === 'editable' &&
      health.mode !== 'unavailable' &&
      health.mode !== 'quota-pressure',
  );

  async function enterEdit(): Promise<void> {
    if (editing || editorLoading || !activeEntry) return;
    editorLoading = true;
    editDenied = false;
    try {
      if (!EditorComponent) {
        // The ProseMirror graph loads on demand; the app entry's static
        // bundle stays editor-free (route bundle gate).
        const [editorModule, pmState] = await Promise.all([
          import('../../lib/Editor.svelte'),
          import('prosemirror-state'),
        ]);
        EditorComponent = editorModule.default;
        changeWatcher = [
          new pmState.Plugin({
            view: () => ({
              update: (view, prevState) => {
                if (!view.state.doc.eq(prevState.doc)) onEditorChanged();
              },
            }),
          }),
        ];
      }
      const granted = await service.beginEditing(workspace.id);
      if (!granted) {
        editDenied = true;
        return;
      }
      session = granted;
      const path = activeEntry.path;
      autosave = new AutosaveController({
        commit: async (text) => {
          await session!.commitText(path, text);
          commitCount += 1;
        },
        onState: (state) => (saveState = state),
      });
      editing = true;
    } finally {
      editorLoading = false;
    }
  }

  function onEditorChanged(): void {
    if (!editorRef || !autosave) return;
    const text = editorRef.getMarkdown();
    displayText = text;
    autosave.noteChange(text);
  }

  async function exitEdit(): Promise<void> {
    if (!editing) return;
    if (editorRef) displayText = editorRef.getMarkdown();
    await autosave?.flush();
    autosave?.dispose();
    autosave = null;
    await session?.release();
    session = null;
    editing = false;
  }

  // Flush on tab hide / page unload so no committed-looking text is lost.
  $effect(() => {
    const flush = (): void => {
      if (autosave?.dirty) void autosave.flush();
    };
    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') flush();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', flush);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', flush);
      flush();
      void session?.release();
    };
  });

  function entryHref(entry: WorkspaceEntry): string {
    return `/app/w/${workspace.id}/${entry.path}`;
  }

  function entryGlyph(entry: WorkspaceEntry): string {
    if (entry.presentation === 'editable') return '';
    return entry.presentation === 'preview' ? '▧ ' : '◇ ';
  }

  function closeShare(): void {
    shareOpen = false;
    shareButton?.focus();
  }

  function closeFilesSheet(): void {
    filesSheetOpen = false;
    dockFilesButton?.focus();
  }

  function closeReviewSheet(): void {
    reviewSheetOpen = false;
    dockReviewButton?.focus();
  }
</script>

<div class="editor-shell" data-app-view="workspace" data-workspace-id={workspace.id}>
  <header class="editor-top">
    <div class="top-brand">
      <a class="brand" href="/app" aria-label="Back to your desk">
        <span class="mark" aria-hidden="true">a.</span>attn
      </a>
    </div>
    <div class="doc-name">
      {#if renamingTitle}
        <input
          class="rail-input title-input"
          type="text"
          aria-label="Workspace title"
          bind:value={titleValue}
          onkeydown={(event) => {
            if (event.key === 'Enter') void commitTitleRename();
            if (event.key === 'Escape') renamingTitle = false;
          }}
          onblur={() => void commitTitleRename()}
        />
      {:else if editing}
        <button
          class="title-button"
          type="button"
          aria-label="Rename workspace"
          onclick={() => {
            titleValue = workspace.name;
            renamingTitle = true;
          }}
        >
          {workspace.name}
        </button>
      {:else}
        {workspace.name}
      {/if}
      <span class="save-state" data-save-state={saveState} data-commits={commitCount}>· {saveState}</span>
    </div>
    <div class="share-action">
      {#if canEdit}
        {#if editing}
          <button class="button" type="button" onclick={() => void exitEdit()}>Done</button>
        {:else}
          <button
            class="button"
            type="button"
            data-action="edit"
            disabled={editorLoading}
            onclick={() => void enterEdit()}
          >
            {editorLoading ? 'Opening…' : 'Edit'}
          </button>
        {/if}
      {/if}
      <button
        class="button primary"
        type="button"
        bind:this={shareButton}
        onclick={() => (shareOpen = true)}
      >
        Share
      </button>
    </div>
  </header>

  <div class="editor-grid">
    <aside class="file-rail" aria-label="Workspace files">
      <div class="rail-title">
        On this device · {workspace.entries.length}
        {workspace.entries.length === 1 ? 'entry' : 'entries'}
      </div>
      <ul class="file-list">
        {#each markdownEntries as entry (entry.path)}
          <li>
            <a
              class="file"
              class:active={entry.path === activeEntry?.path}
              href={entryHref(entry)}
              aria-current={entry.path === activeEntry?.path ? 'page' : undefined}
            >
              {entry.path}
              <span class="file-size">{entry.sizeLabel}</span>
            </a>
          </li>
        {/each}
        {#each assetEntries as entry (entry.path)}
          <li>
            <a
              class="file asset"
              class:active={entry.path === activeEntry?.path}
              href={entryHref(entry)}
              aria-current={entry.path === activeEntry?.path ? 'page' : undefined}
            >
              {entryGlyph(entry)}{entry.path}
              <span class="file-size">{entry.sizeLabel}</span>
            </a>
          </li>
        {/each}
      </ul>
      {#if activeEntry}
        <div class="entry-actions" aria-label={`Actions for ${activeEntry.path}`}>
          {#if renamingEntry}
            <input
              class="rail-input"
              type="text"
              aria-label="New path"
              bind:value={renameEntryValue}
              onkeydown={(event) => {
                if (event.key === 'Enter') void commitEntryRename();
                if (event.key === 'Escape') renamingEntry = false;
              }}
            />
          {:else}
            <button
              class="row-action"
              type="button"
              onclick={() => {
                renamingEntry = true;
                renameEntryValue = activeEntry?.path ?? '';
              }}
            >
              Rename
            </button>
            <button class="row-action danger" type="button" onclick={() => (confirmingEntryDelete = true)}>
              Delete
            </button>
            <button class="row-action" type="button" onclick={() => void downloadActiveEntry()}>
              Download
            </button>
          {/if}
        </div>
        {#if confirmingEntryDelete}
          <div class="confirm-clear" role="alertdialog" aria-label={`Delete ${activeEntry.path}?`}>
            <strong>Delete {activeEntry.path}?</strong>
            <div class="actions">
              <button class="button" type="button" onclick={() => (confirmingEntryDelete = false)}>
                Cancel
              </button>
              <button class="button danger" type="button" onclick={() => void deleteActiveEntry()}>
                Delete file
              </button>
            </div>
          </div>
        {/if}
      {/if}
      {#if addingMarkdown}
        <input
          class="rail-input"
          type="text"
          aria-label="New Markdown file path"
          placeholder="notes.md"
          bind:value={newMarkdownPath}
          onkeydown={(event) => {
            if (event.key === 'Enter') void createMarkdownFile();
            if (event.key === 'Escape') addingMarkdown = false;
          }}
        />
      {:else}
        <button class="file rail-add" type="button" data-action="new-markdown" onclick={() => (addingMarkdown = true)}>
          ＋ New Markdown
        </button>
      {/if}
      <button class="file rail-add" type="button" data-action="add-assets" onclick={() => assetInput?.click()}>
        ↥ Add files or assets
      </button>
      <button class="file rail-add" type="button" data-action="export-zip" onclick={() => void exportZip()}>
        ⤓ Export workspace (.zip)
      </button>
      <input
        bind:this={assetInput}
        type="file"
        multiple
        style="display: none"
        aria-hidden="true"
        tabindex="-1"
        onchange={() => void onAssetsPicked()}
      />
      {#if railError}
        <p role="alert" style="color: var(--rust-deep); font: 0.8rem/1.4 var(--sans); margin-top: 0.6rem;">
          {railError}
        </p>
      {/if}
    </aside>

    <!-- Scrollable region must be keyboard-reachable (axe
         scrollable-region-focusable); the region role makes the tabindex
         legitimate for assistive tech. -->
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <main class="editor-canvas" bind:this={canvasEl} tabindex="0" aria-label="Document">
      {#if health.mode !== 'persistent' && health.mode !== 'best-effort'}
        <div style="max-width: 760px; margin: 0 auto 1.5rem;">
          <DegradedBanner mode={health.mode} />
        </div>
      {/if}
      {#if editDenied}
        <div class="degraded-banner" role="status" data-degraded="lease-denied" style="max-width: 760px; margin: 0 auto 1.5rem;">
          <div>
            <strong>Another tab is editing this workspace.</strong>
            <p>This tab stays read-only until the other tab finishes or closes.</p>
          </div>
        </div>
      {/if}
      <article class="writing-sheet">
        {#if editing && EditorComponent}
          <EditorComponent
            bind:this={editorRef}
            markdown={displayText ?? ''}
            editable={true}
            plugins={changeWatcher as never}
            onCheckboxToggle={onEditorChanged}
          />
        {:else if isNewDraft && (displayText === null || displayText.length === 0)}
          <div class="eyebrow">New workspace</div>
          <h1>Untitled</h1>
          <p class="placeholder">Tap to start writing…</p>
        {:else if activeEntry && activeEntry.presentation !== 'editable'}
          <div class="eyebrow">
            {activeEntry.presentation === 'preview' ? 'Asset preview' : 'Download only'}
          </div>
          <h1>{activeEntry.path}</h1>
          {#if activeEntry.presentation === 'preview' && previewUrl}
            <button
              class="asset-image-button"
              type="button"
              aria-label={`View ${activeEntry.path} full screen`}
              onclick={openLightbox}
            >
              <img class="asset-image" src={previewUrl} alt={activeEntry.path} />
            </button>
          {:else}
            <div class="asset-preview">
              <strong>{activeEntry.path}</strong>
              {#if activeEntry.presentation === 'preview'}
                Decrypting preview… · {activeEntry.sizeLabel}
              {:else}
                This format is never executed here. Download it or open it in native attn ·
                {activeEntry.sizeLabel}
              {/if}
            </div>
            <div class="storage-actions">
              <button class="button" type="button" onclick={() => void downloadActiveEntry()}>
                Download
              </button>
            </div>
          {/if}
        {:else}
          <div class="eyebrow">Working draft</div>
          <h1>{workspace.name}</h1>
          {#if displayText !== null && displayText.length > 0}
            <div class="plain-md" data-body-text>{displayText}</div>
          {:else if displayText !== null}
            <p class="placeholder">Start writing…</p>
          {:else}
            <p class="placeholder">This entry has no Markdown body.</p>
          {/if}
        {/if}
      </article>
    </main>

    <aside class="review-rail" aria-label="Review margin">
      <div class="rail-title">Review margin · {workspace.reviewCards.length}</div>
      {#each workspace.reviewCards as card (card.author + card.body)}
        <div class="review-card">
          <strong>{card.author} · {card.ageLabel}</strong>
          {card.body}
        </div>
      {:else}
        <p class="review-empty">
          No review yet. Share this workspace to open an encrypted room around it.
        </p>
      {/each}
    </aside>
  </div>

  <nav class="thumb-dock" aria-label="Document actions">
    <button
      type="button"
      bind:this={dockFilesButton}
      onclick={() => {
        blurEditor();
        filesSheetOpen = true;
      }}
    >
      Files
    </button>
    <button
      type="button"
      bind:this={dockReviewButton}
      onclick={() => {
        blurEditor();
        reviewSheetOpen = true;
      }}
    >
      Review · {workspace.reviewCards.length}
    </button>
    {#if editing}
      <button type="button" onclick={() => void exitEdit()}>Done</button>
    {:else if canEdit}
      <button type="button" disabled={editorLoading} onclick={() => void enterEdit()}>Edit</button>
    {:else}
      <!-- Editing is unavailable here; the reader stays first-class and the
           native app is the honest handoff (ios-ux.md §6). -->
      <a class="dock-link" href="/#native" data-action="open-native">Open native</a>
    {/if}
    <button type="button" onclick={() => (shareOpen = true)}>Share</button>
  </nav>
</div>

{#if editing}
  <div class="edit-bar" style={`--kb-offset: ${editBarOffset}px`} role="toolbar" aria-label="Formatting">
    <button type="button" aria-label="Bold" onclick={() => editorRef?.toggleBold()}><strong>B</strong></button>
    <button type="button" aria-label="Italic" onclick={() => editorRef?.toggleItalic()}><em>I</em></button>
    <button type="button" aria-label="Heading" onclick={() => editorRef?.toggleHeading(2)}>H2</button>
    <button type="button" aria-label="Bullet list" onclick={() => editorRef?.toggleBulletList()}>••</button>
    <button type="button" aria-label="Undo" onclick={() => editorRef?.undoStep()}>↺</button>
    <button type="button" aria-label="Redo" onclick={() => editorRef?.redoStep()}>↻</button>
    <span class="edit-bar-state" data-save-state={saveState}>{saveState}</span>
  </div>
{/if}

{#if lightboxOpen && previewUrl && activeEntry}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div
    class="lightbox"
    role="dialog"
    aria-modal="true"
    tabindex="-1"
    aria-label={`${activeEntry.path} full screen`}
    onclick={(event) => {
      if (event.target === event.currentTarget) closeLightbox();
    }}
    onkeydown={(event) => {
      if (event.key === 'Escape') closeLightbox();
    }}
  >
    <img src={previewUrl} alt={activeEntry.path} />
    <button class="button lightbox-close" type="button" bind:this={lightboxClose} onclick={closeLightbox}>
      Close
    </button>
  </div>
{/if}

{#if shareOpen}
  <ShareSheet
    workspaceName={workspace.name}
    scope={service.shareScopeFor(workspace)}
    {health}
    onclose={closeShare}
  />
{/if}

{#if filesSheetOpen}
  <BottomSheet title={`Files · ${workspace.entries.length}`} onclose={closeFilesSheet}>
    <ul class="file-list">
      {#each workspace.entries as entry (entry.path)}
        <li>
          <a
            class="file"
            class:asset={entry.presentation !== 'editable'}
            class:active={entry.path === activeEntry?.path}
            href={entryHref(entry)}
            aria-current={entry.path === activeEntry?.path ? 'page' : undefined}
          >
            {entryGlyph(entry)}{entry.path}
            <span class="file-size">{entry.sizeLabel}</span>
          </a>
        </li>
      {/each}
    </ul>
  </BottomSheet>
{/if}

{#if reviewSheetOpen}
  <BottomSheet title={`Review · ${workspace.reviewCards.length}`} onclose={closeReviewSheet}>
    {#each workspace.reviewCards as card (card.author + card.body)}
      <div class="review-card">
        <strong>{card.author} · {card.ageLabel}</strong>
        {card.body}
      </div>
    {:else}
      <p class="review-empty" style="margin-top: 0.5rem;">
        No review yet. Share this workspace to open an encrypted room around it.
      </p>
    {/each}
  </BottomSheet>
{/if}
