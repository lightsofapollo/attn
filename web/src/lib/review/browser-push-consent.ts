import { base64UrlDecode, buildAdmissionHeaderV3 } from './browser-crypto';
import { BROWSER_POW_DIFFICULTY, mintBrowserPowInWorker } from './browser-pow';
import {
  ensurePushSubscription,
  forgetPushBinding,
  forgetPushBindingAndCount,
  getPushBinding,
  hasPushBinding,
  replacePushBinding,
  restorePushBinding,
  subscriptionWireValue,
  type PushBindingRecord,
} from './browser-push-worker';
import type { Device } from './browser-ws';

export type BrowserPushConsentStatus =
  | 'checking'
  | 'off'
  | 'install_hint'
  | 'enabling'
  | 'on'
  | 'disabling'
  | 'denied'
  | 'unsupported'
  | 'error';

export interface BrowserPushConsentState {
  status: BrowserPushConsentStatus;
  message: string | null;
  /** Last durably-known local binding state, including during retries. */
  enabled: boolean;
}

export interface BrowserPushBindingContext {
  shareId: string;
  bundleId: string;
  roomId: string;
  epoch: number;
  revision: number;
  manifestDigest: string;
  deviceId: string;
  relayUrl: string;
  roomReadCapabilityBytes: Uint8Array;
  readAdmissionKeyBytes: Uint8Array;
  writeAdmissionKeyBytes: Uint8Array;
  ownerSigningKey: string;
  devices: Device[];
  fileName: string;
}

interface NotificationApi {
  readonly permission: NotificationPermission;
  requestPermission(): Promise<NotificationPermission>;
}

interface PushConsentNavigator {
  readonly userAgent?: string;
  readonly standalone?: boolean;
  readonly serviceWorker?: { readonly ready: Promise<ServiceWorkerRegistration> };
  readonly locks?: { request<T>(name: string, callback: () => Promise<T>): Promise<T> };
}

export interface BrowserPushConsentOptions {
  getBindingContext(signal?: AbortSignal): Promise<BrowserPushBindingContext>;
  canEnable?(): boolean;
  isBindingContextCurrent?(context: BrowserPushBindingContext): boolean;
  notification?: NotificationApi;
  navigator?: PushConsentNavigator;
  matchMedia?: (query: string) => Pick<MediaQueryList, 'matches'>;
  fetch?: typeof fetch;
  indexedDB?: IDBFactory;
  mintPow?: (input: {
    shareId: string;
    deviceId: string;
    method: 'POST' | 'DELETE';
    path: string;
    signal?: AbortSignal;
  }) => Promise<string>;
  onState?(state: BrowserPushConsentState): void;
}

/**
 * Explicit, user-gesture-only Web Push consent for one durable share.
 * Invite-only rooms intentionally never construct this controller.
 */
export class BrowserPushConsentController {
  private state: BrowserPushConsentState = { status: 'checking', message: null, enabled: false };
  private operation: Promise<void> | null = null;
  private generation = 0;
  private abort: AbortController | null = null;

  constructor(private readonly options: BrowserPushConsentOptions) {}

  getState(): BrowserPushConsentState { return { ...this.state }; }

  async initialize(): Promise<void> {
    if (this.requiresIosInstallHint()) {
      this.patch('install_hint', 'On iPhone or iPad, add attn to your Home Screen before enabling notifications.');
      return;
    }
    if (!this.supported()) {
      this.patch('unsupported', 'Push notifications are not supported in this browser.');
      return;
    }
    let context: BrowserPushBindingContext | null = null;
    try {
      context = await this.options.getBindingContext();
      const remembered = await hasPushBinding(bindingId(context), this.indexedDB());
      this.patch(remembered ? 'on' : 'off', null, remembered);
    } catch {
      this.patch('off', null);
    } finally {
      zeroContext(context);
    }
  }

