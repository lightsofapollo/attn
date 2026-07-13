// Svelte action: focus an element as soon as it mounts. Used for inline fields
// (rename, new-file, title) that appear on demand and expect immediate typing —
// without it the field looks inert and, on touch, the on-screen keyboard never
// opens. queueMicrotask defers to after the node is in the DOM.
export function autofocus(node: HTMLInputElement | HTMLTextAreaElement) {
  queueMicrotask(() => {
    node.focus();
    // Put the caret at the end so an existing value (e.g. a rename) is editable
    // rather than fully selected-and-replaced on the first keystroke.
    const end = node.value.length;
    try {
      node.setSelectionRange(end, end);
    } catch {
      // Some input types disallow selection ranges; focus alone is enough.
    }
  });
}
