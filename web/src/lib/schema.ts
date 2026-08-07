import { Schema } from 'prosemirror-model';
import type { NodeSpec, MarkSpec, DOMOutputSpec } from 'prosemirror-model';
import {
  MarkdownParser,
  MarkdownSerializer,
  MarkdownSerializerState,
  defaultMarkdownParser,
  defaultMarkdownSerializer,
} from 'prosemirror-markdown';
import MarkdownIt from 'markdown-it';
import type Token from 'markdown-it/lib/token.mjs';
import type StateCore from 'markdown-it/lib/rules_core/state_core.mjs';
import {
  insertion,
  deletion,
  modification,
} from '@handlewithcare/prosemirror-suggest-changes';
import { renderEmbeddedSvg } from './embedded-svg-view';

// -- Nodes --

const baseNodes = defaultMarkdownParser.schema.spec.nodes;

const codeBlockNode: NodeSpec = {
  content: 'text*',
  group: 'block',
  code: true,
  defining: true,
  marks: '',
  attrs: { params: { default: '' } },
  parseDOM: [
    {
      tag: 'pre',
      preserveWhitespace: 'full',
      getAttrs: (dom) => ({
        params: (dom as HTMLElement).getAttribute('data-params') || '',
      }),
    },
  ],
  toDOM(node): DOMOutputSpec {
    return [
      'div',
      { class: 'prose-scroll-x' },
      ['pre', node.attrs.params ? { 'data-params': node.attrs.params } : {}, ['code', 0]],
    ];
  },
};

// YAML frontmatter (--- … ---) at the top of a document. Stored as an atom
// carrying the raw block so it round-trips byte-exact; rendered by a NodeView
// as a folded metadata card instead of a run-on serif paragraph.
const frontmatterNode: NodeSpec = {
  group: 'block',
  atom: true,
  selectable: true,
  attrs: { value: { default: '' } },
  parseDOM: [
    {
      tag: 'div[data-frontmatter]',
      getAttrs: (dom) => ({
        value: (dom as HTMLElement).getAttribute('data-frontmatter') || '',
      }),
    },
  ],
  toDOM(node): DOMOutputSpec {
    return ['div', { 'data-frontmatter': node.attrs.value, class: 'frontmatter-block' }];
  },
};

// Embedded SVG (attn-vlmz.4). An atom carrying the RAW source so the file
// round-trips byte-exact; `toDOM` renders the *sanitised* form built by
// `renderEmbeddedSvg`, which allowlists tags/attributes and constructs real
// nodes with createElementNS rather than parsing a string.
//
// Read planning/embedded-svg-threat-model.md before touching this or the
// `attn_svg_block` rule below. Documents are agent-authored and arrive from
// peers over shares; the parser stays in `html: false` mode and this ONE
// construct is recognised, so there is no general raw-HTML path to audit.
const embeddedSvgNode: NodeSpec = {
  group: 'block',
  atom: true,
  selectable: true,
  attrs: { source: { default: '' } },
  parseDOM: [
    {
      tag: 'div[data-embedded-svg]',
      getAttrs: (dom) => ({
        source: (dom as HTMLElement).getAttribute('data-embedded-svg') || '',
      }),
    },
  ],
  toDOM(node): DOMOutputSpec {
    const source = String(node.attrs.source ?? '');
    // No document during tsx-run unit tests; the spec form is enough there and
    // never reaches a browser.
    if (typeof document === 'undefined') {
      return ['div', { 'data-embedded-svg': source, class: 'embedded-svg' }];
    }
    return renderEmbeddedSvg(source);
  },
};

const taskListNode: NodeSpec = {
  content: 'task_list_item+',
  group: 'block',
  attrs: { tight: { default: false } },
  parseDOM: [
    {
      tag: 'ul.task-list',
      getAttrs: (dom) => ({
        tight: (dom as HTMLElement).hasAttribute('data-tight'),
      }),
    },
  ],
  toDOM(): DOMOutputSpec {
    return ['ul', { class: 'task-list' }, 0];
  },
};

