import { consumePendingRoomFocus } from './pending-room-focus';
import type { RoomId } from '../types';

let hydrated = false;
const metrics = { selections: 0 };
function assertEqual(actual: unknown, expected: unknown, message: string): void {
  if (actual !== expected) throw new Error(message);
}
const store = {
  currentRoomId: null as RoomId | null,
  selectRoom(roomId: RoomId): boolean {
    if (roomId !== 'room-startup' || !hydrated) return false;
    metrics.selections += 1;
    this.currentRoomId = roomId;
    return true;
  },
};

let pending: RoomId | null = 'room-startup';
pending = consumePendingRoomFocus(store, pending);
if (pending !== 'room-startup') {
  throw new Error('room target was lost before hydration');
}
assertEqual(metrics.selections, 0, 'unknown room was selected before hydration');

hydrated = true;
pending = consumePendingRoomFocus(store, pending);
if (pending !== null) {
  throw new Error('hydrated local room was not selected exactly once');
}
assertEqual(metrics.selections, 1, 'hydrated room selection count was not one');

pending = consumePendingRoomFocus(store, pending);
if (pending !== null) {
  throw new Error('cleared room target replayed after successful selection');
}
assertEqual(metrics.selections, 1, 'cleared target replayed its selection');

const unknown = consumePendingRoomFocus(store, 'room-nonlocal');
if (unknown !== 'room-nonlocal') {
  throw new Error('unknown nonlocal room mutated selection');
}
assertEqual(metrics.selections, 1, 'nonlocal target changed selection count');

console.log('  ok  pending native room focus survives hydration and consumes exactly once');
