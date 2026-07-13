// Autosave engine (attn-7xl.3.3). Pure and injectable: commits immutable
// revisions after a bounded debounce, flushes on demand (visibility/pagehide),
// serializes commits, and reports honest save states — "Saved" only ever
// follows a durable commit.

import type { SaveState } from './types';

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
  private committing = false;
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
    if (this.dirtySince === null) this.dirtySince = this.now();
    this.cancelTimer?.();
    const pendingFor = this.now() - this.dirtySince;
    const wait = Math.max(0, Math.min(this.debounceMs, this.maxPendingMs - pendingFor));
    this.cancelTimer = this.schedule(() => void this.runCommit(), wait);
  }

  /** Commit any pending text immediately (visibility/pagehide/unmount). */
  async flush(): Promise<void> {
    this.cancelTimer?.();
    this.cancelTimer = null;
    await this.runCommit();
  }

  get dirty(): boolean {
    return this.pendingProvider !== null;
  }

  dispose(): void {
    this.disposed = true;
    this.cancelTimer?.();
    this.cancelTimer = null;
  }

  private async runCommit(): Promise<void> {
    if (this.committing) {
      // A commit is in flight; the fresh text recommits when it settles.
      return;
    }
    const provider = this.pendingProvider;
    if (provider === null) return;
    this.pendingProvider = null;
    this.dirtySince = null;
    this.committing = true;
    this.onState('Saving…');
    // Serialize exactly once, here — not per keystroke.
    const text = provider();
    try {
      await this.commit(text);
      if (this.pendingProvider === null) {
        this.onState('Saved on this device');
      }
    } catch {
      // The durable head is still the previous commit; keep the change pending
      // so the next change or flush retries (re-serializing the latest state).
      if (this.pendingProvider === null) {
        this.pendingProvider = provider;
        this.dirtySince = this.now();
      }
      this.onState('Storage needs attention');
    } finally {
      this.committing = false;
      if (this.pendingProvider !== null && !this.disposed) {
        // Newer text arrived mid-commit (or the commit failed): reschedule.
        this.cancelTimer?.();
        this.cancelTimer = this.schedule(() => void this.runCommit(), this.debounceMs);
      }
    }
  }
}
