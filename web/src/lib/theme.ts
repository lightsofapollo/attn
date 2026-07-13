import type { ThemeName } from './types';
import { themeChange } from './ipc';

const VALID_THEMES: readonly ThemeName[] = ['light', 'dark'] as const;

/** Apply the effective dark/light class on <html> for shadcn. */
function applyDarkClass(theme: ThemeName): void {
  document.documentElement.classList.toggle('dark', theme === 'dark');
}

export function getTheme(): ThemeName {
  const current = document.documentElement.dataset.theme;
  if (current && VALID_THEMES.includes(current as ThemeName)) {
    return current as ThemeName;
  }
  return 'light';
}

export function setTheme(theme: ThemeName): void {
  // Atomic flip (Truth Rule, attn-hg5): suppress transitions for one frame so
  // the theme never renders half-applied — a frozen animation clock (occluded
  // window) otherwise strands mid-transition colors on screen.
  const root = document.documentElement;
  root.style.setProperty('--t', '0ms');
  root.style.setProperty('transition', 'none');
  root.dataset.theme = theme;
  applyDarkClass(theme);
  requestAnimationFrame(() => {
    root.style.removeProperty('--t');
    root.style.removeProperty('transition');
  });
  themeChange(theme);
}

export function cycleTheme(): void {
  const current = getTheme();
  const idx = VALID_THEMES.indexOf(current);
  const next = VALID_THEMES[(idx + 1) % VALID_THEMES.length];
  setTheme(next);
}

export function getEffectiveTheme(): 'light' | 'dark' {
  return getTheme();
}

/** Initialize theme from data-theme attribute (set by Rust). */
export function initTheme(): void {
  const theme = getTheme();
  applyDarkClass(theme);
}
