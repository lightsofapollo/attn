// One automatic reload per tab, for application code that never arrived
// (attn-ze60.1).
//
// THE FAILURE THIS EXISTS FOR. Route code is loaded on demand, and a dynamic
// import can reject: the tab lost the network mid-navigation, or — far more
// often — the deployment this document was served from has since been replaced
// and its hashed chunk names are now 404s. Retrying the same `import()` cannot
// fix either case, because the module map records a failed fetch and answers
// the next call with the same rejection without going back to the network. Only
// a fresh document can: it re-reads index.html and picks up the new chunk names.
//
// So the recovery is a reload — and a reload that can happen every time is a
// loop. This module is the memory that makes it happen at most once per tab,
// after which the failure is a real fault and has to be shown rather than
// papered over.

/** The slice of `Storage` this needs; injectable so the policy is testable. */
export interface ReloadMemory {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const CHUNK_RELOAD_KEY = 'attn:chunk-reload';

/**
 * `sessionStorage`, or null where the browser refuses it.
 *
 * Per tab, not per profile: the fault is a stale document, so the memory should
 * die with the document's tab rather than follow the person around. Access
 * itself throws when site data is blocked (private windows, restrictive
 * settings), which is why the read is guarded rather than the use.
 */
function tabMemory(): ReloadMemory | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/**
 * Claim this tab's one reload. True means take it; false means it is spent —
 * or that there is nowhere to record it, in which case reloading would loop
 * forever, so the answer is no.
 */
export function takeChunkReload(memory: ReloadMemory | null = tabMemory()): boolean {
  if (!memory) return false;
  try {
    if (memory.getItem(CHUNK_RELOAD_KEY) !== null) return false;
    memory.setItem(CHUNK_RELOAD_KEY, '1');
    return true;
  } catch {
    // A storage that reads but will not write (quota, eviction) leaves the
    // attempt unrecorded, which is the looping case again.
    return false;
  }
}

/**
 * Give the tab its reload back, once a chunk has actually arrived.
 *
 * Without this the memory would be "this tab reloaded once, ever", so a real
 * failure hours later in the same tab would go straight to the error surface
 * even though a reload would have fixed it.
 */
export function clearChunkReload(memory: ReloadMemory | null = tabMemory()): void {
  if (!memory) return;
  try {
    memory.removeItem(CHUNK_RELOAD_KEY);
  } catch {
    // Nothing to clear is indistinguishable from cleared.
  }
}
