import { createHighlightPlugin } from 'prosemirror-highlight';
import { createParser } from 'prosemirror-highlight/shiki';
import type { Plugin } from 'prosemirror-state';
import type { Node as PmNode } from 'prosemirror-model';
import type { Decoration } from 'prosemirror-view';
import {
  createHighlighterCore,
  type HighlighterCore,
} from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';

type ParserFn = (options: {
  content: string;
  pos: number;
  language?: string;
  size: number;
}) => Decoration[] | Promise<void>;

let highlighterPromise: Promise<HighlighterCore> | undefined;
let resolvedParser: ParserFn | undefined;

function getHighlighter(): Promise<HighlighterCore> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighterCore({
      engine: createJavaScriptRegexEngine(),
      themes: [
        import('shiki/themes/github-light'),
        import('shiki/themes/github-dark'),
      ],
      langs: [
        import('shiki/langs/javascript'),
        import('shiki/langs/typescript'),
        import('shiki/langs/python'),
        import('shiki/langs/bash'),
        import('shiki/langs/rust'),
        import('shiki/langs/go'),
        import('shiki/langs/json'),
        import('shiki/langs/yaml'),
        import('shiki/langs/html'),
        import('shiki/langs/css'),
        import('shiki/langs/c'),
        import('shiki/langs/cpp'),
        import('shiki/langs/java'),
        import('shiki/langs/ruby'),
        import('shiki/langs/sql'),
        import('shiki/langs/xml'),
        import('shiki/langs/toml'),
        import('shiki/langs/diff'),
        import('shiki/langs/markdown'),
        import('shiki/langs/svelte'),
      ],
    });
  }
  return highlighterPromise;
}

/** Lazy parser: returns Promise<void> while highlighter loads, then delegates to shiki parser.
 *  Skips blocks without a language tag and catches per-block errors so one
 *  unrecognised language doesn't kill highlighting for the entire document. */
function lazyParser(options: {
  content: string;
  pos: number;
  language?: string;
  size: number;
}): Decoration[] | Promise<void> {
  // No language tag → render as plain text (no highlighting)
  if (!options.language) return [];

  if (resolvedParser) {
    try {
      return resolvedParser(options);
    } catch {
      // Language not loaded or parse error — skip this block
      return [];
    }
  }
  return getHighlighter().then((highlighter) => {
    resolvedParser = createParser(highlighter, {
      themes: {
        light: 'github-light',
        dark: 'github-dark',
      },
    });
    // Return void — plugin will re-dispatch to pick up decorations
  });
}

function languageExtractor(node: PmNode): string | undefined {
  const params = (node.attrs.params as string) || '';
  const lang = params.split(/\s+/)[0].toLowerCase();
  return lang || undefined;
}

export function codeHighlightPlugin(): Plugin {
  return createHighlightPlugin({
    parser: lazyParser,
    nodeTypes: ['code_block'],
    languageExtractor,
  });
}
