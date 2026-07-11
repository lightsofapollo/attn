import type { BrowserCollabDelivery } from './browser-session';
import {
  BROWSER_OWNER_OFFLINE_STATUS,
  BrowserReviewerCollabGate,
  MAX_BROWSER_REVIEWER_COLLAB_WAITERS,
  browserReviewerAvailability,
  browserReviewerViewMatchesEpoch,
  rememberAuthenticatedOwnerDevice,
} from './browser-review-collab';

interface CaseResult { name: string; ok: boolean; detail?: string }
const cases: Array<() => Promise<CaseResult>> = [];

function defineCase(name: string, run: () => void | Promise<void>): void {
  cases.push(async () => {
    try {
      await run();
      return { name, ok: true };
    } catch (error) {
      return { name, ok: false, detail: error instanceof Error ? error.stack : String(error) };
    }
  });
}

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

function delivery(index: number): BrowserCollabDelivery {
  return {
    envelopeId: `delivery-${index}`,
    source: 'network',
    payload: JSON.stringify({ kind: 'resync', fileId: 'file', epoch: 'snapshot' }),
    sender: {
      deviceId: 'owner-device', participantId: 'owner', kind: 'owner',
      client: 'attn-browser', publicEncryptionKey: 'key', publicSigningKey: 'key',
      selfSignature: 'signature',
    },
  };
}

defineCase('owner offline disables live editing without disabling durable review authoring', () => {
  const availability = browserReviewerAvailability({
    hasMarkdownSnapshot: true,
    ownerOnline: false,
    liveEditingAvailable: false,
    authoringReady: true,
  });
  assert(availability.collabReady, 'offline snapshot lost collab readiness');
  assert(!availability.liveEditing, 'offline owner left document editable');
  assert(availability.reviewAuthoring, 'offline owner disabled review authoring');
  assert(availability.ownerStatus === BROWSER_OWNER_OFFLINE_STATUS, 'offline status copy drifted');
});

defineCase('authenticated owner presence enables epoch-bound editing', () => {
  const availability = browserReviewerAvailability({
    hasMarkdownSnapshot: true,
    ownerOnline: true,
    liveEditingAvailable: true,
    authoringReady: true,
  });
  assert(availability.liveEditing, 'online owner did not enable live editing');
  assert(availability.ownerStatus === null, 'online owner retained offline status');
});

defineCase('only directory-authenticated owner deliveries enter the authority device set', () => {
  const owners = new Set<string>();
  assert(rememberAuthenticatedOwnerDevice(owners, delivery(1)), 'owner delivery was not accepted');
  const reviewer = delivery(2);
  reviewer.sender.kind = 'reviewer';
  assert(!rememberAuthenticatedOwnerDevice(owners, reviewer), 'reviewer delivery became authoritative');
  assert(owners.size === 1 && owners.has('owner-device'), 'authority device set drifted');
});

defineCase('new epoch cannot bind the prior epoch editor view', () => {
  assert(browserReviewerViewMatchesEpoch(4, 4), 'matching editor epoch was rejected');
  assert(!browserReviewerViewMatchesEpoch(4, 5), 'prior editor epoch was accepted');
  assert(!browserReviewerViewMatchesEpoch(-1, 0), 'unmounted editor epoch was accepted');
});

defineCase('gate waits for controller bind and rebinds deliveries after epoch reset', async () => {
  const routed: string[] = [];
  const gate = new BrowserReviewerCollabGate();
  const first = gate.route(delivery(1));
  let firstSettled = false;
  void first.then(() => { firstSettled = true; });
  await Promise.resolve();
  assert(!firstSettled, 'delivery resolved before controller bind');
  gate.bind((item) => routed.push(`old:${item.envelopeId}`));
  await first;
  gate.reset();
  const second = gate.route(delivery(2));
  gate.bind((item) => routed.push(`new:${item.envelopeId}`));
  await second;
  assert(routed.join(',') === 'old:delivery-1,new:delivery-2', 'epoch rebind routing');
});

defineCase('gate rejects overflow and close keeps waiting delivery retryable', async () => {
  let overflowVisible = false;
  const gate = new BrowserReviewerCollabGate(() => { overflowVisible = true; });
  const waiting: Promise<boolean>[] = [];
  for (let index = 0; index < MAX_BROWSER_REVIEWER_COLLAB_WAITERS; index += 1) {
    waiting.push(gate.route(delivery(index)).then(() => false, () => true));
  }
  const overflow = await gate.route(delivery(999)).then(() => false, () => true);
  assert(overflow && overflowVisible, 'gate overflow was not surfaced');
  gate.close();
  assert((await Promise.all(waiting)).every(Boolean), 'closed waiters were marked dispatched');
});

async function run(): Promise<void> {
  let passed = 0;
  const failures: string[] = [];
  for (const test of cases) {
    const result = await test();
    if (result.ok) {
      passed += 1;
      console.log(`PASS ${result.name}`);
    } else {
      failures.push(`${result.name}: ${result.detail ?? ''}`);
      console.error(`FAIL ${result.name}\n${result.detail ?? ''}`);
    }
  }
  console.log(`browser-review-collab: ${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) process.exitCode = 1;
}

void run();