const taskListItemNode: NodeSpec = {
  content: 'block+',
  defining: true,
  attrs: { checked: { default: false } },
  parseDOM: [
    {
      tag: 'li.task-list-item',
      getAttrs: (dom) => ({
        checked: (dom as HTMLElement).querySelector('input[type="checkbox"]')
          ?.hasAttribute('checked') ?? false,
      }),
    },
  ],
  toDOM(node): DOMOutputSpec {
    const checkbox = [
      'input',
      {
        type: 'checkbox',
        ...(node.attrs.checked ? { checked: '' } : {}),
        disabled: '',
      },
    ] as DOMOutputSpec;
    return [
      'li',
      { class: 'task-list-item', 'data-checked': node.attrs.checked ? 'true' : 'false' },
      ['span', { class: 'task-checkbox' }, checkbox],
      ['div', { class: 'task-content' }, 0],
    ];
  },
};

const tableNode: NodeSpec = {
  content: 'table_row+',
  group: 'block',
  tableRole: 'table',
  isolating: true,
  parseDOM: [{ tag: 'table' }],
  toDOM(): DOMOutputSpec {
    return ['div', { class: 'prose-scroll-x' }, ['table', ['tbody', 0]]];
  },
};

const tableRowNode: NodeSpec = {
  content: '(table_header | table_cell)+',
  tableRole: 'row',
  parseDOM: [{ tag: 'tr' }],
  toDOM(): DOMOutputSpec {
    return ['tr', 0];
  },
};

/**
 * Cell attributes.
 *
 * `align` is ours (markdown column alignment). The other three are a hard
 * requirement of prosemirror-tables, which reads them off every cell without
 * checking they exist: `findWidth()` does `rowWidth += cell.attrs.colspan`, so
 * a cell missing `colspan` makes the table's width `NaN`, `computeMap()` then
 * returns a zero-length TableMap, and every consumer of it fails —
 * `CellSelection.create` throws `RangeError: No cell with offset N found`, and
 * hovering within 5px of a cell's right edge throws the same from the column-
 * resize plugin's `decorations` prop. That was attn-11g4.8; declaring these is
 * the fix. Mirrors the shape of the library's own `tableNodes()` helper, whose
 * `getCellAttrs`/`setCellAttrs` are not exported for reuse.
 *
 * Markdown has no concept of spans or pixel widths, so these never reach the
 * file: the markdown serializer reads `align` and cell content and nothing
 * else. `colwidth` is written by a live column drag and is deliberately
 * session-local — it round-trips through collab and snapshots, not through the
 * document on disk.
 */
const cellAttrs: NodeSpec['attrs'] = {
  align: { default: null },
  colspan: { default: 1, validate: 'number' },
  rowspan: { default: 1, validate: 'number' },
  colwidth: { default: null, validate: validateColwidth },
};

function validateColwidth(value: unknown): void {
  if (value === null) return;
  if (!Array.isArray(value)) throw new TypeError('colwidth must be null or an array');
  for (const item of value) {
    if (typeof item !== 'number') throw new TypeError('colwidth must be null or an array of numbers');
  }
}

/** Read cell attributes off a pasted/parsed `<th>`/`<td>`. */
function readCellAttrs(dom: HTMLElement): Record<string, unknown> {
  const widthAttr = dom.getAttribute('data-colwidth');
  const widths =
    widthAttr && /^\d+(,\d+)*$/.test(widthAttr) ? widthAttr.split(',').map(Number) : null;
  const colspan = Number(dom.getAttribute('colspan') || 1);
  return {
    align: dom.style.textAlign || null,
    colspan,
    rowspan: Number(dom.getAttribute('rowspan') || 1),
    // A width list that doesn't describe this cell's columns is not this
    // cell's width list — drop it rather than let TableView size off garbage.
    colwidth: widths && widths.length === colspan ? widths : null,
  };
}

/** Write cell attributes back out, omitting every default. */
function writeCellAttrs(attrs: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  if (attrs.align) out.style = `text-align: ${String(attrs.align)}`;
  if (attrs.colspan !== 1) out.colspan = String(attrs.colspan);
  if (attrs.rowspan !== 1) out.rowspan = String(attrs.rowspan);
  if (Array.isArray(attrs.colwidth)) out['data-colwidth'] = attrs.colwidth.join(',');
  return out;
}

