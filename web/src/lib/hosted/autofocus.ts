// Svelte action: focus an element as soon as it mounts. Used for inline fields
// (rename, new-file, title) that appear on demand and expect immediate typing —
// without it the field looks inert and, on touch, the on-screen keyboard never
// opens. queueMicrotask defers to after the node is in the DOM.
export function autofocus(node: HTMLElement) {
  queueMicrotask(() => {
    node.focus();
    // Text fields: put the caret at the end so an existing value (e.g. a
    // rename) is editable rather than fully selected-and-replaced on the
    // first keystroke. Non-text elements (e.g. a confirm dialog's safe
    // Cancel button) just take focus.
    if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement) {
      const end = node.value.length;
      try {
        node.setSelectionRange(end, end);
      } catch {
        // Some input types disallow selection ranges; focus alone is enough.
      }
    }
  });
}
