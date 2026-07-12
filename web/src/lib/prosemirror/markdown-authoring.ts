import { toggleMark } from 'prosemirror-commands';
import {
  emDash,
  ellipsis,
  inputRules,
  smartQuotes,
  textblockTypeInputRule,
  wrappingInputRule,
} from 'prosemirror-inputrules';
import { keymap } from 'prosemirror-keymap';
import type { Schema } from 'prosemirror-model';
import type { Plugin } from 'prosemirror-state';

/**
 * Standard ProseMirror authoring behavior for Markdown-backed documents.
 *
 * ProseMirror deliberately provides a toolkit rather than a preassembled
 * Markdown editor. Keeping the official input-rules and keymap modules here
 * gives native and hosted surfaces one explicit, testable authoring layer.
 */
export function markdownAuthoringPlugins(schema: Schema): Plugin[] {
  return [
    inputRules({
      rules: [
        ...smartQuotes,
        ellipsis,
        emDash,
        textblockTypeInputRule(/^(#{1,6})\s$/u, schema.nodes.heading, (match) => ({
          level: match[1]?.length ?? 1,
        })),
        textblockTypeInputRule(/^```$/u, schema.nodes.code_block),
        wrappingInputRule(/^\s*>\s$/u, schema.nodes.blockquote),
        wrappingInputRule(/^\s*([-+*])\s$/u, schema.nodes.bullet_list),
        wrappingInputRule(/^(\d+)\.\s$/u, schema.nodes.ordered_list, (match) => ({
          order: Number(match[1] ?? 1),
        })),
      ],
    }),
    keymap({
      'Mod-b': toggleMark(schema.marks.strong),
      'Mod-i': toggleMark(schema.marks.em),
    }),
  ];
}
