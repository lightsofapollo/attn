/* Desktop autosave: when the native window may write the user's file on a
 * timer, and how long it waits (attn-yzsa.1).
 *
 * WHY THIS EXISTS. The save chip says "Changes autosaved". Until this module
 * that was a lie on desktop and only on desktop: hosted /app has had a real
 * AutosaveController since attn-7xl.3.3, while the native window had exactly
 * two save paths — ⌘S in the editor keymap, and a 1.5s debounce that only ran
 * inside a live review room. A person editing a local file with no room open
 * had no autosave at all, so the dirty chip was the only thing standing
 * between them and lost work. That is a bad job for a status chip. The owner's
 * decision (attn-yzsa.1) was to make the sentence true rather than to weaken
 * it per surface.
 *
 * WHY NOT REUSE hosted/app/autosave.ts. Considered and rejected. Its contract
 * is `commit: (text) => Promise<void>` and its entire discipline is that
 * "Saved" only ever follows a *durable* commit — it awaits the write, reports
 * 'Storage needs attention' when the promise rejects, and re-queues the text.
 * The native save path is `editSave()` in lib/ipc.ts: a fire-and-forget
 * `window.ipc.postMessage` with no ack and no promise. Adopting the controller
 * here would mean wrapping a void send in `Promise.resolve()`, which reports
 * "saved" the moment the message is QUEUED rather than when bytes reach disk —
 * keeping the shape of a durability guarantee while voiding its substance. A
 * sibling that is honest about the transport it actually has is better than a
 * shared class that quietly lies. If the daemon ever acks writes, THIS is the
 * module that grows a promise, and the two can merge then.
 *
 * THE TWO HALVES. `resolveAutosaveGate` is the policy — may we write this file
 * right now, at all — and `NativeAutosave` is the clock. They are separate
 * because the gate has to be re-asked at fire time, not at schedule time: a
 * file can change on disk during the debounce window, and the whole point of
 * the held state is that the decision made 1.2 seconds ago is not the decision
 * that governs the write.
 */

export type AutosaveMode = 'read' | 'edit';

/** Everything the gate reads, lifted out of App.svelte so it can be tested. */
export interface AutosaveContext {
  /** `edit` is the explicit editing mode; `read` is the rendered view. */
  mode: AutosaveMode;
  /** File type of the active tab. Only markdown has a save path. */
  fileType: string;
  /** There is an active file path to write to. */
  hasPath: boolean;
  /**
   * This window is a reviewer looking at someone else's shared snapshot.
   * There is no local file underneath it — a write here would have no target,
   * and the reviewer's edits belong in suggestions, not on the owner's disk.
   */
  isReviewerViewingSnapshot: boolean;
  /** A live co-typing session is up. */
  collabActive: boolean;
  /** This window's role in that session. */
  collabRole: 'owner' | 'reviewer';
  /**
   * The file changed on disk since we loaded it and the reload has been
   * DEFERRED because the buffer is dirty (App.svelte's
   * `deferredReloadMtimeByPath`). Autosaving now would silently overwrite
   * whatever the other writer — an agent, a git checkout, another editor —
   * just put there. This is the one case where the timer must lose to the
   * human.
   */
  externalChangePending: boolean;
}

export type AutosaveGate =
  /** Write when the timer says so. */
  | { status: 'armed' }
  /**
   * Autosave applies here but must not fire yet. Distinct from `off`: the
   * pending text stays pending, the chip stays dirty, and the user resolves it
   * (⌘S keeps theirs, Escape takes the disk's).
   */
  | { status: 'held'; reason: string }
  /** Autosave does not apply to this surface at all. */
  | { status: 'off'; reason: string };

export const AUTOSAVE_OFF_REVIEWING_SNAPSHOT =
  'This is a shared snapshot, not a local file — there is nothing on this device to write to.';
