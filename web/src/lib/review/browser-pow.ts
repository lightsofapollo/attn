import { sha256 } from '@noble/hashes/sha2.js';

export const BROWSER_POW_DIFFICULTY = 12;
export const BROWSER_POW_TTL_MS = 5 * 60 * 1000;
export const MIN_POW_DIFFICULTY = 12;
export const MAX_POW_DIFFICULTY = 24;

const encoder = new TextEncoder();

export interface BrowserPowInputs {
  roomId: string;
  deviceId: string;
  method: string;
  path: string;
  difficulty: number;
  expiresAt: number;
  rand: string;
  counterStart?: bigint;
}

export interface MinedBrowserPow {
  token: string;
  counter: bigint;
  hash: Uint8Array;
}

export interface BrowserPowWorkerOptions {
  signal?: AbortSignal;
  now?: () => number;
  randomBytes?: () => Uint8Array;
  workerFactory?: () => Worker;
}

export function base64UrlEncodePow(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function requestPathHash(method: string, path: string): string {
  validateMethodAndPath(method, path);
  const digest = sha256(encoder.encode(`${method.toUpperCase()} ${path}`));
  return base64UrlEncodePow(digest.subarray(0, 8));
}

export function powResource(roomId: string, deviceId: string, method: string, path: string): string {
  validateField(roomId, 'roomId');
  validateField(deviceId, 'deviceId');
  return `${roomId}:${deviceId}:${requestPathHash(method, path)}`;
}

export function leadingZeroBits(hash: Uint8Array): number {
  let bits = 0;
  for (const byte of hash) {
    if (byte === 0) {
      bits += 8;
      continue;
    }
    bits += Math.clz32(byte) - 24;
    break;
  }
  return bits;
}

/** Synchronous pure miner. Call this inside a Worker in browser code. */
export function mineBrowserPow(inputs: BrowserPowInputs): MinedBrowserPow {
  validateInputs(inputs);
  const resource = powResource(inputs.roomId, inputs.deviceId, inputs.method, inputs.path);
  const prefix = `attn-pow:v2:${inputs.difficulty}:${inputs.expiresAt}:${resource}:${inputs.rand}:`;
  let counter = inputs.counterStart ?? 0n;
  if (counter < 0n) throw new Error('counterStart must be non-negative');

  for (;;) {
    const token = `${prefix}${counter}`;
    const hash = sha256(encoder.encode(token));
    if (leadingZeroBits(hash) >= inputs.difficulty) return { token, counter, hash };
    counter += 1n;
  }
}

/** Mint a registration token off the UI thread with cancellation support. */
export function mintBrowserPowInWorker(
  request: Omit<BrowserPowInputs, 'expiresAt' | 'rand' | 'counterStart'>,
  options: BrowserPowWorkerOptions = {},
): Promise<string> {
  if (options.signal?.aborted) return Promise.reject(abortError());
  const random = options.randomBytes?.() ?? crypto.getRandomValues(new Uint8Array(16));
  if (!(random instanceof Uint8Array) || random.length !== 16) {
    return Promise.reject(new Error('PoW random source must return 16 bytes'));
  }
  const inputs: BrowserPowInputs = {
    ...request,
    expiresAt: (options.now?.() ?? Date.now()) + BROWSER_POW_TTL_MS,
    rand: base64UrlEncodePow(random),
  };
  const worker =
    options.workerFactory?.() ??
    new Worker(new URL('./browser-pow.worker.ts', import.meta.url), { type: 'module' });

  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener('abort', onAbort);
      worker.terminate();
      fn();
    };
    const onAbort = (): void => finish(() => reject(abortError()));

    worker.onmessage = (event: MessageEvent<unknown>) => {
      const data = event.data;
      if (
        typeof data === 'object' &&
        data !== null &&
        'token' in data &&
        typeof (data as { token?: unknown }).token === 'string'
      ) {
        const token = (data as { token: string }).token;
        finish(() => resolve(token));
        return;
      }
      const message =
        typeof data === 'object' && data !== null && 'error' in data
          ? String((data as { error: unknown }).error)
          : 'PoW worker returned an invalid response';
      finish(() => reject(new Error(message)));
    };
    worker.onerror = () => finish(() => reject(new Error('PoW worker failed')));
    options.signal?.addEventListener('abort', onAbort, { once: true });
    worker.postMessage(inputs);
  });
}

function validateInputs(inputs: BrowserPowInputs): void {
  validateField(inputs.roomId, 'roomId');
  validateField(inputs.deviceId, 'deviceId');
  validateMethodAndPath(inputs.method, inputs.path);
  if (
    !Number.isInteger(inputs.difficulty) ||
    inputs.difficulty < MIN_POW_DIFFICULTY ||
    inputs.difficulty > MAX_POW_DIFFICULTY
  ) {
    throw new Error(`difficulty must be an integer in [${MIN_POW_DIFFICULTY}, ${MAX_POW_DIFFICULTY}]`);
  }
  if (!Number.isSafeInteger(inputs.expiresAt) || inputs.expiresAt <= 0) {
    throw new Error('expiresAt must be a positive safe integer');
  }
  if (!/^[A-Za-z0-9_-]{22}$/.test(inputs.rand)) {
    throw new Error('rand must be base64url-no-pad of 16 bytes');
  }
}

function validateField(value: string, label: string): void {
  if (typeof value !== 'string' || value.length === 0 || value.includes(':')) {
    throw new Error(`${label} must be non-empty and contain no colon`);
  }
}

function validateMethodAndPath(method: string, path: string): void {
  if (!/^[A-Za-z]+$/.test(method)) throw new Error('method must contain only ASCII letters');
  if (typeof path !== 'string' || !path.startsWith('/') || path.includes(':')) {
    throw new Error('path must start with / and contain no colon');
  }
}

function abortError(): DOMException {
  return new DOMException('PoW mint cancelled', 'AbortError');
}