  /** Must be called directly by a click/tap handler. */
  enableFromUserGesture(): Promise<void> {
    if (this.operation) return this.operation;
    if (this.requiresIosInstallHint()) {
      this.patch('install_hint', 'On iPhone or iPad, add attn to your Home Screen before enabling notifications.');
      return Promise.resolve();
    }
    if (this.options.canEnable && !this.options.canEnable()) {
      this.patch('unsupported', 'View-only and invite-only sessions cannot enable notifications.');
      return Promise.resolve();
    }
    if (!this.supported()) {
      this.patch('unsupported', 'Push notifications are not supported in this browser.');
      return Promise.resolve();
    }
    // Capture the permission promise synchronously while transient user
    // activation is still present. No storage/network await may precede it.
    const notification = this.notification();
    const permissionPromise = notification.permission === 'granted'
      ? Promise.resolve<NotificationPermission>('granted')
      : notification.requestPermission();
    this.patch('enabling', null);
    const generation = ++this.generation;
    const abort = new AbortController(); this.abort?.abort(); this.abort = abort;
    const run = this.enable(permissionPromise, generation, abort.signal).finally(() => {
      if (this.operation === run) this.operation = null;
      if (this.abort === abort) this.abort = null;
    });
    this.operation = run;
    return run;
  }

  disableFromUserGesture(): Promise<void> {
    if (this.operation) return this.operation;
    if (!this.supported()) {
      this.patch('unsupported', 'Push notifications are not supported in this browser.');
      return Promise.resolve();
    }
    this.patch('disabling', null, true);
    const generation = ++this.generation;
    const abort = new AbortController(); this.abort?.abort(); this.abort = abort;
    const run = this.disable(generation, abort.signal).finally(() => {
      if (this.operation === run) this.operation = null;
      if (this.abort === abort) this.abort = null;
    });
    this.operation = run;
    return run;
  }

  close(): void { ++this.generation; this.abort?.abort(); this.abort = null; }

  private async enable(permissionPromise: Promise<NotificationPermission>, generation: number, signal: AbortSignal): Promise<void> {
    const permission = await permissionPromise;
    if (permission !== 'granted') {
      this.patch('denied', 'Notifications are blocked. You can change this site’s permission in browser settings.');
      return;
    }
    let context: BrowserPushBindingContext | null = null;
    try {
      this.assertCurrent(generation, signal);
      context = await this.options.getBindingContext(signal);
      validateContext(context);
      this.assertContextCurrent(context, generation, signal);
      const config = await this.fetchPushConfig(context, signal);
      await this.withSubscriptionLock(async () => {
        const registration = await this.serviceWorkerRegistration();
        const existing = await registration.pushManager.getSubscription();
        let subscription: PushSubscription | null = null;
        const preflightPrevious: PushBindingRecord | null = await getPushBinding(bindingId(context!), this.indexedDB());
        let rollbackPrevious: PushBindingRecord | null = null;
        let postAttempted = false;
        let localReplaced = false;
        try {
          subscription = existing ?? await ensurePushSubscription(registration, config);
          postAttempted = true;
          await this.putRelayBinding(context!, subscription, signal);
          this.assertContextCurrent(context!, generation, signal);
          rollbackPrevious = await replacePushBinding({
            bindingId: bindingId(context!), kind: 'share', resourceId: context!.shareId,
            roomId: context!.roomId, deviceId: context!.deviceId, relayUrl: context!.relayUrl,
            protocolVersion: 3, roomReadCapabilityBytes: new Uint8Array(context!.roomReadCapabilityBytes),
            readAdmissionKeyBytes: new Uint8Array(context!.readAdmissionKeyBytes),
            writeAdmissionKeyBytes: new Uint8Array(context!.writeAdmissionKeyBytes), bundleId: context!.bundleId,
            epoch: context!.epoch, revision: context!.revision, manifestDigest: context!.manifestDigest,
            fileName: context!.fileName, deepLinkPath: `/s/${encodeURIComponent(bindingId(context!))}`,
            ownerSigningKey: context!.ownerSigningKey, devices: context!.devices,
          }, { indexedDB: this.indexedDB() });
          localReplaced = true;
          this.assertContextCurrent(context!, generation, signal);
        } catch (error) {
          if (postAttempted) await this.deleteRelayBinding(context!).catch(() => undefined);
          if (localReplaced) await restorePushBinding(bindingId(context!), rollbackPrevious, this.indexedDB()).catch(() => undefined);
          if (preflightPrevious && subscription) await this.putRelayBinding(context!, subscription).catch(() => undefined);
          if (existing === null && subscription) await subscription.unsubscribe().catch(() => false);
          throw error;
        } finally { config.fill(0); }
      });
      this.patch('on', null, true);
    } catch (error) {
      if (generation === this.generation) this.patch('error', safeMessage(error, 'Could not enable notifications. Try again.'));
    } finally {
      zeroContext(context);
    }
  }

