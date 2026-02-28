import { Plugin, PluginKey } from 'prosemirror-state';
import type { EditorState } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';
import type { Node as PmNode } from 'prosemirror-model';
import hljs from 'highlight.js/lib/common';

const highlightKey = new PluginKey('code-highlight');
const MAX_CODE_BLOCK_CHARS = 20_000;
const MAX_TOTAL_HIGHLIGHT_CHARS = 120_000;
const MAX_AUTODETECT_CHARS = 4_000;

let lastHighlightSkipSignature = '';

hljs.registerAliases(['js', 'jsx'], { languageName: 'javascript' });
hljs.registerAliases(['ts', 'tsx'], { languageName: 'typescript' });
hljs.registerAliases(['py'], { languageName: 'python' });
hljs.registerAliases(['cxx', 'cpp', 'c++', 'h', 'hpp'], { languageName: 'cpp' });
hljs.registerAliases(['c#'], { languageName: 'csharp' });
hljs.registerAliases(['sh', 'zsh', 'bashrc', 'shell'], { languageName: 'bash' });
hljs.registerAliases(['yml'], { languageName: 'yaml' });
hljs.registerAliases(['html', 'xhtml', 'xsl'], { languageName: 'xml' });
hljs.registerAliases(['rs'], { languageName: 'rust' });
hljs.registerAliases(['text', 'plain'], { languageName: 'plaintext' });

function hasCodeBlocks(doc: PmNode): boolean {
  let hasCodeBlock = false;
  doc.descendants((node) => {
    if (node.type.name === 'code_block') {
      hasCodeBlock = true;
      return false;
    }
    return true;
  });
  return hasCodeBlock;
}

/** Parse hljs HTML output into a flat list of {className, text} segments */
interface HljsSpan {
  className: string;
  text: string;
}

function parseHljsHtml(html: string): HljsSpan[] {
  const spans: HljsSpan[] = [];
  // hljs outputs: plain text and <span class="hljs-...">text</span> (possibly nested)
  // We use a stack-based approach to handle nesting
  const classStack: string[] = [];
  let i = 0;
  while (i < html.length) {
    if (html[i] === '<') {
      // Check for closing tag
      if (html[i + 1] === '/') {
        // </span>
        const closeEnd = html.indexOf('>', i);
        if (closeEnd !== -1) {
          classStack.pop();
          i = closeEnd + 1;
          continue;
        }
      }
      // Opening tag: <span class="hljs-keyword">
      const tagEnd = html.indexOf('>', i);
      if (tagEnd !== -1) {
        const tag = html.substring(i, tagEnd + 1);
        const classMatch = /class="([^"]*)"/.exec(tag);
        if (classMatch) {
          classStack.push(classMatch[1]);
        } else {
          classStack.push('');
        }
        i = tagEnd + 1;
        continue;
      }
    }
    // Find the next tag or end of string
    let textEnd = html.indexOf('<', i);
    if (textEnd === -1) textEnd = html.length;
    if (textEnd > i) {
      const rawText = html.substring(i, textEnd);
      // Decode HTML entities
      const text = rawText
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#x27;/g, "'")
        .replace(/&#39;/g, "'");
      // Use the innermost class from the stack
      const className = classStack.length > 0 ? classStack[classStack.length - 1] : '';
      spans.push({ className, text });
    }
    i = textEnd;
  }
  return spans;
}

function getDecorations(doc: PmNode): DecorationSet {
  const decorations: Decoration[] = [];
  let totalHighlightedChars = 0;
  let highlightedBlocks = 0;
  let skippedLargeBlocks = 0;
  let skippedDueToBudget = 0;
  let skippedAutodetectBlocks = 0;

  doc.descendants((node, pos) => {
    if (node.type.name !== 'code_block') return false;

    const code = node.textContent;
    if (!code) return false;
    if (code.length > MAX_CODE_BLOCK_CHARS) {
      skippedLargeBlocks++;
      return false;
    }

    totalHighlightedChars += code.length;
    if (totalHighlightedChars > MAX_TOTAL_HIGHLIGHT_CHARS) {
      skippedDueToBudget++;
      return false;
    }

    const lang = ((node.attrs.params as string) || '').split(/\s+/)[0].toLowerCase();

    let result;
    try {
      if (lang && hljs.getLanguage(lang)) {
        result = hljs.highlight(code, { language: lang, ignoreIllegals: true });
      } else if (code.length <= MAX_AUTODETECT_CHARS) {
        result = hljs.highlightAuto(code);
      } else {
        skippedAutodetectBlocks++;
        return false;
      }
    } catch {
      return false;
    }

    highlightedBlocks++;
    const spans = parseHljsHtml(result.value);

    // +1 to skip the opening tag position of code_block
    let offset = pos + 1;
    for (const span of spans) {
      if (span.className && span.text.length > 0) {
        decorations.push(
          Decoration.inline(offset, offset + span.text.length, {
            class: span.className,
          }),
        );
      }
      offset += span.text.length;
    }

    return false;
  });

  const skipSignature = `${highlightedBlocks}:${skippedLargeBlocks}:${skippedDueToBudget}:${skippedAutodetectBlocks}`;
  if (
    skipSignature !== lastHighlightSkipSignature
    && (skippedLargeBlocks > 0 || skippedDueToBudget > 0 || skippedAutodetectBlocks > 0)
  ) {
    console.warn(
      `[attn] code highlight partial: highlighted=${highlightedBlocks}, `
      + `skipped_large=${skippedLargeBlocks}, `
      + `skipped_budget=${skippedDueToBudget}, `
      + `skipped_autodetect=${skippedAutodetectBlocks}`,
    );
  }
  lastHighlightSkipSignature = skipSignature;

  return DecorationSet.create(doc, decorations);
}

export function codeHighlightPlugin(): Plugin {
  return new Plugin({
    key: highlightKey,
    state: {
      init(_, state: EditorState) {
        return hasCodeBlocks(state.doc) ? getDecorations(state.doc) : DecorationSet.empty;
      },
      apply(tr, old, _oldState, newState) {
        if (!tr.docChanged && !tr.getMeta(highlightKey)) return old;
        if (!hasCodeBlocks(newState.doc)) return DecorationSet.empty;
        return getDecorations(newState.doc);
      },
    },
    props: {
      decorations(state) {
        return this.getState(state);
      },
    },
  });
}
