// Pure formatters / derivers for PeerStrip.svelte (attn-nnj.4.12).
//
// Lives outside the .svelte file so the test harness (tsx) can import the
// contract directly without going through the Svelte compiler. The component
// re-uses every export here so any drift between rendering and tests fails
// loudly.
//
// Spec refs:
//   * planning/collab/ui/connection-share.md §7 — peer-strip layout (chip
//     shapes, overflow rule, color tokens).
//   * planning/collab/ui/presence-identity.md (10.5) — chip taxonomy,
//     monogram rule, agent glyph, "you" affordance, identity card content.

import { resolveParticipantColor } from './participant-color';
import type { ParticipantId, ReviewStatusPeer } from './types';

/**
 * Max chips drawn inline before the overflow "+N" chip kicks in
 * (connection-share.md §7: "more than 5 peers → first 4 chips + `+N`").
 */
export const MAX_VISIBLE_CHIPS = 4;

/**
 * Threshold at which the overflow chip appears. Strictly greater than
 * `MAX_VISIBLE_CHIPS + 1` (5) means 5 peers all render inline (4 chips +
 * 1 more, no overflow). 6 peers → 4 inline + "+2".
 */
export const OVERFLOW_THRESHOLD = 5;

/**
 * The Unicode glyph used for agent chips. Per presence-identity.md §2 we
 * deliberately pick a geometric codepoint (not emoji, not a letter): the
 * monogram rule is "first letter of displayName" for humans, so a letter
 * on a hex chip would read as "another human" at a glance.
 *
 * `⊳` (U+22B3, "normal subgroup of") satisfies the design constraints:
 *   * geometric, monospace-friendly, no semantic baggage
 *   * legible at 16-20 px
 *   * single codepoint, font-rendered, free
 *
 * Open question 4 of presence-identity.md tracks a future SVG swap.
 */
export const AGENT_GLYPH = '⊳';

/**
 * Strongly-typed peer kind. Mirrors `Participant['kind']` so the test
 * harness doesn't have to import the full type tree.
 */
export type PeerKind = 'owner' | 'reviewer' | 'agent';

/**
 * Visual chip shape. The shape is the small-size distinction between
 * human (round) and agent (hex/diamond) — agents on a 20 px chip stay
 * recognizable even if color is lost (per §7 / §2).
 */
export type ChipShape = 'round' | 'hex';

/**
 * What goes on a chip: a letter monogram (humans) or the agent glyph.
 */
export type ChipContent =
  | { kind: 'monogram'; letter: string }
  | { kind: 'glyph'; glyph: typeof AGENT_GLYPH };

/**
 * Computed visual descriptor for a peer chip. The Svelte component reads
 * these fields verbatim; the test harness asserts the same.
 */
export interface ChipVisual {
  shape: ChipShape;
  content: ChipContent;
  /**
   * Concrete CSS color for the chip background (attn-3gdd): the
   * participant's personal identity color resolved through
   * `participant-color.ts` — declared pick first, deterministic hash
   * fallback; agents always violet. Replaces the old per-ROLE
   * `--peer-avatar-bg-*` var so two reviewers are never the same blue.
   */
  bg: string;
}

/**
 * Identity-card field bundle (per presence-identity.md §5.1). Computed
 * from a peer + (optional) signing-key fingerprint. Pure data — the
 * Svelte popover renders it verbatim.
 */
export interface IdentityCardData {
  displayName: string;
  kind: PeerKind;
  /** 12-char SHA-256 fingerprint, grouped `4-4-4`. May be the placeholder. */
  fingerprint: string;
  /** Truncated participantId for the row label (last 6 chars after prefix). */
  participantIdShort: string;
  /** Full participantId for the copy button. */
  participantIdFull: ParticipantId;
}

/**
 * Decide the chip shape for a peer kind. Humans are round, agents hex.
 * The shape is the primary color-blind / small-size signal.
 */
export function chipShapeFor(kind: PeerKind): ChipShape {
  return kind === 'agent' ? 'hex' : 'round';
}

/**
 * Compute the monogram for a human peer (attn-3gdd — two letters so
 * same-first-letter names stop colliding):
 *
 *   * Multi-word name → first grapheme of the first word + first grapheme
 *     of the last word ("James Lal" → "JL").
 *   * Single word → its first two graphemes ("James" → "JA").
 *   * Single grapheme → just that one; empty `displayName` → `?` fallback.
 *
 * We approximate "grapheme cluster" with `Array.from(name)` which walks
 * code points (close enough for the latin / cyrillic / asian subset that
 * the daemon's display-name generator emits; the harness doesn't have
 * `Intl.Segmenter` everywhere).
 */
