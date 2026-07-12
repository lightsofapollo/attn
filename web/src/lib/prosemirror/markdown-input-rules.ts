// Live markdown input rules (attn-vea): typed markdown becomes real nodes and
// marks as you write, so the hosted desktop editor stops showing literal `#`
// and matches the mobile/native reading register. The schema already supports
// every one of these (it parses them from disk); only the live rules were
// missing. Block rules mirror prosemirror-example-setup; inline mark rules are
// added on top for **bold** / *italic* / `code`.

import {
  InputRule,
  inputRules,
  wrappingInputRule,
  textblockTypeInputRule,
  smartQuotes,
  emDash,
  ellipsis,
} from 'prosemirror-inputrules';
import type { MarkType, NodeType, Schema } from 'prosemirror-model';
import type { Plugin } from 'prosemirror-state';

/** `> ` at the start of a textblock wraps it in a blockquote. */
function blockQuoteRule(nodeType: NodeType): InputRule {
  return wrappingInputRule(/^\s*>\s$/, nodeType);
}

/** `1. ` starts (or joins) an ordered list at the typed number. */
function orderedListRule(nodeType: NodeType): InputRule {
  return wrappingInputRule(
    /^(\d+)\.\s$/,
    nodeType,
    (match) => ({ order: Number(match[1]) }),
    (match, node) => node.childCount + (node.attrs.order as number) === Number(match[1]),
  );
}

/** `- `, `+ `, or `* ` starts a bullet list. */
function bulletListRule(nodeType: NodeType): InputRule {
  return wrappingInputRule(/^\s*([-+*])\s$/, nodeType);
}

/** ` ``` ` at the start of a block becomes a code block. */
function codeBlockRule(nodeType: NodeType): InputRule {
  return textblockTypeInputRule(/^```$/, nodeType);
}

/** `#`…`######` + space becomes a heading of that level. */
function headingRule(nodeType: NodeType, maxLevel: number): InputRule {
  return textblockTypeInputRule(
    new RegExp(`^(#{1,${maxLevel}})\\s$`),
    nodeType,
    (match) => ({ level: match[1].length }),
  );
}

/**
 * Apply an inline mark when a delimited run is closed. `match[1]` is the inner
 * text; the surrounding delimiters are stripped and the mark is applied to
 * what remains, then removed from the stored marks so typing continues plain.
 */
function markInputRule(regexp: RegExp, markType: MarkType): InputRule {
  return new InputRule(regexp, (state, match, start, end) => {
    const inner = match[1];
    if (!inner) return null;
    const full = match[0];
    const leading = full.search(/\S/);
    const textStart = start + full.indexOf(inner);
    const textEnd = textStart + inner.length;
    const tr = state.tr;
    // Delete from the end first so the earlier positions stay valid.
    if (textEnd < end) tr.delete(textEnd, end);
    if (textStart > start + leading) tr.delete(start + leading, textStart);
    const markFrom = start + leading;
    const markTo = markFrom + inner.length;
    tr.addMark(markFrom, markTo, markType.create());
    tr.removeStoredMark(markType);
    return tr;
  });
}

/**
 * Build the full markdown input-rules plugin for the attn schema. Includes the
 * typographic niceties (smart quotes, em-dash, ellipsis) that the markdown
 * serializer round-trips cleanly.
 */
export function markdownInputRules(schema: Schema): Plugin {
  const rules: InputRule[] = [...smartQuotes, ellipsis, emDash];

  const { heading, blockquote, ordered_list, bullet_list, code_block } = schema.nodes;
  if (heading) rules.push(headingRule(heading, 6));
  if (blockquote) rules.push(blockQuoteRule(blockquote));
  if (ordered_list) rules.push(orderedListRule(ordered_list));
  if (bullet_list) rules.push(bulletListRule(bullet_list));
  if (code_block) rules.push(codeBlockRule(code_block));

  const { strong, em, code } = schema.marks;
  if (strong) {
    rules.push(markInputRule(/\*\*([^*]+)\*\*$/, strong));
    rules.push(markInputRule(/__([^_]+)__$/, strong));
  }
  if (em) {
    // Single delimiter, but not part of a `**`/`__` pair — lookbehind keeps
    // the leading delimiter out of the match so bold isn't shadowed.
    rules.push(markInputRule(/(?<![*])\*(?![*])([^*]+?)\*$/, em));
    rules.push(markInputRule(/(?<![_])_(?![_])([^_]+?)_$/, em));
  }
  if (code) {
    rules.push(markInputRule(/`([^`]+)`$/, code));
  }

  return inputRules({ rules });
}
