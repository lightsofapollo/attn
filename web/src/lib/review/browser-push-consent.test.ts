import { indexedDB as fakeIndexedDB } from 'fake-indexeddb';
import { base64UrlEncode } from './browser-crypto';
import {
  BrowserPushConsentController,
  type BrowserPushBindingContext,
} from './browser-push-consent';
import { getPushBinding, hasPushBinding, PUSH_DB_NAME } from './browser-push-worker';
import type { Device } from './browser-ws';

interface Case { name: string; run: () => void | Promise<void> }
const cases: Case[] = [];
function test(name: string, run: Case['run']): void { cases.push({ name, run }); }
function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }

const SHARE_ID = 'share-consent';
const BUNDLE_ID = 'abcdefghijklmnopqrstuv';
const DEVICE_ID = 'browser-reviewer';
const OWNER_KEY = base64UrlEncode(new Uint8Array(32).fill(4));
let lockTail = Promise.resolve();
const testLocks = { request: async <T>(_name: string, callback: () => Promise<T>): Promise<T> => {
  const prior = lockTail; let release!: () => void; lockTail = new Promise<void>(resolve => { release = resolve; });
  await prior; try { return await callback(); } finally { release(); }
} };
const owner: Device = {
  deviceId: 'owner-device', participantId: 'owner', publicEncryptionKey: base64UrlEncode(new Uint8Array(32).fill(5)),
  publicSigningKey: OWNER_KEY, client: 'attn-native', kind: 'owner', selfSignature: base64UrlEncode(new Uint8Array(64).fill(6)),
};

function context(): BrowserPushBindingContext {
  return {
    shareId: SHARE_ID, bundleId: BUNDLE_ID, roomId: 'room-consent', epoch: 2, revision: 3,
    manifestDigest: base64UrlEncode(new Uint8Array(32).fill(3)),
    deviceId: DEVICE_ID, relayUrl: 'https://relay.example',
    roomReadCapabilityBytes: new Uint8Array(32).fill(7),
    readAdmissionKeyBytes: new Uint8Array(32).fill(8),
    writeAdmissionKeyBytes: new Uint8Array(32).fill(9),
    deviceSigningSecretBytes: new Uint8Array(32).fill(10),
    deviceRegistration: {
      deviceId: DEVICE_ID, participantId: 'participant-reviewer',
      publicSigningKey: base64UrlEncode(new Uint8Array(32).fill(11)),
      publicEncryptionKey: base64UrlEncode(new Uint8Array(32).fill(12)),
      client: 'attn-browser', kind: 'reviewer', grantTier: 'comment',
      grantSignature: base64UrlEncode(new Uint8Array(64).fill(13)),
      selfSignature: base64UrlEncode(new Uint8Array(64).fill(14)),
    },
    ownerSigningKey: OWNER_KEY, devices: [owner], fileName: 'plan.md',
  };
}

function contextFor(bundleId: string, deviceId: string): BrowserPushBindingContext {
  const value = context();
  return { ...value, bundleId, deviceId, deviceRegistration: { ...value.deviceRegistration, deviceId } };
}

async function resetDb(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = fakeIndexedDB.deleteDatabase(PUSH_DB_NAME);
    request.onsuccess = () => resolve(); request.onerror = () => reject(request.error);
  });
}

function subscription(unsubscribe: () => Promise<boolean>): PushSubscription {
  return {
    endpoint: 'https://fcm.googleapis.com/fcm/send/consent-target', expirationTime: null,
    options: { userVisibleOnly: true, applicationServerKey: null }, unsubscribe,
    getKey: () => null,
    toJSON: () => ({ endpoint: 'https://fcm.googleapis.com/fcm/send/consent-target', expirationTime: null,
      keys: { p256dh: base64UrlEncode(Uint8Array.from([4, ...new Uint8Array(64).fill(10)])),
        auth: base64UrlEncode(new Uint8Array(16).fill(11)) } }),
  } as PushSubscription;
}