const tableHeaderNode: NodeSpec = {
  content: 'inline*',
  tableRole: 'header_cell',
  attrs: cellAttrs,
  isolating: true,
  parseDOM: [
    {
      tag: 'th',
      getAttrs: (dom) => readCellAttrs(dom as HTMLElement),
    },
  ],
  toDOM(node): DOMOutputSpec {
    return ['th', writeCellAttrs(node.attrs), 0];
  },
};

const tableCellNode: NodeSpec = {
  content: 'inline*',
  tableRole: 'cell',
  attrs: cellAttrs,
  isolating: true,
  parseDOM: [
    {
      tag: 'td',
      getAttrs: (dom) => readCellAttrs(dom as HTMLElement),
    },
  ],
  toDOM(node): DOMOutputSpec {
    return ['td', writeCellAttrs(node.attrs), 0];
  },
};

// -- Marks --

const baseMarks = defaultMarkdownParser.schema.spec.marks;

const strikethroughMark: MarkSpec = {
  parseDOM: [
    { tag: 's' },
    { tag: 'del' },
    { style: 'text-decoration=line-through' },
  ],
  toDOM(): DOMOutputSpec {
    return ['del'];
  },
};

// -- Build schema --

export const schema = new Schema({
  nodes: (baseNodes as unknown as Record<string, NodeSpec>)
    ? (() => {
        // Rebuild the OrderedMap with our additions
        let nodes = baseNodes;
        nodes = nodes.update('code_block', codeBlockNode);
        nodes = nodes.addBefore('text', 'frontmatter', frontmatterNode);
        nodes = nodes.addBefore('text', 'embedded_svg', embeddedSvgNode);
        nodes = nodes.addBefore('text', 'task_list', taskListNode);
        nodes = nodes.addBefore('text', 'task_list_item', taskListItemNode);
        nodes = nodes.addBefore('text', 'table', tableNode);
        nodes = nodes.addBefore('text', 'table_row', tableRowNode);
        nodes = nodes.addBefore('text', 'table_header', tableHeaderNode);
        nodes = nodes.addBefore('text', 'table_cell', tableCellNode);
        return nodes;
      })()
    : baseNodes,
  marks: (() => {
    let marks = baseMarks;
    marks = marks.addBefore('code', 'strikethrough', strikethroughMark);
    // Track-changes marks (inline suggesting mode, attn-07i.2). The marks live
    // in the schema so reviewer suggestions can be represented + synced over
    // collab; the on-disk file serializes a *reverted* doc so it never contains
    // them (see serializeAccepted in Editor.svelte).
    marks = marks.addToEnd('insertion', insertion);
    marks = marks.addToEnd('deletion', deletion);
    marks = marks.addToEnd('modification', modification);
    return marks;
  })(),
});

// -- markdown-it plugin for task lists --

