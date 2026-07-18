// Contract tests for reviewer-status-model.ts — the single status-chip
// presentation on the hosted reviewer surface. The load-bearing contract is
// that EVERY transient session state folds into the chip + popover lines
// (fixed-size chrome) instead of inline header text, because inline text is
// what made the document column jump on every posted comment.
//
// Run with:  cd web && npx tsx src/lib/review/reviewer-status-model.test.ts

import {
  reviewerStatusPresentation,
  reviewerTierLabel,
  type ReviewerStatusInput,
} from './reviewer-status-model';

interface CaseResult {
  name: string;
  ok: boolean;
  detail?: string;
}

const cases: Array<() => CaseResult> = [];

function defineCase(name: string, fn: () => void | string): void {
  cases.push(() => {
    try {
      const note = fn();
      return { name, ok: true, detail: typeof note === 'string' ? note : undefined };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { name, ok: false, detail: message };
    }
  });
}

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function input(overrides: Partial<ReviewerStatusInput> = {}): ReviewerStatusInput {
  return {
    connection: 'mailbox',
    ownerOnline: true,
    outboxPending: 0,
    authoringError: null,
    hasSnapshot: true,
    authoringReady: true,
    grantTier: 'comment',
    ...overrides,
  };
}

defineCase('healthy relay session presents as Connected with no notes', () => {
  const p = reviewerStatusPresentation(input());
  assert(p.label === 'Connected', `label ${p.label}`);
  assert(p.tone === 'connected', `tone ${p.tone}`);
  assert(p.notes.length === 0, 'no transient notes');
  assert(!p.canRetry, 'no retry action when healthy');
});

defineCase('live_direct presents as Live; direct_failed still reads Connected', () => {
  const live = reviewerStatusPresentation(input({ connection: 'live_direct' }));
  assert(live.label === 'Live', 'live');
  // The hosted share path flags live whenever the owner broadcasts — which
  // may be relay-mediated — so the reviewer detail never claims a mechanism.
  assert(!/peer-to-peer|p2p|datachannel/i.test(live.detail), 'no transport mechanism claim');
  const failed = reviewerStatusPresentation(input({ connection: 'direct_failed' }));
  assert(failed.label === 'Connected', 'direct_failed is not an error to the user');
  assert(!/fail|error/i.test(failed.label), 'no failure language');
});

defineCase('offline keeps feedback-is-kept reassurance, no transport jargon', () => {
  const p = reviewerStatusPresentation(input({ connection: 'offline' }));
  assert(p.label === 'Offline', `label ${p.label}`);
  assert(/kept|saved/i.test(p.detail), 'detail reassures feedback is kept');
  assert(!/mailbox|relay|webrtc|datachannel/i.test(p.detail), 'no transport jargon');
});

defineCase('outbox pending becomes a popover note, never a label change', () => {
  const one = reviewerStatusPresentation(input({ outboxPending: 1 }));
  assert(one.label === 'Connected', 'label stays the status word');
  assert(one.notes.some((n) => n.includes('1 item')), `notes ${JSON.stringify(one.notes)}`);
  const many = reviewerStatusPresentation(input({ outboxPending: 3 }));
  assert(many.notes.some((n) => n.includes('3 items')), 'pluralizes');
});

defineCase('owner away is a note gated on having content', () => {
  const away = reviewerStatusPresentation(input({ ownerOnline: false }));
  assert(away.notes.some((n) => /owner is away/i.test(n)), 'note present');
  assert(away.label === 'Connected', 'owner presence never changes the connection word');
  const preSnapshot = reviewerStatusPresentation(input({ ownerOnline: false, hasSnapshot: false }));
  assert(!preSnapshot.notes.some((n) => /owner/i.test(n)), 'suppressed before first snapshot');
});

defineCase('authoring error escalates to Sync issue with a retry action', () => {
  const p = reviewerStatusPresentation(input({ authoringError: 'sealed envelope rejected', outboxPending: 2 }));
  assert(p.label === 'Sync issue', `label ${p.label}`);
  assert(p.tone === 'attention', `tone ${p.tone}`);
  assert(p.canRetry, 'retry offered');
  assert(p.notes.some((n) => n.includes('2 items')), 'pending note kept alongside');
  assert(/kept on this device/i.test(p.detail), 'reassures nothing is lost');
});

defineCase('authoring warm-up is a note for writable tiers only', () => {
  const warming = reviewerStatusPresentation(input({ authoringReady: false }));
  assert(warming.notes.some((n) => /preparing/i.test(n)), 'note while warming');
  const viewer = reviewerStatusPresentation(input({ authoringReady: false, grantTier: 'view' }));
  assert(!viewer.notes.some((n) => /preparing/i.test(n)), 'view-only never sees it');
  const errored = reviewerStatusPresentation(input({ authoringReady: false, authoringError: 'x' }));
  assert(!errored.notes.some((n) => /preparing/i.test(n)), 'error supersedes warm-up note');
});

defineCase('tier labels are user language', () => {
  assert(reviewerTierLabel('view') === 'View only', 'view');
  assert(reviewerTierLabel('comment') === 'Can comment', 'comment');
  assert(/suggest/i.test(reviewerTierLabel('suggest')), 'suggest');
});

function main(): void {
  let failed = 0;
  for (const run of cases) {
    const result = run();
    const status = result.ok ? 'PASS' : 'FAIL';
    const detail = result.detail ? ` — ${result.detail}` : '';
    console.log(`${status}  ${result.name}${detail}`);
    if (!result.ok) failed += 1;
  }
  console.log(`\n${cases.length - failed}/${cases.length} passed`);
  if (failed > 0) process.exit(1);
}

main();
