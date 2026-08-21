import { createReviewCountingSink, EMPTY_REVIEW_COUNTS } from './review-counts';
import { reconstructThreads } from './selectors';
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

// Reopening puts the thread back in the open count (attn-bb6t.4).
{
  const sink = createReviewCountingSink();
  sink.applyEvent(event({ type: 'comment_created', threadId: 't1', anchor, body: 'a' } as ReviewEventBody));
  sink.applyEvent(event({ type: 'comment_resolved', threadId: 't1' } as ReviewEventBody));
  check('resolved thread leaves the open count', sink.counts().openComments, 0);
  sink.applyEvent(event({ type: 'comment_reopened', threadId: 't1' } as ReviewEventBody));
  check('reopening restores the open count', sink.counts().openComments, 1);
  sink.applyEvent(event({ type: 'comment_reopened', threadId: 't1' } as ReviewEventBody));
  check('reopening twice does not double-count', sink.counts().openComments, 1);
}

// Only a comment thread reopens (attn-1l2f.1). A `comment_reopened` carrying a
// suggestion id must not inflate the open-comment badge with an edit the owner
// already decided.
{
  const sink = createReviewCountingSink();
  sink.applyEvent(event({ type: 'suggestion_created', suggestionId: 's1', anchor, operation: anchor } as ReviewEventBody));
  sink.applyEvent(event({ type: 'suggestion_accepted', suggestionId: 's1', appliedRevisionId: 'r1' } as ReviewEventBody));
  sink.applyEvent(event({ type: 'comment_reopened', threadId: 's1' } as ReviewEventBody));
  check('a reopen naming a suggestion is not an open comment', sink.counts().openComments, 0);
  check('and does not put the suggestion back in pending', sink.counts().pendingSuggestions, 0);
}

// Events arrive out of order across replay and live delivery, so the guard
// cannot depend on having seen the suggestion first.
{
  const sink = createReviewCountingSink();
  sink.applyEvent(event({ type: 'comment_reopened', threadId: 's1' } as ReviewEventBody));
  sink.applyEvent(event({ type: 'suggestion_created', suggestionId: 's1', anchor, operation: anchor } as ReviewEventBody));
  check('a suggestion id leaked by an early reopen is reclaimed', sink.counts().openComments, 0);
  check('the suggestion still counts as pending', sink.counts().pendingSuggestions, 1);
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

// Delivery order is not log order (attn-e9r2.4). Replay and live delivery
// interleave peers, so a NEWER reopen can arrive before the OLDER resolve it
// supersedes. Folding in arrival order left the thread closed here while the
// rail — which folds last-writer-wins — showed it open, so the desk badge
// disagreed with the surface it links to. The rail is the reference: every
// case below asserts the count equals what `reconstructThreads` reconstructs
// from the same events.
function openCommentsPerRail(events: ReviewEvent[]): number {
  return reconstructThreads(events, {}).filter((thread) => !thread.resolved).length;
}

function feed(events: ReviewEvent[]): ReturnType<typeof createReviewCountingSink> {
  const sink = createReviewCountingSink();
  for (const item of events) sink.applyEvent(item);
  return sink;
}

{
  // The reopen is newer (t=3) but lands first; the resolve it supersedes
  // arrives late.
  const events = [
    event({ type: 'comment_created', threadId: 't1', anchor, body: 'a' } as ReviewEventBody, { id: 'a', at: 1 }),
    event({ type: 'comment_reopened', threadId: 't1' } as ReviewEventBody, { id: 'c', at: 3 }),
    event({ type: 'comment_resolved', threadId: 't1' } as ReviewEventBody, { id: 'b', at: 2 }),
  ];
  check('a late older resolve does not close a reopened thread', feed(events).counts().openComments, 1);
  check('and the rail agrees', openCommentsPerRail(events), 1);
}

{
  // Same three events in log order: the resolve is newest and wins.
  const events = [
    event({ type: 'comment_created', threadId: 't1', anchor, body: 'a' } as ReviewEventBody, { id: 'a', at: 1 }),
    event({ type: 'comment_reopened', threadId: 't1' } as ReviewEventBody, { id: 'b', at: 2 }),
    event({ type: 'comment_resolved', threadId: 't1' } as ReviewEventBody, { id: 'c', at: 3 }),
  ];
  check('a newer resolve closes a reopened thread', feed(events).counts().openComments, 0);
  check('and the rail agrees', openCommentsPerRail(events), 0);
}

{
  // Same wall clock on both sides of the decision: event id is the tiebreak,
  // and it has to be the SAME tiebreak the rail uses or the two disagree on
  // exactly the events a fast reviewer generates.
  const events = [
    event({ type: 'comment_created', threadId: 't1', anchor, body: 'a' } as ReviewEventBody, { id: 'a', at: 1 }),
    event({ type: 'comment_reopened', threadId: 't1' } as ReviewEventBody, { id: 'z-reopen', at: 9 }),
    event({ type: 'comment_resolved', threadId: 't1' } as ReviewEventBody, { id: 'a-resolve', at: 9 }),
  ];
  check('same-timestamp lifecycle breaks the tie by event id', feed(events).counts().openComments, 1);
  check('and the rail agrees', openCommentsPerRail(events), 1);
}

{
  // A thread nobody ever opened is not an open comment. The count is rooted in
  // `comment_created`, exactly like the rail's thread list — a stray reopen
  // (an older client, a replayed log) cannot invent a thread out of nothing.
  const events = [
    event({ type: 'comment_reopened', threadId: 'ghost' } as ReviewEventBody, { id: 'a', at: 1 }),
  ];
  check('a reopen with no thread behind it counts nothing', feed(events).counts().openComments, 0);
  check('and the rail agrees', openCommentsPerRail(events), 0);
}

{
  // A suggestion decided out of order: the accept is newer than the create it
  // answers, but arrives first. Arrival-order folding put it back in pending.
  const sink = feed([
    event({ type: 'suggestion_accepted', suggestionId: 's1', appliedRevisionId: 'r1' } as ReviewEventBody, { id: 'b', at: 2 }),
    event({ type: 'suggestion_created', suggestionId: 's1', anchor, operation: anchor } as ReviewEventBody, { id: 'a', at: 1 }),
  ]);
  check('a late suggestion_created does not un-decide the suggestion', sink.counts().pendingSuggestions, 0);
}

console.log(`review-counts: ${failures === 0 ? 'all cases passed' : `${failures} failed`}`);
if (failures > 0) process.exitCode = 1;
