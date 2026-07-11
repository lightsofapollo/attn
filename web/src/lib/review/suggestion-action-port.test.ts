import {
  isSuggestionDeliveryPending,
  runSuggestionAction,
  selectSuggestionActionPort,
  shouldDismissSuggestionAfterAction,
  type SuggestionActionFeedback,
  type SuggestionActionPort,
} from './suggestion-action-port';

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function equal<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

async function main(): Promise<void> {
  let nativeCalls = 0;
  const native: SuggestionActionPort<string> = {
    accept: () => { nativeCalls += 1; },
    reject: () => { nativeCalls += 1; },
  };

  const nativeSelected = selectSuggestionActionPort(undefined, native);
  await nativeSelected.accept?.('thread-a');
  equal(nativeCalls, 1, 'omitted port preserves native default');

  const unavailable = selectSuggestionActionPort({}, native);
  equal(unavailable.accept, undefined, 'explicit empty hosted port has no accept action');
  equal(unavailable.reject, undefined, 'explicit empty hosted port has no reject action');
  equal(nativeCalls, 1, 'empty hosted port never falls through to native');

  let injectedCalls = 0;
  const injected = selectSuggestionActionPort({
    accept: () => { injectedCalls += 1; },
  }, native);
  await injected.accept?.('thread-b');
  equal(injectedCalls, 1, 'injected action selected');
  equal(nativeCalls, 1, 'injected action bypasses native');

  let release: ((value: unknown) => void) | undefined;
  const deferred = new Promise<unknown>((resolve) => { release = resolve; });
  const feedback: SuggestionActionFeedback[] = [];
  const running = runSuggestionAction(
    () => deferred,
    'accept',
    (next) => feedback.push(next),
  );
  equal(feedback[0]?.status, 'pending', 'pending reported before callback settles');
  assert(feedback[0]?.status === 'pending' && feedback[0].action === 'accept', 'pending action identified');
  equal(feedback.length, 1, 'no premature completion feedback');
  release?.({ deliveryPending: false });
  await running;
  equal(feedback.at(-1)?.status, 'idle', 'successful delivery clears pending state');

  const deliveryFeedback: SuggestionActionFeedback[] = [];
  await runSuggestionAction(
    () => ({ deliveryPending: true, deliveryError: 'relay unavailable' }),
    'reject',
    (next) => deliveryFeedback.push(next),
  );
  equal(deliveryFeedback.at(-1)?.status, 'delivery_pending', 'durable local decision reports pending delivery');
  const deliveredLater = deliveryFeedback.at(-1);
  assert(
    deliveredLater?.status === 'delivery_pending'
      && deliveredLater.message.includes('relay unavailable'),
    'delivery detail remains visible',
  );
  assert(isSuggestionDeliveryPending({ deliveryPending: true }), 'delivery-pending result detected');
  assert(!isSuggestionDeliveryPending({ status: 'committed' }), 'ordinary result is fully delivered');
  assert(
    shouldDismissSuggestionAfterAction({ status: 'committed', deliveryPending: true }),
    'durable pending delivery dismisses while the outbox owns retry',
  );
  assert(
    shouldDismissSuggestionAfterAction({ deliveryPending: false }),
    'fully delivered decision may dismiss the card',
  );
  assert(
    !shouldDismissSuggestionAfterAction({ status: 'needs_review' }),
    'needs-review result remains active for owner input',
  );

  const errorFeedback: SuggestionActionFeedback[] = [];
  await runSuggestionAction(
    () => { throw new Error('lease lost'); },
    'reject',
    (next) => errorFeedback.push(next),
  );
  equal(errorFeedback.at(-1)?.status, 'error', 'callback failure reported as error');
  const failed = errorFeedback.at(-1);
  assert(
    failed?.status === 'error'
      && failed.message === 'lease lost',
    'callback error remains honest and actionable',
  );

  console.log('  ok  suggestion action port selection and feedback');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
