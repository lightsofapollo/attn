// Per-participant color resolution (attn-3gdd).
//
// One color system for every surface that renders a person: peer chips,
// remote carets/selections, and comment-card accents all resolve through
// here so a participant reads as the SAME color everywhere.
//
// Resolution order (humans):
//   1. For OUR OWN participant id: the local profile's picked color. Ours is
//      ours in every room and under every role — the announce that carries it
//      to peers can lag it, and never happens at all for a view-tier reviewer.
//   2. A color the participant declared themselves (ParticipantJoined
//      `color`) — validated first.
//   3. Deterministic fallback: hash of the participantId into the curated
//      palette. Stable per room, identical on every client, no coordination.
//
// Agents are exempt: they keep the fixed violet family so the hex chip +
// violet pairing stays the "this is an agent" brand (shape carries the
// distinction for color-blind users; color reinforces it).
//
// Palette notes: OKLCH, lightness pinned to 0.56–0.60 and chroma 0.11–0.14 so
// every hue sits correctly on both paper (light) and ink (dark) themes with
// white monogram text — same envelope as the original --peer-avatar-bg-*
// tokens. The violet band (~280–310) is deliberately absent from the human
// pool so nothing collides with the agent identity.
//
// Kept runes-free so pure formatters (peer-strip-format.ts) and the tsx test
// harness can import it without the Svelte compiler.

/** One curated swatch. `id` persists (identity.json / localStorage); the CSS
 * color string is what travels on the wire and hits inline styles. */
export interface ParticipantSwatch {
  id: string;
  color: string;
}

/** Curated human palette (documented in DESIGN.md §2 "Tertiary — Peer
 * identity"). Nine hues spaced ~35° apart around the wheel, skipping the
 * 280–310 violet band reserved for agents. `clay` is the existing Owner Clay
 * value so pre-palette rooms keep their look. Order matters: hashing indexes
 * into this array, so reordering or removing entries reshuffles every
 * fallback color. Append-only. */
export const PARTICIPANT_PALETTE: readonly ParticipantSwatch[] = [
  { id: 'clay', color: 'oklch(0.58 0.14 32)' },
  { id: 'amber', color: 'oklch(0.60 0.12 70)' },
  { id: 'olive', color: 'oklch(0.58 0.11 110)' },
  { id: 'green', color: 'oklch(0.56 0.12 150)' },
  { id: 'teal', color: 'oklch(0.56 0.11 185)' },
  { id: 'steel', color: 'oklch(0.56 0.11 218)' },
  { id: 'blue', color: 'oklch(0.56 0.11 250)' },
  { id: 'plum', color: 'oklch(0.57 0.13 325)' },
  { id: 'berry', color: 'oklch(0.58 0.14 358)' },
];

/** Fixed agent color — mirrors `--peer-avatar-bg-agent`. */
export const AGENT_COLOR = 'oklch(0.57 0.13 295)';

/**
 * Validate a declared color before it touches an inline style or the wire.
 * Declared colors arrive from OTHER participants (ParticipantJoined events),
 * so the grammar is strict: 6-digit hex or a bare numeric oklch() triple.
 * Anything else (including `var(...)`, extra declarations, url()) → null.
 */
export function sanitizeParticipantColor(
  raw: string | null | undefined,
): string | null {
  // Wire data can be any JSON shape despite the type — reject non-strings
  // outright instead of trusting the declaration.
  if (typeof raw !== 'string' || raw.length === 0) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 64) return null;
  if (/^#[0-9a-fA-F]{6}$/.test(trimmed)) return trimmed;
  if (/^oklch\(\s*[01](?:\.\d+)?\s+0(?:\.\d+)?\s+\d{1,3}(?:\.\d+)?\s*\)$/.test(trimmed)) {
    return trimmed;
  }
  return null;
}

/**
 * Deterministic palette pick for a participant with no declared color.
 * FNV-1a over the participantId — every client hashes the same id to the
 * same swatch, so the fallback agrees everywhere without coordination.
 * Collisions between two participants are possible and tolerated: the
 * monogram + name disambiguate, and a picked color overrides.
 */
export function hashParticipantColor(participantId: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < participantId.length; i++) {
    hash ^= participantId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  const index = (hash >>> 0) % PARTICIPANT_PALETTE.length;
  return PARTICIPANT_PALETTE[index].color;
}

