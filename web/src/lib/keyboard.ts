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
  onCommentComposer?: () => void;
  onSuggestionComposer?: () => void;
  onToggleReviewPanel?: () => void;
  /**
   * Three-way apply hooks (attn-nnj.8.3 / planning/collab/ui/three-way-apply.md
   * §6 keybindings). Fired only when `isApplyExpandOpen()` returns true, so
   * `a` doesn't collide with the margin-card accept binding on a collapsed
   * card. `Esc` is bound separately because cancel-only consumers don't need
   * the other three.
   */
  onAcceptApply?: () => void;
  onKeepMine?: () => void;
  onEditApply?: () => void;
  onCancelApply?: () => void;
  /**
   * Predicate that tells the keyboard handler whether the three-way apply
   * expand card is currently open. Wire to `() => reviewStore.activeThreeWayApply !== null`.
   */
  isApplyExpandOpen?: () => boolean;
}

function isEditableElement(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const el = target;
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
  if (isEditableElement(target)) return true;
  const activeEl = document.activeElement;
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

    // Three-way apply expand bindings (attn-nnj.8.3) take precedence over the
    // generic single-key shortcuts (`t` theme cycle, `j`/`k` cycling) while
    // the expand is open, per `planning/collab/ui/three-way-apply.md` §6.
    // The card itself also handles `onkeydown`; this global path covers the
    // case where focus has wandered off the card (e.g. the user clicked the
    // backdrop or focus landed on the body).
    if (!meta && config.isApplyExpandOpen?.()) {
      if ((key === 'a' || key === 'A') && config.onAcceptApply) {
        e.preventDefault();
        config.onAcceptApply();
        return;
      }
      if ((key === 'k' || key === 'K') && config.onKeepMine) {
        e.preventDefault();
        config.onKeepMine();
        return;
      }
      if ((key === 'e' || key === 'E') && config.onEditApply) {
        e.preventDefault();
        config.onEditApply();
        return;
      }
      if (key === 'Escape' && config.onCancelApply) {
        e.preventDefault();
        config.onCancelApply();
        return;
      }
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
      // Cmd/Ctrl+. opens the comment composer; Cmd/Ctrl+Shift+. opens the
      // suggestion composer. Match on physical key (`Period`) so the binding
      // survives Shift altering the produced character (`.` → `>`).
      if (code === 'Period' || key === '.' || key === '>') {
        if (e.shiftKey && config.onSuggestionComposer) {
          e.preventDefault();
          config.onSuggestionComposer();
          return;
        }
        if (!e.shiftKey && config.onCommentComposer) {
          e.preventDefault();
          config.onCommentComposer();
          return;
        }
      }
      // Cmd/Ctrl+J toggles the review panel.
      if (!e.shiftKey && (key === 'j' || key === 'J') && config.onToggleReviewPanel) {
        e.preventDefault();
        config.onToggleReviewPanel();
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
