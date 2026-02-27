import type { ThemeName } from './types';
import { themeChange } from './ipc';

const VALID_THEMES: readonly ThemeName[] = ['light', 'dark', 'system'] as const;

export function getTheme(): ThemeName {
  const current = document.documentElement.dataset.theme;
  if (current && VALID_THEMES.includes(current as ThemeName)) {
    return current as ThemeName;
  }
  return 'system';
}

export function setTheme(theme: ThemeName): void {
  document.documentElement.dataset.theme = theme;
  themeChange(theme);
}

export function cycleTheme(): void {
  const current = getTheme();
  const idx = VALID_THEMES.indexOf(current);
  const next = VALID_THEMES[(idx + 1) % VALID_THEMES.length];
  setTheme(next);
}

export function getEffectiveTheme(): 'light' | 'dark' {
  const theme = getTheme();
  if (theme === 'system') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return theme;
}