function registration(value: PushSubscription | null): ServiceWorkerRegistration {
  const pushManager = {
    getSubscription: async () => value,
    subscribe: async () => value ?? (() => { throw new Error('missing subscription'); })(),
  } as PushManager;
  return { pushManager } as ServiceWorkerRegistration;
}

test('permission starts before capability/network work, then POST remembers a non-extractable binding', async () => {
  await resetDb();
  const order: string[] = [];
  let permission: NotificationPermission = 'default';
  const sub = subscription(async () => true);
  const requests: Array<{ method: string; headers: Headers; body: string }> = [];
  const controller = new BrowserPushConsentController({
    notification: { get permission() { return permission; }, requestPermission: async () => {
      order.push('permission'); permission = 'granted'; return permission;
    } },
    navigator: { serviceWorker: { ready: Promise.resolve(registration(sub)) }, userAgent: 'Desktop', locks: testLocks },
    indexedDB: fakeIndexedDB,
    getBindingContext: async () => { order.push('context'); return context(); },
    mintPow: async () => 'v1:pow',
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input); const method = init?.method ?? 'GET';
      if (method === 'GET') return Response.json({ features: { push: true,
        vapidPublicKey: base64UrlEncode(Uint8Array.from([4, ...new Uint8Array(64).fill(12)])) } });
      requests.push({ method, headers: new Headers(init?.headers), body: String(init?.body ?? '') });
      return Response.json({ v: 3 }, { status: 201 });
    }) as typeof fetch,
  });
  await controller.enableFromUserGesture();
  assert(order.join(',') === 'permission,context', 'permission was not captured before async capability work');
  assert(controller.getState().status === 'on', `consent did not become enabled: ${JSON.stringify(controller.getState())}`);
  assert(requests.length === 1 && requests[0]!.method === 'POST', 'relay POST was not sent');
  assert(requests[0]!.headers.get('Attn-Device-Id') === DEVICE_ID, 'device binding header missing');
  assert(requests[0]!.headers.get('Attn-Share-Bundle') === BUNDLE_ID, 'bundle selector missing');
  assert(requests[0]!.headers.get('Attn-PoW') === 'v1:pow', 'PoW header missing');
  assert(requests[0]!.headers.get('Attn-Device-Proof')?.length === 86, 'device proof header missing');
  assert(requests[0]!.headers.get('Attn-Device-Registration') !== null, 'signed device registration missing');
  assert(JSON.parse(requests[0]!.body).v === 3, 'push subscription wire body is not v3');
  assert(await hasPushBinding(`share_${BUNDLE_ID}_${DEVICE_ID}`, fakeIndexedDB), 'worker binding was not remembered');
});

test('disable deletes relay binding, unsubscribes, and crypto-erases local binding', async () => {
  await resetDb();
  let unsubscribed = false;
  const sub = subscription(async () => { unsubscribed = true; return true; });
  const methods: string[] = [];
  const dependencies = {
    notification: { permission: 'granted' as const, requestPermission: async () => 'granted' as const },
    navigator: { serviceWorker: { ready: Promise.resolve(registration(sub)) }, userAgent: 'Desktop', locks: testLocks },
    indexedDB: fakeIndexedDB, getBindingContext: async () => context(), mintPow: async () => 'v1:pow',
    fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET'; methods.push(method);
      if (method === 'GET') return Response.json({ features: { push: true,
        vapidPublicKey: base64UrlEncode(Uint8Array.from([4, ...new Uint8Array(64).fill(13)])) } });
      return method === 'DELETE' ? new Response(null, { status: 204 }) : Response.json({}, { status: 201 });
    }) as typeof fetch,
  };
  const controller = new BrowserPushConsentController(dependencies);
  await controller.enableFromUserGesture();
  await controller.disableFromUserGesture();
  assert(methods.includes('DELETE'), 'relay DELETE was not sent');
  assert(unsubscribed, 'browser PushSubscription was not unsubscribed');
  assert(!await hasPushBinding(`share_${BUNDLE_ID}_${DEVICE_ID}`, fakeIndexedDB), 'worker binding survived disable');
  assert(controller.getState().status === 'off', 'disable did not settle off');
});

