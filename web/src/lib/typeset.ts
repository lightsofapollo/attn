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
    description: 'Source Serif for reading, Source Sans for chrome. The attn default.',
    specimen: 'Serif reading column',
  },
  {
    id: 'modern',
    label: 'Modern',
    description: 'Sans-serif throughout — closer to a code review tool than a manuscript.',
    specimen: 'Sans reading column',
  },
  {
    id: 'compact',
    label: 'Compact',
    description: 'Tighter scale and leading. More document on screen for dense ops docs.',
    specimen: 'Dense reading column',
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
  // Same atomic-flip discipline as the theme: font metrics change layout, and
  // a transition mid-swap reads as a stutter rather than a setting taking
  // effect.
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
