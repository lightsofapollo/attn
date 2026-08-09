// DESIGN.md's frontmatter must state what the code ships (design-system
// consolidation, 2026-08-08 — issue 6 of the conflict inventory).
//
// THE FAILURE THIS PINS. DESIGN.md's `colors:` block quotes literal token
// values. Twice in one session it went stale the moment tokens.css moved
// (--code-block after attn-evme.3, --link after attn-evme.1) and was only
// caught by hand. A design doc that quotes values it does not verify is a
// second source of truth, and second sources of truth lose.
//
// tokens.css is CANONICAL. This test makes DESIGN.md's frontmatter a checked
// MIRROR of it: every colour the frontmatter names must equal the token it
// documents, so a token change fails CI until the doc moves with it — the
// same discipline share-dialog-state.test.ts uses to pin copy to code.
//
// Contrast RATIOS quoted in DESIGN.md prose are deliberately NOT pinned here:
// they are measurements, and the live measurement is reading-palette.spec.ts,
// which prints the full sweep on every run. Prose ratios are snapshots with a
// pointer to the probe, not claims this test could keep honest.
//
// Run with:
//
//   cd web && npx tsx src/lib/design-doc-parity.test.ts

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
      const message = err instanceof Error ? err.message : String(err);
      return { name, ok: false, detail: message };
    }
  });
}

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const libDir = path.dirname(fileURLToPath(import.meta.url));
const designMd = fs.readFileSync(path.join(libDir, '../../../DESIGN.md'), 'utf8');
const tokensCss = fs.readFileSync(path.join(libDir, '../tokens.css'), 'utf8');
const appCss = fs.readFileSync(path.join(libDir, '../app.css'), 'utf8');
const participantTs = fs.readFileSync(path.join(libDir, 'participant-color.ts'), 'utf8');

const norm = (v: string): string => v.replace(/\s+/g, ' ').trim();

/** The `colors:` block of the YAML frontmatter, as name -> value. */
function frontmatterColors(): Record<string, string> {
  const fm = designMd.match(/^---\n([\s\S]*?)\n---/);
  assert(fm !== null, 'DESIGN.md must open with YAML frontmatter');
  const colorsBlock = fm![1]!.match(/\ncolors:\n([\s\S]*?)(?=\n\w)/);
  assert(colorsBlock !== null, 'the frontmatter must carry a colors: block');
  const out: Record<string, string> = {};
  for (const m of colorsBlock![1]!.matchAll(/^ {2}([a-z0-9-]+): "([^"]+)"$/gm)) {
    out[m[1]!] = norm(m[2]!);
  }
  return out;
}

/**
 * The FIRST (Paper) theme block of tokens.css — the frontmatter documents the
 * light theme, as its own `paper-bg` naming says. Reading only up to the
 * second theme block keeps a same-named Ink token from shadowing the value
 * under test.
 */
function paperTokens(): Record<string, string> {
  const dark = tokensCss.search(/\.dark\s*,|\.dark\s*\{|:root\.dark/);
  const paper = dark > 0 ? tokensCss.slice(0, dark) : tokensCss;
  const out: Record<string, string> = {};
  for (const m of paper.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)) {
    out[m[1]!] = norm(m[2]!);
  }
  return out;
}

/**
 * frontmatter name -> canonical source. Most colours live in tokens.css under
 * a different (usually longer) name; the participant ramp lives in
 * participant-color.ts as TS constants. An UNMAPPED frontmatter entry fails
 * the test on purpose: adding a colour to the doc without saying where the
 * code keeps it is how the next second-source starts.
 */
