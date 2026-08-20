// How a workspace came to exist, remembered per device (attn-rjuo.1.2).
//
// THE FAILURE THIS FIXES. "Start a blank untitled.md" and "Import files" both
// mint a workspace holding one empty `untitled.md`, so the two are
// indistinguishable in storage. The canvas invitation has to tell them apart —
// someone who asked for a blank page in so many words must not be asked back
// what they want — and it was doing so from component state, which a reload
// discards. Refreshing an explicitly blank workspace re-covered it with an
// import prompt.
//
// This is a UI HINT, not user content: it never affects what is stored, shared
// or exported, and losing it costs one avoidable invitation. That is why it
// lives in localStorage rather than in the encrypted workspace record — the
// alternative was a schema change on the storage layer to carry a preference.
// Every call is total: private modes and blocked-storage browsers throw on
// access, and the honest fallback there is the import-first default.

const KEY_PREFIX = 'attn:workspace-origin:';

export type WorkspaceOrigin = 'blank' | 'import';

function keyFor(workspaceId: string): string {
  return `${KEY_PREFIX}${workspaceId}`;
}

export function rememberWorkspaceOrigin(workspaceId: string, origin: WorkspaceOrigin): void {
  try {
    localStorage.setItem(keyFor(workspaceId), origin);
  } catch {
    // Storage blocked or full. The origin is a hint; the session-scoped copy in
    // AppShell still covers this visit.
  }
}

export function readWorkspaceOrigin(workspaceId: string): WorkspaceOrigin | undefined {
  try {
    const stored = localStorage.getItem(keyFor(workspaceId));
    return stored === 'blank' || stored === 'import' ? stored : undefined;
  } catch {
    return undefined;
  }
}

/** Called when a workspace is deleted, so the keys cannot outlive their ids. */
export function forgetWorkspaceOrigin(workspaceId: string): void {
  try {
    localStorage.removeItem(keyFor(workspaceId));
  } catch {
    // Nothing to clean up if the store is unreachable.
  }
}

/**
 * Drop every remembered origin. Used by "Clear all local attn data", which
 * promises durable erasure — a stale hint is not content, but leaving keys
 * behind after that button would still be a lie about what was removed.
 */
export function forgetAllWorkspaceOrigins(): void {
  try {
    const stale: string[] = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key?.startsWith(KEY_PREFIX)) stale.push(key);
    }
    for (const key of stale) localStorage.removeItem(key);
  } catch {
    // Unreachable store: nothing was written either.
  }
}