export const AUTOSAVE_OFF_NO_FILE = 'No file is open.';
export const AUTOSAVE_OFF_NOT_MARKDOWN = 'Only markdown documents are editable.';
export const AUTOSAVE_OFF_NOT_EDITING = 'Not editing this document.';
export const AUTOSAVE_HELD_DISK_CONFLICT =
  'This file changed on disk after you started editing. Autosave is paused so your window does not overwrite the newer version — save to keep yours, or cancel to take the version on disk.';

/** Short enough for a status chip; the sentence above is for anywhere with room. */
export const AUTOSAVE_HELD_SHORT = 'Unsaved changes · file changed on disk';

/**
 * May this window write the active file on a timer right now?
 *
 * Ordering is deliberate. The structural refusals come first so that a
 * reviewer or a non-markdown tab never reaches the disk-conflict branch and
 * reads as "held" — held promises the user that ⌘S will resolve it, and on
 * those surfaces it would not.
 */
export function resolveAutosaveGate(ctx: AutosaveContext): AutosaveGate {
  if (ctx.isReviewerViewingSnapshot) {
    return { status: 'off', reason: AUTOSAVE_OFF_REVIEWING_SNAPSHOT };
  }
  if (!ctx.hasPath) return { status: 'off', reason: AUTOSAVE_OFF_NO_FILE };
  if (ctx.fileType !== 'markdown') {
    return { status: 'off', reason: AUTOSAVE_OFF_NOT_MARKDOWN };
  }
  // Two ways to be legitimately writing this file: explicit edit mode, or a
  // live room where the owner's view is editable regardless of `mode` (collab
  // makes the document editable so the owner can co-type from the rendered
  // view). The second clause is the old collab-only save timer's guard,
  // preserved exactly — this module REPLACES that timer rather than running
  // beside it, because two debounces writing the same file is how you get
  // interleaved writes and a save that reverts the one before it.
  if (ctx.mode !== 'edit' && !(ctx.collabActive && ctx.collabRole === 'owner')) {
    return { status: 'off', reason: AUTOSAVE_OFF_NOT_EDITING };
  }
  if (ctx.externalChangePending) {
    return { status: 'held', reason: AUTOSAVE_HELD_DISK_CONFLICT };
  }
  return { status: 'armed' };
}

/**
 * Quiet period after the last keystroke. Matches hosted's 1.2s rather than the
 * old collab timer's 1.5s: the two surfaces now claim the same sentence, so
 * they should not feel different, and the shorter wait is the one that was
 * already shipping to users on the web.
 */
export const NATIVE_AUTOSAVE_DEBOUNCE_MS = 1_200;

/**
 * Ceiling. Without it, continuous typing renews the debounce forever and a
 * long uninterrupted paragraph never reaches disk — the exact failure a naive
 * debounce hides, because it only shows up for the people writing fastest.
 */
export const NATIVE_AUTOSAVE_CEILING_MS = 8_000;

export interface NativeAutosaveOptions {
  /** Quiet period after the last change before writing. */
  debounceMs?: number;
  /** Upper bound: continuous typing still writes at least this often. */
  maxPendingMs?: number;
  /**
   * Perform the write. Fire-and-forget by design (see the module header) —
   * a `void` return is the honest signature for `window.ipc.postMessage`.
   */
  commit: () => void;
  /**
   * Re-asked at fire time, never cached at schedule time. See the module
   * header: the state that matters is the state when the write would land.
   */
  gate: () => AutosaveGate;
  /** Observability hook — fired with the gate that refused a due write. */
  onSkipped?: (gate: AutosaveGate) => void;
  schedule?: (fn: () => void, ms: number) => () => void;
  now?: () => number;
}

export class NativeAutosave {
  private readonly debounceMs: number;
  private readonly maxPendingMs: number;
  private readonly commitFn: () => void;
  private readonly gate: () => AutosaveGate;
  private readonly onSkipped: ((gate: AutosaveGate) => void) | null;
  private readonly schedule: (fn: () => void, ms: number) => () => void;
  private readonly now: () => number;

  private cancelTimer: (() => void) | null = null;
  private hasPending = false;
  private pendingSince: number | null = null;
  private disposed = false;

