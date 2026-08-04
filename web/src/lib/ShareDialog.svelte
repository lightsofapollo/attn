<!--
  Share-for-review modal (rewritten for the "just give me the URL" UX).

  Design goal (per user feedback 2026-05-19): when the owner hits Cmd+Shift+S
  the dialog should show *one* thing — a URL the reviewer can click or paste.
  Mode / fingerprint / single-device-toggle are valid concerns but not in the
  critical path; they live behind an "Advanced" disclosure.

  Flow:
    1. Dialog opens with the current Markdown/HTML file selected.
    2. The owner confirms an exact N-file selection before publication begins.
    3. The daemon's `ShareReady` IPC populates `reviewStore.currentShare`,
       App.svelte threads `existingInviteUrl` into this dialog, and the URL
       card swaps in with a Copy button + an `attn review join …` CLI snippet
       so a reviewer who can't click `attn://` URLs has a one-line fallback.
    4. The URL is auto-copied to the clipboard on first arrival; subsequent
       opens act as inspect-mode (re-Share is idempotent against the cached
       room secret on disk, so no extra round-trip is needed).
    5. [Done] dismisses after the URL is ready.

  Advanced disclosure exposes the original mode picker + verify-key
  fingerprint + single-device toggle for power users.
-->

<script lang="ts">
  import Copy from '@lucide/svelte/icons/copy';
  import Check from '@lucide/svelte/icons/check';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import Link from '@lucide/svelte/icons/link';
  import Terminal from '@lucide/svelte/icons/terminal';
  import * as Dialog from './components/ui/dialog';
  import { Button } from './components/ui/button';
  import { ScrollArea } from './components/ui/scroll-area';
  import { reviewShare } from './ipc';
  import { ownerKeyFingerprint } from './review/fingerprint';
  import type { RoomId, SearchResultItem } from './types';

  // ---------------------------------------------------------------------------
  // Public surface (bound by App.svelte)
  // ---------------------------------------------------------------------------

  export type ShareMode = 'live' | 'async_24h' | 'async_7d' | 'hybrid';

  interface Props {
    open: boolean;
    filePath: string;
    projectRoot?: string;
    files?: SearchResultItem[];
    filesLoading?: boolean;
    targetIsDirectory?: boolean;
    existingFilePaths?: string[];
    ownerSigningKey?: string;
    /** Empty until the daemon's ShareReady callback populates it. */
    existingInviteUrl?: string;
    /** Hosted HTTPS invite; preferred for the human-facing copy-link action. */
    existingBrowserInviteUrl?: string;
    existingViewInviteUrl?: string;
    existingSuggestInviteUrl?: string;
    existingBrowserViewInviteUrl?: string;
    existingBrowserSuggestInviteUrl?: string;
    /** Non-null when a share already exists for this file. Suppresses re-mint. */
    existingRoomId?: RoomId | null;
    /** Latest daemon-side share failure while this dialog is open. */
    shareErrorMessage?: string;
    writeToClipboard?: (text: string) => Promise<void>;
    onStart?: (params: ShareStartParams) => void;
    onClearError?: () => void;
  }

  export interface ShareStartParams {
    mode: ShareMode;
    ipcMode: 'live' | 'async' | 'hybrid';
    ttl?: string;
    deleteEventsAfterOwnerAck: boolean;
    filePath: string;
    selectedPaths: string[];
  }

  let {
    open = $bindable(false),
    filePath,
    projectRoot = '',
    files = [],
    filesLoading = false,
    targetIsDirectory = false,
    existingFilePaths = [],
    ownerSigningKey = '',
    existingInviteUrl = '',
    existingBrowserInviteUrl = '',
    existingViewInviteUrl = '',
    existingSuggestInviteUrl = '',
    existingBrowserViewInviteUrl = '',
    existingBrowserSuggestInviteUrl = '',
    existingRoomId = null,
    shareErrorMessage = '',
    writeToClipboard,
    onStart,
    onClearError,
  }: Props = $props();

  // ---------------------------------------------------------------------------
  // Local view-state
  // ---------------------------------------------------------------------------

  // Mode is intentionally not user-facing anymore. The daemon always shares
  // in Hybrid mode: live-direct WebRTC when both peers are online, mailbox
  // fallback when they're not, transparent switching as connectivity
  // changes. Per user feedback 2026-05-19: "I want not live or envelope
  // mode it should seamlessly do both and switch between them as needed
  // for optimal experience."
  const selectedMode: ShareMode = 'hybrid';
  let singleDeviceOnly = $state(false);
  let copiedTier = $state<'view' | 'comment' | 'suggest' | null>(null);
  let copiedCli = $state(false);
  let copiedFingerprint = $state(false);
  let advancedOpen = $state(false);
  let phase = $state<'configure' | 'minting' | 'ready' | 'error'>('configure');
  let selectedPaths = $state<string[]>([]);
  let fileQuery = $state('');
  let fingerprint = $state('—— —— ——');
  /** Guards the minting phase: if ShareReady never lands, surface an error. */
  let mintTimeout: ReturnType<typeof setTimeout> | null = null;
  const MINT_TIMEOUT_MS = 15000;

  const inviteUrl = $derived(existingBrowserInviteUrl || existingInviteUrl);
  const tierLinks = $derived([
    {
      tier: 'view' as const,
      label: 'Anyone with this link can view',
      detail: 'Read the document and review activity. No device registration or writes.',
      url: existingBrowserViewInviteUrl || existingViewInviteUrl,
    },
    {
      tier: 'comment' as const,
      label: 'Anyone with this link can comment',
      detail: 'Add and resolve comments. Suggestions are blocked by every importing peer.',
      url: inviteUrl,
    },
    {
      tier: 'suggest' as const,
      label: 'Anyone with this link can suggest',
      detail: 'Comment and propose edits for the owner to accept or reject.',
      url: existingBrowserSuggestInviteUrl || existingSuggestInviteUrl,
    },
  ]);
  /**
   * Zero-install one-liner for reviewers without `attn` on their PATH.
   * `npx attnmd` is the published npm package's bin entrypoint — the
   * launcher (bin/attn.js) downloads the right binary for the platform
   * on first run and then forwards args, so the reviewer doesn't need
   * to install anything separately. Single-quoted so the `#` fragment
   * isn't eaten by the shell.
   */
  const cliCommand = $derived(
    existingInviteUrl.length > 0
      ? `npx attnmd review join '${existingInviteUrl}'`
      : '',
  );

  let selectionInitializedFor: string | null = null;
  const filteredFiles = $derived.by(() => {
    const query = fileQuery.trim().toLocaleLowerCase();
    if (!query) return files;
    return files.filter((file) => relativePath(file.path).toLocaleLowerCase().includes(query));
  });
  const selectedCount = $derived(selectedPaths.length);
  const selectionSummary = $derived(
    `${selectedCount} ${selectedCount === 1 ? 'file' : 'files'} selected`,
  );

  // Existing shares open directly to their link. New shares always wait for
  // an explicit file selection; loading the native project scan must never
  // race into publication.
  $effect(() => {
    if (!open) {
      selectionInitializedFor = null;
      return;
    }
    copiedTier = null;
    copiedCli = false;
    copiedFingerprint = false;
    if (existingRoomId !== null && existingInviteUrl.length > 0) {
      if (existingFilePaths.length > 0) {
        selectedPaths = [...new Set(existingFilePaths)];
      }
      phase = 'ready';
      return;
    }
    phase = 'configure';
    if (filesLoading) return;
    const selectionKey = `${projectRoot}\u0000${filePath}\u0000${targetIsDirectory}`;
    if (selectionInitializedFor === selectionKey) return;
    selectionInitializedFor = selectionKey;
    fileQuery = '';
    selectedPaths = targetIsDirectory
      ? files.filter((file) => pathIsWithin(filePath, file.path)).map((file) => file.path)
      : files.some((file) => file.path === filePath)
        ? [filePath]
        : [];
  });

  // Transition → ready when the daemon's ShareReady IPC lands. Recovers from a
  // timed-out mint too: a slow relay can answer AFTER the 15s timeout already
  // flipped phase to 'error', and the invite is still valid — so surface it
  // rather than leaving a spurious error on screen. A genuine daemon failure
  // never populates inviteUrl, so this can't paper over a real error.
  $effect(() => {
    if ((phase === 'minting' || phase === 'error') && inviteUrl.length > 0) {
      if (mintTimeout) {
        clearTimeout(mintTimeout);
        mintTimeout = null;
      }
      phase = 'ready';
      // Keep the backwards-compatible join command as the automatic clipboard
      // value until the production hosted origin is deployed. The staging-
      // configured HTTPS link remains available in the browser card below.
      const automaticShare = inviteUrl || cliCommand;
      void copyToClipboard(automaticShare).then((ok) => {
        if (ok) {
          if (cliCommand) {
            copiedCli = true;
            setTimeout(() => (copiedCli = false), 1600);
          } else {
            copiedTier = 'comment';
            setTimeout(() => (copiedTier = null), 1600);
          }
        }
      });
    }
  });

  // Transition minting → error as soon as Rust reports a share failure.
  $effect(() => {
    if (!open) return;
    if (phase !== 'minting') return;
    if (shareErrorMessage.length === 0) return;
    if (mintTimeout) {
      clearTimeout(mintTimeout);
      mintTimeout = null;
    }
    phase = 'error';
  });

  // Recompute the fingerprint whenever the owner key changes.
  $effect(() => {
    let cancelled = false;
    void (async () => {
      const fp = await ownerKeyFingerprint(ownerSigningKey);
      if (!cancelled) fingerprint = fp;
    })();
    return () => {
      cancelled = true;
    };
  });

  async function startMint(): Promise<void> {
    if (selectedPaths.length === 0) return;
    const { mode: ipcMode, ttl } = modeToIpc(selectedMode);
    onClearError?.();
    phase = 'minting';
    // reviewShare is fire-and-forget IPC; the daemon answers asynchronously via
    // the ShareReady callback. If the relay is unreachable or create_room
    // fails, ShareReady never lands — so guard with a timeout that flips to an
    // explicit error state (with retry) instead of spinning forever.
    if (mintTimeout) clearTimeout(mintTimeout);
    mintTimeout = setTimeout(() => {
      if (phase === 'minting') phase = 'error';
    }, MINT_TIMEOUT_MS);
    await reviewShare(projectRoot || filePath, selectedPaths, filePath, ipcMode, ttl);
    onStart?.({
      mode: selectedMode,
      ipcMode,
      ttl,
      deleteEventsAfterOwnerAck: singleDeviceOnly,
      filePath,
      selectedPaths: [...selectedPaths],
    });
  }

  function retryMint(): void {
    void startMint();
  }

  function togglePath(path: string, checked: boolean): void {
    selectedPaths = checked
      ? [...new Set([...selectedPaths, path])]
      : selectedPaths.filter((candidate) => candidate !== path);
  }

  function selectVisible(): void {
    selectedPaths = [...new Set([...selectedPaths, ...filteredFiles.map((file) => file.path)])];
  }

  function clearSelection(): void {
    selectedPaths = [];
  }

  function relativePath(path: string): string {
    const normalizedRoot = projectRoot.replace(/[\\/]+$/u, '');
    if (!normalizedRoot) return path;
    const prefix = `${normalizedRoot}/`;
    return path.replaceAll('\\', '/').startsWith(prefix.replaceAll('\\', '/'))
      ? path.replaceAll('\\', '/').slice(prefix.replaceAll('\\', '/').length)
      : path;
  }

  function pathIsWithin(parent: string, candidate: string): boolean {
    const normalizedParent = parent.replaceAll('\\', '/').replace(/\/+$/u, '');
    const normalizedCandidate = candidate.replaceAll('\\', '/');
    return normalizedCandidate === normalizedParent || normalizedCandidate.startsWith(`${normalizedParent}/`);
  }

  export function modeToIpc(mode: ShareMode): { mode: 'live' | 'async' | 'hybrid'; ttl?: string } {
    switch (mode) {
      case 'live':
        return { mode: 'live' };
      case 'hybrid':
        return { mode: 'hybrid' };
      case 'async_24h':
        return { mode: 'async', ttl: '24h' };
      case 'async_7d':
        return { mode: 'async', ttl: '7d' };
    }
  }

  async function copyToClipboard(text: string): Promise<boolean> {
    if (!text) return false;
    try {
      if (writeToClipboard) {
        await writeToClipboard(text);
      } else if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  async function handleCopyTier(tier: 'view' | 'comment' | 'suggest', url: string): Promise<void> {
    const ok = await copyToClipboard(url);
    if (ok) {
      copiedTier = tier;
      setTimeout(() => (copiedTier = null), 1500);
    }
  }

  async function handleCopyCli(): Promise<void> {
    const ok = await copyToClipboard(cliCommand);
    if (ok) {
      copiedCli = true;
      setTimeout(() => (copiedCli = false), 1500);
    }
  }

  async function handleCopyFingerprint(): Promise<void> {
    const ok = await copyToClipboard(fingerprint);
    if (ok) {
      copiedFingerprint = true;
      setTimeout(() => (copiedFingerprint = false), 1500);
    }
  }

  function handleDone(): void {
    open = false;
  }

  const isMinting = $derived(phase === 'minting');
  const isConfiguring = $derived(phase === 'configure');
  const isReady = $derived(phase === 'ready');
  const isError = $derived(phase === 'error');
</script>

<Dialog.Root bind:open>
  <Dialog.Content class="w-[min(36rem,calc(100%-2rem))] max-w-[36rem] overflow-x-hidden" data-slot="share-dialog">
    <Dialog.Header>
      <Dialog.Title>Share for review</Dialog.Title>
      <Dialog.Description>
        {#if isConfiguring}
          Choose the exact files reviewers will receive.
        {:else}
          <span class="font-medium text-foreground">{selectionSummary}</span>
        {/if}
      </Dialog.Description>
    </Dialog.Header>

    {#if isConfiguring}
      <section class="flex min-h-0 flex-col gap-3" aria-labelledby="native-share-files-heading">
        <div class="flex items-end justify-between gap-3">
          <div>
            <h3 id="native-share-files-heading" class="text-sm font-semibold text-foreground">Select files</h3>
            <p class="mt-0.5 text-xs text-muted-foreground">The current file starts selected. Nothing is shared until you create the link.</p>
          </div>
          <div class="flex shrink-0 gap-1 text-xs">
            <button type="button" class="rounded-md px-2 py-1.5 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50" onclick={selectVisible}>Select visible</button>
            <button type="button" class="rounded-md px-2 py-1.5 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50" onclick={clearSelection}>Clear</button>
          </div>
        </div>

        <input
          type="search"
          class="h-9 w-full rounded-md border border-border bg-background px-3 font-sans text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
          placeholder="Filter project files…"
          aria-label="Filter files to share"
          bind:value={fileQuery}
        />

        <ScrollArea viewportClasses="max-h-72" class="rounded-md border border-border bg-background" data-slot="share-file-picker">
          {#if filesLoading}
            <div class="flex items-center gap-2 px-3 py-8 text-sm text-muted-foreground" role="status">
              <span class="inline-block size-3 animate-pulse rounded-full bg-primary/60" aria-hidden="true"></span>
              Finding reviewable files…
            </div>
          {:else if files.length === 0}
            <p class="px-3 py-8 text-center text-sm text-muted-foreground">No Markdown or HTML files found in this project.</p>
          {:else if filteredFiles.length === 0}
            <p class="px-3 py-8 text-center text-sm text-muted-foreground">No files match “{fileQuery}”.</p>
          {:else}
            {#each filteredFiles as file (file.path)}
              <label class="grid min-h-11 cursor-pointer grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 border-b border-border/60 px-3 py-2 last:border-b-0 hover:bg-muted/45">
                <input
                  type="checkbox"
                  class="size-4 accent-primary"
                  checked={selectedPaths.includes(file.path)}
                  onchange={(event) => togglePath(file.path, event.currentTarget.checked)}
                />
                <span class="min-w-0 truncate font-mono text-xs text-foreground">{relativePath(file.path)}</span>
                <span class="text-[11px] text-muted-foreground">
                  {file.path === filePath ? 'Current · ' : ''}{file.fileType === 'html' ? 'Read-only' : 'Markdown'}
                </span>
              </label>
            {/each}
          {/if}
        </ScrollArea>

        <div class="flex items-center justify-between gap-3 text-xs" aria-live="polite">
          <strong class="font-medium text-foreground">{selectionSummary}</strong>
          <span class="truncate font-mono text-muted-foreground">{projectRoot}</span>
        </div>
      </section>
    {:else}
    {#if isReady && selectedPaths.length > 0}
      <section class="flex min-w-0 flex-col gap-1.5 border-b border-border/60 pb-3" aria-labelledby="native-shared-files-heading" data-slot="share-ready-files">
        <div class="flex items-center justify-between gap-3 text-xs">
          <strong id="native-shared-files-heading" class="font-medium text-foreground">Reviewers receive</strong>
          <span class="text-muted-foreground">{selectionSummary}</span>
        </div>
        <ScrollArea viewportClasses="max-h-24" class="font-mono text-xs leading-5 text-muted-foreground">
          {#each selectedPaths as path (path)}
            <div class="truncate" title={relativePath(path)}>{relativePath(path)}</div>
          {/each}
        </ScrollArea>
      </section>
    {/if}
    <!-- ============================================================
         Primary card: the one-liner command. This works for ANYONE —
         npx uses a locally-installed attn if present, else downloads on
         first run. No account, no signup, no "do you have the app?".
         ============================================================ -->
    <div
      class="flex w-full min-w-0 flex-col gap-2 overflow-hidden rounded-lg border border-primary/40 bg-primary/5 p-4 transition-colors"
      data-slot="share-command-card"
    >
      <div class="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        <Terminal class="size-3.5" aria-hidden="true" />
        Send this command
      </div>
      {#if isError}
        <div class="flex flex-col gap-2 py-1.5 text-sm" data-slot="share-error">
          <span class="text-destructive">
            {shareErrorMessage || "Couldn't reach the review relay — the share didn't complete. Nothing left this machine."}
          </span>
          <button
            type="button"
            class="self-start rounded-md border border-border px-3 py-1 text-xs hover:border-primary/60"
            data-slot="share-retry"
            onclick={retryMint}
          >
            Try again
          </button>
        </div>
      {:else}
        <!-- Stable-height swap (attn-0sv): minting and ready render the
             SAME rows — only the command row's content changes — so the
             ShareReady IPC landing never resizes the dialog. The minting
             row copies the command row's box metrics exactly. -->
        {#if isReady && cliCommand.length > 0}
          <button
            type="button"
            class="block w-full overflow-hidden rounded-md border border-border bg-background px-3 py-2 text-left font-mono text-xs text-foreground hover:border-primary/60"
            data-slot="share-cli-command"
            onclick={handleCopyCli}
            title="Click to copy"
          >
            <span class="block truncate">{cliCommand}</span>
          </button>
        {:else}
          <div
            class="flex w-full items-center gap-2 overflow-hidden rounded-md border border-border bg-background px-3 py-2 font-mono text-xs text-muted-foreground"
            data-slot="share-minting"
          >
            <span class="inline-block size-3 shrink-0 animate-pulse rounded-full bg-primary/60" aria-hidden="true"></span>
            <span class="block truncate">Minting room…</span>
          </div>
        {/if}
        <Button
          type="button"
          variant="default"
          size="default"
          onclick={handleCopyCli}
          data-slot="share-copy-cli"
          class="w-full"
          disabled={!isReady}
        >
          {#if copiedCli}
            <Check class="size-4" aria-hidden="true" />
            <span>Copied to clipboard</span>
          {:else}
            <Copy class="size-4" aria-hidden="true" />
            <span>Copy invite command</span>
          {/if}
        </Button>
        <p class="text-xs text-muted-foreground">
          Send this to anyone. <code>npx</code> uses their installed attn if they have
          one, otherwise downloads it on first run — no account, no signup. They join
          over an end-to-end encrypted channel.
        </p>
      {/if}
    </div>

    <!-- ============================================================
         Secondary card: the hosted HTTPS link. The room secret remains in the
         fragment and is stripped by the trusted browser client immediately.
         ============================================================ -->
    {#if !isError}
      <!-- Rendered from the moment the dialog opens (attn-0sv): a
           placeholder row holds the card's final size while minting so
           the dialog never grows a whole card when ShareReady lands. -->
      <div class="flex w-full min-w-0 flex-col gap-3 overflow-hidden rounded-lg border border-border/60 bg-muted/30 p-4" data-slot="share-url-card">
        <div class="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          <Link class="size-3.5" aria-hidden="true" />
          Choose what the link allows
        </div>
        {#if isReady && inviteUrl.length > 0}
          <div class="grid gap-2" data-slot="share-tier-links">
            {#each tierLinks as link (link.tier)}
              <button
                type="button"
                class="group grid min-w-0 grid-cols-[1fr_auto] items-center gap-3 rounded-md border border-border bg-background px-3 py-2.5 text-left transition-colors hover:border-primary/60 hover:bg-primary/[0.03]"
                data-slot={`share-tier-${link.tier}`}
                onclick={() => handleCopyTier(link.tier, link.url)}
                disabled={link.url.length === 0}
              >
                <span class="min-w-0">
                  <span class="block text-sm font-medium text-foreground">{link.label}</span>
                  <span class="block truncate text-[11px] leading-4 text-muted-foreground">{link.detail}</span>
                </span>
                <span class="flex size-7 items-center justify-center rounded border border-border text-muted-foreground group-hover:text-foreground">
                  {#if copiedTier === link.tier}
                    <Check class="size-3.5" aria-hidden="true" />
                  {:else}
                    <Copy class="size-3.5" aria-hidden="true" />
                  {/if}
                </span>
              </button>
            {/each}
          </div>
          <!-- Hidden field with the same data-slot test selectors rely on.
               Stays gated on `isReady`: E2E scripts treat this element's
               APPEARANCE as the share-ready signal. -->
          <input
            type="text"
            class="sr-only"
            readonly
            tabindex="-1"
            aria-hidden="true"
            value={inviteUrl}
            data-slot="share-invite-url"
          />
        {:else}
          <div class="grid gap-2" aria-label="Generating permission links">
            {#each ['View', 'Comment', 'Suggest'] as label}
              <div class="flex h-[3.75rem] items-center rounded-md border border-border bg-background px-3 text-sm text-muted-foreground">
                <span class="mr-2 inline-block size-2 animate-pulse rounded-full bg-primary/50" aria-hidden="true"></span>
                {label} link
              </div>
            {/each}
          </div>
        {/if}
        <p class="text-xs text-muted-foreground">
          Comment is the default for people; agent workflows use Suggest. The relay only sees encrypted envelopes and scoped admission proofs.
        </p>
      </div>
    {/if}

    <!-- ============================================================
         Advanced disclosure — mode picker, fingerprint, single-device.
         Closed by default; the 95th-percentile flow never opens this.
         ============================================================ -->
    <button
      type="button"
      class="group flex items-center gap-1.5 self-start rounded text-xs font-medium text-muted-foreground hover:text-foreground"
      onclick={() => (advancedOpen = !advancedOpen)}
      data-slot="share-advanced-toggle"
      aria-expanded={advancedOpen}
    >
      <ChevronRight
        class="size-3.5 transition-transform {advancedOpen ? 'rotate-90' : ''}"
        aria-hidden="true"
      />
      Advanced options
    </button>

    {#if advancedOpen}
      <div class="flex flex-col gap-3 rounded-md border border-border/60 bg-muted/10 p-3" data-slot="share-advanced">
        <div class="flex flex-col gap-1" data-slot="share-fingerprint-row">
          <label class="text-xs font-medium text-foreground" for="share-fingerprint">
            Verify-key fingerprint
          </label>
          <div class="flex items-center gap-2">
            <code
              id="share-fingerprint"
              class="flex-1 rounded-md border border-border bg-muted/40 px-2 py-1.5 font-mono text-xs tracking-wider text-foreground"
              data-slot="share-fingerprint"
            >{fingerprint}</code>
            <Button
              type="button"
              variant={copiedFingerprint ? 'default' : 'outline'}
              size="sm"
              onclick={handleCopyFingerprint}
              data-slot="share-copy-fingerprint"
            >
              {#if copiedFingerprint}
                <Check class="size-3.5" aria-hidden="true" />
                <span>Copied</span>
              {:else}
                <Copy class="size-3.5" aria-hidden="true" />
                <span>Copy</span>
              {/if}
            </Button>
          </div>
          <p class="text-[11px] text-muted-foreground">
            Read aloud to your reviewer for out-of-band identity check (SHA-256 of your signing key).
          </p>
        </div>

        <label class="flex cursor-pointer items-start gap-2 rounded p-1.5" data-slot="share-single-device-row">
          <input
            type="checkbox"
            class="mt-0.5 size-3.5 shrink-0 accent-primary"
            bind:checked={singleDeviceOnly}
            data-slot="share-single-device-toggle"
          />
          <div class="flex min-w-0 flex-col">
            <span class="text-xs font-medium text-foreground">I only use one device for review</span>
            <span class="text-[11px] text-muted-foreground">
              Auto-deletes mailbox events after I acknowledge them.
            </span>
          </div>
        </label>
      </div>
    {/if}
    {/if}

    <Dialog.Footer>
      <Button
        type="button"
        onclick={isConfiguring ? startMint : handleDone}
        disabled={isMinting || (isConfiguring && (filesLoading || selectedCount === 0))}
        data-slot="share-start"
      >
        {#if isConfiguring}
          Create review link for {selectedCount} {selectedCount === 1 ? 'file' : 'files'}
        {:else if isMinting}
          Minting…
        {:else}
          Done
        {/if}
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
