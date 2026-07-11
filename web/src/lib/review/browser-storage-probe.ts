// Storage capability and durability probes (attn-7xl.2.5).
//
// Every signal comes from actually exercising the API — never from
// user-agent sniffing (Lockdown Mode, Private Browsing, and managed
// profiles all lie to UA heuristics). The probes round-trip:
//
//   1. IndexedDB       — open a probe database, put/get a record
//   2. CryptoKey       — a non-extractable HKDF root survives the IDB
//                        structured clone and can still deriveBits
//   3. OPFS            — write/read/delete a probe file
//
// plus navigator.storage.persisted()/estimate(). The typed mode is honest:
// `volatile` is only reported when the OPFS API exists but *refuses* with a
// security-shaped error (WebKit's Private Browsing signal); Chromium private
// windows are indistinguishable from best-effort and report as such.

import type { BrowserStorageNavigator, BrowserStorageEstimate } from './browser-storage';
import { requestValue, transactionDone } from './browser-idb';

export type DurabilityMode = 'persistent' | 'best_effort' | 'volatile' | 'unsupported';

export interface ProbeFailure {
  name: string;
  message: string;
}

export interface ProbeResult {
  ok: boolean;
  cause?: ProbeFailure;
}

export interface StorageCapabilities {
  mode: DurabilityMode;
  indexedDb: ProbeResult;
  cryptoKeyClone: ProbeResult;
  opfs: ProbeResult & { apiPresent: boolean };
  /** navigator.storage.persisted() — null when the API is unavailable. */
  persisted: boolean | null;
  /** Result of an explicit persist() request when one was made. */
  persistRequested?: boolean;
  estimate: BrowserStorageEstimate | null;
}

export interface ProbeOptions {
  indexedDB?: IDBFactory;
  crypto?: Crypto;
  navigator?: BrowserStorageNavigator | null;
  databaseName?: string;
  /** Ask the browser for persistent storage during the probe. */
  requestPersist?: boolean;
}

const PROBE_DB = 'attn-storage-probe';
const PROBE_STORE = 'probe';
// Error names WebKit uses when storage APIs exist but are refused for the
// session (Private Browsing / policy), as opposed to being absent.
const SESSION_REFUSAL_ERRORS = new Set(['SecurityError', 'NotAllowedError', 'UnknownError']);

export async function probeStorageCapabilities(
  options: ProbeOptions = {},
): Promise<StorageCapabilities> {
  const factory = options.indexedDB ?? globalThis.indexedDB;
  const cryptoImpl = options.crypto ?? globalThis.crypto;
  const nav = options.navigator === undefined ? defaultNavigator() : options.navigator;
  const databaseName = options.databaseName ?? PROBE_DB;

  const indexedDb = factory
    ? await probeIndexedDb(factory, databaseName)
    : { ok: false, cause: { name: 'Unavailable', message: 'indexedDB is not defined' } };
  const cryptoKeyClone =
    indexedDb.ok && cryptoImpl?.subtle
      ? await probeCryptoKeyClone(factory!, cryptoImpl, databaseName)
      : {
          ok: false,
          cause: indexedDb.ok
            ? { name: 'Unavailable', message: 'WebCrypto subtle is not available' }
            : { name: 'Skipped', message: 'IndexedDB probe failed first' },
        };
  const opfs = await probeOpfs(nav);

  let persisted: boolean | null = null;
  let persistRequested: boolean | undefined;
  try {
    if (options.requestPersist && nav?.storage?.persist) {
      persistRequested = await nav.storage.persist.call(nav.storage);
    }
    persisted = nav?.storage?.persisted
      ? await nav.storage.persisted.call(nav.storage)
      : (persistRequested ?? null);
  } catch {
    persisted = null;
  }

  let estimate: BrowserStorageEstimate | null = null;
  try {
    estimate = nav?.storage?.estimate ? await nav.storage.estimate.call(nav.storage) : null;
  } catch {
    estimate = null;
  }

  return {
    mode: resolveMode(indexedDb, cryptoKeyClone, opfs, persisted),
    indexedDb,
    cryptoKeyClone,
    opfs,
    persisted,
    ...(persistRequested === undefined ? {} : { persistRequested }),
    estimate,
  };
}

function resolveMode(
  indexedDb: ProbeResult,
  cryptoKeyClone: ProbeResult,
  opfs: ProbeResult & { apiPresent: boolean },
  persisted: boolean | null,
): DurabilityMode {
  if (!indexedDb.ok || !cryptoKeyClone.ok) return 'unsupported';
  if (persisted === true) return 'persistent';
  if (opfs.apiPresent && !opfs.ok && opfs.cause && SESSION_REFUSAL_ERRORS.has(opfs.cause.name)) {
    return 'volatile';
  }
  return 'best_effort';
}

/** Map a probed mode onto the UI shells' persistence union. */
export function toPersistenceMode(
  capabilities: Pick<StorageCapabilities, 'mode' | 'estimate'>,
): 'persistent' | 'best-effort' | 'session-only' | 'unavailable' | 'quota-pressure' {
  if (capabilities.mode === 'unsupported') return 'unavailable';
  if (quotaPressure(capabilities.estimate)) return 'quota-pressure';
  switch (capabilities.mode) {
    case 'persistent':
      return 'persistent';
    case 'volatile':
      return 'session-only';
    case 'best_effort':
      return 'best-effort';
  }
  return 'best-effort';
}