function taskListPlugin(md: MarkdownIt): void {
  md.core.ruler.after('inline', 'task-lists', (state: StateCore) => {
    const tokens = state.tokens;
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i].type !== 'bullet_list_open') continue;

      // Find the matching close of this list block.
      let depth = 1;
      let k = i + 1;
      while (k < tokens.length && depth > 0) {
        if (tokens[k].type === 'bullet_list_open') depth++;
        else if (tokens[k].type === 'bullet_list_close') {
          depth--;
          if (depth === 0) {
            tokens[k].type = 'task_list_close';
            tokens[k].tag = 'ul';
          }
        }
        k++;
      }

      const taskItems: Array<{ openIdx: number; inlineIdx: number; checked: boolean; prefixLen: number }> = [];
      let allTopLevelItemsAreTasks = true;
      let foundTopLevelItems = false;

      // Inspect only top-level list items for this specific bullet list.
      let listDepth = 1;
      for (let j = i + 1; j < k - 1; j++) {
        const tok = tokens[j];
        if (tok.type === 'bullet_list_open' || tok.type === 'ordered_list_open') {
          listDepth++;
          continue;
        }
        if (tok.type === 'bullet_list_close' || tok.type === 'ordered_list_close') {
          listDepth--;
          continue;
        }
        if (tok.type !== 'list_item_open' || listDepth !== 1) {
          continue;
        }

        foundTopLevelItems = true;
        const inlineIdx = findInlineToken(tokens, j);
        if (inlineIdx < 0) {
          allTopLevelItemsAreTasks = false;
          break;
        }
        const content = tokens[inlineIdx].content;
        const match = /^\[([ xX])\]\s/.exec(content);
        if (!match) {
          allTopLevelItemsAreTasks = false;
          break;
        }
        taskItems.push({
          openIdx: j,
          inlineIdx,
          checked: match[1] !== ' ',
          prefixLen: match[0].length,
        });
      }

      // Only convert when all top-level items are task items.
      if (!foundTopLevelItems || !allTopLevelItemsAreTasks) continue;

      // Convert this bullet list to a task list.
      tokens[i].type = 'task_list_open';
      tokens[i].tag = 'ul';
      tokens[k - 1].type = 'task_list_close';
      tokens[k - 1].tag = 'ul';

      for (const item of taskItems) {
        tokens[item.openIdx].type = 'task_list_item_open';
        tokens[item.openIdx].tag = 'li';
        tokens[item.openIdx].attrSet('checked', item.checked ? 'true' : 'false');

        // Strip checkbox prefix from inline content.
        const inline = tokens[item.inlineIdx];
        inline.content = inline.content.slice(item.prefixLen);
        if (inline.children && inline.children.length > 0) {
          const firstChild = inline.children[0];
          if (firstChild.type === 'text') {
            firstChild.content = firstChild.content.slice(item.prefixLen);
          }
        }

        const closeIdx = findMatchingListItemClose(tokens, item.openIdx, k);
        if (closeIdx >= 0) {
          tokens[closeIdx].type = 'task_list_item_close';
          tokens[closeIdx].tag = 'li';
        }
      }
    }
  });
}

function findInlineToken(tokens: Token[], fromIndex: number): number {
  for (let i = fromIndex + 1; i < tokens.length; i++) {
    if (tokens[i].type === 'inline') return i;
    if (tokens[i].type === 'list_item_close') return -1;
  }
  return -1;
}

function findMatchingListItemClose(tokens: Token[], openIndex: number, endExclusive: number): number {
  let itemDepth = 1;
  for (let i = openIndex + 1; i < endExclusive; i++) {
    if (tokens[i].type === 'list_item_open' || tokens[i].type === 'task_list_item_open') itemDepth++;
    else if (tokens[i].type === 'list_item_close' || tokens[i].type === 'task_list_item_close') {
      itemDepth--;
      if (itemDepth === 0) return i;
    }
  }
  return -1;
}

// -- Build parser --

function listIsTight(tokens: Token[], i: number): boolean {
  while (++i < tokens.length)
    if (tokens[i].type !== 'list_item_open') return tokens[i].hidden;
  return false;
}

function frontmatterPlugin(md: MarkdownIt): void {
  md.block.ruler.before(
    'table',
    'front_matter',
    (state, startLine, endLine, silent) => {
      // Only a fence on the very first line, at column 0, counts.
      if (startLine !== 0 || state.blkIndent !== 0 || state.tShift[startLine] !== 0) {
        return false;
      }
      const begin = state.bMarks[startLine];
      if (state.src.slice(begin, state.eMarks[startLine]).trim() !== '---') return false;
      // Find the closing fence.
      let nextLine = startLine + 1;
      let found = false;
      for (; nextLine < endLine; nextLine++) {
        const b = state.bMarks[nextLine] + state.tShift[nextLine];
        const e = state.eMarks[nextLine];
        if (state.src.slice(b, e).trim() === '---') {
          found = true;
          break;
        }
      }
      if (!found) return false;
      if (silent) return true;
      const raw = state.src
        .slice(state.eMarks[startLine] + 1, state.bMarks[nextLine])
        .replace(/\n$/, '');
      const token = state.push('front_matter', '', 0);
      token.meta = raw;
      token.map = [startLine, nextLine + 1];
      token.block = true;
      state.line = nextLine + 1;
      return true;
    },
    { alt: [] },
  );
}

/**
 * Locate the end of the root `<svg>` element within `text`, returning the
 * offset just past its closing tag, or -1.
 *
 * Nested `<svg>` elements are legal, so this counts depth rather than taking
 * the first `</svg>`. An attribute value containing `>` truncates a match early
 * but still yields exactly one open, so the depth count stays correct.
 */
