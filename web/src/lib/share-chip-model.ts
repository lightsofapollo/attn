// Pure model for ShareChip.svelte — the single share-status control that
// replaced the ConnectionBadge + SharedFilesBadge + share-pill trio. Lives in
// a separate `.ts` module so tsx-based tests can import it without going
// through the .svelte compiler.
//
// The chip shows STATUS, never the transport mechanism ("mailbox",
// "DataChannel" are internal plumbing). mailbox + direct_failed both present
// as "Connected": a failed direct-link attempt is not an error to the user
// because the relay path works — only the plain-English detail differs.

import type { ReviewStatus } from './types';
import type { SharedFile } from './review/shared-tree';

export type ConnectionState = ReviewStatus['connection'];

export type ShareChipIcon = 'live' | 'connected' | 'offline';

export interface ShareChipDescriptor {
  /** User-facing status word — status, never the transport mechanism. */
  label: string;
  /** Plain-English popover line explaining what's happening. */
  detail: string;
  /** Dot / accent treatment class hook. */
  tone: 'live' | 'connected' | 'offline';
  icon: ShareChipIcon;
  /** Offer "Try a faster connection" (only when connected but not live). */
  canTryFaster: boolean;
}

export const SHARE_CHIP_DESCRIPTORS: Record<ConnectionState, ShareChipDescriptor> = {
  live_direct: {
    label: 'Live',
    detail: 'Connected live — changes appear instantly (peer-to-peer).',
    tone: 'live',
    icon: 'live',
    canTryFaster: false,
  },
  mailbox: {
    label: 'Connected',
    detail: 'Connected — changes sync through the encrypted relay, usually within a second.',
    tone: 'connected',
    icon: 'connected',
    canTryFaster: true,
  },
  direct_failed: {
    // Deliberately NOT an error state to the user — the relay path works.
    label: 'Connected',
    detail:
      'Connected through the relay. A faster peer-to-peer link wasn’t available, so changes sync in about a second.',
    tone: 'connected',
    icon: 'connected',
    canTryFaster: true,
  },
  offline: {
    label: 'Offline',
    detail: 'Offline — your changes are saved and will sync automatically when you reconnect.',
    tone: 'offline',
    icon: 'offline',
    canTryFaster: false,
  },
};

/** Safe default when no status has arrived yet. */
export function resolveConnection(
  status: ReviewStatus | null | undefined,
  fallback: ConnectionState,
): ConnectionState {
  return status?.connection ?? fallback;
}

/**
 * The chip's scope fragment — WHAT is shared. A single file shows its
 * document name; several files collapse to a count. Empty until the first
 * snapshot publishes.
 */
export function shareScopeLabel(files: readonly SharedFile[]): string {
  if (files.length === 0) return '';
  if (files.length === 1) return files[0].name;
  return `${files.length} files`;
}

/**
 * The chip's visible label. Owners lead with the verb ("Sharing") because the
 * chip is their standing disclosure of what's leaving the machine; reviewers
 * see the connection status word (they joined — scope lives in the popover).
 */
export function shareChipLabel(
  isOwner: boolean,
  descriptor: ShareChipDescriptor,
  files: readonly SharedFile[],
  hasActiveRoom: boolean,
): string {
  if (!hasActiveRoom) return 'Share';
  if (!isOwner) return descriptor.label;
  const scope = shareScopeLabel(files);
  return scope === '' ? 'Sharing' : `Sharing · ${scope}`;
}

/** Per-peer presence label — no transport jargon. */
export function peerPresenceLabel(online: boolean): 'here' | 'away' {
  return online ? 'here' : 'away';
}
