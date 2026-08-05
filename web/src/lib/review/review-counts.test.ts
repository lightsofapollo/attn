import { createReviewCountingSink, EMPTY_REVIEW_COUNTS } from './review-counts';
import type { ReviewEvent, ReviewEventBody } from '../types';

let failures = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  ok  ${label}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL ${label}\n       expected ${e}\n       got      ${a}`);
}

let seq = 0;
function event(body: ReviewEventBody, opts: { id?: string; at?: number; author?: string } = {}): ReviewEvent {
  seq += 1;
  return {
    meta: {
      v: 2,
      eventId: (opts.id ?? `e${seq}`) as ReviewEvent['meta']['eventId'],
      roomId: 'room-1' as ReviewEvent['meta']['roomId'],
      authorId: (opts.author ?? 'human-1') as ReviewEvent['meta']['authorId'],
      deviceId: 'device-1' as ReviewEvent['meta']['deviceId'],
      createdAt: opts.at ?? seq,
      parentEventIds: [],
    },
    body,
    auth: {} as ReviewEvent['auth'],
  };
}

const anchor = {} as never;

// A fresh sink reports nothing, so a desk row for a shared-but-quiet workspace
// says "no review work" rather than inventing a zero-ish badge.
{
  const sink = createReviewCountingSink();
  check('empty sink matches EMPTY_REVIEW_COUNTS', sink.counts(), EMPTY_REVIEW_COUNTS);
}

// Open comments are created-minus-resolved, keyed by thread so the same thread
// resolving twice cannot drive the count negative.
{
  const sink = createReviewCountingSink();
  sink.applyEvent(event({ type: 'comment_created', threadId: 't1', anchor, body: 'a' } as ReviewEventBody));
  sink.applyEvent(event({ type: 'comment_created', threadId: 't2', anchor, body: 'b' } as ReviewEventBody));
  check('two comments open', sink.counts().openComments, 2);
  sink.applyEvent(event({ type: 'comment_resolved', threadId: 't1' } as ReviewEventBody));
  check('resolving one leaves one', sink.counts().openComments, 1);
  sink.applyEvent(event({ type: 'comment_resolved', threadId: 't1' } as ReviewEventBody));
  check('resolving the same thread twice does not go negative', sink.counts().openComments, 1);
}

// Pending suggestions are created minus accepted OR rejected — a rejected
// suggestion is no longer waiting on the owner, which is what the row means.
{
  const sink = createReviewCountingSink();
  sink.applyEvent(event({ type: 'suggestion_created', suggestionId: 's1', anchor, operation: anchor } as ReviewEventBody));
  sink.applyEvent(event({ type: 'suggestion_created', suggestionId: 's2', anchor, operation: anchor } as ReviewEventBody));
  sink.applyEvent(event({ type: 'suggestion_created', suggestionId: 's3', anchor, operation: anchor } as ReviewEventBody));
  check('three suggestions pending', sink.counts().pendingSuggestions, 3);
  sink.applyEvent(event({ type: 'suggestion_accepted', suggestionId: 's1', appliedRevisionId: 'r1' } as ReviewEventBody));
  sink.applyEvent(event({ type: 'suggestion_rejected', suggestionId: 's2' } as ReviewEventBody));
  check('accepted and rejected both stop pending', sink.counts().pendingSuggestions, 1);
}

// The log is append-only and replay can overlap, so the same event arriving
// twice must not double-count. This is the property the real store guarantees
// by eventId, and the sink has to match it or the badge drifts upward forever.
{
  const sink = createReviewCountingSink();
  const dup = event({ type: 'comment_created', threadId: 't1', anchor, body: 'a' } as ReviewEventBody, { id: 'same' });
  sink.applyEvent(dup);
  sink.applyEvent(dup);
  check('replayed event is deduped by eventId', sink.counts().openComments, 1);
}

// Room lifecycle and presence are not review work. Counting them would make a
// row claim attention because somebody merely opened the document.
{
  const sink = createReviewCountingSink();
  sink.applyEvent(event({ type: 'participant_joined' } as ReviewEventBody, { at: 500 }));
  sink.applyEvent(event({ type: 'presence_updated' } as ReviewEventBody, { at: 600 }));
  check('lifecycle events do not count', sink.counts(), EMPTY_REVIEW_COUNTS);
}

// Recency tracks the latest REVIEW event, and remembers who so the caller can
// resolve human-vs-agent against the roster.
{
  const sink = createReviewCountingSink();
  sink.applyEvent(event({ type: 'comment_created', threadId: 't1', anchor, body: 'a' } as ReviewEventBody, { at: 100, author: 'human-1' }));
  sink.applyEvent(event({ type: 'suggestion_created', suggestionId: 's1', anchor, operation: anchor } as ReviewEventBody, { at: 300, author: 'agent-7' }));
  sink.applyEvent(event({ type: 'presence_updated' } as ReviewEventBody, { at: 900, author: 'human-1' }));
  check('last activity is the newest review event, not the newest event', sink.counts().lastActivityAt, 300);
  check('last author follows it', sink.counts().lastAuthorId, 'agent-7');
}

// Out-of-order replay must not rewind recency.
{
  const sink = createReviewCountingSink();
  sink.applyEvent(event({ type: 'comment_created', threadId: 't1', anchor, body: 'a' } as ReviewEventBody, { at: 400 }));
  sink.applyEvent(event({ type: 'comment_created', threadId: 't2', anchor, body: 'b' } as ReviewEventBody, { at: 200 }));
  check('older event does not rewind lastActivityAt', sink.counts().lastActivityAt, 400);
}

console.log(`review-counts: ${failures === 0 ? 'all cases passed' : `${failures} failed`}`);
if (failures > 0) process.exitCode = 1;
