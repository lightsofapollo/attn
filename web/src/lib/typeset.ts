import type { TypesetName } from './types';
import { typesetChange } from './ipc';

/**
 * Curated typeset presets (shadcn's typeset model): each is a complete
 * reading system — font pairing plus type scale — not a pile of independent
 * knobs. The token values live in `web/styles/typeset.css`, keyed off the
 * `data-typeset` attribute on <html>, so switching one is a single attribute
 * write with no reflow of component code.
 *
 * `editorial` is the default and is pixel-identical to the app's historical
 * rendering — changing it is a visual regression, not a preset tweak.
 *
 * A preset only ever redefines DOCUMENT tokens (`--doc-font`,
 * `--attn-doc-scale`, `--doc-leading`, `--doc-tracking`, `--content-measure`).
 * The app's rem baseline (`--attn-base-font-size`) is off limits, so switching
 * a typeset reflows the reading column and leaves the header, the dialogs, and
 * every control exactly where they were. See the contract in typeset.css.
 */
export interface TypesetPreset {
  id: TypesetName;
  label: string;
  description: string;
  /** Short specimen shown in the settings preview. */
  specimen: string;
}

export const TYPESETS: readonly TypesetPreset[] = [
  {
    id: 'editorial',
    label: 'Editorial',
    description: 'Source Serif on a wide column. The attn default.',
    specimen: 'The quick brown fox',
  },
  {
    id: 'modern',
    label: 'Modern',
    description: 'Sans-serif throughout. Reads like a code review tool.',
    specimen: 'The quick brown fox',
  },
  {
    id: 'compact',
    label: 'Compact',
    description: 'Tighter scale and leading. More document per screen.',
    specimen: 'The quick brown fox',
  },
  {
    id: 'manuscript',
    label: 'Manuscript',
    description: 'Large serif, short column. For reading end to end.',
    specimen: 'The quick brown fox',
  },
  {
    id: 'terminal',
    label: 'Terminal',
    description: 'Monospace throughout. For diffs and config.',
    specimen: 'The quick brown fox',
  },
] as const;

const VALID: readonly TypesetName[] = TYPESETS.map((preset) => preset.id);

export function getTypeset(): TypesetName {
  const current = document.documentElement.dataset.typeset;
  if (current && VALID.includes(current as TypesetName)) return current as TypesetName;
  return 'editorial';
}

export function setTypeset(typeset: TypesetName): void {
  const root = document.documentElement;
  if (root.dataset.typeset === typeset) return;
  // Same atomic-flip discipline as the theme: a half-swapped face mid-
  // transition reads as a stutter, not as a setting taking effect. This is
  // now scoped to what actually changes — the reading column — because the
  // chrome no longer resizes with the preset at all.
  root.style.setProperty('--t', '0ms');
  root.style.setProperty('transition', 'none');
  root.dataset.typeset = typeset;
  requestAnimationFrame(() => {
    root.style.removeProperty('--t');
    root.style.removeProperty('transition');
  });
  typesetChange(typeset);
}

/** Adopt the seeded preset (Rust stamps `data-typeset` before first paint). */
export function initTypeset(): void {
  document.documentElement.dataset.typeset = getTypeset();
}
