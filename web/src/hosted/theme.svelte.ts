// Hosted theme state (attn-7xl.1.2), migrated from site/src/lib/theme.svelte.ts.
//
// The hosted CSP forbids inline scripts, so there is no pre-paint <script> to
// stamp the stored theme. Instead each hosted entry module calls initTheme()
// before mounting: the default follows prefers-color-scheme and an explicit
// user choice is persisted to localStorage.
//
// THREE STATES, not two (attn-08fa.11). This module used to expose a light/dark
// toggle only, so a hosted user who had ever touched it was pinned to one
// appearance forever — the OS could change around them and the app would not
// follow. The native app has always modelled appearance as System / Paper / Ink
// (src/lib/theme.ts, Settings → Appearance) and the two surfaces share a
// palette, so they should not disagree about what a preference IS. `system`
// tracks the OS live; an explicit choice ignores it.

export type ThemeName = 'light' | 'dark';
export type ThemePreference = ThemeName | 'system';

const STORAGE_KEY = 'attn-theme';
const CYCLE: readonly ThemePreference[] = ['light', 'dark', 'system'] as const;

/** One name per preference, shared by the nav control and the command palette
 *  so the same state is never called two things. "Paper" and "Ink" are the
 *  themes' names in DESIGN.md; System is the absence of a choice. */
export const THEME_LABEL: Record<ThemePreference, string> = {
  light: 'Paper',
  dark: 'Ink',
  system: 'System',
};

/** What the next press of the cycling control will select. */
export function nextPreference(): ThemePreference {
  return CYCLE[(CYCLE.indexOf(preference) + 1) % CYCLE.length]!;
}

let preference = $state<ThemePreference>('system');
let theme = $state<ThemeName>('light');

function systemPrefersDark(): boolean {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
}

function resolve(next: ThemePreference): ThemeName {
  if (next === 'system') return systemPrefersDark() ? 'dark' : 'light';
  return next;
}

/** The effective appearance actually painted. */
export function getTheme(): ThemeName {
  return theme;
}

/** The user's stored choice — `system` means "follow the OS". */
export function getThemePreference(): ThemePreference {
  return preference;
}

export function setThemePreference(next: ThemePreference): void {
  apply(next);
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // Persisting the preference is best-effort.
  }
}

/** Light → Dark → System. Backs the landing nav control and ⌘K. */
export function cycleTheme(): void {
  setThemePreference(CYCLE[(CYCLE.indexOf(preference) + 1) % CYCLE.length]!);
}

/**
 * Adopt the stored preference and keep following the OS while it is `system`.
 * Returns a teardown for the media listener.
 */
export function initTheme(): () => void {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(STORAGE_KEY);
  } catch {
    // Storage may be blocked (Lockdown Mode, embedded contexts); fall through.
  }
  apply(stored === 'dark' || stored === 'light' || stored === 'system' ? stored : 'system');

  const media = window.matchMedia?.('(prefers-color-scheme: dark)');
  if (!media) return () => {};
  const onChange = (): void => {
    // Only a `system` user follows the OS; an explicit choice stays put.
    if (preference !== 'system') return;
    apply('system');
  };
  media.addEventListener('change', onChange);
  return () => media.removeEventListener('change', onChange);
}

function apply(next: ThemePreference): void {
  preference = next;
  theme = resolve(next);
  document.documentElement.dataset.theme = theme;
  // Shared native/editor components key their INK palette from `.dark`.
  // Stamp both selectors so hosted and native views consume one token set.
  document.documentElement.classList.toggle('dark', theme === 'dark');
}