test('failed disable remains enabled and retries the full removal path', async () => {
  await resetDb();
  let deleteAttempts = 0; let unsubscribed = false;
  const sub = subscription(async () => { unsubscribed = true; return true; });
  const controller = new BrowserPushConsentController({
    notification: { permission: 'granted', requestPermission: async () => 'granted' },
    navigator: { serviceWorker: { ready: Promise.resolve(registration(sub)) }, userAgent: 'Desktop', locks: testLocks },
    indexedDB: fakeIndexedDB, getBindingContext: async () => context(), mintPow: async () => 'v1:pow',
    fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (method === 'GET') return Response.json({ features: { push: true,
        vapidPublicKey: base64UrlEncode(Uint8Array.from([4, ...new Uint8Array(64).fill(14)])) } });
      if (method === 'DELETE') {
        deleteAttempts += 1;
        return deleteAttempts === 1 ? Response.json({}, { status: 503 }) : new Response(null, { status: 204 });
      }
      return Response.json({}, { status: 201 });
    }) as typeof fetch,
  });
  await controller.enableFromUserGesture();
  await controller.disableFromUserGesture();
  assert(controller.getState().status === 'error' && controller.getState().enabled, 'failed disable lost enabled retry state');
  assert(!unsubscribed, 'local subscription changed before relay deletion succeeded');
  await controller.disableFromUserGesture();
  assert(deleteAttempts === 2 && unsubscribed && controller.getState().status === 'off', 'disable retry did not finish cleanup');
});

test('denied permission never reads capability state or sends a request', async () => {
  let contextCalls = 0; let fetchCalls = 0;
  const controller = new BrowserPushConsentController({
    notification: { permission: 'default', requestPermission: async () => 'denied' },
    navigator: { serviceWorker: { ready: Promise.resolve(registration(null)) }, userAgent: 'Desktop', locks: testLocks },
    getBindingContext: async () => { contextCalls += 1; return context(); },
    fetch: (async () => { fetchCalls += 1; return new Response(); }) as typeof fetch,
  });
  await controller.enableFromUserGesture();
  assert(controller.getState().status === 'denied', 'denial was not surfaced');
  assert(contextCalls === 0 && fetchCalls === 0, 'denied permission touched capability or network state');
});

test('view tier is rejected before permission even for programmatic facade calls', async () => {
  let requested = 0;
  const controller = new BrowserPushConsentController({ canEnable: () => false,
    notification: { permission: 'default', requestPermission: async () => { requested += 1; return 'granted'; } },
    navigator: { serviceWorker: { ready: Promise.resolve(registration(null)) }, userAgent: 'Desktop', locks: testLocks },
    getBindingContext: async () => context() });
  await controller.enableFromUserGesture();
  assert(requested === 0 && controller.getState().status === 'unsupported', 'view tier requested permission');
});

test('close fences a delayed context before relay POST or local persistence', async () => {
  await resetDb(); let release!: (value: BrowserPushBindingContext) => void; let posts = 0;
  const delayed = new Promise<BrowserPushBindingContext>(resolve => { release = resolve; });
  const controller = new BrowserPushConsentController({
    notification: { permission: 'granted', requestPermission: async () => 'granted' },
    navigator: { serviceWorker: { ready: Promise.resolve(registration(subscription(async () => true))) }, userAgent: 'Desktop', locks: testLocks },
    indexedDB: fakeIndexedDB, getBindingContext: async () => delayed,
    fetch: (async () => { posts += 1; return new Response(); }) as typeof fetch,
  });
  const enabling = controller.enableFromUserGesture(); controller.close(); release(context()); await enabling;
  assert(posts === 0 && !await hasPushBinding(`share_${BUNDLE_ID}_${DEVICE_ID}`, fakeIndexedDB), 'closed controller resurrected push state');
});

