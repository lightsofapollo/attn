import { createHighlightPlugin } from 'prosemirror-highlight';
import { createParser } from 'prosemirror-highlight/shiki';
import type { Plugin } from 'prosemirror-state';
import type { Node as PmNode } from 'prosemirror-model';
import type { Decoration } from 'prosemirror-view';
import {
  createHighlighterCore,
  type HighlighterCore,
  type ThemeRegistrationAny,
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

/**
 * github-light-high-contrast clears AA on the recessed code ground for every
 * token family except ONE, and this closes it.
 *
 * Its comment grey (#66707B) measures 3.79:1 on oklch(0.885) — better than
 * anything else tried, and still short of the 4.5:1 a comment owes as ordinary
 * text. Nothing about the surface can rescue it: the ground would have to go
 * back to roughly oklch(0.955) for #66707B to clear, which is the near-white
 * panel attn-evme.3 exists to remove.
 *
 * So the theme is patched rather than the page. #58616B is the same hue and
 * family, darkened until it measures 4.68:1 on the same ground — margin enough
 * that a later nudge to the surface does not immediately re-break it.
 *
 * `colorReplacements` is shiki's own mechanism for this and runs at tokenize
 * time, so nothing downstream needs to know: no `!important` override, no
 * per-token CSS hook (shiki emits inline colours and a bare `.shiki` class, so
 * there is no selector that could target comments anyway).
 *
 * Light only. The dark theme's comment already clears AA on the Ink ground.
 */
const LIGHT_COMMENT_AA_FIX = { '#66707b': '#58616B' } as const;

async function highContrastLightTheme(): Promise<ThemeRegistrationAny> {
  const mod = await bundledThemes['github-light-high-contrast']();
  const theme = structuredClone(mod.default) as ThemeRegistrationAny & {
    colorReplacements?: Record<string, string>;
  };
  theme.colorReplacements = { ...(theme.colorReplacements ?? {}), ...LIGHT_COMMENT_AA_FIX };
  return theme;
}

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
        highContrastLightTheme,
        bundledThemes['github-dark-high-contrast'],
      ],
      langs: PRELOAD_LANGS.map((id) => bundledLanguages[id]),
    }).then((highlighter) => {
      resolvedHighlighter = highlighter;
      resolvedParser = createParser(highlighter, {
        themes: {
          // The HIGH-CONTRAST pair, and the reason is a moving target that has
          // now moved twice.
          //
          // gate-35 picked vitesse-light because it cleared AA on the code
          // ground as it stood then: oklch(0.972), a near-white panel. It named
          // github-light's keyword at 3.23:1 as the thing it was fixing.
          //
          // attn-evme.3 moved that ground to oklch(0.885) — the block is now
          // RECESSED into the paper rather than lit on top of it — and every
          // token lost the headroom vitesse-light had been chosen for. Measured
          // on the new surface: comments 1.76:1, punctuation 2.15:1, variables
          // 2.69:1, strings 3.08:1, keywords 3.67:1. Several of those cannot
          // reach 4.5:1 on ANY background (vitesse's comment grey tops out at
          // 2.34:1 against pure white), so this was not a tuning problem the
          // surface could be blamed for — the palette had no headroom left.
          //
          // github-*-high-contrast is built for exactly this: the same token
          // vocabulary, darkened until it clears AA with room to spare. The
          // dark side moves with it so the two themes stay one decision rather
          // than drifting apart the next time a surface changes.
          //
          // reading-palette.spec.ts measures every rendered token family
          // against the live code surface in both themes, so the next surface
          // move cannot silently strand this choice the way it stranded gate-35's.
          light: 'github-light-high-contrast',
          dark: 'github-dark-high-contrast',
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