  constructor(options: NativeAutosaveOptions) {
    this.debounceMs = options.debounceMs ?? NATIVE_AUTOSAVE_DEBOUNCE_MS;
    this.maxPendingMs = options.maxPendingMs ?? NATIVE_AUTOSAVE_CEILING_MS;
    this.commitFn = options.commit;
    this.gate = options.gate;
    this.onSkipped = options.onSkipped ?? null;
    this.schedule =
      options.schedule ??
      ((fn, ms) => {
        const handle = setTimeout(fn, ms);
        return () => clearTimeout(handle);
      });
    this.now = options.now ?? Date.now;
  }

  /** Is there an edit waiting to be written? */
  get pending(): boolean {
    return this.hasPending;
  }

  /**
   * A doc-changing transaction happened. Re-arms the debounce, clamped so the
   * write still lands within the ceiling measured from the FIRST change of the
   * burst — not from this one, which is what would let fast typing outrun it.
   *
   * Deliberately does NOT consult the gate. A refused write and a not-yet-due
   * write are different, and collapsing them here would mean an edit made
   * during a disk conflict is forgotten rather than held: the user resolves
   * the conflict with ⌘S and their keystrokes from the held window are gone.
   */
  noteChange(): void {
    if (this.disposed) return;
    if (!this.hasPending) {
      this.hasPending = true;
      this.pendingSince = this.now();
    }
    this.arm();
  }

  /**
   * Write now if there is anything to write and the gate allows it. Used for
   * the moments where waiting out the debounce is not an option: switching
   * files (the buffer is about to be replaced), and the window going away.
   *
   * Returns whether a write actually happened, so callers can tell "nothing to
   * do" from "refused".
   */
  flush(): boolean {
    if (this.disposed) return false;
    this.clearTimer();
    if (!this.hasPending) return false;
    return this.fire();
  }

  /**
   * The pending write no longer needs to happen — either it just happened by
   * another route (⌘S, which calls the same save function directly), or the
   * edits were discarded (Escape reverts the buffer), or the surface changed
   * out from under it. Drops the pending state WITHOUT writing.
   */
  cancel(): void {
    this.clearTimer();
    this.hasPending = false;
    this.pendingSince = null;
  }

  dispose(): void {
    this.disposed = true;
    this.cancel();
  }

  private arm(): void {
    this.clearTimer();
    const pendingFor = this.pendingSince === null ? 0 : this.now() - this.pendingSince;
    const wait = Math.max(0, Math.min(this.debounceMs, this.maxPendingMs - pendingFor));
    this.cancelTimer = this.schedule(() => {
      this.cancelTimer = null;
      this.fire();
    }, wait);
  }

  private fire(): boolean {
    if (this.disposed || !this.hasPending) return false;
    const gate = this.gate();
    if (gate.status === 'armed') {
      // Clear BEFORE committing: `commit` runs the app's save function, which
      // may re-enter this controller (a save re-serializes the doc, and any
      // resulting transaction would call `noteChange`). Clearing afterwards
      // would throw away that legitimately-new pending state.
      this.hasPending = false;
      this.pendingSince = null;
      this.commitFn();
      return true;
    }
    if (gate.status === 'held') {
      // Stay pending and stop the clock. Nothing this module can do resolves a
      // disk conflict, so retrying on a timer would just re-refuse forever
      // (and each refusal is a wakeup). The resolution is a user action —
      // ⌘S or Escape — and both of those call back in.
      this.onSkipped?.(gate);
      return false;
    }
    // 'off': the surface no longer accepts writes (left edit mode, switched to
    // a non-markdown tab, became a reviewer). Drop the pending write rather
    // than holding it: whatever changed the surface owns the buffer now, and a
    // write fired later against a different active path is data loss, not
    // rescue.
    this.onSkipped?.(gate);
    this.hasPending = false;
    this.pendingSince = null;
    return false;
  }

  private clearTimer(): void {
    this.cancelTimer?.();
    this.cancelTimer = null;
  }
}
