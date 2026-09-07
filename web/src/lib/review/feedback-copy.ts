import type { FeedbackRoute, ReviewEvent, ReviewSnapshot, Thread } from '../types';

export interface FeedbackCopyContext {
  routes: Record<string, FeedbackRoute>;
  snapshots: ReviewSnapshot[];
  events: ReviewEvent[];
  displayNameFor(participantId: string): string;
  kindFor(participantId: string): 'owner' | 'reviewer' | 'agent';
}

export function markedFeedbackThreads(
  threads: Thread[],
  routes: Record<string, FeedbackRoute>,
): Thread[] {
  return threads.filter((thread) => !thread.resolved && routes[thread.id]?.marked === true);
}

export function serializeFeedbackThreads(
  threads: Thread[],
  context: FeedbackCopyContext,
): string {
  const ordered = [...threads].sort((a, b) => {
    const aPath = sourcePath(a, context.snapshots);
    const bPath = sourcePath(b, context.snapshots);
    return aPath.localeCompare(bPath)
      || (a.anchor?.position.byteRange[0] ?? 0) - (b.anchor?.position.byteRange[0] ?? 0)
      || a.id.localeCompare(b.id);
  });
  const project = ordered
    .map((thread) => sourcePath(thread, context.snapshots))
    .find((path) => path.length > 0) ?? 'current attn project';
  const lines = [
    '# attn feedback v1',
    `Scope: ${project}`,
    '',
    'Address this feedback in the available source files. Verify every quote against the current file before editing. Report changes and unresolved questions by feedback ID.',
  ];
  if (ordered.length === 0) {
    lines.push('', 'No marked, unresolved feedback in this scope.');
    return `${lines.join('\n')}\n`;
  }
  for (const thread of ordered) {
    const root = thread.rootEvent;
    if (root.body.type !== 'comment_created') continue;
    const route = context.routes[thread.id];
    const author = context.displayNameFor(root.meta.authorId);
    const humanFollowups = thread.replies.filter(
      (reply) => context.kindFor(reply.meta.authorId) !== 'agent',
    ).length;
    const lifecycleTransitions = context.events.filter(
      (event) => event.meta.roomId === root.meta.roomId
        && ((event.body.type === 'comment_resolved' || event.body.type === 'comment_reopened')
          && event.body.threadId === thread.id),
    ).length;
    const anchor = root.body.anchor;
    lines.push(
      '',
      '---',
      '',
      `[${root.meta.roomId}:${thread.id}] ${sourcePath(thread, context.snapshots)}`,
      `Thread: ${thread.id} · Revision: ${(route?.revision ?? 0) + humanFollowups + lifecycleTransitions} · Snapshot: ${anchor.snapshotId}`,
      `File ID: ${anchor.fileId}`,
    );
    if (anchor.html) {
      lines.push(`Anchor: rendered HTML · selector ${anchor.html.cssSelector}`);
    } else {
      lines.push(`Anchor: source lines ${anchor.position.lineRange[0]}-${anchor.position.lineRange[1]} · bytes ${anchor.position.byteRange[0]}-${anchor.position.byteRange[1]}`);
    }
    lines.push(currentResolutionLine(thread));
    const quote = anchor.quote?.exact.trim();
    if (quote) lines.push('', ...quote.split('\n').map((line) => `> ${line}`));
    lines.push('', `Request (${author}): ${root.body.body}`);
    for (const reply of thread.replies) {
      if (reply.body.type !== 'comment_created') continue;
      lines.push('', `Reply (${context.displayNameFor(reply.meta.authorId)} · ${context.kindFor(reply.meta.authorId)}): ${reply.body.body}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

function currentResolutionLine(thread: Thread): string {
  const resolution = thread.resolvedAnchor;
  if (resolution === null) return 'Current anchor: unresolved';
  if (resolution.status === 'ambiguous') {
    return `Current anchor: ambiguous · ${resolution.candidates.length} candidate${resolution.candidates.length === 1 ? '' : 's'}`;
  }
  if (resolution.status === 'stale') return `Current anchor: stale · ${resolution.reason}`;

  const range = resolution.currentRange;
  if (thread.anchor?.html) {
    return `Current rendered anchor: ${resolution.status} · text lines ${range.lineRange[0]}-${range.lineRange[1]} · offsets ${range.byteRange[0]}-${range.byteRange[1]}`;
  }
  return `Current source anchor: ${resolution.status} · lines ${range.lineRange[0]}-${range.lineRange[1]} · bytes ${range.byteRange[0]}-${range.byteRange[1]}`;
}

function sourcePath(thread: Thread, snapshots: ReviewSnapshot[]): string {
  const anchor = thread.anchor;
  const snapshot = snapshots.find(
    (item) => item.roomId === thread.rootEvent.meta.roomId
      && item.snapshotId === anchor?.snapshotId,
  ) ?? snapshots.find(
    (item) => item.roomId === thread.rootEvent.meta.roomId
      && item.fileId === anchor?.fileId,
  );
  return snapshot?.ownerDisplayPath ?? anchor?.fileId ?? 'unknown source';
}
