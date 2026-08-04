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
import { bundledThemes } from 'shiki/themes';
import { bundledLanguages } from 'shiki/langs';
import { detectLanguage } from './detect-language';

type ParserFn = (options: {
  content: string;
  pos: number;
  language?: string;
  size: number;
}) => Decoration[] | Promise<void>;

/** Preloaded at highlighter creation so the common cases paint on the first
 *  decoration pass; anything else in shiki's bundle loads on demand. */
const PRELOAD_LANGS: (keyof typeof bundledLanguages)[] = [
  'javascript', 'typescript', 'python', 'bash', 'rust', 'go',
  'json', 'yaml', 'html', 'css', 'c', 'cpp', 'java', 'ruby',
  'sql', 'xml', 'toml', 'diff', 'markdown', 'svelte',
];

/** Fences that must stay unhighlighted: plain-text spellings shiki has no
 *  grammar for, plus languages owned by specialized NodeViews. */
const SKIP_LANGS = new Set(['plaintext', 'plain', 'text', 'txt', 'log', 'output', 'mermaid', 'math', 'latex']);

/** Spellings seen in real docs that shiki's alias table doesn't cover. */
const EXTRA_ALIASES: Record<string, string> = {
  'shell-session': 'shellsession',
  term: 'shellsession',
  terminal: 'shellsession',
  node: 'javascript',
  golang: 'go',
  yarn: 'bash',
  npm: 'bash',
};

/** Resolve a fence tag to a loadable shiki language id, or undefined for
 *  plain text. shiki's own bundle already maps common aliases (js, ts, py,
 *  sh, yml, …) so most spellings resolve directly. */
function normalizeLang(raw: string): string | undefined {
  if (!raw || SKIP_LANGS.has(raw)) return undefined;
  if (raw in bundledLanguages) return raw;
  const aliased = EXTRA_ALIASES[raw];
  if (aliased && aliased in bundledLanguages) return aliased;
  return undefined;
}

let highlighterPromise: Promise<HighlighterCore> | undefined;
let resolvedHighlighter: HighlighterCore | undefined;
let resolvedParser: ParserFn | undefined;
const langLoads = new Map<string, Promise<void>>();

function getHighlighter(): Promise<HighlighterCore> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighterCore({
      engine: createJavaScriptRegexEngine(),
      themes: [
        bundledThemes['vitesse-light'],
        bundledThemes['github-dark'],
      ],
      langs: PRELOAD_LANGS.map((id) => bundledLanguages[id]),
    }).then((highlighter) => {
      resolvedHighlighter = highlighter;
      resolvedParser = createParser(highlighter, {
        themes: {
          // vitesse-light: darker, muted tokens that clear WCAG AA on the warm
          // paper code ground (github-light's keyword was 3.23:1) and read
          // warmer, on-brand (gate-35).
          light: 'vitesse-light',
          dark: 'github-dark',
        },
      });
      return highlighter;
    });
  }
  return highlighterPromise;
}

/** Load a not-yet-loaded language into the live highlighter exactly once.
 *  Returns a promise so the plugin re-dispatches when the grammar lands. */
function ensureLangLoaded(highlighter: HighlighterCore, lang: string): Promise<void> {
  let load = langLoads.get(lang);
  if (!load) {
    load = highlighter
      .loadLanguage(bundledLanguages[lang as keyof typeof bundledLanguages])
      .catch(() => {
        /* grammar failed to load — block stays plain text */
      });
    langLoads.set(lang, load);
  }
  return load;
}

/** Lazy parser: returns Promise<void> while the highlighter (or a grammar)
 *  loads, then delegates to the shiki parser. Catches per-block errors so one
 *  broken block doesn't kill highlighting for the entire document. */
function lazyParser(options: {
  content: string;
  pos: number;
  language?: string;
  size: number;
}): Decoration[] | Promise<void> {
  const lang = options.language;
  // No declared language and nothing confidently detected → plain text.
  if (!lang) return [];

  if (!resolvedParser || !resolvedHighlighter) {
    return getHighlighter().then(() => undefined);
  }
  if (!resolvedHighlighter.getLoadedLanguages().includes(lang)) {
    return ensureLangLoaded(resolvedHighlighter, lang);
  }
  try {
    return resolvedParser(options);
  } catch {
    return [];
  }
}

function languageExtractor(node: PmNode): string | undefined {
  const params = (node.attrs.params as string) || '';
  const declared = params.split(/\s+/)[0].toLowerCase();
  if (declared) return normalizeLang(declared);
  // Untagged fence: fall back to conservative content-based detection.
  return detectLanguage(node.textContent);
}

export function codeHighlightPlugin(): Plugin {
  return createHighlightPlugin({
    parser: lazyParser,
    nodeTypes: ['code_block'],
    languageExtractor,
  });
}
