import type { ThemeName, ThemePreference } from './types';
import { themeChange } from './ipc';

const VALID_PREFERENCES: readonly ThemePreference[] = ['light', 'dark', 'system'] as const;
/** Cycle order for the keyboard shortcut and command palette. */
const CYCLE: readonly ThemePreference[] = ['light', 'dark', 'system'] as const;

const DARK_QUERY = '(prefers-color-scheme: dark)';

function systemPrefersDark(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia(DARK_QUERY).matches;
}

function resolve(preference: ThemePreference): ThemeName {
  if (preference === 'system') return systemPrefersDark() ? 'dark' : 'light';
  return preference;
}

/**
 * Paint the resolved appearance.
 *
 * Atomic flip (Truth Rule, attn-hg5): suppress transitions for one frame so
 * the theme never renders half-applied — a frozen animation clock (occluded
 * window) otherwise strands mid-transition colors on screen.
 */
function apply(preference: ThemePreference, animate: boolean): void {
  const root = document.documentElement;
  const effective = resolve(preference);
  if (root.dataset.theme === effective && root.dataset.themePreference === preference) return;
  if (animate) {
    root.style.setProperty('--t', '0ms');
    root.style.setProperty('transition', 'none');
  }
  root.dataset.themePreference = preference;
  root.dataset.theme = effective;
  root.classList.toggle('dark', effective === 'dark');
  if (animate) {
    requestAnimationFrame(() => {
      root.style.removeProperty('--t');
      root.style.removeProperty('transition');
    });
  }
}

/** The user's stored choice — `system` means "follow the OS". */
export function getThemePreference(): ThemePreference {
  const current = document.documentElement.dataset.themePreference;
  if (current && VALID_PREFERENCES.includes(current as ThemePreference)) {
    return current as ThemePreference;
  }
  // Pre-resolver fallback: an explicit data-theme IS a concrete preference.
  const stamped = document.documentElement.dataset.theme;
  if (stamped === 'light' || stamped === 'dark') return stamped;
  return 'system';
}

/** What is actually painted right now. */
export function getEffectiveTheme(): ThemeName {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

/** Back-compat alias for callers that only want the painted appearance. */
export function getTheme(): ThemeName {
  return getEffectiveTheme();
}

export function setThemePreference(preference: ThemePreference): void {
  apply(preference, true);
  themeChange(preference);
}

/** Legacy entry point: a concrete theme is just a concrete preference. */
export function setTheme(theme: ThemeName): void {
  setThemePreference(theme);
}

export function cycleTheme(): void {
  const idx = CYCLE.indexOf(getThemePreference());
  setThemePreference(CYCLE[(idx + 1) % CYCLE.length]);
}

/**
 * Adopt the seeded preference and keep following the OS while it is `system`.
 * The first paint already happened in the template's inline resolver — this
 * only takes ownership of subsequent OS appearance changes.
 */
export function initTheme(): () => void {
  apply(getThemePreference(), false);

  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return () => {};
  }
  const media = window.matchMedia(DARK_QUERY);
  const onChange = (): void => {
    // Only a `system` user follows the OS; an explicit choice stays put.
    if (getThemePreference() !== 'system') return;
    apply('system', true);
  };
  media.addEventListener('change', onChange);
  return () => media.removeEventListener('change', onChange);
}
