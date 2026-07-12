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

export function publishDeskCount(count: number): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(Math.max(0, count)));
  } catch {
    // Storage blocked (Lockdown Mode, embedded contexts) — the landing
    // simply keeps its first-run CTA.
  }
}
