import type { RoomId } from '../types';

export interface PendingRoomFocusStore {
  currentRoomId: RoomId | null;
  selectRoom(roomId: RoomId): boolean;
}

/**
 * Consume a native notification target only once it names a locally hydrated
 * room. Returning the target keeps it durable across startup callbacks;
 * returning null means selection succeeded and it must be cleared.
 */
export function consumePendingRoomFocus(
  store: PendingRoomFocusStore,
  pending: RoomId | null,
): RoomId | null {
  if (pending === null) return null;
  if (store.currentRoomId === pending) return null;
  return store.selectRoom(pending) ? null : pending;
}