  private async disable(generation: number, signal: AbortSignal): Promise<void> {
    let context: BrowserPushBindingContext | null = null;
    try {
      context = await this.options.getBindingContext(signal);
      validateContext(context);
      this.assertCurrent(generation, signal);
      await this.withSubscriptionLock(async () => {
        await this.deleteRelayBinding(context!, signal);
        const remaining = await forgetPushBindingAndCount(bindingId(context!), this.indexedDB());
        const registration = await this.serviceWorkerRegistration();
        const subscription = await registration.pushManager.getSubscription();
        if (remaining === 0 && subscription && !await subscription.unsubscribe()) {
          throw new Error('the browser did not remove the push subscription');
        }
      });
      this.patch('off', null, false);
    } catch (error) {
      const retained = context ? await hasPushBinding(bindingId(context), this.indexedDB()).catch(() => true) : true;
      this.patch('error', safeMessage(error, 'Could not disable notifications. Try again.'), retained);
    } finally {
      zeroContext(context);
    }
  }

  private async fetchPushConfig(context: BrowserPushBindingContext, signal: AbortSignal): Promise<Uint8Array> {
    const path = `/v3/shares/${encodeURIComponent(context.shareId)}`;
    const response = await this.fetchImpl()(new URL(path, context.relayUrl), { signal, headers: {
      'Attn-Share-Bundle': context.bundleId,
      'Attn-Admission': buildAdmissionHeaderV3(context.readAdmissionKeyBytes, 'read', 'GET', path, new Uint8Array()),
    } });
    if (!response.ok) throw new Error(`push configuration fetch failed (${response.status})`);
    const value = await response.json() as unknown;
    if (!isRecord(value) || !isRecord(value.features) || value.features.push !== true ||
      typeof value.features.vapidPublicKey !== 'string') {
      throw new Error('push is not configured for this relay');
    }
    const key = base64UrlDecode(value.features.vapidPublicKey);
    if (key.byteLength !== 65 || key[0] !== 4) {
      key.fill(0);
      throw new Error('relay VAPID public key is invalid');
    }
    return key;
  }

  private async putRelayBinding(context: BrowserPushBindingContext, subscription: PushSubscription, signal?: AbortSignal): Promise<void> {
    const path = pushPath(context);
    const body = JSON.stringify(subscriptionWireValue(subscription));
    const bodyBytes = new TextEncoder().encode(body);
    const pow = await this.pow(context, 'POST', path, signal);
    const response = await this.fetchImpl()(new URL(path, context.relayUrl), { method: 'POST', body, signal, headers: {
      'Content-Type': 'application/json', 'Attn-Device-Id': context.deviceId,
      'Attn-Share-Bundle': context.bundleId,
      'Attn-Admission': buildAdmissionHeaderV3(context.writeAdmissionKeyBytes, 'write', 'POST', path, bodyBytes),
      'Attn-PoW': pow,
    } });
    bodyBytes.fill(0);
    if (!response.ok) throw new Error(`push subscription was rejected (${response.status})`);
  }

  private async deleteRelayBinding(context: BrowserPushBindingContext, signal?: AbortSignal): Promise<void> {
    const path = pushPath(context);
    const pow = await this.pow(context, 'DELETE', path, signal);
    const response = await this.fetchImpl()(new URL(path, context.relayUrl), { method: 'DELETE', signal, headers: {
      'Attn-Device-Id': context.deviceId, 'Attn-Share-Bundle': context.bundleId,
      'Attn-Admission': buildAdmissionHeaderV3(context.writeAdmissionKeyBytes, 'write', 'DELETE', path, new Uint8Array()),
      'Attn-PoW': pow,
    } });
    if (!response.ok) throw new Error(`push subscription removal failed (${response.status})`);
  }

