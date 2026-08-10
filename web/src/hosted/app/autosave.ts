// Autosave engine (attn-7xl.3.3). Pure and injectable: commits immutable
// revisions after a bounded debounce, flushes on demand (visibility/pagehide),
// serializes commits, and reports honest save states — "Saved" only ever
// follows a durable commit.

import type { SaveState } from './types';
import {
  SAVE_STATE_AUTOSAVED,
  SAVE_STATE_SAVING,
  SAVE_STATE_STORAGE_ATTENTION,
} from '../../lib/save-state-copy';

export interface AutosaveOptions {
  /** Quiet period after the last keystroke before committing. */
  debounceMs?: number;
  /** Upper bound: continuous typing still commits at least this often. */
  maxPendingMs?: number;
  commit: (text: string) => Promise<void>;
  onState: (state: SaveState) => void;
  schedule?: (fn: () => void, ms: number) => () => void;
  now?: () => number;
}

const DEFAULT_DEBOUNCE_MS = 1_200;
const DEFAULT_MAX_PENDING_MS = 8_000;

export class AutosaveController {
  private readonly debounceMs: number;
  private readonly maxPendingMs: number;
  private readonly commit: (text: string) => Promise<void>;
  private readonly onState: (state: SaveState) => void;
  private readonly schedule: (fn: () => void, ms: number) => () => void;
  private readonly now: () => number;

  private cancelTimer: (() => void) | null = null;
  // A lazy provider so callers can defer expensive serialization (e.g. a full
  // markdown re-serialize) until the debounce actually fires — not on every
  // keystroke. A plain string is wrapped into a constant provider.
  private pendingProvider: (() => string) | null = null;
  private dirtySince: number | null = null;
  private inFlight: Promise<boolean> | null = null;
  private disposed = false;

  constructor(options: AutosaveOptions) {
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.maxPendingMs = options.maxPendingMs ?? DEFAULT_MAX_PENDING_MS;
    this.commit = options.commit;
    this.onState = options.onState;
    this.schedule =
      options.schedule ??
      ((fn, ms) => {
        const handle = setTimeout(fn, ms);
        return () => clearTimeout(handle);
      });
    this.now = options.now ?? Date.now;
  }

  /**
   * Record a pending change; (re)schedule a bounded-debounce commit. Pass a
   * `() => string` provider to defer serialization until the commit actually
   * runs (cheap per-keystroke); a plain string is committed as-is.
   */
  noteChange(text: string | (() => string)): void {
    if (this.disposed) return;
    this.pendingProvider = typeof text === 'function' ? text : () => text;
    if (this.dirtySince === null) {
      this.dirtySince = this.now();
      // Pending text is REPORTED immediately (gate: the chip must never
      // claim "Saved" while unsaved keystrokes exist — that is what makes
      // an immediate reload guard honest).
      this.onState(SAVE_STATE_SAVING);
    }
    this.cancelTimer?.();
    const pendingFor = this.now() - this.dirtySince;
    const wait = Math.max(0, Math.min(this.debounceMs, this.maxPendingMs - pendingFor));
    this.cancelTimer = this.schedule(() => void this.runCommit(), wait);
  }

  /**
   * Commit any pending text immediately (visibility/pagehide/unmount, file
   * switch). Drains completely: an in-flight commit is awaited and any text
   * that accumulated behind it is committed too, so a caller that disposes
   * the controller right after `flush()` resolves can never drop edits.
   * Stops early only on commit failure — the text stays pending and the
   * reported state stays honest.
   */
  async flush(): Promise<void> {
    for (;;) {
      this.cancelTimer?.();
      this.cancelTimer = null;
      const inFlight = this.inFlight;
      if (inFlight !== null) {
        await inFlight;
        continue; // Newer text may have landed while awaiting; drain it too.
      }
      if (this.pendingProvider === null || this.disposed) return;
      if (!(await this.runCommit())) return;
    }
  }

  get dirty(): boolean {
    return this.pendingProvider !== null;
  }

  dispose(): void {
    this.disposed = true;
    this.cancelTimer?.();
    this.cancelTimer = null;
  }

  private runCommit(): Promise<boolean> {
    if (this.inFlight !== null) {
      // A commit is in flight; the fresh text recommits when it settles.
      return Promise.resolve(false);
    }
    if (this.pendingProvider === null) return Promise.resolve(true);
    // The wrapper owns the inFlight lifecycle. commitPending can complete
    // fully synchronously (a throwing provider), so clearing inFlight from
    // inside it would run BEFORE the assignment below and strand a settled
    // promise in inFlight forever — wedging every future flush.
    const task = (async () => {
      try {
        return await this.commitPending();
      } finally {
        this.inFlight = null;
      }
    })();
    this.inFlight = task;
    return task;
  }

  private async commitPending(): Promise<boolean> {
    const provider = this.pendingProvider!;
    this.pendingProvider = null;
    this.dirtySince = null;
    this.onState(SAVE_STATE_SAVING);
    let succeeded = false;
    try {
      // Serialize exactly once, here — not per keystroke. Inside the guard:
      // a throwing provider must fail this commit honestly, not strand the
      // controller with a permanently 'in flight' commit that never settles.
      const text = provider();
      await this.commit(text);
      succeeded = true;
      if (this.pendingProvider === null) {
        this.onState(SAVE_STATE_AUTOSAVED);
      }
    } catch {
      // The durable head is still the previous commit; keep the change pending
      // so the next change or flush retries (re-serializing the latest state).
      if (this.pendingProvider === null) {
        this.pendingProvider = provider;
        this.dirtySince = this.now();
      }
      this.onState(SAVE_STATE_STORAGE_ATTENTION);
    } finally {
      if (this.pendingProvider !== null && !this.disposed) {
        // Newer text arrived mid-commit (or the commit failed): reschedule.
        this.cancelTimer?.();
        this.cancelTimer = this.schedule(() => void this.runCommit(), this.debounceMs);
      }
    }
    return succeeded;
  }
}
