import { tableEditing, columnResizing, goToNextCell } from 'prosemirror-tables';
import { keymap } from 'prosemirror-keymap';
import type { Plugin } from 'prosemirror-state';

/**
 * Returns an array of ProseMirror plugins for table editing support.
 * Includes column resizing, cell selection, and Tab key navigation.
 */
export function tablePlugins(): Plugin[] {
  return [
    columnResizing(),
    tableEditing(),
    keymap({
      Tab: goToNextCell(1),
      'Shift-Tab': goToNextCell(-1),
    }),
  ];
}
