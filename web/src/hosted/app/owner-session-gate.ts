// One in-flight editing acquisition, owned by a workspace (attn-e9r2.2).
//
// THE FAILURE THIS PINS. Acquiring the writer lease is slow by design — a
// polite ask, a handoff doorbell rung at whichever tab holds the pen, a grace
// period, and only then a forced takeover. Desktop switches workspaces in
// place, so the user can pick another workspace inside that window. The
// acquisition was tracked as a bare promise with no workspace attached, so
// two things went wrong at once: the new workspace's request was answered
// with the OLD workspace's pending promise, and when that promise resolved it
// installed workspace A's runtime as the session for workspace B. Autosave
// then committed B's open file through A's fenced session.
//
// So the gate holds the pair — which promise, for which workspace — and every
// resolution asks whether it is still the live attempt before anything is
// installed. A session that lost is not merely dropped: nothing installed it,
// so nothing else will ever close it, and `discard` has to hand back its
// lease, heartbeat and transport (attn-e9r2.3) rather than leave an orphan
// runtime holding a workspace against the user's other tabs.

export interface OwnerSessionGateOptions<T> {
  /** The workspace on screen right now. */
  current(): string;
  /** Start acquiring for `workspaceId`. Null means "denied, stay read-only". */
  begin(workspaceId: string): Promise<T | null>;
  /** Give back an acquisition that arrived too late to be installed. */
  discard(workspaceId: string, granted: T): Promise<void>;
}

export interface OwnerSessionGate<T> {
  /**
   * Acquire for the current workspace, calling `install` with the result —
   * including a null denial, which the caller still has to reflect. Resolves
   * null when the acquisition was superseded, so nothing was installed.
   *
   * Concurrent calls for the SAME workspace share one acquisition; a call for
   * a different workspace starts its own and orphans the first.
   */
  acquire(install: (granted: T | null) => Promise<void>): Promise<T | null>;
  /**
   * Drop the in-flight acquisition, if any: whatever it returns belongs to
   * nobody and will be discarded. Called when the workspace is torn down —
   * including the A → B → A case, where the workspace id alone would say the
   * stale attempt is current again.
   */
  invalidate(): void;
  /** The workspace an acquisition is in flight for, or null. */
  pendingFor(): string | null;
}

export function createOwnerSessionGate<T>(
  options: OwnerSessionGateOptions<T>,
): OwnerSessionGate<T> {
  let pending: Promise<T | null> | null = null;
  let pendingWorkspaceId: string | null = null;

  return {
    pendingFor: () => pendingWorkspaceId,

    invalidate(): void {
      pending = null;
      pendingWorkspaceId = null;
    },

    acquire(install: (granted: T | null) => Promise<void>): Promise<T | null> {
      const workspaceId = options.current();
      if (pending !== null && pendingWorkspaceId === workspaceId) return pending;
      const attempt: Promise<T | null> = options.begin(workspaceId).then(async (granted) => {
        // Two ways to be stale: the workspace moved on, or this attempt is no
        // longer the live one (a teardown, or a newer acquire replaced it).
        if (options.current() !== workspaceId || pending !== attempt) {
          if (granted !== null) {
            await options.discard(workspaceId, granted).catch(() => undefined);
          }
          return null;
        }
        await install(granted);
        return granted;
      }).finally(() => {
        // Only clear our own slot; a switch mid-flight already replaced it.
        if (pending === attempt) {
          pending = null;
          pendingWorkspaceId = null;
        }
      });
      pending = attempt;
      pendingWorkspaceId = workspaceId;
      return attempt;
    },
  };
}
