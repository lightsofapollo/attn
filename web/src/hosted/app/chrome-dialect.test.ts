// The hosted app shell's chrome must speak ONE dialect (attn-a9f7.2.2).
//
// THE FAILURE THIS PINS. The hosted routes are written twice: `app-shell.css`
// is hand-authored CSS on the hosted aliases, and the workspace editor is
// built from the native app's shadcn-derived components on Tailwind utilities.
// Nothing enforced a shared vocabulary between them — they were kept in step
// by CSS comments and review attention alone, which is how the desk header
// stayed on the paper plane for weeks after DESIGN.md declared the accent
// plane "shared by all three headers — one grammar, one plane".
//
// The rule this encodes is NOT "one file may not use utilities". It is:
//   * shared TOKENS are canonical — chrome states its colours as var(--…),
//     never as a raw hex/oklch literal that forks the palette; and
//   * every font-size in the hosted shell comes from DESIGN.md's nine-step
//     chrome ramp, which is the list the shell claimed to be on already.
//
// Run with:
//
//   cd web && npx tsx src/hosted/app/chrome-dialect.test.ts

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const shellCss = fs.readFileSync(path.join(here, 'app-shell.css'), 'utf8');

interface CaseResult {
  name: string;
  ok: boolean;
  detail?: string;
}

const cases: Array<() => CaseResult> = [];

function defineCase(name: string, fn: () => void): void {
  cases.push(() => {
    try {
      fn();
      return { name, ok: true };
    } catch (err) {
      return { name, ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  });
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

/** Strip comments so documentation examples never trip the scanners. */
function withoutComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//gu, '');
}

const css = withoutComments(shellCss);

/**
 * Every size DESIGN.md's frontmatter declares as a typography role — the nine
 * chrome steps plus the four the component layer ships (badge, micro,
 * chrome-xs, chrome-sm). DESIGN.md: "A ramp step that is not in the
 * frontmatter does not exist", so the frontmatter is the whole list and this
 * set is its transcription.
 */
const RAMP_REM = new Set([
  '0.625', // badge
  '0.6875', // micro
  '0.7', // label
  '0.75', // chrome-xs
  '0.78', // meta
  '0.85', // mono / caption
  '0.875', // chrome-sm
  '0.95', // control
  '1', // body
  '1.15', // control-lg
  '1.25', // title
  '1.5', // headline
  '2', // display
]);

defineCase('every font-size sits on the nine-step chrome ramp', () => {
  const offRamp = new Set<string>();
  // Both spellings: `font-size: 0.85rem` and the `font:` shorthand's size slot.
  for (const match of css.matchAll(/font-size:\s*([0-9.]+)rem/gu)) {
    if (!RAMP_REM.has(match[1])) offRamp.add(`${match[1]}rem`);
  }
  for (const match of css.matchAll(/font:\s*(?:[a-z0-9-]+\s+)*?([0-9.]+)rem/gu)) {
    if (!RAMP_REM.has(match[1])) offRamp.add(`${match[1]}rem`);
  }
  assert(
    offRamp.size === 0,
    `off-ramp font sizes in app-shell.css: ${[...offRamp].sort().join(', ')}. ` +
      'DESIGN.md: "a size outside this list is still a defect". Pick the nearest ' +
      'of 0.7 / 0.78 / 0.85 / 0.95 / 1 / 1.15 / 1.25 / 1.5 / 2rem.',
  );
});

defineCase('colour is spent through tokens, never raw literals', () => {
  // A literal colour in chrome forks the palette away from tokens.css, which
  // is what makes the two dialects drift in the first place. `oklch(…)` inside
  // a color-mix over a token is still a token expression, so only bare
  // literals in a colour-ish declaration count.
  const offenders: string[] = [];
  const declaration = /(^|[\s;{])(color|background|background-color|border-color|fill|stroke|box-shadow|outline-color)\s*:\s*([^;}]+)/gu;
  for (const match of css.matchAll(declaration)) {
    const value = match[3];
    if (/var\(--/u.test(value)) continue;
    if (/#[0-9a-fA-F]{3,8}\b/u.test(value) || /\b(?:oklch|rgb|rgba|hsl|hsla)\(/u.test(value)) {
      offenders.push(`${match[2]}: ${value.trim().slice(0, 60)}`);
    }
  }
  assert(
    offenders.length === 0,
    `raw colour literals in app-shell.css:\n  ${offenders.join('\n  ')}\n` +
      'Chrome states colour as var(--token); tokens.css is the one palette.',
  );
});

defineCase('the desk header is on the shared accent plane', () => {
  // DESIGN.md: "Header Surface … Shared by all three headers — one grammar,
  // one plane." The desk was the header that was not.
  const header = /\.app-header\s*\{[^}]*\}/u.exec(css)?.[0] ?? '';
  assert(header.length > 0, 'app-shell.css must define .app-header');
  assert(
    header.includes('var(--header-surface)'),
    '.app-header must paint --header-surface so the desk and the workspace ' +
      'editor share one header plane',
  );
  assert(
    header.includes('--primary-foreground'),
    '.app-header must re-point its aliases at --primary-foreground for the ' +
      'accent plane; hard-coded white is correct in exactly one theme',
  );
});

defineCase('the keycap is one component, not one per surface', () => {
  assert(css.includes('.kbd-chip'), 'app-shell.css must define the shared .kbd-chip');
  // A bare `kbd { … }` rule here would be a fourth private keycap.
  assert(
    !/(^|[\s,}])kbd\s*\{/u.test(css),
    'style keycaps through .kbd-chip; a bare `kbd` rule forks the treatment again',
  );
});

let failed = 0;
for (const run of cases) {
  const result = run();
  if (result.ok) {
    console.log(`PASS ${result.name}`);
  } else {
    failed += 1;
    console.error(`FAIL ${result.name}`);
    if (result.detail) console.error(`  ${result.detail}`);
  }
}

console.log(`chrome-dialect: ${failed === 0 ? 'all cases passed' : `${failed} failed`}`);
if (failed > 0) process.exit(1);