test('ambiguous POST failure performs authenticated idempotent DELETE and preserves no candidate', async () => {
  await resetDb(); const methods: string[] = [];
  const controller = new BrowserPushConsentController({
    notification: { permission: 'granted', requestPermission: async () => 'granted' },
    navigator: { serviceWorker: { ready: Promise.resolve(registration(subscription(async () => true))) }, userAgent: 'Desktop', locks: testLocks },
    indexedDB: fakeIndexedDB, getBindingContext: async () => context(), mintPow: async () => 'v1:pow',
    fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET'; methods.push(method);
      if (method === 'GET') return Response.json({ features: { push: true,
        vapidPublicKey: base64UrlEncode(Uint8Array.from([4, ...new Uint8Array(64).fill(16)])) } });
      if (method === 'POST') throw new TypeError('connection reset after send');
      return new Response(null, { status: 204 });
    }) as typeof fetch,
  });
  await controller.enableFromUserGesture();
  assert(methods.join(',') === 'GET,POST,DELETE', 'ambiguous POST was not cleaned up with DELETE');
  assert(!await hasPushBinding(`share_${BUNDLE_ID}_${DEVICE_ID}`, fakeIndexedDB), 'ambiguous POST persisted a local candidate');
});

test('late rotation fence restores the previous good local binding', async () => {
  await resetDb(); const sub = subscription(async () => true);
  const network = (async (_input: RequestInfo | URL, init?: RequestInit) => (init?.method ?? 'GET') === 'GET'
    ? Response.json({ features: { push: true, vapidPublicKey: base64UrlEncode(Uint8Array.from([4, ...new Uint8Array(64).fill(17)])) } })
    : (init?.method === 'DELETE' ? new Response(null, { status: 204 }) : Response.json({}, { status: 201 }))) as typeof fetch;
  const base = { notification: { permission: 'granted' as const, requestPermission: async () => 'granted' as const },
    navigator: { serviceWorker: { ready: Promise.resolve(registration(sub)) }, userAgent: 'Desktop', locks: testLocks },
    indexedDB: fakeIndexedDB, mintPow: async () => 'v1:pow', fetch: network };
  await new BrowserPushConsentController({ ...base, getBindingContext: async () => context() }).enableFromUserGesture();
  let fences = 0;
  const rotated = new BrowserPushConsentController({ ...base,
    getBindingContext: async () => ({ ...context(), epoch: 3, revision: 4,
      manifestDigest: base64UrlEncode(new Uint8Array(32).fill(18)) }),
    isBindingContextCurrent: () => ++fences < 3 });
  await rotated.enableFromUserGesture();
  const restored = await getPushBinding(`share_${BUNDLE_ID}_${DEVICE_ID}`, fakeIndexedDB);
  assert(restored?.epoch === 2 && restored.revision === 3, 'late failed rotation destroyed the previous good binding');
});

test('origin subscription stays active while another remembered binding remains', async () => {
  await resetDb(); let unsubscribed = 0;
  const sub = subscription(async () => { unsubscribed += 1; return true; });
  const make = (bundleId: string, deviceId: string) => new BrowserPushConsentController({
    notification: { permission: 'granted', requestPermission: async () => 'granted' },
    navigator: { serviceWorker: { ready: Promise.resolve(registration(sub)) }, userAgent: 'Desktop', locks: testLocks }, indexedDB: fakeIndexedDB,
    getBindingContext: async () => contextFor(bundleId, deviceId), mintPow: async () => 'v1:pow',
    fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => (init?.method ?? 'GET') === 'GET'
      ? Response.json({ features: { push: true, vapidPublicKey: base64UrlEncode(Uint8Array.from([4, ...new Uint8Array(64).fill(15)])) } })
      : (init?.method === 'DELETE' ? new Response(null, { status: 204 }) : Response.json({}, { status: 201 }))) as typeof fetch,
  });
  const first = make(BUNDLE_ID, DEVICE_ID); const second = make('bcdefghijklmnopqrstuvw', 'browser-two');
  await first.enableFromUserGesture(); await second.enableFromUserGesture(); await first.disableFromUserGesture();
  assert(unsubscribed === 0 && second.getState().enabled, 'disabling one binding unsubscribed the origin-global subscription');
  await second.disableFromUserGesture();
  assert(Number(unsubscribed) === 1, 'last binding did not unsubscribe the origin-global subscription');
});

