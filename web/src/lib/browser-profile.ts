// Browser-side display-name persistence (attn-sur).
//
// On native, the display name lives on the Rust device identity and arrives
// via the init payload. Hosted surfaces have no daemon, so the chosen name is
// kept in localStorage — it is not a secret (it is broadcast to every room
// peer by design), so plaintext browser storage is the honest fit.
//
// Kept runes-free so BOTH the narrow /s/ bootstrap (which must not pull the
// Svelte runtime early) and the profile store can import it.

const STORAGE_KEY = 'attn.profile.displayName';

/** The user's chosen display name, or null when never set (or storage denied). */
export function readStoredDisplayName(): string | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const trimmed = raw?.trim();
    return trimmed && trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

/** Persist (or clear, with null/empty) the chosen display name. Best-effort. */
export function writeStoredDisplayName(name: string | null): void {
  try {
    const trimmed = name?.trim();
    if (trimmed && trimmed.length > 0) {
      window.localStorage.setItem(STORAGE_KEY, trimmed);
    } else {
      window.localStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    // Private-mode / storage-denied browsers: the in-memory value still
    // applies for this visit; the next visit re-prompts.
  }
}