/**
 * The single resolution entrypoint: declared-if-valid, else hashed; agents
 * always violet. `declared` is whatever the participant announced (or the
 * local profile's picked color for self) — pass null/undefined when unknown.
 */
export function resolveParticipantColor(
  participantId: string,
  declared: string | null | undefined,
  kind: 'owner' | 'reviewer' | 'agent' = 'reviewer',
): string {
  if (kind === 'agent') return AGENT_COLOR;
  return sanitizeParticipantColor(declared) ?? hashParticipantColor(participantId);
}

/** One `ParticipantJoined` colour declaration, flattened out of the event log. */
export interface DeclaredColorAnnounce {
  participantId: string;
  /** The announced color, or null/undefined for "Auto" (no declaration). */
  color?: string | null;
  /** Authored time of the announce (`meta.createdAt`) — NOT arrival order. */
  announcedAt: number;
}

/**
 * Reduce a room's `ParticipantJoined` announces to participantId → declared
 * color. Latest-authored announce wins per participant, and — crucially — an
 * announce that declares NO color CLEARS any earlier declaration: picking
 * "Auto" is a choice, and a re-announce is exactly how it travels. (Keeping
 * the last non-null color instead made Auto un-pickable once a color had been
 * announced: the withdrawal was invisible to every client, self included.)
 *
 * Validated here so a malicious declaration never reaches an inline style;
 * an invalid color reads as no declaration and falls through to the hash.
 * Ties on `announcedAt` resolve to the later entry in iteration order.
 */
export function harvestDeclaredColors(
  announces: Iterable<DeclaredColorAnnounce>,
): Record<string, string> {
  const colors: Record<string, string> = {};
  const announcedAt: Record<string, number> = {};
  for (const announce of announces) {
    if ((announcedAt[announce.participantId] ?? -1) > announce.announcedAt) continue;
    announcedAt[announce.participantId] = announce.announcedAt;
    const color = sanitizeParticipantColor(announce.color);
    if (color) colors[announce.participantId] = color;
    else delete colors[announce.participantId];
  }
  return colors;
}

/** Everything known about who the local device is, from the caller's view. */
export interface SelfIdentity {
  /** The local device identity's own participant id, when known. */
  selfParticipantId: string | null | undefined;
  /** The room owner's participant id (snapshot-derived), when known. */
  ownerParticipantId: string | null | undefined;
  /** The local role in the active room. */
  role: 'owner' | 'reviewer' | 'unknown' | null | undefined;
}

/**
 * Is `participantId` the local user?
 *
 * Identity first: a match against our OWN participant id is self in every
 * room, under every role. The owner branch is the fallback for surfaces that
 * never learned a local participant id (rooms shared before the init payload
 * carried one; hosted surfaces that mint a per-session id) — and it is
 * role-gated on purpose: on a reviewer window `ownerParticipantId` is
 * SOMEONE ELSE, so matching it there would paint the owner in our color.
 */
export function isSelfParticipant(
  participantId: string,
  { selfParticipantId, ownerParticipantId, role }: SelfIdentity,
): boolean {
  if (participantId.length === 0) return false;
  if (selfParticipantId && participantId === selfParticipantId) return true;
  return role === 'owner' && !!ownerParticipantId && participantId === ownerParticipantId;
}

/** Inputs to the one identity-color decision every surface renders through. */
export interface IdentityColorInput {
  participantId: string;
  kind: 'owner' | 'reviewer' | 'agent';
  /** Color this participant announced on `ParticipantJoined`, if any. */
  announced?: string | null;
  /** True when this id is the local device's own participant. */
  isSelf?: boolean;
  /** The local user's picked color; null means "Auto" (use the hash). */
  selfColor?: string | null;
}

/**
 * Resolve the color for one participant, self included.
 *
 * For self the LOCAL pick outranks our own last announce: it is the freshest
 * statement of what we chose, and the re-announce that carries it to peers
 * may still be in flight (or may never have been made — a view-tier reviewer
 * never announces at all). For everyone else the announce is all we have.
 *
 * Agents short-circuit to violet BEFORE the self override, so an agent
 * rendering its own surface can never repaint itself out of the agent brand.
 */
export function resolveIdentityColor({
  participantId,
  kind,
  announced = null,
  isSelf = false,
  selfColor = null,
}: IdentityColorInput): string {
  if (kind === 'agent') return AGENT_COLOR;
  const declared = (isSelf ? sanitizeParticipantColor(selfColor) : null) ?? announced;
  return resolveParticipantColor(participantId, declared, kind);
}
