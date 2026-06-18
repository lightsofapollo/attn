// Shared Enter-key policy for review composers (attn-2aj).
//
// Every authoring textarea (reply, comment, suggestion fields) submits on
// plain Enter; Shift+Enter (or Alt+Enter) inserts a newline. Cmd/Ctrl+
// Enter keeps submitting for muscle memory. Kept pure so it is testable
// without a DOM and identical across surfaces.
//
// IME safety: the Enter that confirms an IME candidate must NEVER submit.
// Chrome/Firefox deliver it with `isComposing: true`, but WebKit — the
// only engine attn ships on — fires `compositionend` FIRST and then a
// keydown with `isComposing: false` and the legacy `keyCode: 229`
// (WebKit bug 165004 / w3c/uievents#202). Checking both is the standard
// guard used by Lexical/ProseMirror-class editors. `repeat` is rejected
// so a held Enter can't machine-gun submits once IPC gains real acks.

export function shouldSubmitOnEnter(e: {
  key: string;
  isComposing?: boolean;
  keyCode?: number;
  repeat?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
}): boolean {
  if (e.key !== 'Enter') return false;
  if (e.isComposing || e.keyCode === 229) return false;
  if (e.repeat) return false;
  if (e.shiftKey || e.altKey) return false;
  return true;
}
