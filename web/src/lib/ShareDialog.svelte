<!--
  Share-for-review modal (attn-nnj.4.10).

  Per planning/collab/ui/connection-share.md §6 the share affordance is a
  modal — the form is tall (mode picker + URL + verify-key + single-device
  toggle + actions), and CLAUDE.md forbids window.confirm/alert. The §6
  field layout is the source of truth for ordering and copy.

  Fields:
    * Mode  — radio group, 4 options: Live / Async 24h / Async 7d / Hybrid.
              Async 7d picks `policy.longSession = true` implicitly
              (amendments #8). Wire format collapses to the 3 IPC values
              `live | async | hybrid` with an optional `ttl: "24h" | "7d"`.
    * URL   — read-only display. Populated after Start mints the room.
              Pre-mint we show a placeholder so the row's height stays
              stable. Copy button copies to clipboard.
    * Verify-key fingerprint — SHA-256(ownerSigningKey) → 12 hex chars,
              grouped 4-4-4 (crypto-spec.md §400-402). Owner reads this
              aloud out-of-band.
    * "I only use one device for review" checkbox — controls
              `deleteEventsAfterOwnerAck`. Default **unchecked** per
              amendments #12 (safer / default-false rule).
    * Buttons — [Cancel] dismisses; [Start] calls reviewShare(...),
              copies the URL, and closes.

  Re-share / inspect path: when `existingRoomId` is non-null the dialog
  acts as inspect-mode — mode radios disabled, [Start] becomes [Done].
  This path is wired by the parent (App.svelte) once the IPC round-trip
  returns the minted invite URL (today the IPC is fire-and-forget per
  4.10's scaffold; full URL plumbing lands in 4.13).
-->

<script lang="ts">
  import Copy from '@lucide/svelte/icons/copy';
  import Check from '@lucide/svelte/icons/check';
  import * as Dialog from './components/ui/dialog';
  import { Button } from './components/ui/button';
  import { reviewShare } from './ipc';
  import { ownerKeyFingerprint } from './review/fingerprint';
  import type { RoomId } from './types';

  // ---------------------------------------------------------------------------
  // Public surface (bound by App.svelte)
  // ---------------------------------------------------------------------------

  /**
   * The four user-visible mode choices. The first three collapse to the
   * IPC `mode: 'live' | 'async' | 'hybrid'` values; `async_7d` adds
   * `ttl: '7d'` and signals long-session (amendments #8 says picking the
   * 7-day radio sets `policy.longSession = true` implicitly).
   */
  export type ShareMode = 'live' | 'async_24h' | 'async_7d' | 'hybrid';

  interface Props {
    /** Two-way bound from parent — controls modal open state. */
    open: boolean;
    /** The file path being shared. Mandatory; the dialog cannot render without it. */
    filePath: string;
    /** Owner's public signing key (any encoding). Empty string → placeholder fingerprint. */
    ownerSigningKey?: string;
    /** Pre-populated invite URL when re-sharing an existing room. */
    existingInviteUrl?: string;
    /** When non-null, the dialog renders in inspect-mode (mode disabled, Start→Done). */
    existingRoomId?: RoomId | null;
    /** Optional clipboard override for test harnesses. Defaults to navigator.clipboard. */
    writeToClipboard?: (text: string) => Promise<void>;
    /** Optional onStart hook fired after the IPC call so parents can react. */
    onStart?: (params: ShareStartParams) => void;
  }

  /** Payload published when the user clicks Start. */
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
  // Local form state
  // ---------------------------------------------------------------------------

  let selectedMode = $state<ShareMode>('live');
  let singleDeviceOnly = $state(false);
  let copiedUrl = $state(false);
  let copiedFingerprint = $state(false);
  /**
   * Tracks the dialog's flow state. `idle` = pre-mint (mode picker visible),
   * `minting` = waiting for the Rust `ShareReady` callback, `ready` = invite
   * URL is populated and ready to copy.
   */
  let phase = $state<'idle' | 'minting' | 'ready'>('idle');

  // The displayed invite URL flows from the parent (driven by
  // `reviewStore.currentShare.inviteUrl`). When the dialog enters
  // `minting` and the prop populates, switch to `ready`.
  const inviteUrl = $derived(existingInviteUrl);
  let fingerprint = $state('—— —— ——');

  // Hydrate the dialog's flow state whenever the dialog opens.
  // Inspect-mode (existingRoomId !== null) jumps straight to `ready`.
  $effect(() => {
    if (open) {
      copiedUrl = false;
      copiedFingerprint = false;
      phase = existingRoomId !== null ? 'ready' : 'idle';
    }
  });

  // Bridge: when we're minting and the URL lands via the store, flip to
  // `ready` so the user sees the URL appear and can copy it.
  $effect(() => {
    if (phase === 'minting' && inviteUrl.length > 0) {
      phase = 'ready';
      // Best-effort clipboard write so the URL is one Cmd-V away as soon
      // as the user sees it. Failures are swallowed (no UI noise).
      void copyToClipboard(inviteUrl);
      copiedUrl = true;
      setTimeout(() => (copiedUrl = false), 1500);
    }
  });

  // Recompute the verify-key fingerprint whenever the ownerSigningKey
  // changes (or the dialog opens). Async because crypto.subtle.digest is.
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

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /** Collapse the 4-way mode picker to the 3-way IPC mode + optional ttl. */
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
      setTimeout(() => {
        copiedUrl = false;
      }, 1500);
    }
  }

  async function handleCopyFingerprint(): Promise<void> {
    const ok = await copyToClipboard(fingerprint);
    if (ok) {
      copiedFingerprint = true;
      setTimeout(() => {
        copiedFingerprint = false;
      }, 1500);
    }
  }

  async function handleStart(): Promise<void> {
    if (phase === 'ready') {
      // Mint succeeded — Start became Done. Close to dismiss.
      open = false;
      return;
    }
    if (phase === 'minting') {
      // Defensive: button is disabled during minting, but double-clicks
      // shouldn't fire reviewShare twice.
      return;
    }
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
    // Stay open; the `$effect` above flips `phase` to 'ready' when the
    // daemon's ShareReady callback populates `existingInviteUrl`.
  }

  function handleCancel(): void {
    open = false;
  }

  // Mode descriptors for the radio list. Order is the §6 design ordering.
  const modeOptions: Array<{
    value: ShareMode;
    label: string;
    helper: string;
  }> = [
    { value: 'live', label: 'Live', helper: 'realtime, peers required online' },
    { value: 'async_24h', label: 'Async 24h', helper: 'mailbox, expires in 24h' },
    { value: 'async_7d', label: 'Async 7d', helper: 'mailbox, expires in 7d (longSession)' },
    { value: 'hybrid', label: 'Hybrid', helper: 'live if possible, mailbox fallback' },
  ];

  const startLabel = $derived(
    phase === 'ready' ? 'Done' : phase === 'minting' ? 'Minting…' : 'Start',
  );
  const modeDisabled = $derived(phase !== 'idle');
  const startDisabled = $derived(filePath.length === 0 || phase === 'minting');
