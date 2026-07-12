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
  private pendingText: string | null = null;
  private dirtySince: number | null = null;
  private commitPromise: Promise<boolean> | null = null;
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

  /** Record the latest text; (re)schedule a bounded-debounce commit. */
  noteChange(text: string): void {
    if (this.disposed) return;
    this.pendingText = text;
    if (this.dirtySince === null) this.dirtySince = this.now();
    // The document is no longer represented by the durable head. Report that
    // immediately rather than leaving a stale "Saved" label visible for the
    // whole debounce window.
    this.onState('Saving…');
    this.cancelTimer?.();
    const pendingFor = this.now() - this.dirtySince;
    const wait = Math.max(0, Math.min(this.debounceMs, this.maxPendingMs - pendingFor));
    this.cancelTimer = this.schedule(() => void this.runCommit(), wait);
  }

  /** Drain pending/in-flight text now; false means durability was not reached. */
  async flush(): Promise<boolean> {
    this.cancelScheduledCommit();
    for (;;) {
      const committed = await this.runCommit();
      if (!committed) return false;
      this.cancelScheduledCommit();
      if (!this.dirty) return true;
    }
  }

  get dirty(): boolean {
    return this.pendingText !== null || this.commitPromise !== null;
  }

  dispose(): void {
    this.disposed = true;
    this.cancelScheduledCommit();
  }

  private cancelScheduledCommit(): void {
    this.cancelTimer?.();
    this.cancelTimer = null;
  }

  private async runCommit(): Promise<boolean> {
    if (this.commitPromise) return this.commitPromise;
    const text = this.pendingText;
    if (text === null) return true;
    this.pendingText = null;
    this.dirtySince = null;
    const commitPromise = (async (): Promise<boolean> => {
      try {
        await this.commit(text);
        if (this.pendingText === null) {
          this.onState('Saved on this device');
        }
        return true;
      } catch {
        // The durable head is still the previous commit; keep the text pending
        // so the next change or flush retries.
        if (this.pendingText === null) {
          this.pendingText = text;
          this.dirtySince = this.now();
        }
        this.onState('Storage needs attention');
        return false;
      }
    })();
    this.commitPromise = commitPromise;
    try {
      return await commitPromise;
    } finally {
      if (this.commitPromise === commitPromise) this.commitPromise = null;
      if (this.pendingText !== null && !this.disposed) {
        // Newer text arrived mid-commit (or the commit failed): reschedule.
        this.cancelTimer?.();
        this.cancelTimer = this.schedule(() => void this.runCommit(), this.debounceMs);
      }
    }
  }
}
