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
    writeToClipboard?: (text: string) => Promise<void>;
    onStart?: (params: ShareStartParams) => void;
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
    writeToClipboard,
    onStart,
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
  let phase = $state<'idle' | 'minting' | 'ready'>('idle');
  let fingerprint = $state('—— —— ——');

  const inviteUrl = $derived(existingInviteUrl);
  /**
   * One-liner the reviewer can paste into a terminal if their browser
   * doesn't route `attn://` (no installed bundle, headless host, etc.).
   * Single-quoted so the `#` fragment doesn't get eaten by the shell.
   */
  const cliCommand = $derived(
    inviteUrl.length > 0
      ? `attn review join '${inviteUrl}' --as-agent reviewer`
      : '',
  );

  // Auto-mint on first open when no share exists yet.
  $effect(() => {
    if (!open) return;
    copiedUrl = false;
    copiedCli = false;
    copiedFingerprint = false;
    if (existingRoomId !== null && existingInviteUrl.length > 0) {
      phase = 'ready';
      return;
    }
    if (phase === 'idle') {
      void autoMint();
    }
  });

  // Transition minting → ready when the daemon's ShareReady IPC lands.
  $effect(() => {
    if (phase === 'minting' && inviteUrl.length > 0) {
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
    phase = 'minting';
    await reviewShare(filePath, ipcMode, ttl);
    onStart?.({
      mode: selectedMode,
      ipcMode,
      ttl,
      deleteEventsAfterOwnerAck: singleDeviceOnly,
      filePath,
    });
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
</script>

<Dialog.Root bind:open>
  <Dialog.Content class="sm:max-w-xl" data-slot="share-dialog">
    <Dialog.Header>
      <Dialog.Title>Share for review</Dialog.Title>
      <Dialog.Description>
        <span class="font-mono text-xs">{filePath || '(no file selected)'}</span>
      </Dialog.Description>
    </Dialog.Header>

    <!-- ============================================================
         Primary card: the URL. This is the whole point of the dialog.
         ============================================================ -->
    <div
      class="flex flex-col gap-2 rounded-lg border border-primary/40 bg-primary/5 p-4 transition-colors"
      data-slot="share-url-card"
    >
      <div class="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        <Link class="size-3.5" aria-hidden="true" />
        Reviewer link
      </div>
      {#if isMinting}
        <div class="flex items-center gap-2 py-1.5 text-sm text-muted-foreground" data-slot="share-minting">
          <span class="inline-block size-3 animate-pulse rounded-full bg-primary/60" aria-hidden="true"></span>
          Minting room…
        </div>
      {:else if isReady && inviteUrl.length > 0}
        <!-- The URL itself is the headline — click anywhere on it to
             select + auto-copy. The explicit Copy button sits below as a
             primary CTA so it can't be clipped on narrow viewports. -->
        <button
          type="button"
          class="block w-full overflow-hidden rounded-md border border-border bg-background px-3 py-2 text-left font-mono text-xs text-foreground hover:border-primary/60 hover:bg-background"
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
          variant={copiedUrl ? 'default' : 'default'}
          size="default"
          onclick={handleCopyUrl}
          data-slot="share-copy-url"
          class="w-full"
        >
          {#if copiedUrl}
            <Check class="size-4" aria-hidden="true" />
            <span>Copied to clipboard</span>
          {:else}
            <Copy class="size-4" aria-hidden="true" />
            <span>Copy reviewer link</span>
          {/if}
        </Button>
        <p class="text-xs text-muted-foreground">
          Send this to anyone you want to review with. They'll join over an end-to-end
          encrypted channel — no account, no signup.
        </p>
      {:else}
        <input
          type="text"
          class="rounded-md border border-border bg-background px-3 py-2 font-mono text-xs text-muted-foreground"
          readonly
          value=""
          placeholder="attn://review/… (generated after Start)"
          data-slot="share-invite-url"
        />
      {/if}
    </div>

    <!-- ============================================================
         Secondary card: CLI fallback for headless reviewers / agents.
         ============================================================ -->
    {#if isReady && cliCommand.length > 0}
      <div class="flex flex-col gap-2 rounded-lg border border-border/60 bg-muted/30 p-4" data-slot="share-cli-card">
        <div class="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          <Terminal class="size-3.5" aria-hidden="true" />
          Terminal command
        </div>
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
          variant="outline"
          size="default"
          onclick={handleCopyCli}
          data-slot="share-copy-cli"
          class="w-full"
        >
          {#if copiedCli}
            <Check class="size-4" aria-hidden="true" />
            <span>Copied command</span>
          {:else}
            <Copy class="size-4" aria-hidden="true" />
            <span>Copy terminal command</span>
          {/if}
        </Button>
        <p class="text-xs text-muted-foreground">
          For AI agents, automation, or anyone whose browser doesn't open <code>attn://</code> links.
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
