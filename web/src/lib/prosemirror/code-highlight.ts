import { Plugin, PluginKey } from 'prosemirror-state';
import type { EditorState } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';
import type { EditorView } from 'prosemirror-view';
import type { Node as PmNode } from 'prosemirror-model';
import type { HLJSApi } from 'highlight.js';

const highlightKey = new PluginKey('code-highlight');
const MAX_CODE_BLOCK_CHARS = 20_000;
const MAX_TOTAL_HIGHLIGHT_CHARS = 120_000;
const MAX_AUTODETECT_CHARS = 4_000;

let hljs: HLJSApi | null = null;
let hljsLoading: Promise<HLJSApi> | null = null;
let lastHighlightSkipSignature = '';

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

function loadHljs(): Promise<HLJSApi> {
  if (hljs) return Promise.resolve(hljs);
  if (hljsLoading) return hljsLoading;
  hljsLoading = import('highlight.js/lib/common').then(async (mod) => {
    const core = mod.default;
    // common includes a broad language set (far more than the previous manual subset)
    // and keeps loading deferred until markdown with code blocks is shown.
    core.registerAliases(['js', 'jsx'], { languageName: 'javascript' });
    core.registerAliases(['ts', 'tsx'], { languageName: 'typescript' });
    core.registerAliases(['py'], { languageName: 'python' });
    core.registerAliases(['cxx', 'cpp', 'c++', 'h', 'hpp'], { languageName: 'cpp' });
    core.registerAliases(['c#'], { languageName: 'csharp' });
    core.registerAliases(['sh', 'zsh', 'bashrc', 'shell'], { languageName: 'bash' });
    core.registerAliases(['yml'], { languageName: 'yaml' });
    core.registerAliases(['html', 'xhtml', 'xsl'], { languageName: 'xml' });
    core.registerAliases(['rs'], { languageName: 'rust' });
    core.registerAliases(['text', 'plain'], { languageName: 'plaintext' });
    hljs = core;
    return core;
  });
  return hljsLoading;
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
  if (!hljs) return DecorationSet.empty;

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
      if (lang && hljs!.getLanguage(lang)) {
        result = hljs!.highlight(code, { language: lang, ignoreIllegals: true });
      } else if (code.length <= MAX_AUTODETECT_CHARS) {
        result = hljs!.highlightAuto(code);
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
        // Kick off lazy load if there are code blocks
        if (hasCodeBlocks(state.doc)) {
          loadHljs();
        }
        return DecorationSet.empty;
      },
      apply(tr, old, _oldState, newState) {
        if (!tr.docChanged && !tr.getMeta(highlightKey) && hljs) return old;
        if (!hljs) {
          // Check if we need to start loading
          if (hasCodeBlocks(newState.doc) && !hljsLoading) {
            loadHljs();
          }
          return DecorationSet.empty;
        }
        return getDecorations(newState.doc);
      },
    },
    props: {
      decorations(state) {
        return this.getState(state);
      },
    },
    view(editorView) {
      let waitingForLoad = false;
      const requestLoad = (view: EditorView) => {
        if (hljs || waitingForLoad || !hasCodeBlocks(view.state.doc)) return;
        waitingForLoad = true;
        loadHljs()
          .then(() => {
            const tr = view.state.tr.setMeta(highlightKey, 'loaded');
            view.dispatch(tr);
          })
          .finally(() => {
            waitingForLoad = false;
          });
      };

      requestLoad(editorView);

      return {
        update(view) {
          requestLoad(view);
        },
      };
    },
  });
}