function findSvgElementEnd(text: string): number {
  const tagRe = /<svg\b[^>]*>|<\/svg\s*>/g;
  let depth = 0;
  let match: RegExpExecArray | null;
  while ((match = tagRe.exec(text)) !== null) {
    const tag = match[0];
    if (tag.startsWith('</')) {
      depth -= 1;
      if (depth === 0) return match.index + tag.length;
      if (depth < 0) return -1;
    } else if (tag.endsWith('/>')) {
      if (depth === 0) return match.index + tag.length; // self-closing root
    } else {
      depth += 1;
    }
  }
  return -1;
}

/**
 * Recognise a top-level block that is exactly one raw `<svg>…</svg>` element
 * (attn-vlmz.4.2). The parser stays in `html: false` mode — every other raw
 * HTML run keeps escaping as it does today — so this rule is the entire
 * embedded-markup surface. See planning/embedded-svg-threat-model.md §D1.
 *
 * Every condition below is also a round-trip guarantee. Because the block must
 * start its own line, close on its own line, and be followed by a blank line or
 * EOF, the boundary in the file always coincides with the block boundary the
 * serializer re-emits — so `serialize(parse(md)) === md` holds unconditionally
 * whenever this rule fires. Anything that does not qualify is simply not
 * recognised and passes through the unchanged paragraph path, which is also
 * byte-exact (just escaped rather than rendered).
 */
function svgBlockPlugin(md: MarkdownIt): void {
  md.block.ruler.before(
    'paragraph',
    'attn_svg_block',
    (state, startLine, endLine, silent) => {
      // Top level only: keeps the node out of list items and blockquotes, where
      // the serializer's per-line block delimiters would rewrite the source.
      if (state.blkIndent !== 0) return false;
      // 4+ spaces is an indented code block, which owns the line.
      if (state.tShift[startLine] >= 4) return false;

      const lineStart = state.bMarks[startLine] + state.tShift[startLine];
      const head = state.src.slice(lineStart, state.eMarks[startLine]);
      if (!/^<svg[\s>/]/.test(head)) return false;

      const searchEnd = state.eMarks[Math.min(endLine, state.lineMax) - 1];
      const relativeEnd = findSvgElementEnd(state.src.slice(lineStart, searchEnd));
      if (relativeEnd < 0) return false;
      const endOffset = lineStart + relativeEnd;

      // Which line does the closing tag land on?
      let closeLine = -1;
      for (let line = startLine; line < endLine; line++) {
        if (endOffset <= state.eMarks[line]) {
          closeLine = line;
          break;
        }
      }
      if (closeLine < 0) return false;

      // Nothing may follow `</svg>` on its line…
      if (state.src.slice(endOffset, state.eMarks[closeLine]).trim() !== '') return false;
      // …and the next line must be blank or the end of the document.
      if (closeLine + 1 < endLine) {
        const nextStart = state.bMarks[closeLine + 1] + state.tShift[closeLine + 1];
        if (nextStart < state.eMarks[closeLine + 1]) return false;
      }

      if (silent) return true;

      // From bMarks (not bMarks+tShift) so any leading indent round-trips too.
      const token = state.push('attn_svg', 'div', 0);
      token.meta = state.src.slice(state.bMarks[startLine], state.eMarks[closeLine]);
      token.map = [startLine, closeLine + 1];
      token.block = true;
      state.line = closeLine + 1;
      return true;
    },
    { alt: [] },
  );
}

const markdownItInstance = MarkdownIt('default', { html: false });
markdownItInstance.use(frontmatterPlugin);
markdownItInstance.use(svgBlockPlugin);
markdownItInstance.use(taskListPlugin);

