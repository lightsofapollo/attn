// Sweep every token colour the two shipped shiki themes can emit against the
// OLD and NEW --code-block grounds. attn-evme.3 moves Paper 0.972 -> 0.885 and
// Ink 0.19 -> 0.176, so every token loses (Paper) or gains (Ink) contrast.
import { bundledThemes } from 'shiki/themes';
import { oklchToSrgb as O, hexToSrgb, contrast, toHex } from './oklch.mjs';

const grounds = {
  'PAPER old 0.972': O(0.972, 0.008, 78),
  'PAPER new 0.885': O(0.885, 0.010, 78),
  'PAPER nested 0.865': O(0.865, 0.010, 78),
  'INK old 0.19': O(0.19, 0.014, 256),
  'INK new 0.176': O(0.176, 0.014, 256),
  'INK nested 0.204': O(0.204, 0.014, 256),
};

async function load(name) {
  const mod = await bundledThemes[name]();
  return mod.default ?? mod;
}

function collect(theme) {
  const out = new Map();
  const add = (scope, color) => {
    if (!color || !/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(color)) return;
    const hex = color.slice(0, 7);
    if (!out.has(hex)) out.set(hex, new Set());
    out.get(hex).add(scope);
  };
  add('editor.foreground', theme.fg ?? theme.colors?.['editor.foreground']);
  for (const rule of theme.tokenColors ?? []) {
    const fg = rule.settings?.foreground;
    if (!fg) continue;
    const scopes = [].concat(rule.scope ?? rule.name ?? '(unnamed)');
    for (const s of scopes) add(String(s), fg);
  }
  return out;
}

for (const [themeName, groundKeys] of [
  ['vitesse-light', ['PAPER old 0.972', 'PAPER new 0.885', 'PAPER nested 0.865']],
  ['github-dark', ['INK old 0.19', 'INK new 0.176', 'INK nested 0.204']],
]) {
  const theme = await load(themeName);
  const colors = collect(theme);
  console.log(`\n================ ${themeName} — ${colors.size} distinct token colours`);
  const rows = [...colors.entries()].map(([hex, scopes]) => {
    const fg = hexToSrgb(hex);
    return {
      hex,
      scopes: [...scopes].slice(0, 4).join(', '),
      ratios: groundKeys.map((g) => contrast(fg, grounds[g])),
    };
  });
  rows.sort((a, b) => a.ratios[1] - b.ratios[1]);
  console.log(`${'hex'.padEnd(9)} ${groundKeys.map((g) => g.padEnd(19)).join('')} scopes`);
  for (const r of rows) {
    const flag = r.ratios[1] < 4.5 ? (r.ratios[1] < 3.0 ? ' !!' : ' !') : '   ';
    console.log(
      `${r.hex.padEnd(9)} ${r.ratios.map((v) => (v.toFixed(2) + ':1').padEnd(19)).join('')}${flag} ${r.scopes}`,
    );
  }
  const failNew = rows.filter((r) => r.ratios[1] < 4.5);
  const failOld = rows.filter((r) => r.ratios[0] < 4.5);
  console.log(`  AA fails on OLD ground: ${failOld.length}/${rows.length}`);
  console.log(`  AA fails on NEW ground: ${failNew.length}/${rows.length}`);
  console.log(`  REGRESSIONS (passed old, fails new): ${rows.filter((r) => r.ratios[0] >= 4.5 && r.ratios[1] < 4.5).map((r) => r.hex).join(' ') || 'none'}`);
}