</script>

<Dialog.Root bind:open>
  <Dialog.Content
    class="sm:max-w-xl"
    data-slot="share-dialog"
  >
    <Dialog.Header>
      <Dialog.Title>Share for review</Dialog.Title>
      <Dialog.Description>
        File: <span class="font-mono text-xs">{filePath || '(no file selected)'}</span>
      </Dialog.Description>
    </Dialog.Header>

    <fieldset class="flex flex-col gap-2" data-slot="share-mode-group">
      <legend class="mb-1 text-sm font-medium text-foreground">Mode</legend>
      {#each modeOptions as opt (opt.value)}
        <label
          class="flex cursor-pointer items-start gap-3 rounded-md border border-border/60 bg-muted/30 p-2.5 transition-colors hover:bg-muted/60 has-[:checked]:border-primary/60 has-[:checked]:bg-accent/50 has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60"
        >
          <input
            type="radio"
            name="share-mode"
            value={opt.value}
            class="mt-1 size-4 shrink-0 accent-primary"
            data-slot="share-mode-radio"
            data-value={opt.value}
            checked={selectedMode === opt.value}
            disabled={modeDisabled}
            onchange={() => (selectedMode = opt.value)}
          />
          <div class="flex min-w-0 flex-col">
            <span class="text-sm font-medium text-foreground">{opt.label}</span>
            <span class="text-xs text-muted-foreground">{opt.helper}</span>
          </div>
        </label>
      {/each}
    </fieldset>

    <div class="flex flex-col gap-2" data-slot="share-url-row">
      <label for="share-invite-url" class="text-sm font-medium text-foreground">
        Invite URL
      </label>
      <div class="flex items-center gap-2">
        <input
          id="share-invite-url"
          type="text"
          class="flex-1 min-w-0 rounded-md border border-border bg-background px-3 py-2 font-mono text-xs text-foreground"
          readonly
          value={inviteUrl}
          placeholder="attn://review/… (generated after Start)"
          data-slot="share-invite-url"
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          onclick={handleCopyUrl}
          disabled={!inviteUrl}
          data-slot="share-copy-url"
        >
          {#if copiedUrl}
            <Check class="size-3.5" aria-hidden="true" />
            <span>Copied</span>
          {:else}
            <Copy class="size-3.5" aria-hidden="true" />
            <span>Copy</span>
          {/if}
        </Button>
      </div>
    </div>

    <div class="flex flex-col gap-2" data-slot="share-fingerprint-row">
      <label class="text-sm font-medium text-foreground" for="share-fingerprint">
        Verify-key fingerprint
      </label>
      <div class="flex items-center gap-2">
        <code
          id="share-fingerprint"
          class="flex-1 rounded-md border border-border bg-muted/40 px-3 py-2 font-mono text-sm tracking-wider text-foreground"
          data-slot="share-fingerprint"
        >{fingerprint}</code>
        <Button
          type="button"
          variant="outline"
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
      <p class="text-xs text-muted-foreground">
        Read aloud to reviewer for out-of-band verification (SHA-256 of owner key).
      </p>
    </div>

    <label
      class="flex cursor-pointer items-start gap-3 rounded-md border border-border/60 bg-muted/20 p-2.5"
      data-slot="share-single-device-row"
    >
      <input
        type="checkbox"
        class="mt-0.5 size-4 shrink-0 accent-primary"
        bind:checked={singleDeviceOnly}
        data-slot="share-single-device-toggle"
      />
      <div class="flex min-w-0 flex-col">
        <span class="text-sm font-medium text-foreground">I only use one device for review</span>
        <span class="text-xs text-muted-foreground">
          Auto-deletes mailbox events after I acknowledge them.
        </span>
      </div>
    </label>

    <Dialog.Footer>
      <Button
        type="button"
        variant="outline"
        onclick={handleCancel}
        data-slot="share-cancel"
      >
        Cancel
      </Button>
      <Button
        type="button"
        onclick={handleStart}
        disabled={startDisabled}
        data-slot="share-start"
      >
        {startLabel}
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