export const markdownParser = new MarkdownParser(schema, markdownItInstance, {
  blockquote: { block: 'blockquote' },
  paragraph: { block: 'paragraph' },
  list_item: { block: 'list_item' },
  bullet_list: {
    block: 'bullet_list',
    getAttrs: (_tok: Token, tokens: Token[], i: number) => ({
      tight: listIsTight(tokens, i),
    }),
  },
  ordered_list: {
    block: 'ordered_list',
    getAttrs: (tok: Token, tokens: Token[], i: number) => ({
      order: +(tok.attrGet('start') || 1),
      tight: listIsTight(tokens, i),
    }),
  },
  heading: {
    block: 'heading',
    getAttrs: (tok: Token) => ({ level: +tok.tag.slice(1) }),
  },
  front_matter: {
    node: 'frontmatter',
    getAttrs: (tok: Token) => ({ value: (tok.meta as string) || '' }),
  },
  attn_svg: {
    node: 'embedded_svg',
    getAttrs: (tok: Token) => ({ source: (tok.meta as string) || '' }),
  },
  code_block: { block: 'code_block', noCloseToken: true },
  fence: {
    block: 'code_block',
    getAttrs: (tok: Token) => ({ params: tok.info || '' }),
    noCloseToken: true,
  },
  hr: { node: 'horizontal_rule' },
  image: {
    node: 'image',
    getAttrs: (tok: Token) => ({
      src: tok.attrGet('src'),
      title: tok.attrGet('title') || null,
      alt: (tok.children?.[0] && tok.children[0].content) || null,
    }),
  },
  hardbreak: { node: 'hard_break' },

  // Marks
  em: { mark: 'em' },
  strong: { mark: 'strong' },
  link: {
    mark: 'link',
    getAttrs: (tok: Token) => ({
      href: tok.attrGet('href'),
      title: tok.attrGet('title') || null,
    }),
  },
  code_inline: { mark: 'code', noCloseToken: true },
  s: { mark: 'strikethrough' },

  // Task list tokens
  task_list: {
    block: 'task_list',
    getAttrs: (_tok: Token, tokens: Token[], i: number) => ({
      tight: listIsTight(tokens, i),
    }),
  },
  task_list_item: {
    block: 'task_list_item',
    getAttrs: (tok: Token) => ({
      checked: tok.attrGet('checked') === 'true',
    }),
  },

  // Table tokens
  table: { block: 'table' },
  thead: { ignore: true },
  tbody: { ignore: true },
  tr: { block: 'table_row' },
  th: {
    block: 'table_header',
    getAttrs: (tok: Token) => ({
      align: tok.attrGet('style')?.match(/text-align:(\w+)/)?.[1] || null,
    }),
  },
  td: {
    block: 'table_cell',
    getAttrs: (tok: Token) => ({
      align: tok.attrGet('style')?.match(/text-align:(\w+)/)?.[1] || null,
    }),
  },
});

// -- Build serializer --

import type { Node as PmNode } from 'prosemirror-model';

// Grab the default node/mark serializers and extend them
const baseNodeSerializers = defaultMarkdownSerializer.nodes;
const baseMarkSerializers = defaultMarkdownSerializer.marks;