export function monogramFor(displayName: string): string {
  const words = displayName.trim().split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) return '?';
  const graphemes =
    words.length === 1
      ? Array.from(words[0]).slice(0, 2)
      : [Array.from(words[0])[0], Array.from(words[words.length - 1])[0]];
  return graphemes.filter((g): g is string => g !== undefined).join('').toLocaleUpperCase() || '?';
}

/**
 * Full visual descriptor for a peer chip. Agents always render the
 * `⊳` glyph (never a monogram) per §2's "Agents never carry a monogram"
 * rule.
 *
 * `declaredColor` is the participant's announced identity color when the
 * caller has one (the review store's `colorFor` covers ParticipantJoined +
 * the local profile); omitted → deterministic hash fallback. Either way the
 * value lands as `ChipVisual.bg` after validation.
 */
export function chipVisualFor(
  peer: ReviewStatusPeer,
  declaredColor?: string | null,
): ChipVisual {
  if (peer.kind === 'agent') {
    return {
      shape: 'hex',
      content: { kind: 'glyph', glyph: AGENT_GLYPH },
      bg: resolveParticipantColor(peer.participantId, null, 'agent'),
    };
  }
  return {
    shape: 'round',
    content: { kind: 'monogram', letter: monogramFor(peer.displayName) },
    bg: resolveParticipantColor(peer.participantId, declaredColor, peer.kind),
  };
}

/**
 * Split a peer list into "inline" + "overflow" buckets per §7's
 * `>5 peers → first 4 + +N` rule.
 *
 * Returns:
 *   * `inline`     — chips drawn directly in the strip.
 *   * `overflow`   — peers hidden behind the `+N` chip popover.
 *   * `overflowCount` — `overflow.length` (cached for template binding).
 *
 * Invariant: `inline.length + overflow.length === peers.length`.
 */
export interface PeerSplit {
  inline: ReviewStatusPeer[];
  overflow: ReviewStatusPeer[];
  overflowCount: number;
}

export function splitForStrip(peers: ReviewStatusPeer[]): PeerSplit {
  if (peers.length <= OVERFLOW_THRESHOLD) {
    return { inline: peers, overflow: [], overflowCount: 0 };
  }
  const inline = peers.slice(0, MAX_VISIBLE_CHIPS);
  const overflow = peers.slice(MAX_VISIBLE_CHIPS);
  return { inline, overflow, overflowCount: overflow.length };
}

/**
 * Decide whether a peer is "you" (the local participant). The peer-strip
 * places a `(you)` label under the matching chip and skips the click→
 * identity card affordance for self (the card is for inspecting others).
 *
 * Match is on `participantId` (stable identity) per presence-identity.md
 * §1 "Identity rules". When `localParticipantId` is `null`, no chip is
 * tagged.
 */
export function isYou(
  peer: ReviewStatusPeer,
  localParticipantId: ParticipantId | null,
): boolean {
  return localParticipantId !== null && peer.participantId === localParticipantId;
}

/**
 * Whether clicking a peer's chip should JUMP the local user to that peer's
 * location instead of opening the identity card (attn-qs03). A peer is
 * jumpable only when:
 *   * a jump handler is wired (`hasHandler`) — otherwise there's nowhere to go;
 *   * the peer is `online` — a stale location for a departed peer is a dead end;
 *   * the peer is not "you" — you're already where you are; and
 *   * a live location is known (`locationFileId` set) — the destination file.
 *
 * The caret position (`locationCaretHead`) is optional: with no caret we still
 * jump to the file and scroll to the top. Kept pure so the strip and the tests
 * agree on the exact rule.
 */
export function peerIsJumpable(
  peer: ReviewStatusPeer,
  localParticipantId: ParticipantId | null,
  hasHandler: boolean,
): boolean {
  return (
    hasHandler &&
    peer.online &&
    !isYou(peer, localParticipantId) &&
    peer.locationFileId !== undefined
  );
}

/** Prefer what the peer is reading over where their possibly-stale caret sits. */
export function peerJumpPosition(peer: ReviewStatusPeer): number {
  return peer.locationViewHead ?? peer.locationCaretHead ?? 0;
}

/**
 * Last-6-hex disambiguator for the chip-hover tooltip (per §3 "tail-6").
 * Cheap disambig for two reviewers who both call themselves "alex".
 *
 * Pure: takes the already-computed fingerprint string and returns the
 * trailing 6 hex chars (ignoring the grouping spaces).
 */
export function tail6(fingerprint: string): string {
  const hex = fingerprint.replace(/\s+/g, '');
  if (hex.length < 6) return hex;
  return hex.slice(-6);
}

/**
 * Truncate a participantId for the identity-card "p_…" row. Keeps the
 * first 4 chars (typically the prefix) plus the last 6 chars, separated
 * by an ellipsis. Stable cosmetic helper.
 */
export function shortenParticipantId(id: ParticipantId): string {
  if (id.length <= 12) return id;
  return `${id.slice(0, 4)}…${id.slice(-6)}`;
}
