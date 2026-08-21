// One transition token for every in-app move (attn-1l2f.2).
//
// AppShell mutates a lot of state after an await: `detail`, `activePath`,
// `bodyText`, `route`, and the history entry all land together once a read
// resolves. Two things can go wrong in that window, and a per-function
// counter only catches the first:
//
//   1. A NEWER move of the same kind started. The old read must not win.
//   2. A move of a DIFFERENT kind started — specifically, the workspace
//      changed underneath. A file read issued against workspace A resolving
//      after the app has opened workspace B would put A's body and A's path
//      into B's editor and B's URL, and the next autosave would write it
//      back into B.
//
// So the counter is shared across every transition — a file switch supersedes
// a workspace navigation and vice versa — and reads that belong to one
// workspace also carry that identity, because generation alone cannot express
// "this body is from a document we are no longer showing".
//
// The module is framework-free so the interleavings can be driven directly by
// a test; the component holds one guard for its lifetime.

export interface NavigationGuard {
  /**
   * Start a transition, superseding anything in flight. Every user-initiated
   * move (navigate, open a workspace, switch file, create) takes one.
   */
  begin(): number;
  /**
   * Observe the current transition WITHOUT starting one. Background refreshes
   * (a cross-tab change, a re-read of the open file) use this: they must be
   * cancelled by a navigation, but must never cancel one.
   */
  current(): number;
  /** Whether `token` still names the transition in flight. */
  isCurrent(token: number): boolean;
}

export function createNavigationGuard(): NavigationGuard {
  let generation = 0;
  return {
    begin(): number {
      generation += 1;
      return generation;
    },
    current(): number {
      return generation;
    },
    isCurrent(token: number): boolean {
      return token === generation;
    },
  };
}

/** A read in flight against one workspace, tagged with the move that issued it. */
export interface PendingWorkspaceRead {
  token: number;
  workspaceId: string;
}

/**
 * Whether a resolved read may still be applied to component state.
 *
 * Both halves are load-bearing. The token drops a read the user has already
 * moved past; `openWorkspaceId` drops a read whose workspace is no longer the
 * open one, which is the case a generation counter cannot see — the newer move
 * may have completed entirely, leaving its own token current.
 */
export function canApplyWorkspaceRead(
  guard: NavigationGuard,
  pending: PendingWorkspaceRead,
  openWorkspaceId: string | undefined,
): boolean {
  return guard.isCurrent(pending.token) && openWorkspaceId === pending.workspaceId;
}
