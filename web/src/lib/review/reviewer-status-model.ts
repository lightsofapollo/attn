// Pure presentation model for ReviewerStatusChip.svelte — the reviewer
// surface's single status control. Lives in a plain `.ts` module so tsx-based
// contract tests can import it without the Svelte compiler (same pattern as
// `share-chip-model.ts`, whose connection descriptors it reuses).
//
// Everything transient about a review session — outbox pending, owner away,
// a sync failure — used to render as inline text in a wrap-prone header row,
// which reflowed the whole document column every time a comment was posted.
// This model folds all of it into ONE fixed-size chip presentation: a status
// word plus popover lines. The chip never changes size; the header never
// reflows; the document never jumps.

import { SHARE_CHIP_DESCRIPTORS, type ConnectionState } from '../share-chip-model';

export type ReviewerStatusTone = 'live' | 'connected' | 'offline' | 'attention';

export interface ReviewerStatusInput {
  connection: ConnectionState;
  /** Authenticated owner-device presence — separate from relay connectivity. */
  ownerOnline: boolean;
  /** Sealed envelopes waiting for relay acknowledgement. */
  outboxPending: number;
  /** Last authoring transport error, or null when delivery is healthy. */
  authoringError: string | null;
  /** True once the first snapshot rendered (gates the owner-away note). */
  hasSnapshot: boolean;
  /** Signed ParticipantJoined acknowledged — authoring is available. */
  authoringReady: boolean;
  grantTier: 'view' | 'comment' | 'suggest';
}

export interface ReviewerStatusPresentation {
  /** Chip word — status, never the transport mechanism. */
  label: string;
  /** Plain-English popover headline for the current state. */
  detail: string;
  tone: ReviewerStatusTone;
  /** Secondary popover lines (owner away, feedback waiting to send). */
  notes: string[];
  /** Offer a "Retry sending" action in the popover. */
  canRetry: boolean;
}

export function reviewerStatusPresentation(
  input: ReviewerStatusInput,
): ReviewerStatusPresentation {
  const notes: string[] = [];
  if (input.outboxPending > 0) {
    notes.push(
      `${input.outboxPending} ${input.outboxPending === 1 ? 'item' : 'items'} of feedback waiting to send`,
    );
  }
  if (input.hasSnapshot && !input.ownerOnline) {
    notes.push('The owner is away — your feedback is delivered when they return.');
  }
  if (input.grantTier !== 'view' && !input.authoringReady && input.authoringError === null) {
    notes.push('Preparing encrypted authoring…');
  }

  if (input.authoringError !== null) {
    return {
      label: 'Sync issue',
      detail: 'Some feedback could not be sent. It is kept on this device — retry below.',
      tone: 'attention',
      notes,
      canRetry: true,
    };
  }

  const base = SHARE_CHIP_DESCRIPTORS[input.connection];
  return {
    label: base.label,
    detail:
      input.connection === 'offline'
        ? 'Offline — feedback you write is kept and sends when you reconnect.'
        : base.detail,
    tone: base.tone,
    notes,
    canRetry: false,
  };
}

/** User-facing access-tier label (shown in the chip popover). */
export function reviewerTierLabel(tier: 'view' | 'comment' | 'suggest'): string {
  switch (tier) {
    case 'view':
      return 'View only';
    case 'comment':
      return 'Can comment';
    case 'suggest':
      return 'Can comment and suggest edits';
  }
}