  private pow(context: BrowserPushBindingContext, method: 'POST' | 'DELETE', path: string, signal?: AbortSignal): Promise<string> {
    if (this.options.mintPow) return this.options.mintPow({ shareId: context.shareId, deviceId: context.deviceId, method, path, signal });
    return mintBrowserPowInWorker({ roomId: context.shareId, deviceId: context.deviceId,
      method, path, difficulty: BROWSER_POW_DIFFICULTY }, { signal });
  }

  private supported(): boolean {
    const nav = this.navigator();
    const notificationAvailable = this.options.notification !== undefined || typeof Notification !== 'undefined';
    const pushAvailable = this.options.navigator !== undefined
      ? !!nav.serviceWorker
      : typeof PushManager !== 'undefined' && !!nav.serviceWorker;
    return notificationAvailable && pushAvailable && !!nav.locks;
  }

  private requiresIosInstallHint(): boolean {
    const nav = this.navigator();
    const ios = /(?:iPad|iPhone|iPod)/u.test(nav.userAgent ?? '') ||
      (/Macintosh/u.test(nav.userAgent ?? '') && /Mobile/u.test(nav.userAgent ?? ''));
    const standalone = nav.standalone === true || this.options.matchMedia?.('(display-mode: standalone)').matches === true ||
      (typeof matchMedia === 'function' && matchMedia('(display-mode: standalone)').matches);
    return ios && !standalone;
  }

  private notification(): NotificationApi { return this.options.notification ?? Notification; }
  private navigator(): PushConsentNavigator { return this.options.navigator ?? navigator; }
  private fetchImpl(): typeof fetch { return this.options.fetch ?? fetch; }
  private indexedDB(): IDBFactory { return this.options.indexedDB ?? indexedDB; }
  private async serviceWorkerRegistration(): Promise<ServiceWorkerRegistration> {
    const ready = this.navigator().serviceWorker?.ready;
    if (!ready) throw new Error('service worker is unavailable');
    return ready;
  }
  private withSubscriptionLock<T>(callback: () => Promise<T>): Promise<T> {
    const locks = this.navigator().locks;
    if (!locks) return Promise.reject(new Error('cross-tab push locking is unavailable'));
    return locks.request('attn-origin-push-subscription-v1', callback);
  }
  private patch(status: BrowserPushConsentStatus, message: string | null, enabled = this.state.enabled): void {
    this.state = { status, message, enabled };
    this.options.onState?.({ ...this.state });
  }
  private assertCurrent(generation: number, signal: AbortSignal): void {
    if (signal.aborted || generation !== this.generation) throw new DOMException('push consent cancelled', 'AbortError');
  }
  private assertContextCurrent(context: BrowserPushBindingContext, generation: number, signal: AbortSignal): void {
    this.assertCurrent(generation, signal);
    if (this.options.isBindingContextCurrent && !this.options.isBindingContextCurrent(context)) {
      throw new Error('the share changed while notifications were being enabled');
    }
  }
}

function pushPath(context: BrowserPushBindingContext): string {
  return `/v3/shares/${encodeURIComponent(context.shareId)}/push-subscriptions/${encodeURIComponent(context.deviceId)}`;
}
function bindingId(context: BrowserPushBindingContext): string {
  // bundleId is the cryptographic per-link selector; excluding the potentially
  // 128-byte share id keeps the worker's bounded protocol identifier valid.
  return `share_${context.bundleId}_${context.deviceId}`;
}
function validateContext(context: BrowserPushBindingContext): void {
  if (context.writeAdmissionKeyBytes.byteLength !== 32 || context.readAdmissionKeyBytes.byteLength !== 32 ||
    context.roomReadCapabilityBytes.byteLength !== 32) throw new Error('push capability is invalid');
  const owners = context.devices.filter(device => device.kind === 'owner' && device.publicSigningKey === context.ownerSigningKey);
  if (owners.length !== 1) throw new Error('push owner identity is not pinned');
}
function zeroContext(context: BrowserPushBindingContext | null): void {
  context?.roomReadCapabilityBytes.fill(0);
  context?.readAdmissionKeyBytes.fill(0);
  context?.writeAdmissionKeyBytes.fill(0);
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function safeMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
