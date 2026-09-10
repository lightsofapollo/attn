import assert from 'node:assert/strict';

import { markedFeedbackThreads, serializeFeedbackThreads } from './feedback-copy';
import {
  clearBrowserFeedbackRouting,
  feedbackRoutingStorageKey,
  loadBrowserFeedbackRouting,
  setBrowserFeedbackMark,
  type FeedbackRoutingStorage,
} from './feedback-routing';
import type { Anchor, FeedbackRoute, ReviewEvent, ReviewSnapshot, Thread } from '../types';

class MemoryStorage implements FeedbackRoutingStorage {
  values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

const storage = new MemoryStorage();
const marked = setBrowserFeedbackMark('room-a', 'thread-a', true, storage, 10);
assert.deepEqual(marked.threads['thread-a'], { marked: true, revision: 1, updatedAt: 10 });
const repeated = setBrowserFeedbackMark('room-a', 'thread-a', true, storage, 20);
assert.deepEqual(repeated.threads['thread-a'], marked.threads['thread-a']);
const unmarked = setBrowserFeedbackMark('room-a', 'thread-a', false, storage, 30);
assert.deepEqual(unmarked.threads['thread-a'], { marked: false, revision: 2, updatedAt: 30 });
assert.deepEqual(loadBrowserFeedbackRouting('room-b', storage), { v: 1, threads: {} });
clearBrowserFeedbackRouting('room-a', storage);
assert.deepEqual(loadBrowserFeedbackRouting('room-a', storage), { v: 1, threads: {} });
storage.values.set(feedbackRoutingStorageKey('room-corrupt'), '{oops');
assert.throws(
  () => loadBrowserFeedbackRouting('room-corrupt', storage),
  /corrupt/,
);

const markdownAnchor: Anchor = {
  v: 2,
  fileId: 'file-plan',
  snapshotId: 'snap-plan',
  baseHash: 'hash',
  position: { byteRange: [12, 28], lineRange: [3, 4] },
  quote: {
    exact: 'Selected source',
    exactHash: 'quote-hash',
    normalized: 'Selected source',
    normalizedHash: 'normalized-hash',
  },
};

function commentEvent(
  eventId: string,
  authorId: string,
  createdAt: number,
  body: string,
  threadId = 'thread-a',
  anchor = markdownAnchor,
): ReviewEvent {
  return {
    meta: {
      v: 2,
      eventId,
      roomId: 'room-a',
      authorId,
      deviceId: `device-${authorId}`,
      createdAt,
      parentEventIds: [],
    },
    body: { type: 'comment_created', threadId, anchor, body },
    auth: { signature: 'sig', signingKeyId: 'key' },
  };
}

const thread: Thread = {
  id: 'thread-a',
  rootEvent: commentEvent('event-root', 'human-a', 1, 'Rewrite this paragraph'),
  replies: [
    commentEvent('event-agent', 'agent-a', 2, 'Applied'),
    commentEvent('event-human', 'human-b', 3, 'Keep the final example'),
  ],
  resolved: false,
  anchor: markdownAnchor,
  resolvedAnchor: {
    status: 'remapped',
    confidence: 0.91,
    currentRange: { byteRange: [19, 35], lineRange: [5, 6] },
    reason: 'quote_match',
  },
};
const resolved: Thread = { ...thread, id: 'thread-resolved', resolved: true };
const routes: Record<string, FeedbackRoute> = {
  'thread-a': { marked: true, revision: 2, updatedAt: 0 },
  'thread-resolved': { marked: true, revision: 1, updatedAt: 10 },
};
assert.deepEqual(markedFeedbackThreads([thread, resolved], routes), [thread]);

const snapshots: ReviewSnapshot[] = [{
  roomId: 'room-a',
  fileId: 'file-plan',
  snapshotId: 'snap-plan',
  ownerDisplayPath: 'docs/plan.md',
  createdAt: 1,
  createdBy: 'human-a',
  baseHash: 'hash',
  byteLength: 10,
  docType: 'markdown',
  content: '# Plan',
}];
const packet = serializeFeedbackThreads([thread], {
  routes,
  snapshots,
  events: [thread.rootEvent, ...thread.replies],
  displayNameFor: (id) => ({ 'human-a': 'Angus', 'human-b': 'Riley', 'agent-a': 'Agent' })[id] ?? id,
  kindFor: (id) => id.startsWith('agent') ? 'agent' : 'reviewer',
});
assert.match(packet, /\[room-a:thread-a\] docs\/plan\.md/);
assert.match(packet, /Revision: 3/);
assert.match(packet, /source lines 3-4 · bytes 12-28/);
assert.match(packet, /Current source anchor: remapped · lines 5-6 · bytes 19-35/);
assert.match(packet, /> Selected source/);
assert.match(packet, /Reply \(Agent · agent\): Applied/);
assert.match(packet, /Reply \(Riley · reviewer\): Keep the final example/);

console.log('feedback routing and copy packet: ok');
