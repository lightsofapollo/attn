import { BrowserPushConsentController, type BrowserPushBindingContext } from '../../src/lib/review/browser-push-consent';
import type { Device } from '../../src/lib/review/browser-ws';

interface HarnessInput {
  shareId: string; bundleId: string; roomId: string; epoch: number; revision: number; manifestDigest: string;
  deviceId: string; relayUrl: string; root: number[]; read: number[]; write: number[]; deviceSigningSecret: number[];
  deviceRegistration: BrowserPushBindingContext['deviceRegistration'];
  ownerSigningKey: string; devices: Device[]; fileName: string; pushEndpoint: string;
}

let controller: BrowserPushConsentController | null = null;
let unsubscribed = false;
const subscription = {
  get endpoint() { return pushEndpoint; }, expirationTime: null,
  options: { userVisibleOnly: true, applicationServerKey: null },
  unsubscribe: async () => { unsubscribed = true; return true; }, getKey: () => null,
  toJSON: () => ({ endpoint: pushEndpoint, expirationTime: null,
    keys: { p256dh: 'BAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      auth: 'AAAAAAAAAAAAAAAAAAAAAA' } }),
} as PushSubscription;
let pushEndpoint = 'https://fcm.googleapis.com/fcm/send/attn-playwright-e2e';
const registration = { pushManager: { getSubscription: async () => subscription,
  subscribe: async () => subscription } } as unknown as ServiceWorkerRegistration;

function configure(input: HarnessInput): BrowserPushConsentController {
  pushEndpoint = input.pushEndpoint;
  const binding = (): BrowserPushBindingContext => ({ shareId: input.shareId, bundleId: input.bundleId, roomId: input.roomId,
    epoch: input.epoch, revision: input.revision, manifestDigest: input.manifestDigest, deviceId: input.deviceId,
    relayUrl: input.relayUrl, roomReadCapabilityBytes: Uint8Array.from(input.root),
    readAdmissionKeyBytes: Uint8Array.from(input.read), writeAdmissionKeyBytes: Uint8Array.from(input.write),
    deviceSigningSecretBytes: Uint8Array.from(input.deviceSigningSecret),
    deviceRegistration: structuredClone(input.deviceRegistration),
    ownerSigningKey: input.ownerSigningKey, devices: structuredClone(input.devices), fileName: input.fileName });
  return new BrowserPushConsentController({ getBindingContext: async () => binding(),
    notification: { permission: 'granted', requestPermission: async () => 'granted' },
    navigator: { userAgent: navigator.userAgent, serviceWorker: { ready: Promise.resolve(registration) }, locks: navigator.locks } });
}
async function enable(input: HarnessInput): Promise<unknown> {
  controller = configure(input);
  await controller.enableFromUserGesture();
  return controller.getState();
}
async function disable(input?: HarnessInput): Promise<unknown> {
  controller ??= input ? configure(input) : null;
  if (!controller) throw new Error('push harness is not configured');
  await controller.disableFromUserGesture();
  return { state: controller.getState(), unsubscribed };
}

Object.assign(window, { __attnPushE2E: { enable, disable } });
if ('serviceWorker' in navigator) await navigator.serviceWorker.register('/sw.js');
