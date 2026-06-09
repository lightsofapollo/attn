<!--
  Share-for-review modal (rewritten for the "just give me the URL" UX).

  Design goal (per user feedback 2026-05-19): when the owner hits Cmd+Shift+S
  the dialog should show *one* thing — a URL the reviewer can click or paste.
  Mode / fingerprint / single-device-toggle are valid concerns but not in the
  critical path; they live behind an "Advanced" disclosure.

  Flow:
    1. Dialog opens (with `filePath` set).
    2. If there is no current share for the file, we auto-fire `reviewShare`
       with `live` mode default. The dialog renders a single Minting…
       placeholder card while we wait.
    3. The daemon's `ShareReady` IPC populates `reviewStore.currentShare`,
       App.svelte threads `existingInviteUrl` into this dialog, and the URL
       card swaps in with a Copy button + an `attn review join …` CLI snippet
       so a reviewer who can't click `attn://` URLs has a one-line fallback.
    4. The URL is auto-copied to the clipboard on first arrival; subsequent
       opens act as inspect-mode (re-Share is idempotent against the cached
       room secret on disk, so no extra round-trip is needed).
    5. [Done] dismisses. There is no [Start] / [Cancel] anymore — the URL is
       always ready by the time the user reads it.

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
  import { reviewShare } from './ipc';
  import { ownerKeyFingerprint } from './review/fingerprint';
  import type { RoomId } from './types';

  // ---------------------------------------------------------------------------
  // Public surface (bound by App.svelte)
  // ---------------------------------------------------------------------------

  export type ShareMode = 'live' | 'async_24h' | 'async_7d' | 'hybrid';

  interface Props {
    open: boolean;
    filePath: string;
    ownerSigningKey?: string;
    /** Empty until the daemon's ShareReady callback populates it. */
    existingInviteUrl?: string;
    /** Non-null when a share already exists for this file. Suppresses re-mint. */
    existingRoomId?: RoomId | null;
    /** Latest daemon-side share failure while this dialog is open. */
    shareErrorMessage?: string;
    writeToClipboard?: (text: string) => Promise<void>;
    onStart?: (params: ShareStartParams) => void;
    /** Fired when the mint fails or times out, so the owner can release any
     *  captured share-intent (see `reviewStore.clearShareIntent`). */
    onAbort?: () => void;
    onClearError?: () => void;
  }

  export interface ShareStartParams {
    mode: ShareMode;
    ipcMode: 'live' | 'async' | 'hybrid';
    ttl?: string;
    deleteEventsAfterOwnerAck: boolean;
    filePath: string;
  }

  let {
    open = $bindable(false),
    filePath,
    ownerSigningKey = '',
    existingInviteUrl = '',
    existingRoomId = null,
    shareErrorMessage = '',
    writeToClipboard,
    onStart,
    onAbort,
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
  let copiedUrl = $state(false);
  let copiedCli = $state(false);
  let copiedFingerprint = $state(false);
  let advancedOpen = $state(false);
  let phase = $state<'idle' | 'minting' | 'ready' | 'error'>('idle');
  let fingerprint = $state('—— —— ——');
  /** Guards the minting phase: if ShareReady never lands, surface an error. */
  let mintTimeout: ReturnType<typeof setTimeout> | null = null;
  const MINT_TIMEOUT_MS = 15000;

  const inviteUrl = $derived(existingInviteUrl);
  /**
   * Zero-install one-liner for reviewers without `attn` on their PATH.
   * `npx attnmd` is the published npm package's bin entrypoint — the
   * launcher (bin/attn.js) downloads the right binary for the platform
   * on first run and then forwards args, so the reviewer doesn't need
   * to install anything separately. Single-quoted so the `#` fragment
   * isn't eaten by the shell.
   */
  const cliCommand = $derived(
    inviteUrl.length > 0
      ? `npx attnmd review join '${inviteUrl}'`
      : '',
  );

  // Tracks which target we've already fired a mint for during this open, so an
  // effect re-run (e.g. ShareReady flipping the existing-invite props) can't
  // double-mint. Plain (non-reactive) on purpose. Reset when the dialog closes.
  let mintingTarget: string | null = null;

  // Auto-mint when the dialog's target isn't already shared. The parent only
  // passes `existingRoomId`/`existingInviteUrl` when the target IS the current
  // share — so a NEW target (sharing a folder while a file is shared, etc.)
  // mints a fresh room and the owner switches over to it.
  $effect(() => {
    if (!open) {
      mintingTarget = null;
      return;
    }
    copiedUrl = false;
    copiedCli = false;
    copiedFingerprint = false;
    if (existingRoomId !== null && existingInviteUrl.length > 0) {
      phase = 'ready';
      return;
    }
    if (mintingTarget === filePath) return;
    mintingTarget = filePath;
    void autoMint();
  });

  // Transition minting → ready when the daemon's ShareReady IPC lands.
  $effect(() => {
    if (phase === 'minting' && inviteUrl.length > 0) {
      if (mintTimeout) {
        clearTimeout(mintTimeout);
        mintTimeout = null;
      }
      phase = 'ready';
      // Auto-copy the URL — the entire point of this dialog is "click,
      // get URL". The user expects it on their clipboard the second they
      // see it.
      void copyToClipboard(inviteUrl).then((ok) => {
        if (ok) {
          copiedUrl = true;
          setTimeout(() => (copiedUrl = false), 1600);
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

  // Release the captured share-intent whenever a mint ends in error (relay
  // error OR the 15s relay-silent timeout, which emits no daemon error). Keeps
  // a stale path from bleeding into a later, unrelated share (e.g. a CLI
  // `attn review share` of a different file). The ready path already clears it
  // via `applyShareReady`.
  $effect(() => {
    if (phase === 'error') onAbort?.();
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

  async function autoMint(): Promise<void> {
    if (filePath.length === 0) return;
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
    await reviewShare(filePath, ipcMode, ttl);
    onStart?.({
      mode: selectedMode,
      ipcMode,
      ttl,
      deleteEventsAfterOwnerAck: singleDeviceOnly,
      filePath,
    });
  }

  function retryMint(): void {
    phase = 'idle';
    void autoMint();
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

  async function handleCopyUrl(): Promise<void> {
    const ok = await copyToClipboard(inviteUrl);
    if (ok) {
      copiedUrl = true;
      setTimeout(() => (copiedUrl = false), 1500);
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
  const isReady = $derived(phase === 'ready');
  const isError = $derived(phase === 'error');
</script>

<Dialog.Root bind:open>
  <Dialog.Content class="w-[min(36rem,calc(100%-2rem))] max-w-[36rem] overflow-hidden" data-slot="share-dialog">
    <Dialog.Header>
      <Dialog.Title>Share for review</Dialog.Title>
      <Dialog.Description>
        <span class="font-mono text-xs">{filePath || '(no file selected)'}</span>
      </Dialog.Description>
    </Dialog.Header>

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
      {#if isMinting}
        <div class="flex items-center gap-2 py-1.5 text-sm text-muted-foreground" data-slot="share-minting">
          <span class="inline-block size-3 animate-pulse rounded-full bg-primary/60" aria-hidden="true"></span>
          Minting room…
        </div>
      {:else if isError}
        <div class="flex flex-col gap-2 py-1.5 text-sm" data-slot="share-error">
          <span class="text-destructive">
            {shareErrorMessage || "Couldn't reach the review relay — the share didn't complete."}
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
      {:else if isReady && cliCommand.length > 0}
        <button
          type="button"
          class="block w-full overflow-hidden rounded-md border border-border bg-background px-3 py-2 text-left font-mono text-xs text-foreground hover:border-primary/60"
          data-slot="share-cli-command"
          onclick={handleCopyCli}
          title="Click to copy"
        >
          <span class="block truncate">{cliCommand}</span>
        </button>
        <Button
          type="button"
          variant="default"
          size="default"
          onclick={handleCopyCli}
          data-slot="share-copy-cli"
          class="w-full"
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
      {:else}
        <input
          type="text"
          class="rounded-md border border-border bg-background px-3 py-2 font-mono text-xs text-muted-foreground"
          readonly
          value=""
          placeholder="npx attnmd review join … (generated when the room is ready)"
          data-slot="share-cli-command"
        />
      {/if}
    </div>

    <!-- ============================================================
         Secondary card: the raw attn:// link — for reviewers who have
         attn installed and want a clickable deep-link instead of a
         terminal command.
         ============================================================ -->
    {#if isReady && inviteUrl.length > 0}
      <div class="flex w-full min-w-0 flex-col gap-2 overflow-hidden rounded-lg border border-border/60 bg-muted/30 p-4" data-slot="share-url-card">
        <div class="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          <Link class="size-3.5" aria-hidden="true" />
          Direct link
        </div>
        <button
          type="button"
          class="block w-full overflow-hidden rounded-md border border-border bg-background px-3 py-2 text-left font-mono text-xs text-foreground hover:border-primary/60"
          data-slot="share-invite-url-button"
          onclick={handleCopyUrl}
          title="Click to copy"
        >
          <span class="block truncate">{inviteUrl}</span>
        </button>
        <!-- Hidden field with the same data-slot test selectors rely on. -->
        <input
          type="text"
          class="sr-only"
          readonly
          tabindex="-1"
          aria-hidden="true"
          value={inviteUrl}
          data-slot="share-invite-url"
        />
        <Button
          type="button"
          variant="outline"
          size="default"
          onclick={handleCopyUrl}
          data-slot="share-copy-url"
          class="w-full"
        >
          {#if copiedUrl}
            <Check class="size-4" aria-hidden="true" />
            <span>Copied link</span>
          {:else}
            <Copy class="size-4" aria-hidden="true" />
            <span>Copy direct link</span>
          {/if}
        </Button>
        <p class="text-xs text-muted-foreground">
          Opens directly in attn for reviewers who already have it installed.
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

    <Dialog.Footer>
      <Button
        type="button"
        onclick={handleDone}
        disabled={isMinting}
        data-slot="share-start"
      >
        {#if isMinting}
          Minting…
        {:else}
          Done
        {/if}
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