export const markdownSerializer = new MarkdownSerializer(
  {
    ...baseNodeSerializers,

    frontmatter(state: MarkdownSerializerState, node: PmNode) {
      state.write('---\n' + (node.attrs.value as string) + '\n---');
      state.closeBlock(node);
    },

    // Emits the ORIGINAL source and nothing else. The sanitised DOM is never
    // consulted here — the sanitiser takes a string and returns a data tree,
    // with no reference to the document — so sanitising can never rewrite the
    // user's file. `state.text(…, escape=false)` rather than a single `write`
    // so interior blank lines survive and block delimiters apply per line.
    embedded_svg(state: MarkdownSerializerState, node: PmNode) {
      state.text(String(node.attrs.source ?? ''), false);
      state.closeBlock(node);
    },

    task_list(state: MarkdownSerializerState, node: PmNode) {
      state.renderList(node, '  ', () => '');
    },

    task_list_item(state: MarkdownSerializerState, node: PmNode) {
      const prefix = node.attrs.checked ? '- [x] ' : '- [ ] ';
      state.wrapBlock('  ', prefix, node, () => state.renderContent(node));
    },

    table(state: MarkdownSerializerState, node: PmNode) {
      // Collect rows
      const rows: PmNode[] = [];
      node.forEach((row) => rows.push(row));
      if (rows.length === 0) return;

      // Determine column count and alignments from first row
      const headerRow = rows[0];
      const colCount = headerRow.childCount;
      const aligns: (string | null)[] = [];
      for (let i = 0; i < colCount; i++) {
        aligns.push(headerRow.child(i).attrs.align || null);
      }

      // Render header row
      renderTableRow(state, headerRow);
      state.ensureNewLine();

      // Render separator
      const sep = aligns
        .map((a) => {
          if (a === 'left') return ':---';
          if (a === 'right') return '---:';
          if (a === 'center') return ':---:';
          return '---';
        })
        .join(' | ');
      state.write('| ' + sep + ' |');
      state.ensureNewLine();

      // Render data rows
      for (let i = 1; i < rows.length; i++) {
        renderTableRow(state, rows[i]);
        if (i < rows.length - 1) state.ensureNewLine();
      }
      state.closeBlock(node);
    },

    table_row() {
      // Handled by table serializer
    },
    table_header() {
      // Handled by table serializer
    },
    table_cell() {
      // Handled by table serializer
    },
  },
  {
    ...baseMarkSerializers,
    strikethrough: {
      open: '~~',
      close: '~~',
      mixable: true,
      expelEnclosingWhitespace: true,
    },
    // Track-changes marks (attn-07i.2). Backstop only: the file path serializes
    // a reverted (clean) doc, so these should never fire there. Render the bare
    // content with no markdown syntax so any stray marked serialization can't
    // throw "no mark serializer".
    insertion: { open: '', close: '', mixable: true },
    deletion: { open: '', close: '', mixable: true },
    modification: { open: '', close: '', mixable: true },
  },
);

/**
 * Escape every `|` in a rendered cell so it can't be read as a column
 * delimiter.
 *
 * A pipe is only special inside a table, so the generic escaper can't do this:
 * `state.esc()` escaps ``` ` * \ ~ [ ] _ ``` and knows nothing about table
 * context. GFM resolves cell-level `\|` escapes BEFORE inline parsing, which
 * is why this is safe to apply to the fully-rendered cell — it reaches pipes
 * inside code spans and link destinations, both of which bypass `esc()`
 * entirely (code marks carry `escape: false`; hrefs are escaped only for
 * `( ) "`).
 *
 * Left unescaped, a bare pipe destroyed content in two saves (attn-11g4.10):
 * the first save widened the row past the header's column count, and the
 * second — markdown-it truncates rows to that count — dropped the overflowing
 * cell for good.
 *
 * Known limit: a literal backslash immediately before a pipe INSIDE a code
 * span emerges as `\\|`, which reads as an escaped backslash followed by a
 * live delimiter. Backslashes are only doubled on the `esc()` path, and code
 * spans skip it. Reaching that state requires source no ordinary document
 * contains, and repairing it would mean rewriting code-span content.
 */
function escapeCellPipes(text: string): string {
  return text.replace(/\|/g, '\\|');
}

/**
 * Render one cell's INLINE content to markdown.
 *
 * The wrapping paragraph is load-bearing. `MarkdownSerializer.serialize()`
 * runs `renderContent`, which walks a node's children as BLOCKS and hands each
 * to its own node serializer — and mark delimiters are emitted only by
 * `renderInline`. Serializing the cell node directly therefore dropped every
 * mark in it: `**bold**` saved as `bold`, and a link lost its target entirely
 * (attn-11g4.10). Wrapping the content in a paragraph inside a doc routes it
 * through the paragraph serializer, whose whole body is `renderInline`.
 *
 * The marks were always in the document — the parser produced them correctly.
 * This was pure loss on the way out, on every save of the whole file.
 */
function serializeCellContent(cell: PmNode): string {
  const paragraph = schema.nodes.paragraph.create(null, cell.content);
  const rendered = markdownSerializer.serialize(schema.nodes.doc.create(null, paragraph));
  // A cell is a single line: fold any hard break into a space, as before.
  return escapeCellPipes(rendered.trim().replace(/\n/g, ' '));
}

function renderTableRow(state: MarkdownSerializerState, row: PmNode): void {
  const cells: string[] = [];
  row.forEach((cell) => {
    cells.push(serializeCellContent(cell));
  });
  state.write('| ' + cells.join(' | ') + ' |');
}
