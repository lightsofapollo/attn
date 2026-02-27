import type { AppMode } from './types';
import { quit } from './ipc';
import { cycleTheme } from './theme';

export interface KeyboardConfig {
  getMode: () => AppMode;
  onEditToggle: () => void;
}

export function initKeyboard(config: KeyboardConfig): () => void {
  function handler(e: KeyboardEvent): void {
    // Skip if focused on an input element
    const tag = (e.target as HTMLElement).tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
      return;
    }

    if (config.getMode() === 'edit') return;

    switch (e.key) {
      case 'q':
        quit();
        break;
      case 'j':
        window.scrollBy(0, 60);
        break;
      case 'k':
        window.scrollBy(0, -60);
        break;
      case ' ':
        e.preventDefault();
        window.scrollBy(0, window.innerHeight * 0.8);
        break;
      case 'g':
        window.scrollTo(0, 0);
        break;
      case 'G':
        window.scrollTo(0, document.body.scrollHeight);
        break;
      case 't':
        cycleTheme();
        break;
      case 'e':
        config.onEditToggle();
        break;
    }
  }

  document.addEventListener('keydown', handler);
  return () => document.removeEventListener('keydown', handler);
}
