<!--
  ReviewerStatusChip — the reviewer surface's single status control.

  Replaces the old wrap-prone header text cluster (tier words, remember /
  forget buttons, push consent, connection status, owner-offline note, outbox
  indicator). Those inline fragments changed the header's height whenever one
  appeared — which reflowed the whole document column and made the page jump
  on every posted comment. This chip is fixed-size; everything transient
  lives in its popover.

  Chip:    [·] Connected          (dot carries tone; label from the model)
  Popover: status detail + notes → your access → this link (remember /
           notifications) → retry action when delivery failed.

  Same self-positioned popover pattern as ShareChip.svelte (no portal — see
  that file's rationale). Presentation logic is pure in
  review/reviewer-status-model.ts.
-->

<script lang="ts">
  import CloudOff from '@lucide/svelte/icons/cloud-off';
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
  import Wifi from '@lucide/svelte/icons/wifi';
  import Zap from '@lucide/svelte/icons/zap';
  import type { BrowserPushConsentState } from './review/browser-push-consent';
  import { userProfile } from './profile.svelte';
  import {
    reviewerTierLabel,
    type ReviewerStatusPresentation,
  } from './review/reviewer-status-model';

  interface Props {
    presentation: ReviewerStatusPresentation;
    tier: 'view' | 'comment' | 'suggest';
    /** Session persistence for the remember/forget affordance. */
    persistence: 'ephemeral' | 'saving' | 'remembered' | 'degraded';
    canRemember: boolean;
    pushCapable: boolean;
    pushConsent: BrowserPushConsentState;
    /** Setup-time collab failure surfaced by the gate (rare, terminal). */
    collabError?: string | null;
    onRememberRoom?: () => void;
    onForgetRoom?: () => void;
    onTogglePush?: () => void;
    onRetryOutbox?: () => void;
  }

  let {
    presentation,
    tier,
    persistence,
    canRemember,
    pushCapable,
    pushConsent,
    collabError = null,
    onRememberRoom,
    onForgetRoom,
    onTogglePush,
    onRetryOutbox,
  }: Props = $props();

  let popoverOpen = $state(false);

  const attention = $derived(presentation.tone === 'attention');
  const offline = $derived(presentation.tone === 'offline');

  function handleKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape' && popoverOpen) {
      event.preventDefault();
      popoverOpen = false;
    }
  }
</script>

<svelte:window onkeydown={handleKeyDown} />

