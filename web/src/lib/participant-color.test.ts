// Contract tests for participant-color.ts (attn-3gdd). Same tsx-runnable
// pattern as PeerStrip.test.ts:
//
//   cd web && npx tsx src/lib/participant-color.test.ts
//
// Covers: the sanitize grammar (the security seam — declared colors arrive
// from other participants and land in inline styles), hash determinism +
// palette membership, and the resolution ladder (declared → hash; agents
// pinned to violet).

import {
  AGENT_COLOR,
  PARTICIPANT_PALETTE,
  hashParticipantColor,
  resolveParticipantColor,
  sanitizeParticipantColor,
} from './participant-color';

let failures = 0;
function assert(cond: boolean, detail: string): void {
  if (!cond) {
    failures += 1;
    console.log(`  FAIL ${detail}`);
  }
}

// --- sanitize grammar --------------------------------------------------------
assert(sanitizeParticipantColor('#a1B2c3') === '#a1B2c3', 'hex6 passes');
assert(sanitizeParticipantColor('oklch(0.58 0.14 32)') === 'oklch(0.58 0.14 32)', 'oklch triple passes');
assert(sanitizeParticipantColor(' oklch(0.58 0.14 32) ') === 'oklch(0.58 0.14 32)', 'trims whitespace');
for (const bad of [
  null,
  undefined,
  '',
  '   ',
  '#fff', // 3-digit hex deliberately excluded
  '#a1b2c3d4', // alpha excluded
  'red',
  'var(--primary)',
  'oklch(0.58 0.14 32 / 50%)', // alpha channel excluded
  'oklch(0.58, 0.14, 32)', // commas excluded
  'url(javascript:alert(1))',
  '#a1b2c3; position: fixed',
  'oklch(0.58 0.14 32); background-image: url(x)',
  `oklch(0.5${'0'.repeat(70)} 0.1 30)`, // grammar-valid but over the 64-char bound
  42 as unknown as string, // non-string wire junk
]) {
  assert(sanitizeParticipantColor(bad) === null, `rejects ${JSON.stringify(bad)}`);
}
// Every palette entry must survive its own sanitizer (self-consistency).
for (const swatch of PARTICIPANT_PALETTE) {
  assert(sanitizeParticipantColor(swatch.color) === swatch.color, `palette ${swatch.id} self-validates`);
}
assert(sanitizeParticipantColor(AGENT_COLOR) === AGENT_COLOR, 'agent violet self-validates');

// --- hash --------------------------------------------------------------------
const ids = ['p_alpha', 'p_beta', 'p_gamma', 'p_delta', 'p_epsilon'];
for (const id of ids) {
  const c = hashParticipantColor(id);
  assert(c === hashParticipantColor(id), `hash deterministic for ${id}`);
  assert(PARTICIPANT_PALETTE.some((s) => s.color === c), `hash lands in palette for ${id}`);
}
assert(new Set(ids.map(hashParticipantColor)).size > 1, 'hash spreads across the palette');

// --- resolution ladder -------------------------------------------------------
assert(
  resolveParticipantColor('p_x', 'oklch(0.56 0.11 250)', 'reviewer') === 'oklch(0.56 0.11 250)',
  'declared wins for humans',
);
assert(
  resolveParticipantColor('p_x', 'nonsense', 'reviewer') === hashParticipantColor('p_x'),
  'invalid declared falls back to hash',
);
assert(
  resolveParticipantColor('p_x', null, 'owner') === hashParticipantColor('p_x'),
  'owner resolves personally, not by role',
);
assert(
  resolveParticipantColor('p_x', '#a1b2c3', 'agent') === AGENT_COLOR,
  'agents ignore declared colors and stay violet',
);

if (failures === 0) {
  console.log('participant-color: all assertions passed');
} else {
  console.log(`participant-color: ${failures} assertion(s) FAILED`);
  process.exit(1);
}
