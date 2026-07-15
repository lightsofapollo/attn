import type { RoomId } from '../types';

export interface RoomListEntry {
  roomId: RoomId;
}

export interface OwnerRoomPathEntry extends RoomListEntry {
  role: RoomRole;
  share?: { ownerDisplayPath: string };
}

export interface RoomPathSnapshot extends RoomListEntry {
  ownerDisplayPath?: string;
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

function normalizeRoomPath(path: string | null | undefined): string {
  return (path ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
}

/**
 * Resolve an owner's active local path to the room that owns its collaboration
 * state. Exact published-file matches beat containing folder shares; ties keep
 * the already-selected room stable before falling back to room-list order.
 * Reviewer rooms are deliberately ignored — joined workspaces keep explicit
 * project-style navigation until P2 folds them into the sidebar picker.
 */
export function ownerRoomForPath(params: {
  path: string | null | undefined;
  currentRoomId: RoomId | null;
  rooms: ReadonlyArray<OwnerRoomPathEntry>;
  snapshots: ReadonlyArray<RoomPathSnapshot>;
}): RoomId | null {
  const target = normalizeRoomPath(params.path);
  if (!target) return null;

  let bestRoomId: RoomId | null = null;
  let bestScore = -1;

  for (const room of params.rooms) {
    if (room.role !== 'owner') continue;

    let score = -1;
    const sharePath = normalizeRoomPath(room.share?.ownerDisplayPath);
    if (sharePath) {
      if (sharePath === target) {
        score = 2_000_000 + sharePath.length;
      } else if (target.startsWith(`${sharePath}/`)) {
        // Longer folder roots are more specific than parent folder shares.
        score = 1_000_000 + sharePath.length;
      }
    }

    for (const snapshot of params.snapshots) {
      if (snapshot.roomId !== room.roomId) continue;
      const snapshotPath = normalizeRoomPath(snapshot.ownerDisplayPath);
      if (snapshotPath === target) {
        // A published file is the strongest possible path→room signal.
        score = Math.max(score, 3_000_000 + snapshotPath.length);
      }
    }

    if (score < 0) continue;
    const keepsCurrent = room.roomId === params.currentRoomId;
    const bestIsCurrent = bestRoomId === params.currentRoomId;
    if (score > bestScore || (score === bestScore && keepsCurrent && !bestIsCurrent)) {
      bestRoomId = room.roomId;
      bestScore = score;
    }
  }

  return bestRoomId;
}

/**
 * Put native room-level unread counts on the owner's spatial navigation.
 * Single-file shares land on that file; folder/multi-file shares land once on
 * the shared folder root so the same count is never repeated on every child.
 */
export function ownerUnreadByPath(params: {
  rooms: ReadonlyArray<OwnerRoomPathEntry>;
  snapshots: ReadonlyArray<RoomPathSnapshot>;
  unreadByRoom: Readonly<Record<string, number>>;
}): Record<string, number> {
  const result: Record<string, number> = {};

  for (const room of params.rooms) {
    if (room.role !== 'owner') continue;
    const unread = Math.max(0, Math.floor(params.unreadByRoom[room.roomId] ?? 0));
    if (unread === 0) continue;

    let anchorPath = normalizeRoomPath(room.share?.ownerDisplayPath);
    if (!anchorPath) {
      const snapshotPaths = Array.from(new Set(
        params.snapshots
          .filter((snapshot) => snapshot.roomId === room.roomId)
          .map((snapshot) => normalizeRoomPath(snapshot.ownerDisplayPath))
          .filter(Boolean),
      ));
      if (snapshotPaths.length === 1) {
        anchorPath = snapshotPaths[0] ?? '';
      } else if (snapshotPaths.length > 1) {
        anchorPath = commonDir(snapshotPaths);
      }
    }

    if (!anchorPath) continue;
    result[anchorPath] = (result[anchorPath] ?? 0) + unread;
  }

  return result;
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

/**
 * Does `target` fall under the path a room was shared for?
 *
 * The owner shares either a single file or a whole folder. A folder share is
 * recognized for the folder itself AND for any markdown file beneath it, so
 * opening the Share dialog on a child of a shared folder re-shows the existing
 * invite instead of minting a fresh room. A different, unshared file (including
 * a sibling whose name merely shares a prefix) does NOT match — the prefix test
 * is path-segment aware (`P + '/'`).
 *
 * Both sides are trailing-slash-normalized so a folder share recorded as
 * '/p/dir' or '/p/dir/' both match the child '/p/dir/child.md'. Empty/nullish
 * inputs never match (no active share / no target selected).
 */
export function shareTargetMatches(
  sharePath: string | null | undefined,
  target: string | null | undefined,
): boolean {
  const p = (sharePath ?? '').replace(/\/+$/, '');
  const t = (target ?? '').replace(/\/+$/, '');
  if (p.length === 0 || t.length === 0) return false;
  return t === p || t.startsWith(`${p}/`);
}
