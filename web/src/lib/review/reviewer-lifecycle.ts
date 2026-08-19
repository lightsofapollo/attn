import type { BrowserSessionError } from './browser-session';

/**
 * The user-facing contract for the hosted reviewer lifecycle. Transport and
 * capability failures deliberately retain their machine-readable tag in
 * BrowserSession; this is the one place that translates it into a useful
 * next step without exposing a relay response or a link fragment.
 */
export interface ReviewerLifecyclePresentation {
  title: string;
  diagnosis: string;
  /** The only cases where re-entering a complete capability can recover. */
  canPasteInvite: boolean;
  /** A reload is meaningful only for transient connection setup failures. */
  canRetry: boolean;
  /** A calm, factual privacy reminder relevant to this state. */
  privacyNote: string;
}

export function reviewerLifecyclePresentation(
  error: Pick<BrowserSessionError, 'kind'> | null | undefined,
): ReviewerLifecyclePresentation {
  if (!error) {
    return {
      title: 'Opening your review',
      diagnosis: 'Checking the invitation and recovering the encrypted review material.',
      canPasteInvite: false,
      canRetry: false,
      privacyNote: 'The room key stays in this browser. The relay only handles ciphertext.',
    };
  }

  switch (error.kind) {
    case 'invite_invalid':
      return {
        title: 'This review link is incomplete',
        diagnosis: 'Paste the complete link you received, including the part after #.',
        canPasteInvite: true,
        canRetry: false,
        privacyNote: 'That room key stays in your browser and is never sent to the relay.',
      };
    case 'admission_rejected':
      return {
        title: 'This link no longer has access',
        diagnosis: 'Ask the person who shared the review to send you a new link.',
        canPasteInvite: false,
        canRetry: false,
        privacyNote: 'No document content was opened with this link.',
      };
    case 'room_deleted':
      return {
        title: 'This review is no longer available',
        diagnosis: 'The owner removed this review. Ask them if you need a new invitation.',
        canPasteInvite: false,
        canRetry: false,
        privacyNote: 'No document content was opened with this link.',
      };
    case 'room_expired':
      return {
        title: 'This review link has expired',
        diagnosis: 'Ask the person who shared it to send a fresh link.',
        canPasteInvite: false,
        canRetry: false,
        privacyNote: 'The room key remains in your browser and is never sent to the relay.',
      };
    case 'cursor_too_old':
      return {
        title: 'Open this review from its original link',
        diagnosis: 'This browser needs the complete link again to resume the review.',
        canPasteInvite: true,
        canRetry: false,
        privacyNote: 'The room key stays in your browser and is never sent to the relay.',
      };
    case 'share_revoked':
      return {
        title: 'This review has ended',
        diagnosis: 'The owner has stopped sharing this review. Ask them if you need a new invitation.',
        canPasteInvite: false,
        canRetry: false,
        privacyNote: 'No new review content will be opened from this link.',
      };
    case 'device_register':
      return {
        // Sentence-initial "Attn" was the only place the brand took a capital
        // (attn-08fa.8); the product is lowercase everywhere else, so the fix is
        // to recast rather than to capitalise a name that has no capital.
        title: 'This review could not be opened',
        diagnosis: 'Check your connection, then paste the complete review link to try again.',
        canPasteInvite: true,
        canRetry: true,
        privacyNote: 'The room key stays in your browser. The relay only handles ciphertext.',
      };
    case 'network':
    default:
      return {
        title: 'This review can’t be reached right now',
        diagnosis: 'Check your connection, then paste the complete review link to try again.',
        canPasteInvite: true,
        canRetry: true,
        privacyNote: 'The room key stays in your browser. The relay only handles ciphertext.',
      };
  }
}
