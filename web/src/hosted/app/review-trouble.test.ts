// The point of review-trouble.ts is that no engine string ever reaches a
// reader, so that is what these assert: every classification, and — the case
// that actually shipped — that the fallback still refuses to print the raw
// message as the explanation.
//
// Run with:
//
//   cd web && npx tsx src/hosted/app/review-trouble.test.ts

import { describeReviewTrouble } from './review-trouble';

const SHARING = { sharing: true } as const;

let failed = 0;

function check(name: string, run: () => void): void {
  try {
    run();
    console.log(`PASS ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${name}`);
    console.error(`  ${error instanceof Error ? error.message : String(error)}`);
  }
}

check('a moved workspace head reads as catching up, not as failure', () => {
  const trouble = describeReviewTrouble('published source revision moved before promotion', SHARING);
  if (trouble.kind !== 'catching-up') throw new Error(`kind was ${trouble.kind}`);
  if (!trouble.transient) throw new Error('a head-moved conflict clears itself and must be transient');
  if (!/latest edits/iu.test(trouble.title)) throw new Error(`title was ${trouble.title}`);
  // The whole defect: the owner read this sentence in the product.
  if (trouble.body.includes('source revision')) throw new Error('engine wording leaked into the body');
  if (trouble.chip.length > 16) throw new Error(`chip too long for the header: ${trouble.chip}`);
});

check('every head-moved gate string classifies the same way', () => {
  for (const message of [
    'published source revision moved before promotion',
    'published source revision is no longer a live workspace head',
    'published source revision is not a live workspace head',
    'published source revision moved or mismatches content',
  ]) {
    const trouble = describeReviewTrouble(message, SHARING);
    if (trouble.kind !== 'catching-up') throw new Error(`${message} -> ${trouble.kind}`);
  }
});

check('an unattached outbox reads as reconnecting', () => {
  const trouble = describeReviewTrouble('browser owner publication outbox is unavailable', SHARING);
  if (trouble.kind !== 'reconnecting') throw new Error(`kind was ${trouble.kind}`);
  if (!trouble.transient) throw new Error('a connecting tab is transient');
  if (trouble.body.includes('outbox')) throw new Error('engine wording leaked into the body');
});

check('an expired room offers a restart and is not transient', () => {
  const trouble = describeReviewTrouble(
    'The review room expired and could not be re-provisioned: relay 410',
    SHARING,
  );
  if (trouble.kind !== 'room-expired') throw new Error(`kind was ${trouble.kind}`);
  if (trouble.transient) throw new Error('an expired room needs a deliberate restart');
  if (!trouble.body.includes('same link')) throw new Error('must say the share link still works');
});

check('a runtime that gave up stops promising the problem will clear itself', () => {
  const raw = 'published source revision moved before promotion';
  const live = describeReviewTrouble(raw, { sharing: true });
  const dead = describeReviewTrouble(raw, { sharing: false, exhausted: true });
  if (!live.transient) throw new Error('still-attached trouble is transient');
  if (dead.transient) throw new Error('an exhausted runtime retries nothing; nothing is in progress');
  if (/on its own/iu.test(dead.body)) throw new Error('exhausted copy must not promise self-healing');
  if (!/reload/iu.test(dead.body)) throw new Error('exhausted copy must name the action that helps');

  const outbox = describeReviewTrouble('browser owner publication outbox is unavailable', {
    sharing: false,
    exhausted: true,
  });
  if (outbox.transient) throw new Error('an exhausted connect attempt is not in progress either');
});

check('the raw message is kept for reporting, never for explaining', () => {
  const raw = 'published source revision moved before promotion';
  const trouble = describeReviewTrouble(raw, SHARING);
  if (trouble.detail !== raw) throw new Error('the engine string must survive for bug reports');
});

check('an unclassified reason still refuses to print itself as the reason', () => {
  const trouble = describeReviewTrouble('ENOTAVERB widget 0x2f collapsed', SHARING);
  if (trouble.kind !== 'unknown') throw new Error(`kind was ${trouble.kind}`);
  if (trouble.body.includes('ENOTAVERB')) throw new Error('fallback leaked the raw string into the body');
  if (trouble.detail !== 'ENOTAVERB widget 0x2f collapsed') throw new Error('detail must still carry it');
});

check('a missing reason produces no empty technical disclosure', () => {
  for (const reason of [null, undefined, '   ']) {
    const trouble = describeReviewTrouble(reason, SHARING);
    if (trouble.detail !== null) throw new Error(`detail was ${JSON.stringify(trouble.detail)}`);
  }
});

check('not sharing yet says sharing, not review', () => {
  const trouble = describeReviewTrouble('something opaque', { sharing: false });
  if (!trouble.title.toLowerCase().includes('sharing')) throw new Error(trouble.title);
  const shared = describeReviewTrouble('something opaque', SHARING);
  if (!shared.title.toLowerCase().includes('review')) throw new Error(shared.title);
});

console.log(`review-trouble: ${failed === 0 ? 'all cases passed' : `${failed} failed`}`);
if (failed > 0) process.exit(1);