test('cross-tab lock serializes concurrent enable publication before teardown recounts', async () => {
  await resetDb(); let releaseFirst!: () => void; let firstEntered!: () => void;
  const entered = new Promise<void>(resolve => { firstEntered = resolve; });
  const gate = new Promise<void>(resolve => { releaseFirst = resolve; }); let posts = 0;
  const sub = subscription(async () => true);
  const make = (bundleId: string, deviceId: string) => new BrowserPushConsentController({
    notification: { permission: 'granted', requestPermission: async () => 'granted' },
    navigator: { serviceWorker: { ready: Promise.resolve(registration(sub)) }, userAgent: 'Desktop', locks: testLocks },
    indexedDB: fakeIndexedDB, getBindingContext: async () => contextFor(bundleId, deviceId), mintPow: async () => 'v1:pow',
    fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (method === 'GET') return Response.json({ features: { push: true,
        vapidPublicKey: base64UrlEncode(Uint8Array.from([4, ...new Uint8Array(64).fill(19)])) } });
      if (method === 'POST' && ++posts === 1) { firstEntered(); await gate; }
      return Response.json({}, { status: 201 });
    }) as typeof fetch,
  });
  const one = make(BUNDLE_ID, DEVICE_ID); const two = make('cdefghijklmnopqrstuvwx', 'browser-three');
  const first = one.enableFromUserGesture(); await entered; const second = two.enableFromUserGesture();
  await Promise.resolve(); assert(posts === 1, 'second tab entered subscription publication without the global lock');
  releaseFirst(); await Promise.all([first, second]);
  assert((await getPushBinding(`share_${BUNDLE_ID}_${DEVICE_ID}`, fakeIndexedDB)) !== null &&
    (await getPushBinding('share_cdefghijklmnopqrstuvwx_browser-three', fakeIndexedDB)) !== null,
  'serialized concurrent enable lost a remembered binding');
});

test('unsupported browsers never request permission', async () => {
  let requested = false;
  const controller = new BrowserPushConsentController({
    notification: { permission: 'default', requestPermission: async () => { requested = true; return 'granted'; } },
    navigator: { userAgent: 'Desktop' }, getBindingContext: async () => context(),
  });
  await controller.enableFromUserGesture();
  assert(controller.getState().status === 'unsupported' && !requested, 'unsupported browser requested permission');
});

test('iOS non-standalone shows install hint and never requests permission in the tab', async () => {
  let requested = 0;
  const controller = new BrowserPushConsentController({
    notification: { permission: 'default', requestPermission: async () => { requested += 1; return 'denied'; } },
    navigator: { serviceWorker: { ready: Promise.resolve(registration(null)) }, userAgent: 'iPhone', locks: testLocks },
    matchMedia: () => ({ matches: false }), getBindingContext: async () => context(),
  });
  await controller.enableFromUserGesture();
  assert(controller.getState().status === 'install_hint' && requested === 0, 'iOS install hint did not precede permission');
  await controller.enableFromUserGesture();
  assert(requested === 0 && controller.getState().status === 'install_hint', 'iOS tab requested permission before installation');
});

for (const c of cases) {
  try { await c.run(); console.log(`PASS ${c.name}`); }
  catch (error) { console.error(`FAIL ${c.name}`); throw error; }
}
console.log(`\n${cases.length} browser push consent tests passed.`);
