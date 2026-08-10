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

/**
 * Rendered while no fingerprint has been computed. Mirrors the value
 * `ownerKeyFingerprint('')` returns for an absent key; `share-dialog-state.test.ts`
 * pins the two together so they cannot drift.
 */
export const FINGERPRINT_PLACEHOLDER = '—— —— ——';

/** Shown when the fingerprint could not be computed at all. */
export const FINGERPRINT_UNAVAILABLE_MESSAGE =
  'This browser did not provide the crypto needed to compute the fingerprint, so there is nothing to read aloud. Verify over another channel.';

/**
 * How the Advanced panel presents the verify-key fingerprint.
 *
 * - `absent`  — no signing key yet. The em-dash placeholder is the honest
 *               rendering and there is nothing to copy.
 * - `pending` — a key exists and the digest is still being computed.
 * - `ready`   — a real fingerprint the owner can read aloud.
 * - `failed`  — a key exists but the digest threw. Web Crypto is undefined on
 *               insecure non-loopback origins (`task dev DEV_HOST=0.0.0.0`
 *               reached over a LAN IP is exactly that), and the old code let
 *               the rejection escape an async `$effect` and left the em-dashes
 *               on screen forever — indistinguishable from `absent`, under a
 *               label telling the owner to read them to their reviewer. This
 *               state is what makes the failure sayable.
 */
export type FingerprintStatus = 'absent' | 'pending' | 'ready' | 'failed';

export interface FingerprintPresentation {
  status: FingerprintStatus;
  /** What the `<code>` element renders. Never empty. */
  text: string;
  /** True only when `text` is a real fingerprint worth copying. */
  copyable: boolean;
}

/**
 * Resolve the fingerprint row. Pure; safe to call in `$derived`.
 *
 * `computed` is whatever the last settled `ownerKeyFingerprint` call produced
 * ('' while in flight), and `failed` records that the call rejected.
 */
export function resolveFingerprintPresentation(
  ownerSigningKey: string,
  computed: string,
  failed: boolean,
): FingerprintPresentation {
  if (ownerSigningKey.length === 0) {
    return { status: 'absent', text: FINGERPRINT_PLACEHOLDER, copyable: false };
  }
  if (failed) return { status: 'failed', text: FINGERPRINT_PLACEHOLDER, copyable: false };
  if (computed.length === 0 || computed === FINGERPRINT_PLACEHOLDER) {
    return { status: 'pending', text: FINGERPRINT_PLACEHOLDER, copyable: false };
  }
  return { status: 'ready', text: computed, copyable: true };
}

/**
 * Shown when the mint deadline expired with no answer at all (attn-bw2h.6).
 *
 * This is the ONLY way to reach 'error' with no daemon message: the
 * daemon-failure effect requires a non-empty `shareErrorMessage` before it
 * flips the phase, so a silent error is always the timeout.
 *
 * The previous text — "Couldn't reach the review relay … Nothing left this
 * machine." — asserted two things a timeout does not establish. We do not know
 * the relay was unreachable (the mint may have failed anywhere along the path,
 * or in the raw browser dev loop never have been transported at all), and we
 * certainly do not know nothing left the machine: the daemon may have created
 * the room and published before failing to answer in time. Telling an owner
 * their data stayed local when it may not have is the one kind of wrong this
 * product cannot afford.
 *
 * What IS true, and is the reassurance worth giving: no invite link was
 * produced, so nobody holds the key. The room secret only ever travels in a
 * link fragment, and no link exists.
 */
export const MINT_TIMEOUT_MESSAGE =
  "The share didn't finish in time, so there's no invite link to send. Nobody can open this document without a link.";

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
          : MINT_TIMEOUT_MESSAGE;
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