/** True when usage is close enough to quota that writes should pause. */
export function quotaPressure(
  estimate: BrowserStorageEstimate | null,
  threshold = 0.95,
): boolean {
  if (!estimate || estimate.usage === undefined || estimate.quota === undefined) return false;
  if (estimate.quota <= 0) return false;
  return estimate.usage / estimate.quota >= threshold;
}

async function probeIndexedDb(factory: IDBFactory, databaseName: string): Promise<ProbeResult> {
  try {
    const db = await openProbeDatabase(factory, databaseName);
    try {
      const tx = db.transaction(PROBE_STORE, 'readwrite');
      const done = transactionDone(tx);
      tx.objectStore(PROBE_STORE).put({ id: 'probe', at: 0 });
      await done;
      const readTx = db.transaction(PROBE_STORE, 'readonly');
      const readDone = transactionDone(readTx);
      const value = await requestValue<{ id: string } | undefined>(
        readTx.objectStore(PROBE_STORE).get('probe'),
      );
      await readDone;
      if (!value || value.id !== 'probe') {
        return { ok: false, cause: { name: 'RoundTrip', message: 'stored record did not read back' } };
      }
      return { ok: true };
    } finally {
      db.close();
    }
  } catch (error) {
    return { ok: false, cause: toFailure(error) };
  }
}

async function probeCryptoKeyClone(
  factory: IDBFactory,
  cryptoImpl: Crypto,
  databaseName: string,
): Promise<ProbeResult> {
  try {
    const material = new Uint8Array(32);
    cryptoImpl.getRandomValues(material);
    const key = await cryptoImpl.subtle.importKey('raw', material, 'HKDF', false, ['deriveBits']);
    material.fill(0);
    const db = await openProbeDatabase(factory, databaseName);
    try {
      const tx = db.transaction(PROBE_STORE, 'readwrite');
      const done = transactionDone(tx);
      tx.objectStore(PROBE_STORE).put({ id: 'probe-key', key });
      await done;
      const readTx = db.transaction(PROBE_STORE, 'readonly');
      const readDone = transactionDone(readTx);
      const record = await requestValue<{ key?: CryptoKey } | undefined>(
        readTx.objectStore(PROBE_STORE).get('probe-key'),
      );
      await readDone;
      const restored = record?.key;
      if (!restored || restored.extractable !== false || restored.algorithm?.name !== 'HKDF') {
        return {
          ok: false,
          cause: { name: 'RoundTrip', message: 'CryptoKey did not survive structured clone' },
        };
      }
      const bits = await cryptoImpl.subtle.deriveBits(
        { name: 'HKDF', hash: 'SHA-256', salt: new ArrayBuffer(0), info: new ArrayBuffer(0) },
        restored,
        256,
      );
      new Uint8Array(bits).fill(0);
      return { ok: true };
    } finally {
      db.close();
    }
  } catch (error) {
    return { ok: false, cause: toFailure(error) };
  }
}

async function probeOpfs(
  nav: BrowserStorageNavigator | null,
): Promise<ProbeResult & { apiPresent: boolean }> {
  const getDirectory = nav?.storage?.getDirectory;
  if (!getDirectory) {
    return {
      ok: false,
      apiPresent: false,
      cause: { name: 'Unavailable', message: 'OPFS getDirectory is not available' },
    };
  }
  try {
    const root = await getDirectory.call(nav!.storage);
    const dir = await root.getDirectoryHandle('.attn-probe', { create: true });
    const file = await dir.getFileHandle('probe.bin', { create: true });
    const writable = await file.createWritable();
    const payload = new Uint8Array([1, 2, 3, 4]);
    try {
      await writable.write(payload);
      await writable.close();
    } catch (error) {
      await writable.abort?.().catch(() => undefined);
      throw error;
    }
    const readBack = new Uint8Array(await (await file.getFile()).arrayBuffer());
    await root.removeEntry('.attn-probe', { recursive: true }).catch(() => undefined);
    if (readBack.length !== 4 || readBack[0] !== 1 || readBack[3] !== 4) {
      return {
        ok: false,
        apiPresent: true,
        cause: { name: 'RoundTrip', message: 'OPFS bytes did not read back' },
      };
    }
    return { ok: true, apiPresent: true };
  } catch (error) {
    return { ok: false, apiPresent: true, cause: toFailure(error) };
  }
}

function openProbeDatabase(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(name, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(PROBE_STORE)) {
        request.result.createObjectStore(PROBE_STORE, { keyPath: 'id' });
      }
    };
    request.onerror = () => reject(request.error ?? new Error('probe open failed'));
    request.onblocked = () => reject(new Error('probe open blocked'));
    request.onsuccess = () => resolve(request.result);
  });
}

function toFailure(error: unknown): ProbeFailure {
  if (error instanceof DOMException || error instanceof Error) {
    return { name: error.name, message: error.message };
  }
  return { name: 'Unknown', message: String(error) };
}

function defaultNavigator(): BrowserStorageNavigator | null {
  return typeof navigator === 'undefined' ? null : (navigator as BrowserStorageNavigator);
}
