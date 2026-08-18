// Desk-count beacon (Theme v2, attn-cjn). The landing page must not load the
// workspace service (crypto/storage graph, route-bundle gated), but its entry
// CTA should know whether this browser already has a desk: returning users
// get "Your desk (N)" as the primary action instead of minting yet another
// Untitled workspace. The app side writes the count; the landing reads it.
// Best-effort only — storage may be blocked, and 0 is a safe default.

const STORAGE_KEY = 'attn-desk-count';

export function readDeskCount(): number {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return 0;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  } catch {
    return 0;
  }
}

/**
 * Re-read the count when the page is restored from the back/forward cache —
 * the one path where a stale count can render: the visitor went to /app,
 * changed the desk, and came back to this already-initialized page. Scoped to
 * `persisted` restores on purpose: refreshing on focus could swap which CTA is
 * primary under the visitor's cursor mid-session. Returns an unsubscribe.
 */
export function onDeskCountRestore(update: (count: number) => void): () => void {
  const refresh = (event: PageTransitionEvent): void => {
    if (event.persisted) update(readDeskCount());
  };
  window.addEventListener('pageshow', refresh);
  return () => window.removeEventListener('pageshow', refresh);
}

export function publishDeskCount(count: number): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(Math.max(0, count)));
  } catch {
    // Storage blocked (Lockdown Mode, embedded contexts) — the landing
    // simply keeps its first-run CTA.
  }
}
