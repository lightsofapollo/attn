import type { RoomId } from '../types';

export interface RoomListEntry {
  roomId: RoomId;
}

export function shouldActivateRoomStatus(status: string | undefined): boolean {
  return status === 'Joined' || status === 'Live';
}

export function shouldForgetRoomStatus(status: string | undefined): boolean {
  return status === 'Stopped';
}

export type CollabRole = 'owner' | 'reviewer';
export type RoomRole = 'owner' | 'reviewer' | 'unknown' | undefined;

/**
 * Should this window render the shared document (reviewer view) rather than
 * the local file (owner view)?
 *
 * Gated on a POSITIVE reviewer role, not merely "no local share". The daemon
 * reports the owner's room as `Live` → role `owner` and a joiner's as `Joined`
 * → role `reviewer`. `hasLocalShare` is only true right after a fresh
 * `ShareReady` and is lost on reconnect/rehydrate, so an owner returning to a
 * remembered room has `hasLocalShare === false` yet `role === 'owner'` —
 * gating on `hasLocalShare` alone flipped them into the shared-doc view
 * (attn-0wa). Requiring `role === 'reviewer'` is a strict tightening: an owner
 * (role `owner`/`unknown`) never flips; a real reviewer still does.
 */
export function isReviewerView(params: {
  inRoom: boolean;
  hasLocalShare: boolean;
  role: RoomRole;
}): boolean {
  return params.inRoom && !params.hasLocalShare && params.role === 'reviewer';
}

/**
 * The window's collaboration role: `owner` iff we minted the share this
 * session (`hasLocalShare`) OR the daemon reports our durable role as `owner`.
 * Everything else (including the brief `unknown` window before the first
 * status arrives) is `reviewer`.
 */
export function collabRoleFor(params: { hasLocalShare: boolean; role: RoomRole }): CollabRole {
  return params.hasLocalShare || params.role === 'owner' ? 'owner' : 'reviewer';
}

/**
 * Is the editor safe to seed a collab session from right now?
 *
 * The collab seed is captured ONCE and then owns the doc (the editor stops
 * resetting from its `markdown` prop), so seeding from a transient/empty value
 * locks the editor BLANK for the whole session — the "shared, then blank" bug.
 * Only seed when there's real content to seed from, and for a reviewer only
 * once the shared snapshot has landed (`isReviewerViewingSnapshot`) so we never
 * seed collab from the reviewer's own local file.
 */
export function collabSeedReady(params: {
  effectiveMarkdown: string;
  isReviewerInRoom: boolean;
  isReviewerViewingSnapshot: boolean;
}): boolean {
  if (params.effectiveMarkdown.length === 0) return false;
  return !params.isReviewerInRoom || params.isReviewerViewingSnapshot;
}

export function shouldAutoSelectOnlyRoom(params: {
  hasActiveTab: boolean;
  currentRoomId: RoomId | null;
  rooms: RoomListEntry[];
}): RoomId | null {
  if (params.hasActiveTab) return null;
  if (params.currentRoomId !== null) return null;
  if (params.rooms.length !== 1) return null;
  return params.rooms[0]?.roomId ?? null;
}

export function shortRoomId(roomId: RoomId): string {
  if (roomId.length <= 10) return roomId;
  return `${roomId.slice(0, 4)}…${roomId.slice(-4)}`;
}

function baseName(path: string): string {
  const normalized = path.replace(/\/+$/, '');
  const idx = normalized.lastIndexOf('/');
  return idx >= 0 ? normalized.slice(idx + 1) : normalized;
}

/** Longest common directory prefix of a set of paths (segment-aligned). */
function commonDir(paths: string[]): string {
  const segments = paths.map((p) => p.split('/'));
  const first = segments[0] ?? [];
  let i = 0;
  while (i < first.length && segments.every((s) => s[i] === first[i])) i++;
  return first.slice(0, i).join('/');
}

/**
 * A human-readable name for a room, derived from the file(s) it shares (each
 * snapshot carries the owner's `ownerDisplayPath`). A single-file room is named
 * after that file; a folder/multi-file room after the shared folder + count.
 * Returns `null` when no snapshots have arrived yet (caller falls back to the
 * short room id).
 */
export function roomDisplayName(
  snapshots: ReadonlyArray<{ roomId: RoomId; ownerDisplayPath?: string }>,
  roomId: RoomId,
): string | null {
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const snap of snapshots) {
    if (snap.roomId !== roomId) continue;
    const p = snap.ownerDisplayPath;
    if (!p || seen.has(p)) continue;
    seen.add(p);
    paths.push(p);
  }
  if (paths.length === 0) return null;
  if (paths.length === 1) return baseName(paths[0]);
  const dir = commonDir(paths);
  const prefix = dir ? `${baseName(dir)}/ ` : '';
  return `${prefix}(${paths.length} files)`;
}
