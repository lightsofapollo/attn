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
