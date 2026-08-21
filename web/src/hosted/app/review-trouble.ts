/**
 * Plain-language names for the states that interrupt a live review.
 *
 * The runtime records `reason: errorMessage(error)` at every failure site, so
 * whatever an internal invariant happened to throw became the sentence the user
 * read. The owner reported two of them verbatim:
 *
 *   "Live review is paused.  browser owner publication outbox is unavailable"
 *   "Live sharing is unavailable.  published source revision moved before
 *    promotion. Your document is safe on this device."
 *
 * Both are engineering assertions. Neither names a thing the reader did, could
 * do, or should worry about, and the second one describes a condition that
 * clears itself.
 *
 * The classification lives HERE rather than in the runtime deliberately. The
 * raw string stays exactly as it is in `state.reason` — several runtime tests
 * assert on it, it is what a bug report needs, and rewording an invariant at
 * its throw site is how error strings stop matching the code that throws them.
 * This module is the presentation layer's reading of that string.
 */

export type ReviewTroubleKind =
  /** The workspace head moved while a publish was in flight — you kept typing. */
  | 'catching-up'
  /** The room is up but this tab has not finished attaching to it. */
  | 'reconnecting'
  /** The relay dropped the room; it can be re-provisioned under the same link. */
  | 'room-expired'
  /** Comments/edits are queued locally and the send is failing. */
  | 'delivery'
  /** Anything unclassified — say so honestly rather than guessing. */
  | 'unknown';

export interface ReviewTrouble {
  kind: ReviewTroubleKind;
  /** Header control text. Short enough to sit beside Share without crowding. */
  chip: string;
  title: string;
  /** One or two sentences: what happened, and what is true about their work. */
  body: string;
  /**
   * True when waiting is a real fix. Transient trouble is reported as activity
   * rather than as failure — a spinner's worth of news, not an alarm.
   */
  transient: boolean;
  /** The engine's own words, for the dialog's technical disclosure. */
  detail: string | null;
}

/**
 * The stage/commit consistency gates in `browser-workspace-share.ts` that mean
 * "the live workspace head advanced past the staged source revision" — the
 * strings are duplicated from `PUBLICATION_HEAD_MOVED_CONFLICTS` in
 * browser-owner-workspace-runtime.ts on purpose: this module must not import
 * the runtime (it is loaded by chrome that renders before any review exists),
 * and a copy that drifts degrades to `unknown`, which is safe.
 */
const HEAD_MOVED = [
  'published source revision moved before promotion',
  'published source revision is no longer a live workspace head',
  'published source revision is not a live workspace head',
  'published source revision moved or mismatches content',
];

const NOT_SHARING = 'Your document is safe on this device, and everything you write is still saved here.';

export function describeReviewTrouble(
  reason: string | null | undefined,
  options: {
    sharing: boolean;
    deliveryFailing?: boolean;
    /**
     * The runtime stopped retrying — it dropped the room and parked in `error`.
     * This flips the self-healing states to terminal ones, because a state that
     * nothing is working on is not "in progress" however transient its CAUSE
     * was. Telling someone to wait for a retry that will never come is the
     * worse failure of the two.
     */
    exhausted?: boolean;
  } = { sharing: true },
): ReviewTrouble {
  const raw = reason?.trim() ?? '';
  const detail = raw.length > 0 ? raw : null;
  const exhausted = options.exhausted === true;

  if (HEAD_MOVED.some((message) => raw.includes(message))) {
    if (exhausted) {
      return {
        kind: 'catching-up',
        chip: 'Sharing stopped',
        title: 'Sharing stopped while catching up with your edits',
        transient: false,
        detail,
        body:
          'Every attempt to publish the shared copy lost to a newer edit, so attn stopped rather than publish a version you had already changed. '
          + 'Reloading publishes what you have now. Nothing is lost, and no reviewer has seen a half-written version.',
      };
    }
    return {
      kind: 'catching-up',
      chip: 'Catching up',
      title: 'Catching up with your latest edits',
      transient: true,
      detail,
      body:
        'You kept writing while the shared copy was being published, so the publish restarted against your newer version. '
        + 'This finishes on its own once you pause for a moment. Nothing is lost and no one has seen a half-written version.',
    };
  }

  if (raw.includes('publication outbox is unavailable') || raw.includes('authoring')) {
    if (exhausted) {
      return {
        kind: 'reconnecting',
        chip: 'Not connected',
        title: 'Could not reach the review room',
        transient: false,
        detail,
        body: `attn gave up attaching this tab to the review relay. Reloading tries again from a clean start. ${NOT_SHARING}`,
      };
    }
    return {
      kind: 'reconnecting',
      chip: 'Reconnecting',
      title: 'Still connecting to the review room',
      transient: true,
      detail,
      body:
        `This tab has not finished attaching to the review relay, so comments and edits are queued rather than sent. ${NOT_SHARING}`,
    };
  }

  if (raw.startsWith('The review room expired') || raw.includes('room expired')) {
    return {
      kind: 'room-expired',
      chip: 'Review expired',
      title: 'The review room expired',
      transient: false,
      detail,
      body:
        `The relay retires idle rooms. Restarting rebuilds it under the same link, so the people you shared with do not need a new one. ${NOT_SHARING}`,
    };
  }

  if (options.deliveryFailing) {
    return {
      kind: 'delivery',
      chip: 'Not sending',
      title: 'Comments are not reaching the relay',
      transient: false,
      detail,
      body:
        `Your comments are recorded on this device and will send once the connection recovers. ${NOT_SHARING}`,
    };
  }

  return {
    kind: 'unknown',
    chip: options.sharing ? 'Review paused' : 'Sharing paused',
    title: options.sharing ? 'Live review is paused' : 'Live sharing is unavailable',
    transient: false,
    detail,
    body:
      `The review connection stopped and did not say why in terms this screen can explain. ${NOT_SHARING} `
      + 'The technical detail below is what to include if you report this.',
  };
}
