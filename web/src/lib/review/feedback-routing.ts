import type {
  FeedbackRoute,
  FeedbackRoutingState,
  ReviewFeedbackRoutingChanged,
  RoomId,
} from '../types';

const KEY_PREFIX = 'attn.feedback-routing.v1:';
const MAX_THREADS = 5_000;

export interface FeedbackRoutingStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function clearBrowserFeedbackRouting(
  roomId: RoomId,
  storage: FeedbackRoutingStorage = window.localStorage,
): void {
  try {
    storage.removeItem(feedbackRoutingStorageKey(roomId));
  } catch {
    throw new Error('This browser could not clear the saved For-agent marks');
  }
}

export function feedbackRoutingStorageKey(roomId: RoomId): string {
  return `${KEY_PREFIX}${encodeURIComponent(roomId)}`;
}

export function emptyFeedbackRouting(): FeedbackRoutingState {
  return { v: 1, threads: {} };
}

export function loadBrowserFeedbackRouting(
  roomId: RoomId,
  storage: FeedbackRoutingStorage = window.localStorage,
): FeedbackRoutingState {
  const raw = storage.getItem(feedbackRoutingStorageKey(roomId));
  if (raw === null) return emptyFeedbackRouting();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Saved For-agent marks are corrupt in this browser');
  }
  if (!isFeedbackRoutingState(parsed)) {
    throw new Error('Saved For-agent marks use an unsupported format');
  }
  return parsed;
}

export function setBrowserFeedbackMark(
  roomId: RoomId,
  threadId: string,
  marked: boolean,
  storage: FeedbackRoutingStorage = window.localStorage,
  now = Date.now(),
): FeedbackRoutingState {
  const state = loadBrowserFeedbackRouting(roomId, storage);
  const existing = state.threads[threadId];
  if (existing?.marked === marked) return state;
  const route: FeedbackRoute = {
    marked,
    revision: (existing?.revision ?? 0) + 1,
    updatedAt: now,
  };
  const threads = { ...state.threads, [threadId]: route };
  const entries = Object.entries(threads);
  if (entries.length > MAX_THREADS) {
    entries
      .sort(([, a], [, b]) => b.updatedAt - a.updatedAt)
      .slice(MAX_THREADS)
      .forEach(([id]) => delete threads[id]);
  }
  const next: FeedbackRoutingState = { v: 1, threads };
  try {
    storage.setItem(feedbackRoutingStorageKey(roomId), JSON.stringify(next));
  } catch {
    throw new Error('This browser could not save the For-agent mark');
  }
  return next;
}

export function feedbackRoutingUpdate(
  roomId: RoomId,
  routing: FeedbackRoutingState,
): ReviewFeedbackRoutingChanged {
  return { roomId, routing };
}

export function routingFromStorageEvent(
  roomId: RoomId,
  event: StorageEvent,
): FeedbackRoutingState | null {
  if (event.key !== feedbackRoutingStorageKey(roomId)) return null;
  if (event.newValue === null) return emptyFeedbackRouting();
  try {
    const parsed: unknown = JSON.parse(event.newValue);
    return isFeedbackRoutingState(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isFeedbackRoutingState(value: unknown): value is FeedbackRoutingState {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { v?: unknown; threads?: unknown };
  if (candidate.v !== 1 || typeof candidate.threads !== 'object' || candidate.threads === null) {
    return false;
  }
  return Object.entries(candidate.threads).every(([threadId, route]) => {
    if (threadId.length === 0 || threadId.length > 512 || typeof route !== 'object' || route === null) {
      return false;
    }
    const item = route as Partial<FeedbackRoute>;
    return typeof item.marked === 'boolean'
      && Number.isSafeInteger(item.revision)
      && (item.revision ?? 0) > 0
      && Number.isFinite(item.updatedAt);
  });
}
