import { reviewerLifecyclePresentation } from './reviewer-lifecycle';

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

const cases = [
  'invite_invalid',
  'admission_rejected',
  'room_deleted',
  'room_expired',
  'cursor_too_old',
  'share_revoked',
  'device_register',
  'network',
] as const;

for (const kind of cases) {
  const state = reviewerLifecyclePresentation({ kind });
  assert(state.title.length > 0, `${kind}: title`);
  assert(state.diagnosis.length > 0, `${kind}: diagnosis`);
  assert(state.privacyNote.length > 0, `${kind}: privacy note`);
  assert(!/relay|remembered room/iu.test(state.diagnosis), `${kind}: internal wording leaked`);
}

assert(reviewerLifecyclePresentation({ kind: 'invite_invalid' }).canPasteInvite, 'invalid link can recover');
assert(reviewerLifecyclePresentation({ kind: 'cursor_too_old' }).canPasteInvite, 'expired cursor can recover');
assert(!reviewerLifecyclePresentation({ kind: 'room_deleted' }).canPasteInvite, 'deleted room does not pretend to recover');
assert(reviewerLifecyclePresentation({ kind: 'network' }).canRetry, 'network error can retry');
assert(!reviewerLifecyclePresentation({ kind: 'room_expired' }).canRetry, 'expired room does not pretend to retry');
assert(reviewerLifecyclePresentation(null).title === 'Opening your review', 'loading presentation');

console.log('reviewer lifecycle: all cases passed');
