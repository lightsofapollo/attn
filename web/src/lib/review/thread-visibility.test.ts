// Manual harness for thread visibility.
//
//   cd web && npx tsx src/lib/review/thread-visibility.test.ts

import { isThreadActive } from './thread-visibility';

let failed = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`PASS ${msg}`);
  else {
    failed += 1;
    console.error(`FAIL ${msg}`);
  }
}

const none: ReadonlySet<string> = new Set();

assert(isThreadActive({ id: 't1', resolved: false }, none), 'an open, un-dismissed thread is active');
assert(!isThreadActive({ id: 't1', resolved: true }, none), 'a resolved thread is hidden');
assert(
  !isThreadActive({ id: 't1', resolved: false }, new Set(['t1'])),
  'a locally-dismissed thread is hidden (Resolve/Reject clicked) — not left visible with dead buttons',
);
assert(
  isThreadActive({ id: 't2', resolved: false }, new Set(['t1'])),
  'dismissing one thread does not hide another',
);

process.exit(failed > 0 ? 1 : 0);
