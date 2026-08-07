/**
 * Phase → presentation rules for the share sheet (attn-vlmz.1.2).
 *
 * Extracted from ShareDialog.svelte so the rule that matters can be tested
 * without mounting the component (tsx evaluates `.svelte` as bare TypeScript,
 * so runes-backed state is unreachable from the unit suite).
 *
 * The rule: **'ready' is a claim, not a state** — and the claim is only true
 * when there is an invite URL the owner can actually send. The old component
 * treated the two as independent: `phase` could reach 'ready' while
 * `inviteUrl` was still empty, the template fell through to its loading
 * skeleton, and nothing could ever clear it — the mint timeout returns early
 * unless the phase is still 'minting'. The visible result was three pulsing
 * rows labelled "View link / Comment link / Suggest link" that never
 * resolved and never explained themselves.
 *
 * So the component no longer renders `phase` directly. It renders the phase
 * this module resolves, which collapses ready-without-an-invite into an
 * explicit error (the error branch already carries a retry button). That
 * makes the stuck skeleton unrepresentable rather than merely unlikely.
 */

export type SharePhase = 'configure' | 'minting' | 'ready' | 'error';

/** Shown when the daemon reported a failure but sent no message of its own. */
export const RELAY_ERROR_MESSAGE =
  "Couldn't reach the review relay — the share didn't complete. Nothing left this machine.";

/**
 * Shown when the mint "succeeded" but produced nothing sendable. Deliberately
 * does not claim the relay failed: we don't know that it did, only that there
 * is no link, which is just as unusable for the owner.
 */
export const EMPTY_INVITE_MESSAGE =
  'The share finished without an invite link, so there is nothing to send yet. Nothing left this machine.';

/**
 * What the primary card offers the owner.
 *
 * - `command` — the zero-install `npx attnmd review join …` one-liner.
 * - `link`    — the invite URL itself. The hosted build mints an HTTPS invite
 *               without an `attn://` URL, and the CLI one-liner is built from
 *               the `attn://` form only; before this the card kept showing
 *               "Minting room…" forever in exactly that case.
 * - `pending` — nothing to copy yet (configure/minting/error).
 */
export type PrimaryShareKind = 'command' | 'link' | 'pending';

export interface PrimaryShareAction {
  kind: PrimaryShareKind;
  /** Empty only when `kind === 'pending'`. */
  text: string;
}

export interface SharePresentationInput {
  /** The component's raw phase state. */
  phase: SharePhase;
  /** Best available invite URL (hosted HTTPS preferred over `attn://`). */
  inviteUrl: string;
  /** The `npx attnmd review join …` one-liner, or '' when unavailable. */
  cliCommand: string;
  /** Latest daemon-reported share failure, or ''. */
  daemonErrorMessage: string;
}

export interface SharePresentation {
  /** Never 'ready' unless there is a usable invite URL. */
  phase: SharePhase;
  /** Non-empty exactly when `phase === 'error'`. */
  errorMessage: string;
  primary: PrimaryShareAction;
}

/**
 * Resolve the phase the sheet may actually render. 'ready' without an invite
 * URL is a failed mint wearing a success costume, so it degrades to 'error'.
 */
export function resolveSharePhase(phase: SharePhase, inviteUrl: string): SharePhase {
  if (phase === 'ready' && inviteUrl.length === 0) return 'error';
  return phase;
}

/** The single decision the template consumes. Pure; safe to call in `$derived`. */
export function resolveSharePresentation(input: SharePresentationInput): SharePresentation {
  const phase = resolveSharePhase(input.phase, input.inviteUrl);

  if (phase === 'error') {
    // A daemon message is always more specific than either default, so it
    // wins even when the trigger was the empty invite.
    const errorMessage =
      input.daemonErrorMessage.length > 0
        ? input.daemonErrorMessage
        : input.phase === 'ready'
          ? EMPTY_INVITE_MESSAGE
          : RELAY_ERROR_MESSAGE;
    return { phase, errorMessage, primary: { kind: 'pending', text: '' } };
  }

  if (phase !== 'ready') {
    return { phase, errorMessage: '', primary: { kind: 'pending', text: '' } };
  }

  return {
    phase,
    errorMessage: '',
    primary:
      input.cliCommand.length > 0
        ? { kind: 'command', text: input.cliCommand }
        : { kind: 'link', text: input.inviteUrl },
  };
}
