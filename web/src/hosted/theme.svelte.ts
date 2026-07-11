// Landing theme state (attn-7xl.1.2), migrated from site/src/lib/theme.svelte.ts.
//
// The hosted CSP forbids inline scripts, so there is no pre-paint <script> to
// stamp the stored theme. Instead the landing entry module calls initTheme()
// before mounting: the default follows prefers-color-scheme and an explicit
// user toggle is persisted to localStorage.

export type ThemeName = 'light' | 'dark';

const STORAGE_KEY = 'attn-theme';

let theme = $state<ThemeName>('light');

export function getTheme(): ThemeName {
  return theme;
}

export function initTheme(): void {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(STORAGE_KEY);
  } catch {
    // Storage may be blocked (Lockdown Mode, embedded contexts); fall through.
  }
  const preferred: ThemeName =
    stored === 'dark' || stored === 'light'
      ? stored
      : window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light';
  applyTheme(preferred);
}

export function toggleTheme(): void {
  applyTheme(theme === 'light' ? 'dark' : 'light');
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Persisting the preference is best-effort.
  }
}

function applyTheme(next: ThemeName): void {
  theme = next;
  document.documentElement.dataset.theme = next;
  // Shared native/editor components key their INK palette from `.dark`.
  // Stamp both selectors so hosted and native views consume one token set.
  document.documentElement.classList.toggle('dark', next === 'dark');
}
