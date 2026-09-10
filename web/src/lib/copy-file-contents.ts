// "Copy file contents" header button — the state machine behind the glyph.
//
// The button is a single icon that reads the CURRENT document (whatever the
// viewer is showing: the live editor buffer, a received snapshot, or the raw
// bytes fetched back from disk) and writes it to the clipboard. The shells
// only own the glyph and the title; everything that can fail or needs a
// timer lives here so it runs under plain tsx (no runes) and can be tested
// with an injected clock and clipboard.
//
// Three states, each visibly distinct (PRODUCT.md: never rely on colour
// alone): `idle` shows the copy glyph, `copied` swaps to a check for
// `resetMs` and announces "Copied" in a live region, `error` keeps the copy
// glyph but puts the failure in the title for the same window. Both
// non-idle states fall back to idle on their own; a fresh click while one is
// pending replaces it and restarts the clock.

export type CopyFileState =
  | { kind: 'idle' }
  | { kind: 'copied' }
  | { kind: 'error'; message: string };

export const COPY_FILE_RESET_MS = 1500;
export const COPY_FILE_IDLE_TITLE = 'Copy file contents';
export const COPY_FILE_COPIED_TITLE = 'Copied';

export interface CopyFileControllerOptions {
  /** Produces the text to copy. Runs on every click, never cached. */
  source: () => Promise<string> | string;
  /** Emits every state transition, including the timed reset to idle. */
  onChange: (state: CopyFileState) => void;
  /** Clipboard writer. Defaults to `navigator.clipboard.writeText`. */
  write?: (text: string) => Promise<void>;
  /** How long `copied` / `error` stay on screen. */
  resetMs?: number;
  /** Injectable timers so tests can drive the reset without waiting. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface CopyFileController {
  /** Reads the source and writes the clipboard; resolves with the new state. */
  copy(): Promise<CopyFileState>;
  /** Cancels a pending reset. Call on unmount. */
  dispose(): void;
}

export function copyFileTitle(state: CopyFileState): string {
  switch (state.kind) {
    case 'copied':
      return COPY_FILE_COPIED_TITLE;
    case 'error':
      return `Couldn't copy: ${state.message}`;
    default:
      return COPY_FILE_IDLE_TITLE;
  }
}

async function writeToNavigatorClipboard(text: string): Promise<void> {
  const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
  if (!clipboard?.writeText) throw new Error('Clipboard is not available');
  await clipboard.writeText(text);
}

function describeError(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  const text = String(err);
  return text && text !== '[object Object]' ? text : 'Unknown error';
}

export function createCopyFileController(options: CopyFileControllerOptions): CopyFileController {
  const {
    source,
    onChange,
    write = writeToNavigatorClipboard,
    resetMs = COPY_FILE_RESET_MS,
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  } = options;

  let resetHandle: unknown = null;
  // Each click gets a ticket; a slow read that resolves after a newer click
  // must not clobber the newer click's outcome.
  let ticket = 0;

  function cancelReset(): void {
    if (resetHandle === null) return;
    clearTimer(resetHandle);
    resetHandle = null;
  }

  function settle(state: CopyFileState): CopyFileState {
    cancelReset();
    onChange(state);
    resetHandle = setTimer(() => {
      resetHandle = null;
      onChange({ kind: 'idle' });
    }, resetMs);
    return state;
  }

  return {
    async copy() {
      const mine = ++ticket;
      let state: CopyFileState;
      try {
        const text = await source();
        await write(text);
        state = { kind: 'copied' };
      } catch (err) {
        state = { kind: 'error', message: describeError(err) };
      }
      if (mine !== ticket) return state;
      return settle(state);
    },
    dispose() {
      ticket++;
      cancelReset();
    },
  };
}
