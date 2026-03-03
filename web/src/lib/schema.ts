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

const tableHeaderNode: NodeSpec = {
  content: 'inline*',
  tableRole: 'header_cell',
  attrs: { align: { default: null } },
  isolating: true,
  parseDOM: [
    {
      tag: 'th',
      getAttrs: (dom) => ({
        align: (dom as HTMLElement).style.textAlign || null,
      }),
    },
  ],
  toDOM(node): DOMOutputSpec {
    const attrs: Record<string, string> = {};
    if (node.attrs.align) attrs.style = `text-align: ${node.attrs.align}`;
    return ['th', attrs, 0];
  },
};

const tableCellNode: NodeSpec = {
  content: 'inline*',
  tableRole: 'cell',
  attrs: { align: { default: null } },
  isolating: true,
  parseDOM: [
    {
      tag: 'td',
      getAttrs: (dom) => ({
        align: (dom as HTMLElement).style.textAlign || null,
      }),
    },
  ],
  toDOM(node): DOMOutputSpec {
    const attrs: Record<string, string> = {};
    if (node.attrs.align) attrs.style = `text-align: ${node.attrs.align}`;
    return ['td', attrs, 0];
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

const markdownItInstance = MarkdownIt('default', { html: false });
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
  },
);

function renderTableRow(state: MarkdownSerializerState, row: PmNode): void {
  const cells: string[] = [];
  row.forEach((cell) => {
    // Serialize each cell's inline content
    const cellSerializer = new MarkdownSerializer(
      markdownSerializer.nodes,
      markdownSerializer.marks,
    );
    const text = cellSerializer.serialize(cell).trim().replace(/\n/g, ' ');
    cells.push(text);
  });
  state.write('| ' + cells.join(' | ') + ' |');
}