const TOKEN_MAP: Record<string, string> = {
  primary: 'primary',
  'primary-foreground': 'primary-foreground',
  'paper-bg': 'background',
  ink: 'foreground',
  'muted-ink': 'muted-foreground',
  card: 'card',
  sidebar: 'sidebar',
  'panel-surface': 'panel-surface',
  'panel-border': 'panel-border',
  'rail-chip-surface': 'rail-chip-surface',
  'code-block': 'code-block',
  'code-block-nested': 'code-block-nested',
  border: 'border',
  link: 'link',
  destructive: 'destructive',
  'suggestion-green': 'review-card-suggestion-accent',
  'comment-amber': 'review-card-comment-accent',
  'peer-owner': 'peer-avatar-bg-owner',
  'peer-reviewer': 'peer-avatar-bg-reviewer',
  'peer-agent': 'peer-avatar-bg-agent',
};

defineCase('every frontmatter colour matches its canonical token', () => {
  const doc = frontmatterColors();
  const tokens = paperTokens();
  assert(Object.keys(doc).length > 10, 'the colors block should not have shrunk to nothing');
  const failures: string[] = [];
  for (const [name, value] of Object.entries(doc)) {
    if (name.startsWith('participant-')) continue; // separate case below
    const tokenName = TOKEN_MAP[name];
    if (!tokenName) {
      failures.push(`${name}: no TOKEN_MAP entry — say where the code keeps this colour`);
      continue;
    }
    const actual = tokens[tokenName];
    if (actual === undefined) {
      failures.push(`${name}: mapped token --${tokenName} not found in tokens.css`);
    } else if (actual !== value) {
      failures.push(`${name}: DESIGN.md says "${value}", --${tokenName} is "${actual}"`);
    }
  }
  assert(failures.length === 0, `frontmatter drifted from tokens.css:\n  ${failures.join('\n  ')}`);
});

defineCase('the participant ramp matches participant-color.ts', () => {
  const doc = frontmatterColors();
  const failures: string[] = [];
  for (const [name, value] of Object.entries(doc)) {
    if (!name.startsWith('participant-')) continue;
    const id = name.slice('participant-'.length);
    const m = participantTs.match(
      new RegExp(`id:\\s*'${id}',\\s*color:\\s*'([^']+)'`),
    );
    if (!m) failures.push(`${name}: no entry with id '${id}' in participant-color.ts`);
    else if (norm(m[1]!) !== value) {
      failures.push(`${name}: DESIGN.md says "${value}", participant-color.ts says "${m[1]}"`);
    }
  }
  assert(failures.length > 0 === false, `participant ramp drifted:\n  ${failures.join('\n  ')}`);
});

defineCase('the micro type steps match the Tailwind theme tokens', () => {
  // The ratified micro end of the ramp (2026-08-08) lives twice by necessity:
  // DESIGN.md documents it, app.css @theme makes it a utility. Pin the pair.
  const fm = designMd.match(/^---\n([\s\S]*?)\n---/)![1]!;
  const docSize = (step: string): string => {
    const m = fm.match(new RegExp(`  ${step}:\\n(?:.*\\n)*?    fontSize: "([^"]+)"`));
    assert(m !== null, `typography step "${step}" must exist in the frontmatter`);
    return m![1]!;
  };
  const cssToken = (name: string): string => {
    const m = appCss.match(new RegExp(`--text-${name}:\\s*([^;]+);`));
    assert(m !== null, `--text-${name} must exist in app.css @theme`);
    return norm(m![1]!);
  };
  for (const [step, token] of [['micro', 'micro'], ['badge', 'badge'], ['meta', 'meta']] as const) {
    assert(
      docSize(step) === cssToken(token),
      `${step}: DESIGN.md says ${docSize(step)}, --text-${token} is ${cssToken(token)}`,
    );
  }
});

defineCase('prose ratios point at the live probe', () => {
  // The disclaimer is what keeps quoted measurements honest without freezing
  // them: the probe prints the current sweep; prose keeps snapshots.
  assert(
    designMd.includes('reading-palette.spec.ts'),
    'DESIGN.md must name reading-palette.spec.ts as the live source for contrast ratios',
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

if (failed > 0) process.exit(1);
