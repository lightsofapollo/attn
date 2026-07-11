// Small IndexedDB promise helpers shared by browser-storage.ts and the
// workspace store. Behavior is identical to the originals in
// browser-storage.ts (moved here for attn-7xl.2.3).

import { BrowserStorageError } from './browser-storage-errors';

export function requestValue<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new BrowserStorageError('IndexedDB request failed'));
  });
}

export function transactionDone(transaction: IDBTransaction): Promise<void> {
  const completion = new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () =>
      reject(transaction.error ?? new DOMException('Transaction aborted', 'AbortError'));
    transaction.onerror = () => {
      // onabort carries the authoritative final error.
    };
  });
  // Some operations perform several cursor/request awaits before awaiting the
  // transaction itself. Mark early aborts observed immediately while keeping
  // the original rejection available to the eventual `await completion`.
  void completion.catch(() => undefined);
  return completion;
}

export function isConstraintError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'ConstraintError';
}

/** Abort a transaction and surface a typed error, tolerating double-aborts. */
export async function abortWith<T extends Error>(
  transaction: IDBTransaction,
  done: Promise<void>,
  error: T,
): Promise<never> {
  try {
    transaction.abort();
  } catch {
    // Already aborting/committed — the typed error still wins.
  }
  await done.catch(() => undefined);
  throw error;
}
