<script lang="ts">
  /* The empty state, when the app is a web page.
   *
   * Served from Vite in a browser tab there is no daemon, so the old copy —
   * "Launch with a file or directory path" — described an action the surface
   * could not perform. This replaces it with the two things a browser CAN do:
   * accept a drop, and open a file picker.
   *
   * The native window keeps the original sentence. There, relaunching with a
   * path is real advice, OS drops are already handled by wry's drag-drop
   * handler (src/main.rs), and a browser file picker would hand back a File
   * with no filesystem path — nothing the daemon could watch or save to. So
   * the picker is gated on the absence of the native bridge rather than
   * offered everywhere and quietly degraded.
   */

  import BrandMark from './BrandMark.svelte';
  import { Button } from '$lib/components/ui/button';
  import {
    openLocalFiles,
    pickedFromDataTransfer,
    pickedFromFileList,
    type OpenLocalResult,
  } from './local-file-source';

  interface Props {
    /** Sentence shown when the picker is unavailable (the native window). */
    nativeHint: string;
  }

  const { nativeHint }: Props = $props();

  /* `installMockIpc` sets this only when it found no real wry bridge. */
  const canPickLocally = $derived(
    typeof window !== 'undefined' && Boolean(window.__attnMockIpc),
  );

  let dragging = $state(false);
  let busy = $state(false);
  let notice = $state('');
  let fileInput = $state<HTMLInputElement | null>(null);
  let folderInput = $state<HTMLInputElement | null>(null);

  /* Enter/leave fire for every child the pointer crosses; count them so the
     highlight does not flicker as the cursor moves over the copy. */
  let dragDepth = 0;

  function describe(result: OpenLocalResult): string {
    if (result.opened === 0) {
      return result.skippedKind > 0
        ? 'No Markdown files in that selection.'
        : 'Nothing to open there.';
    }
    const parts = [`Opened ${result.opened} file${result.opened === 1 ? '' : 's'}`];
    if (result.skippedKind > 0) parts.push(`${result.skippedKind} non-Markdown skipped`);
    if (result.skippedLimit > 0) parts.push(`${result.skippedLimit} too large or over the limit`);
    return parts.join(' · ');
  }

  async function accept(picked: Awaited<ReturnType<typeof pickedFromDataTransfer>>): Promise<void> {
    busy = true;
    notice = '';
    try {
      notice = describe(await openLocalFiles(picked));
    } catch (error) {
      notice = 'That selection could not be read.';
      console.error('[attn] local open failed', error);
    } finally {
      busy = false;
    }
  }

  function dragHasFiles(event: DragEvent): boolean {
    const types = event.dataTransfer?.types;
    return types ? Array.from(types).includes('Files') : false;
  }

  function onDragEnter(event: DragEvent): void {
    if (!canPickLocally || !dragHasFiles(event)) return;
    event.preventDefault();
    dragDepth += 1;
    dragging = true;
  }

  function onDragOver(event: DragEvent): void {
    if (!canPickLocally || !dragHasFiles(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  }

  function onDragLeave(event: DragEvent): void {
    if (!canPickLocally || !dragHasFiles(event)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) dragging = false;
  }

  async function onDrop(event: DragEvent): Promise<void> {
    if (!canPickLocally || !dragHasFiles(event)) return;
    event.preventDefault();
    dragDepth = 0;
    dragging = false;
    if (!event.dataTransfer) return;
    await accept(await pickedFromDataTransfer(event.dataTransfer));
  }

  async function onPicked(event: Event): Promise<void> {
    const input = event.currentTarget as HTMLInputElement;
    const files = input.files;
    if (!files || files.length === 0) return;
    await accept(pickedFromFileList(files));
    /* Reset so re-choosing the same file fires `change` again. */
    input.value = '';
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="flex h-full flex-col items-center justify-center gap-4 px-6 text-center"
  data-slot="empty-workspace"
  data-drag-over={dragging ? '' : undefined}
  ondragenter={onDragEnter}
  ondragover={onDragOver}
  ondragleave={onDragLeave}
  ondrop={onDrop}
>
  {#if canPickLocally}
    <!-- A well, not a card. The drop target is recessed onto the chrome plane
         (`--panel-surface`, the same plane as the sidebar and the rails)
         rather than raised onto `--review-card-surface`: you drop INTO it.
         It used to paint nothing at all, which left a dashed outline floating
         on undifferentiated paper (user-reported).

         Both states set the background in the SAME conditional rather than a
         static `bg-…` plus a conditional one: two background-color utilities
         on one element resolve by stylesheet order, which Tailwind controls,
         not by the order they appear here. The drag state therefore mixes its
         tint INTO the panel so the well stays recessed while it is armed,
         instead of flipping back to the paper plane mid-drag. -->
    <div
      class="flex w-full max-w-md flex-col items-center gap-4 rounded-xl border border-dashed px-8 py-10 transition-colors
             {dragging
               ? 'border-primary/60 bg-[color-mix(in_oklch,var(--primary)_8%,var(--panel-surface))]'
               : 'border-border bg-[var(--panel-surface)]'}"
    >
      <BrandMark size={40} />

      <div class="flex flex-col gap-1">
        <p class="font-serif text-base font-semibold text-foreground">
          {dragging ? 'Drop to open' : 'No file selected'}
        </p>
        <p class="text-sm text-muted-foreground">
          Drop a Markdown file or a folder here, or choose one.
        </p>
      </div>

      <div class="flex flex-wrap items-center justify-center gap-2">
        <Button size="sm" disabled={busy} onclick={() => fileInput?.click()}>Choose file</Button>
        <Button size="sm" variant="outline" disabled={busy} onclick={() => folderInput?.click()}>
          Choose folder
        </Button>
      </div>

      <p class="text-xs text-muted-foreground/80">
        Files are read in this tab only — nothing is uploaded.
      </p>
    </div>

    <!-- Outside the card, and empty until there is something to say: a
         reserved-height line inside the card left it visibly bottom-heavy.
         The element itself is always mounted so the live region is in place
         before its text changes, which is what makes the update announce. -->
    <div class="text-xs text-muted-foreground" role="status">
      {#if busy}Reading…{:else if notice}{notice}{/if}
    </div>

    <input
      bind:this={fileInput}
      class="sr-only"
      type="file"
      accept=".md,.markdown,text/markdown"
      multiple
      tabindex="-1"
      aria-hidden="true"
      onchange={onPicked}
    />
    <input
      bind:this={folderInput}
      class="sr-only"
      type="file"
      webkitdirectory
      tabindex="-1"
      aria-hidden="true"
      onchange={onPicked}
    />
  {:else}
    <p class="text-sm font-medium text-foreground">No file selected</p>
    <p class="text-sm text-muted-foreground opacity-75">{nativeHint}</p>
  {/if}
</div>
