import { decreaseFontScale, increaseFontScale, resetFontScale } from './font-scale';
import { cycleTheme } from './theme';

export interface KeyboardConfig {
  onTabClose?: () => void;
  onTabPrev?: () => void;
  onTabNext?: () => void;
  onGalleryPrev?: () => void;
  onGalleryNext?: () => void;
  onCommandPalette?: () => void;
  onShortcutsHelp?: () => void;
  onUndo?: () => void;
  onRedo?: () => void;
}

function isEditableElement(el: HTMLElement | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (el.isContentEditable) return true;

  // Respect embedded editor surfaces (CodeMirror/Monaco/ProseMirror/etc.)
  if (
    el.closest('[contenteditable="true"]')
    || el.closest('[role="textbox"]')
    || el.closest('.cm-editor')
    || el.closest('.monaco-editor')
    || el.closest('.ProseMirror')
  ) {
    return true;
  }

  return false;
}

function isEditableTarget(target: EventTarget | null): boolean {
  const targetEl = target as HTMLElement | null;
  if (isEditableElement(targetEl)) return true;
  const activeEl = document.activeElement as HTMLElement | null;
  return isEditableElement(activeEl);
}

export function initKeyboard(config: KeyboardConfig): () => void {
  function handler(e: KeyboardEvent): void {
    if (e.repeat || e.defaultPrevented || e.isComposing) return;

    const meta = e.metaKey || e.ctrlKey;
    const key = e.key;
    const code = e.code;
    const nativeHostShortcuts = Boolean(
      (window as Window & { __attn_native_shortcuts__?: boolean }).__attn_native_shortcuts__,
    );
    const mermaidFullscreenOpen = Boolean(document.querySelector('.mermaid-fullscreen-modal'));
    const editingTarget = isEditableTarget(e.target);

    // Browser-like font size controls (Cmd/Ctrl +, -, 0)
    if (meta && !nativeHostShortcuts && !mermaidFullscreenOpen) {
      if (key === '=' || key === '+' || code === 'Equal' || code === 'NumpadAdd') {
        e.preventDefault();
        increaseFontScale();
        return;
      }
      if (key === '-' || key === '_' || code === 'Minus' || code === 'NumpadSubtract') {
        e.preventDefault();
        decreaseFontScale();
        return;
      }
      if (key === '0' || code === 'Digit0' || code === 'Numpad0') {
        e.preventDefault();
        resetFontScale();
        return;
      }
    }

    // App-level shortcuts should never steal focus from text-editing surfaces.
    if (editingTarget) {
      return;
    }

    // Cmd/Ctrl+P opens command palette globally
    if (key === 'p' && meta && config.onCommandPalette) {
      e.preventDefault();
      config.onCommandPalette();
      return;
    }

    // Cmd/Ctrl+/ (or Cmd/Ctrl+?) opens keyboard shortcuts help globally
    if (
      meta
      && config.onShortcutsHelp
      && (
        code === 'Slash'
        || code === 'NumpadDivide'
        || code === 'IntlRo'
        || code === 'IntlYen'
        || key === '/'
        || key === '?'
        || key === '÷'
      )
    ) {
      e.preventDefault();
      config.onShortcutsHelp();
      return;
    }

    // Tab shortcuts (Cmd+W, Cmd+[, Cmd+])
    if (meta) {
      if (e.key === 'z' && !e.shiftKey && config.onUndo) {
        e.preventDefault();
        config.onUndo();
        return;
      }
      if ((e.key === 'y' || (e.key === 'z' && e.shiftKey)) && config.onRedo) {
        e.preventDefault();
        config.onRedo();
        return;
      }
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
      case 't':
        cycleTheme();
        break;
      case 'ArrowLeft':
        if (config.onGalleryPrev) config.onGalleryPrev();
        break;
      case 'ArrowRight':
        if (config.onGalleryNext) config.onGalleryNext();
        break;
    }
  }

  window.addEventListener('keydown', handler);
  return () => window.removeEventListener('keydown', handler);
}
