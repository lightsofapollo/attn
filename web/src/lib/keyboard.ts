import type { AppMode } from './types';
import { quit } from './ipc';
import { cycleTheme } from './theme';

export interface KeyboardConfig {
  getMode: () => AppMode;
  onEditToggle: () => void;
  onEditCancel?: () => void;
  onEditSave?: () => void;
  onFind?: () => void;
  onTabClose?: () => void;
  onTabPrev?: () => void;
  onTabNext?: () => void;
  onGalleryPrev?: () => void;
  onGalleryNext?: () => void;
  onCommandPalette?: () => void;
  onShortcutsHelp?: () => void;
}

export function initKeyboard(config: KeyboardConfig): () => void {
  function handler(e: KeyboardEvent): void {
    const meta = e.metaKey || e.ctrlKey;

    // Cmd/Ctrl+P opens command palette globally (even in edit mode or from inputs)
    if (e.key === 'p' && meta && config.onCommandPalette) {
      e.preventDefault();
      config.onCommandPalette();
      return;
    }

    // Cmd+? opens keyboard shortcuts help globally
    if (e.key === '?' && meta && config.onShortcutsHelp) {
      e.preventDefault();
      config.onShortcutsHelp();
      return;
    }

    // Cmd/Ctrl+F opens editor find
    if (e.key === 'f' && meta && config.onFind) {
      e.preventDefault();
      config.onFind();
      return;
    }

    // Skip if focused on an input element
    const tag = (e.target as HTMLElement).tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
      return;
    }

    // In edit mode, only handle Escape and Cmd/Ctrl+S
    if (config.getMode() === 'edit') {
      if (e.key === 'Escape' && config.onEditCancel) {
        e.preventDefault();
        config.onEditCancel();
      } else if (e.key === 's' && meta && config.onEditSave) {
        e.preventDefault();
        config.onEditSave();
      }
      return;
    }

    // Tab shortcuts (Cmd+W, Cmd+[, Cmd+])
    if (meta) {
      if (e.key === 'w' && config.onTabClose) {
        e.preventDefault();
        config.onTabClose();
        return;
      }
      if (e.key === '[' && config.onTabPrev) {
        e.preventDefault();
        config.onTabPrev();
        return;
      }
      if (e.key === ']' && config.onTabNext) {
        e.preventDefault();
        config.onTabNext();
        return;
      }
    }

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
      case 'ArrowLeft':
        if (config.onGalleryPrev) config.onGalleryPrev();
        break;
      case 'ArrowRight':
        if (config.onGalleryNext) config.onGalleryNext();
        break;
    }
  }

  document.addEventListener('keydown', handler);
  return () => document.removeEventListener('keydown', handler);
}
