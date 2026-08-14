/* Can the person compose review feedback on this selection, and if not, why?
 * (attn-64iy.2)
 *
 * THE PROBLEM THIS REPLACES. Three separate places gave up in silence when
 * composing was impossible:
 *
 *   - `refreshSelectionToolbar` cleared the toolbar entirely if no snapshot was
 *     resolvable, so the user highlighted text and no control appeared at all;
 *   - `openCommentComposer` returned bare on a missing snapshot;
 *   - `openSuggestionComposer` returned bare on the wrong grant tier.
 *
 * The reported symptom — "I highlight text but nothing appears" — is what all
 * three look like from outside, and it is indistinguishable from a broken
 * build. A person who selects text inside a review room has done everything
 * right; if the answer is no, the product owes them the reason.
 *
 * This module is the reason, resolved once and spent by every entry point, so
 * the toolbar, the keyboard shortcut and the composer cannot disagree about
 * why an action is unavailable.
 *
 * The distinction that matters is TRANSIENT vs STRUCTURAL. A snapshot still in
 * flight resolves itself in a moment and must read as pending — disabling it
 * with a flat "unavailable" would be a lie the next second. A file outside the
 * share, or an invite without the grant, will not change on its own and must
 * read as blocked. Same discipline as attn-vlmz.1.2 (no pending state may
 * outlive its deadline) and attn-bw2h.6 (a mint that cannot finish says so).
 */

export type ComposeKind = 'comment' | 'suggest';

export type ComposeAvailability =
  /** Go ahead. */
  | { status: 'ready' }
  /** Not yet, but by itself — show a waiting affordance, not a dead one. */
  | { status: 'pending'; reason: string }
  /** Not from here — show a disabled affordance carrying the reason. */
  | { status: 'blocked'; reason: string }
  /** There is no review context at all; the affordance should not exist. */
  | { status: 'absent' };

/** Everything the decision reads, lifted out of the store for testability. */
export interface ComposeContext {
  /** A review room is active. Without one there is nothing to compose into. */
  hasRoom: boolean;
  /**
   * The room holds at least one snapshot. False means the share is still
   * landing — the room mints before its snapshots arrive — which is a wait,
   * not a refusal.
   */
  roomHasSnapshot: boolean;
  /** A snapshot exists for the document currently on screen. */
  fileHasSnapshot: boolean;
  /**
   * That snapshot carries an anchor index. A pointer snapshot exists before
   * its payload is hydrated, and an anchor cannot be authored against one.
   */
  fileSnapshotHasAnchors: boolean;
  /** HTML has no Markdown anchor index; this capability means its sandboxed
   * document runtime can author selector anchors instead. */
  fileSnapshotHasHtmlSelectors?: boolean;
  /** What this device's invite permits. */
  grantTier: 'comment' | 'suggest';
}

export const COMPOSE_PREPARING =
  'Preparing this document for review — one moment.';
export const COMPOSE_FILE_NOT_SHARED =
  'This file is not part of the share, so there is nothing for a comment to attach to. Share it to review it.';
export const COMPOSE_SUGGEST_NOT_GRANTED =
  'Your invite allows comments, not edits, so suggestions are unavailable.';
export const COMPOSE_HTML_SUGGEST_UNSUPPORTED =
  'Suggestions are unavailable for HTML documents; add a comment instead.';
/**
 * HTML's version of "there is no review context at all".
 *
 * Markdown reports that as `absent` and simply hides its toolbar, because the
 * selection toolbar is the affordance. An HTML document's affordances live
 * inside a frame the shell cannot reach into, so it cannot hide them — the
 * refusal has to be spoken instead.
 */
export const COMPOSE_HTML_SHARE_FIRST =
  'Share this HTML file to start a review before commenting.';
/**
 * The snapshot is here and hydrated, but it never declared the annotation
 * capability — it was published by a build that could not author selector
 * anchors. Structural, not transient: reporting it as "preparing" promises a
 * wait that will never end.
 */
export const COMPOSE_HTML_NOT_ANNOTATABLE =
  'This shared copy was published without comment support. Share it again to enable commenting.';

/**
 * Resolve whether `kind` can be composed right now.
 *
 * Ordering is deliberate. The grant tier is checked BEFORE the snapshot state
 * for suggestions: a reviewer without the suggest grant should be told that
 * plainly rather than watching a spinner that would never have led anywhere.
 */
export function resolveComposeAvailability(
  kind: ComposeKind,
  ctx: ComposeContext,
): ComposeAvailability {
  if (!ctx.hasRoom) return { status: 'absent' };

  if (kind === 'suggest' && ctx.grantTier !== 'suggest') {
    return { status: 'blocked', reason: COMPOSE_SUGGEST_NOT_GRANTED };
  }

  if (kind === 'suggest' && ctx.fileSnapshotHasHtmlSelectors) {
    return { status: 'blocked', reason: COMPOSE_HTML_SUGGEST_UNSUPPORTED };
  }

  // No snapshot anywhere in the room: the share is still completing. This is
  // the state the browser dev loop was permanently stuck in before
  // attn-64iy.1, and reading it as "not shared" would have been wrong — the
  // file WAS shared; nothing had published it yet.
  if (!ctx.roomHasSnapshot) return { status: 'pending', reason: COMPOSE_PREPARING };

  if (!ctx.fileHasSnapshot) {
    return { status: 'blocked', reason: COMPOSE_FILE_NOT_SHARED };
  }

  // Snapshot known but not yet hydrated — its blob is still arriving.
  if (!ctx.fileSnapshotHasAnchors && !ctx.fileSnapshotHasHtmlSelectors) {
    return { status: 'pending', reason: COMPOSE_PREPARING };
  }

  return { status: 'ready' };
}

/** Should the selection toolbar be on screen at all? */
export function toolbarShouldRender(comment: ComposeAvailability): boolean {
  return comment.status !== 'absent';
}

/** Short label for a control in this state. `null` keeps the normal label. */
export function composeButtonHint(availability: ComposeAvailability): string | null {
  switch (availability.status) {
    case 'pending':
      return availability.reason;
    case 'blocked':
      return availability.reason;
    default:
      return null;
  }
}