<div class="reviewer-status relative inline-flex shrink-0" data-slot="reviewer-status-root">
  <button
    type="button"
    class="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border px-2.5 font-sans text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50
      {attention
        ? 'border-destructive/40 bg-destructive/5 text-destructive hover:bg-destructive/10'
        : offline
          ? 'border-border/60 bg-muted/20 text-muted-foreground/80 hover:bg-muted/40'
          : 'border-primary/30 bg-primary/5 text-primary hover:bg-primary/10'}"
    data-slot="reviewer-status-chip"
    data-tone={presentation.tone}
    aria-haspopup="dialog"
    aria-expanded={popoverOpen}
    aria-label="Review session status: {presentation.label}"
    title={presentation.detail}
    onclick={() => (popoverOpen = !popoverOpen)}
  >
    <span
      class="size-1.5 shrink-0 rounded-full
        {attention ? 'bg-destructive' : offline ? 'bg-muted-foreground/70' : 'bg-primary'}
        {presentation.tone === 'live' ? 'reviewer-status-dot-live' : ''}"
      aria-hidden="true"
    ></span>
    <span data-slot="reviewer-status-label">{presentation.label}</span>
  </button>

  {#if popoverOpen}
    <button
      type="button"
      class="fixed inset-0 z-50 cursor-default bg-transparent"
      data-slot="reviewer-status-shield"
      aria-label="Close session details"
      onclick={() => (popoverOpen = false)}
    ></button>

    <div
      class="attn-chrome absolute right-0 top-full z-[60] mt-1 w-80 rounded-lg border border-border bg-popover text-popover-foreground shadow-md"
      data-slot="reviewer-status-popover"
      role="dialog"
      aria-label="Review session details"
    >
      <header class="flex items-start gap-2 px-3 pb-2.5 pt-3">
        {#if attention}
          <TriangleAlert class="mt-0.5 size-3.5 shrink-0 text-destructive" aria-hidden="true" />
        {:else if presentation.tone === 'live'}
          <Zap class="mt-0.5 size-3.5 shrink-0 text-primary" aria-hidden="true" />
        {:else if presentation.tone === 'connected'}
          <Wifi class="mt-0.5 size-3.5 shrink-0 text-primary" aria-hidden="true" />
        {:else}
          <CloudOff class="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        {/if}
        <div class="min-w-0">
          <p class="text-sm font-medium {attention ? 'text-destructive' : offline ? 'text-muted-foreground' : 'text-primary'}">
            {presentation.label}
          </p>
          <p class="pt-0.5 text-xs text-muted-foreground" data-slot="reviewer-status-detail">
            {presentation.detail}
          </p>
          {#each presentation.notes as note (note)}
            <p class="pt-1 text-[11px] text-muted-foreground" data-slot="reviewer-status-note">{note}</p>
          {/each}
          {#if collabError}
            <p class="pt-1 text-[11px] text-destructive" role="status" data-slot="reviewer-status-collab-error">
              {collabError}
            </p>
          {/if}
        </div>
      </header>

      <section class="border-t border-border/50 px-3 py-2.5" aria-label="Your access">
        {#if tier !== 'view'}
          <div class="flex items-center justify-between gap-2 pb-1" data-slot="reviewer-status-identity">
            <p class="min-w-0 truncate text-[11px] text-muted-foreground">
              Commenting as
              <span class="font-medium text-foreground" data-slot="reviewer-status-self-name">
                {userProfile.displayName ?? 'Browser reviewer'}
              </span>
            </p>
            <button
              type="button"
              class="shrink-0 rounded-md px-2 py-0.5 text-[11px] font-medium text-muted-foreground hover:bg-muted"
              data-slot="reviewer-status-edit-name"
              onclick={() => {
                userProfile.requestEdit();
                popoverOpen = false;
              }}
            >
              Edit
            </button>
          </div>
        {/if}
        <p class="text-[11px] text-muted-foreground">
          Your access:
          <span class="font-medium text-foreground" data-slot="browser-grant-tier">{reviewerTierLabel(tier)}</span>
        </p>
        <p class="pt-0.5 text-[11px] text-muted-foreground">End-to-end encrypted — the relay only sees ciphertext.</p>
      </section>

      {#if tier !== 'view'}
        <section class="border-t border-border/50 px-3 py-2.5" aria-label="This link">
          {#if !canRemember}
            <p class="text-[11px] text-muted-foreground">
              {pushCapable && pushConsent.enabled
                ? 'Remembered for notifications.'
                : 'Keep this link to come back to the review.'}
            </p>
          {:else if persistence === 'ephemeral'}
            <div class="flex items-center justify-between gap-2">
              <p class="min-w-0 text-[11px] text-muted-foreground">Temporary on this browser</p>
              <button
                type="button"
                class="shrink-0 rounded-md border border-border bg-background px-2 py-0.5 text-[11px] font-medium text-foreground hover:bg-muted"
                data-slot="browser-remember-room"
                title="Store a non-extractable room key and encrypted recovery state in this browser profile"
                onclick={() => onRememberRoom?.()}
              >
                Remember this room
              </button>
            </div>
          {:else if persistence === 'saving'}
            <p class="text-[11px] text-muted-foreground" role="status">Securing local recovery…</p>
          {:else}
            <div class="flex items-center justify-between gap-2">
              <p class="min-w-0 text-[11px] text-muted-foreground">
                {persistence === 'degraded'
                  ? 'Remembered; browser may evict local data'
                  : 'Remembered on this browser'}
              </p>
              <button
                type="button"
                class="shrink-0 rounded-md px-2 py-0.5 text-[11px] font-medium text-muted-foreground hover:bg-muted"
                data-slot="browser-forget-room"
                onclick={() => onForgetRoom?.()}
              >
                Forget
              </button>
            </div>
          {/if}
          {#if pushCapable}
            <div class="mt-1.5 flex items-center justify-between gap-2">
              <p class="min-w-0 text-[11px] text-muted-foreground">Notify me about replies</p>
              <button
                type="button"
                role="switch"
                aria-checked={pushConsent.enabled}
                aria-describedby={pushConsent.message ? 'browser-push-message' : undefined}
                class="shrink-0 rounded-md border border-border bg-background px-2 py-0.5 text-[11px] font-medium text-foreground hover:bg-muted disabled:cursor-wait disabled:opacity-60"
                data-slot="browser-push-toggle"
                data-push-status={pushConsent.status}
                disabled={pushConsent.status === 'checking' || pushConsent.status === 'enabling' || pushConsent.status === 'disabling'}
                onclick={() => onTogglePush?.()}
              >
                {pushConsent.status === 'on'
                  ? 'On'
                  : pushConsent.status === 'enabling'
                    ? 'Enabling…'
                    : pushConsent.status === 'disabling'
                      ? 'Turning off…'
                      : pushConsent.status === 'install_hint'
                        ? 'Install to enable'
                        : pushConsent.enabled
                          ? 'Retry turning off'
                          : 'Turn on'}
              </button>
            </div>
            {#if pushConsent.message}
              <p
                id="browser-push-message"
                class="pt-1 text-[11px] {pushConsent.status === 'error' || pushConsent.status === 'denied' ? 'text-destructive' : 'text-muted-foreground'}"
                role="status"
                data-slot="browser-push-message"
              >{pushConsent.message}</p>
            {/if}
          {/if}
        </section>
      {/if}

      {#if presentation.canRetry}
        <footer class="flex items-center justify-end border-t border-border/50 px-3 py-2">
          <button
            type="button"
            class="rounded-md border border-border bg-background px-2.5 py-1 text-[11px] font-medium text-foreground hover:bg-muted"
            data-slot="reviewer-status-retry"
            onclick={() => {
              onRetryOutbox?.();
              popoverOpen = false;
            }}
          >
            Retry sending
          </button>
        </footer>
      {/if}
    </div>
  {/if}
</div>

<style>
  /* Live = instant peer-to-peer: one soft ring conveys the state change
     without ambient animation (mirrors ShareChip). */
  .reviewer-status-dot-live {
    box-shadow: 0 0 0 3px color-mix(in oklch, var(--primary, currentColor) 20%, transparent);
  }
</style>
