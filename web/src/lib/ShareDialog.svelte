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
  import {
    FINGERPRINT_UNAVAILABLE_MESSAGE,
    resolveFingerprintPresentation,
    resolveSharePresentation,
    type SharePhase,
  } from './share-dialog-state';
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
  let phase = $state<SharePhase>('configure');
  let selectedPaths = $state<string[]>([]);
  let fileQuery = $state('');
  /** Last settled digest; '' while the first computation is in flight. */
  let fingerprintDigest = $state('');
  /** Set when `ownerKeyFingerprint` rejected — see `resolveFingerprintPresentation`. */
  let fingerprintFailed = $state(false);
  /** Guards the minting phase: if ShareReady never lands, surface an error. */
  let mintTimeout: ReturnType<typeof setTimeout> | null = null;
  const MINT_TIMEOUT_MS = 15000;
  /**
   * Same guarantee for the file scan (attn-vlmz.1.1): no spinner in this
   * dialog may outlive a timeout. `filesLoading` is cleared by the daemon's
   * `shareableFiles` reply, and the browser build has no handler for
   * `review_list_shareable_files` at all — so an uploaded folder pins the
   * picker on "Finding reviewable files…" and the owner can never proceed.
   * Bound it and explain it instead.
   */
  let fileScanTimedOut = $state(false);
  const FILE_SCAN_TIMEOUT_MS = 8000;

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
    // `inviteUrl`, not `existingInviteUrl`: a hosted mint returns an HTTPS
    // invite and NO `attn://` URL, and gating on the native form alone made
    // this effect fall through to `phase = 'configure'` the moment the room
    // landed — throwing the owner back to the file picker on a share that had
    // just succeeded. Reading the same resolved URL the rest of the dialog
    // uses also makes the effect depend on the hosted prop, so it re-runs when
    // that is what arrives (attn-vlmz.1.2).
    if (existingRoomId !== null && inviteUrl.length > 0) {
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

  // Bound the file scan. Cleared automatically the moment `filesLoading`
  // flips false, so a slow-but-successful scan lands normally.
  $effect(() => {
    if (!open || !filesLoading) {
      fileScanTimedOut = false;
      return;
    }
    fileScanTimedOut = false;
    const timer = setTimeout(() => (fileScanTimedOut = true), FILE_SCAN_TIMEOUT_MS);
    return () => clearTimeout(timer);
  });

  // Recompute the fingerprint whenever the owner key changes.
  //
  // The rejection path is load-bearing, not defensive dressing: `crypto.subtle`
  // is undefined on an insecure non-loopback origin, so reaching a dev server
  // over a LAN IP makes `ownerKeyFingerprint` throw. Without the catch the
  // rejection escaped this effect unhandled and the row kept rendering the
  // em-dash placeholder indefinitely — a pending state with no deadline and no
  // way to tell it apart from "no key yet", under a label that tells the owner
  // to read it aloud as an identity check.
  $effect(() => {
    const key = ownerSigningKey;
    let cancelled = false;
    // Drop the previous key's digest immediately. Holding it while the new one
    // computes would show a fingerprint that verifies the wrong identity.
    fingerprintDigest = '';
    fingerprintFailed = false;
    void (async () => {
      try {
        const fp = await ownerKeyFingerprint(key);
        if (!cancelled) fingerprintDigest = fp;
      } catch {
        if (!cancelled) {
          fingerprintDigest = '';
          fingerprintFailed = true;
        }
      }
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
    // Retrying with nothing selected would post an empty share and land back
    // in the same error, so send the owner to the step that can fix it.
    if (selectedPaths.length === 0) {
      onClearError?.();
      phase = 'configure';
      return;
    }
    void startMint();
  }

  /**
   * Escape hatch for a file scan that never answered. The owner opened Share
   * on a concrete file, so that file is shareable whether or not the rest of
   * the project could be enumerated.
   */
  function shareTargetOnly(): void {
    if (!canShareTargetOnly) return;
    selectedPaths = [filePath];
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

  async function handleCopyPrimary(): Promise<void> {
    const ok = await copyToClipboard(primaryShare.text);
    if (ok) {
      copiedCli = true;
      setTimeout(() => (copiedCli = false), 1500);
    }
  }

  async function handleCopyFingerprint(): Promise<void> {
    // Guarded as well as disabled: copying the em-dash placeholder would hand
    // the owner something that looks like a verification value and isn't.
    if (!fingerprintView.copyable) return;
    const ok = await copyToClipboard(fingerprintView.text);
    if (ok) {
      copiedFingerprint = true;
      setTimeout(() => (copiedFingerprint = false), 1500);
    }
  }

  function handleDone(): void {
    open = false;
  }

  /**
   * The template renders THIS phase, never `phase` directly (attn-vlmz.1.2).
   * `resolveSharePresentation` collapses "ready but nothing to send" into an
   * explicit error with the retry affordance, so no branch below can put a
   * skeleton on screen that outlives the mint timeout.
   */
  const presentation = $derived(
    resolveSharePresentation({
      phase,
      inviteUrl,
      cliCommand,
      daemonErrorMessage: shareErrorMessage,
    }),
  );
  const isMinting = $derived(presentation.phase === 'minting');
  const isConfiguring = $derived(presentation.phase === 'configure');
  const isReady = $derived(presentation.phase === 'ready');
  const isError = $derived(presentation.phase === 'error');
  /** The one thing the primary card copies: CLI one-liner, else the link. */
  const primaryShare = $derived(presentation.primary);
  const canShareTargetOnly = $derived(!targetIsDirectory && filePath.length > 0);
  /** Same discipline as `presentation`: the row renders a resolved status. */
  const fingerprintView = $derived(
    resolveFingerprintPresentation(ownerSigningKey, fingerprintDigest, fingerprintFailed),
  );
</script>

<Dialog.Root bind:open>
  <Dialog.Content class="w-[min(36rem,calc(100%-2rem))] max-w-[36rem] overflow-x-hidden" data-slot="share-dialog">
    <Dialog.Header>
      <Dialog.Title>Share for review</Dialog.Title>
      <!-- One line, always: configure explains the step, minting explains the
           wait (attn-11g4.1.2), ready/error state the selection. Same slot and
           same single line in every phase, so the header never resizes. -->
      <Dialog.Description>
        {#if isConfiguring}
          Choose the exact files reviewers will receive.
        {:else if isMinting}
          <span class="font-medium text-foreground" data-slot="share-minting-description">
            Creating the encrypted room and minting invite links…
          </span>
        {:else}
          <span class="font-medium text-foreground">{selectionSummary}</span>
        {/if}
      </Dialog.Description>
    </Dialog.Header>

    {#if isConfiguring}
      <section class="flex min-h-0 flex-col gap-3" aria-labelledby="native-share-files-heading">
        <div class="flex shrink-0 items-end justify-between gap-3">
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
          class="h-9 w-full shrink-0 rounded-md border border-border bg-background px-3 font-sans text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
          placeholder="Filter project files…"
          aria-label="Filter files to share"
          bind:value={fileQuery}
        />

        <!-- Cap the picker against the WINDOW, not a fixed row count: a fixed
             max-h-72 plus the surrounding chrome overflowed the dialog's 85vh
             ceiling, so the whole modal scrolled and the create button sat
             below the fold. Sized so list + chrome always fits, which keeps
             every control visible without scrolling the dialog itself. -->
        <ScrollArea
          viewportClasses="max-h-[min(20rem,34vh)]"
          class="rounded-md border border-border bg-background"
          data-slot="share-file-picker"
        >
          {#if filesLoading && !fileScanTimedOut}
            <div class="flex items-center gap-2 px-3 py-8 text-sm text-muted-foreground" role="status">
              <span class="inline-block size-3 animate-pulse rounded-full bg-primary/60" aria-hidden="true"></span>
              Finding reviewable files…
            </div>
          {:else if filesLoading}
            <!-- The scan never answered. Say so, and keep a way forward:
                 refusing to show anything here is what left the owner with
                 "can't proceed from there" (attn-vlmz.1.1). -->
            <div class="flex flex-col items-start gap-2 px-3 py-6 text-sm" role="status" data-slot="share-files-unavailable">
              <p class="text-foreground">Couldn’t list the files in this project.</p>
              <p class="text-xs text-muted-foreground">
                {#if canShareTargetOnly}
                  The file scan didn’t come back. You can still share the file you have open, or close this and try again.
                {:else}
                  The file scan didn’t come back, so there is nothing to choose from. Open a file and share that instead.
                {/if}
              </p>
              {#if canShareTargetOnly}
                <button
                  type="button"
                  class="rounded-md border border-border px-3 py-1.5 text-xs text-foreground hover:border-primary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                  data-slot="share-files-fallback"
                  onclick={shareTargetOnly}
                >
                  {selectedPaths.includes(filePath) ? 'Sharing just this file' : 'Share just this file'}
                </button>
              {/if}
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
                <span class="text-micro text-muted-foreground">
                  {file.path === filePath ? 'Current · ' : ''}{file.fileType === 'html' ? 'Read-only' : 'Markdown'}
                </span>
              </label>
            {/each}
          {/if}
        </ScrollArea>

        <div class="flex shrink-0 items-center justify-between gap-3 text-xs" aria-live="polite">
          <strong class="font-medium text-foreground">{selectionSummary}</strong>
          <span class="truncate font-mono text-muted-foreground">{projectRoot}</span>
        </div>
      </section>
    {:else}
    <!-- Rendered from the moment minting starts, not from ready: the selection
         is already known, and gating it on `isReady` grew the dialog by a whole
         section the instant ShareReady landed (attn-11g4.1.2 — the dialog must
         not resize when the loading state clears). Never silently collapses on
         an empty selection either; it says what it doesn't know. Hidden only on
         error, where "reviewers receive" would be a false claim — nothing was
         published, and that branch drops the links card anyway. -->
    {#if !isError}
    <section class="flex min-w-0 flex-col gap-1.5 border-b border-border/60 pb-3" aria-labelledby="native-shared-files-heading" data-slot="share-ready-files">
      <div class="flex items-center justify-between gap-3 text-xs">
        <strong id="native-shared-files-heading" class="font-medium text-foreground">Reviewers receive</strong>
        <span class="text-muted-foreground">{selectionSummary}</span>
      </div>
      <ScrollArea viewportClasses="max-h-24" class="font-mono text-xs leading-5 text-muted-foreground">
        {#each selectedPaths as path (path)}
          <div class="truncate" title={relativePath(path)}>{relativePath(path)}</div>
        {/each}
        {#if selectedPaths.length === 0}
          <div class="font-sans" data-slot="share-files-unknown">
            This window doesn’t have the file list for this share.
          </div>
        {/if}
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
        {#if primaryShare.kind === 'link'}
          <Link class="size-3.5" aria-hidden="true" />
          Send this link
        {:else}
          <Terminal class="size-3.5" aria-hidden="true" />
          Send this command
        {/if}
      </div>
      {#if isError}
        <div class="flex flex-col gap-2 py-1.5 text-sm" data-slot="share-error">
          <span class="text-destructive">{presentation.errorMessage}</span>
          <button
            type="button"
            class="self-start rounded-md border border-border px-3 py-1 text-xs hover:border-primary/60"
            data-slot="share-retry"
            onclick={retryMint}
          >
            {selectedPaths.length === 0 ? 'Choose files' : 'Try again'}
          </button>
        </div>
      {:else}
        <!-- Stable-height swap (attn-0sv): minting and ready render the
             SAME rows — only the command row's content changes — so the
             ShareReady IPC landing never resizes the dialog. The minting
             row copies the command row's box metrics exactly. -->
        {#if primaryShare.kind !== 'pending'}
          <button
            type="button"
            class="block w-full overflow-hidden rounded-md border border-border bg-background px-3 py-2 text-left font-mono text-xs text-foreground hover:border-primary/60"
            data-slot={primaryShare.kind === 'command' ? 'share-cli-command' : 'share-invite-link'}
            onclick={handleCopyPrimary}
            title="Click to copy"
          >
            <span class="block truncate">{primaryShare.text}</span>
          </button>
        {:else}
          <!-- Minting. The dot is decoration — under prefers-reduced-motion the
               global rule in styles/base.css stops it, so the sentence, the
               role="status" announcement and the footer label carry the state
               on their own. -->
          <div
            class="flex w-full items-center gap-2 overflow-hidden rounded-md border border-border bg-background px-3 py-2 font-mono text-xs text-muted-foreground"
            data-slot="share-minting"
            role="status"
            aria-live="polite"
          >
            <span class="inline-block size-3 shrink-0 animate-pulse rounded-full bg-primary/60" aria-hidden="true"></span>
            <span class="block truncate">Creating the room and minting invite links…</span>
          </div>
        {/if}
        <Button
          type="button"
          variant="default"
          size="default"
          onclick={handleCopyPrimary}
          data-slot="share-copy-cli"
          class="w-full"
          disabled={!isReady}
        >
          {#if copiedCli}
            <Check class="size-4" aria-hidden="true" />
            <span>Copied to clipboard</span>
          {:else}
            <Copy class="size-4" aria-hidden="true" />
            <span>{primaryShare.kind === 'link' ? 'Copy invite link' : 'Copy invite command'}</span>
          {/if}
        </Button>
        <p class="text-xs text-muted-foreground">
          {#if primaryShare.kind === 'link'}
            <!-- Kept to roughly the same line count as the command copy below:
                 the two swap in place and the dialog must not resize. -->
            Send this to anyone. It opens in their browser — no account, no signup,
            nothing to install. The room secret never leaves the link fragment, and
            they join over an end-to-end encrypted channel.
          {:else}
            Send this to anyone. <code>npx</code> uses their installed attn if they have
            one, otherwise downloads it on first run — no account, no signup. They join
            over an end-to-end encrypted channel.
          {/if}
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
        <!-- `isReady` already implies a usable invite URL — resolveSharePhase
             demotes ready-without-one to 'error', which this card doesn't
             render at all. So the placeholder below is reachable only from
             'minting', which the mint timeout bounds (attn-vlmz.1.2). -->
        {#if isReady}
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
                  <span class="block truncate text-micro leading-4 text-muted-foreground">{link.detail}</span>
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
          <!-- 3.625rem is the real row's measured height, not a guess: py-2.5
               (20px) + a text-sm line (20px) + a leading-4 detail line (16px) +
               two 1px borders = 58px. The old 3.75rem placeholder was 2px
               taller each, which shrank the dialog by 6px the moment the links
               arrived. Labelled "Preparing …" rather than named like a finished
               control: while minting these are not links yet. -->
          <div class="grid gap-2" role="status" aria-live="polite" data-slot="share-tier-pending">
            {#each ['View', 'Comment', 'Suggest'] as label}
              <div class="flex h-[3.625rem] items-center rounded-md border border-border bg-background px-3 text-sm text-muted-foreground">
                <span class="mr-2 inline-block size-2 animate-pulse rounded-full bg-primary/50" aria-hidden="true"></span>
                Preparing {label.toLocaleLowerCase()} link…
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
              data-status={fingerprintView.status}
            >{fingerprintView.text}</code>
            <Button
              type="button"
              variant={copiedFingerprint ? 'default' : 'outline'}
              size="sm"
              onclick={handleCopyFingerprint}
              disabled={!fingerprintView.copyable}
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
          {#if fingerprintView.status === 'failed'}
            <p class="text-micro text-destructive" data-slot="share-fingerprint-unavailable">
              {FINGERPRINT_UNAVAILABLE_MESSAGE}
            </p>
          {:else}
            <p class="text-micro text-muted-foreground">
              Read aloud to your reviewer for out-of-band identity check (SHA-256 of your signing key).
            </p>
          {/if}
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
            <span class="text-micro text-muted-foreground">
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
        disabled={isMinting
          || (isConfiguring && ((filesLoading && !fileScanTimedOut) || selectedCount === 0))}
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
