// Recompute the CSP source hash for the inline theme-preflight script.
// Run after editing THEME_PREFLIGHT_SCRIPT, then paste the result into
// THEME_PREFLIGHT_SHA256 in src/lib/hosted/theme-preflight.ts.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/lib/hosted/theme-preflight.ts', import.meta.url), 'utf8');
const match = source.match(/export const THEME_PREFLIGHT_SCRIPT =\s*([\s\S]*?);\n/u);
if (!match) throw new Error('THEME_PREFLIGHT_SCRIPT not found');
// eslint-disable-next-line no-eval
const script = eval(match[1]);
const hash = createHash('sha256').update(script, 'utf8').digest('base64');
console.log(`sha256-${hash}`);
