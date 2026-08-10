// Regression tests for "the color I choose for my avatar is not respected"
// (attn-bw2h.4). Same tsx-runnable pattern as participant-color.test.ts:
//
//   cd web && npx tsx src/lib/participant-self-color.test.ts
//
// The bug: reviewStore.colorFor() consulted the local pick only when the id
// matched `ownerParticipantId` AND the active room's role was `owner`. A
// reviewer — or an owner window before the first snapshot resolved an owner
// id — fell through to the deterministic hash, so the picker did nothing.
//
// The three seams that fix live in are pure and tested here directly; the
// store's `isSelf`/`colorFor` are thin wrappers over them (store.svelte.ts
// uses runes and cannot be imported under raw tsx).

import {
  AGENT_COLOR,
  harvestDeclaredColors,
  hashParticipantColor,
  isSelfParticipant,
  resolveIdentityColor,
} from './participant-color';

let failures = 0;
function assert(cond: boolean, detail: string): void {
  if (!cond) {
    failures += 1;
    console.log(`  FAIL ${detail}`);
  }
}

const ME = 'p_me';
const OWNER = 'p_owner';
// Widened to `string` so the fixture guards below are real runtime checks and
// not literal-type comparisons the compiler rejects as "no overlap".
const PICKED: string = 'oklch(0.58 0.11 110)'; // olive
const OTHER: string = 'oklch(0.58 0.14 358)'; // berry

// These assertions are only meaningful while the fixtures differ from what the
// hash would have produced anyway — otherwise "respects the pick" passes even
// when the pick is being ignored. Guard it, because the hash is a black box:
// `PICKED` was originally teal, which is EXACTLY hashParticipantColor('p_me'),
// and every self assertion below was silently vacuous.
assert(PICKED !== hashParticipantColor(ME), 'fixture: my pick differs from my hash color');
assert(OTHER !== hashParticipantColor(ME), 'fixture: the announced color differs from my hash');
assert(OTHER !== hashParticipantColor(OWNER), "fixture: the announced color differs from the owner's hash");
assert(PICKED !== OTHER, 'fixture: pick and announced color are distinguishable');

// --- who is self -------------------------------------------------------------

// The reported case: I am a reviewer, so the old owner+role predicate said
// "not you" about my own id.
assert(
  isSelfParticipant(ME, {
    selfParticipantId: ME,
    ownerParticipantId: OWNER,
    role: 'reviewer',
  }),
  'my own id is self on a reviewer window',
);
assert(
  isSelfParticipant(ME, { selfParticipantId: ME, ownerParticipantId: null, role: 'unknown' }),
  'my own id is self before a role resolves',
);
assert(
  isSelfParticipant(ME, { selfParticipantId: ME, ownerParticipantId: undefined, role: undefined }),
  'my own id is self with no active room at all',
);
// The owner fallback still covers windows that never learned a local id.
assert(
  isSelfParticipant(OWNER, {
    selfParticipantId: null,
    ownerParticipantId: OWNER,
    role: 'owner',
  }),
  'owner id is self on an owner window with no local participant id',
);
// ...and stays role-gated: on a reviewer window the owner is someone else.
assert(
  !isSelfParticipant(OWNER, {
    selfParticipantId: ME,
    ownerParticipantId: OWNER,
    role: 'reviewer',
  }),
  'the owner is NOT self on a reviewer window',
);
assert(
  !isSelfParticipant(OWNER, {
    selfParticipantId: null,
    ownerParticipantId: OWNER,
    role: 'unknown',
  }),
  'an unresolved role does not make the owner self',
);
assert(
  !isSelfParticipant('p_peer', {
    selfParticipantId: ME,
    ownerParticipantId: OWNER,
    role: 'owner',
  }),
  'an unrelated peer is never self',
);
// Empty/absent ids must never collide into "self".
assert(
  !isSelfParticipant('', { selfParticipantId: null, ownerParticipantId: null, role: 'owner' }),
  'the empty id is not self',
);
assert(
  !isSelfParticipant('p_peer', {
    selfParticipantId: null,
    ownerParticipantId: null,
    role: 'owner',
  }),
  'nothing is self when neither id is known',
);

// --- the picked color wins for self -----------------------------------------

// The exact reported failure: reviewer, own comment, picked color, no announce
// harvested yet. Pre-fix this returned hashParticipantColor(ME).
assert(
  resolveIdentityColor({
    participantId: ME,
    kind: 'reviewer',
    announced: null,
    isSelf: true,
    selfColor: PICKED,
  }) === PICKED,
  'a reviewer sees their own picked color (the reported bug)',
);
assert(
  resolveIdentityColor({
    participantId: ME,
    kind: 'owner',
    announced: null,
    isSelf: true,
    selfColor: PICKED,
  }) === PICKED,
  'an owner sees their own picked color',
);
// A re-pick must not be held back by our own in-flight/older announce.
assert(
  resolveIdentityColor({
    participantId: ME,
    kind: 'reviewer',
    announced: OTHER,
    isSelf: true,
    selfColor: PICKED,
  }) === PICKED,
  'the fresh local pick outranks our own previously announced color',
);
// "Auto" means Auto: no pick, no lingering self override.
assert(
  resolveIdentityColor({
    participantId: ME,
    kind: 'reviewer',
    announced: null,
    isSelf: true,
    selfColor: null,
  }) === hashParticipantColor(ME),
  'Auto falls back to the deterministic hash',
);
// A corrupted stored pick can never reach an inline style.
assert(
  resolveIdentityColor({
    participantId: ME,
    kind: 'reviewer',
    announced: OTHER,
    isSelf: true,
    selfColor: 'url(javascript:alert(1))',
  }) === OTHER,
  'an invalid local pick is discarded, not rendered',
);
assert(
  resolveIdentityColor({
    participantId: ME,
    kind: 'reviewer',
    announced: null,
    isSelf: true,
    selfColor: '#a1b2c3; position: fixed',
  }) === hashParticipantColor(ME),
  'an invalid local pick with no announce falls to the hash',
);

// --- everyone else is unaffected --------------------------------------------

assert(
  resolveIdentityColor({
    participantId: OWNER,
    kind: 'owner',
    announced: OTHER,
    isSelf: false,
    selfColor: PICKED,
  }) === OTHER,
  "a peer keeps their announced color — our pick never leaks onto them",
);
assert(
  resolveIdentityColor({
    participantId: OWNER,
    kind: 'owner',
    announced: null,
    isSelf: false,
    selfColor: PICKED,
  }) === hashParticipantColor(OWNER),
  'a peer with no declaration keeps the hash, not our pick',
);
// Agents stay violet even when the local user IS the agent process.
assert(
  resolveIdentityColor({
    participantId: 'p_agent',
    kind: 'agent',
    announced: OTHER,
    isSelf: true,
    selfColor: PICKED,
  }) === AGENT_COLOR,
  'a self override never repaints an agent out of violet',
);

// Every surface (margin card avatar + accent, peer chip, caret, selection)
// funnels through this one call, so identical inputs must be byte-identical
// out — that is what makes one person read as one color everywhere.
const surfaces = [1, 2, 3].map(() =>
  resolveIdentityColor({
    participantId: ME,
    kind: 'reviewer',
    announced: OTHER,
    isSelf: true,
    selfColor: PICKED,
  }),
);
assert(new Set(surfaces).size === 1, 'the entrypoint is deterministic across surfaces');

// --- declared-color harvest --------------------------------------------------

assert(
  harvestDeclaredColors([{ participantId: ME, color: PICKED, announcedAt: 10 }])[ME] === PICKED,
  'a declared color is harvested',
);
assert(
  harvestDeclaredColors([
    { participantId: ME, color: OTHER, announcedAt: 10 },
    { participantId: ME, color: PICKED, announcedAt: 20 },
  ])[ME] === PICKED,
  'the latest-authored announce wins',
);
// Relay history replays after a reconnecting session re-announces: an OLDER
// announce arriving later must not resurrect the stale color.
assert(
  harvestDeclaredColors([
    { participantId: ME, color: PICKED, announcedAt: 20 },
    { participantId: ME, color: OTHER, announcedAt: 10 },
  ])[ME] === PICKED,
  'a late-arriving stale announce does not win',
);
// Switching back to Auto is a choice, and it travels as an announce with no
// color — it has to clear the earlier declaration on every client.
assert(
  harvestDeclaredColors([
    { participantId: ME, color: PICKED, announcedAt: 10 },
    { participantId: ME, color: null, announcedAt: 20 },
  ])[ME] === undefined,
  'switching to Auto clears the earlier declaration',
);
assert(
  harvestDeclaredColors([
    { participantId: ME, color: PICKED, announcedAt: 10 },
    { participantId: ME, announcedAt: 20 },
  ])[ME] === undefined,
  'an announce that omits color clears the earlier declaration',
);
assert(
  harvestDeclaredColors([
    { participantId: ME, color: PICKED, announcedAt: 10 },
    { participantId: ME, color: 'var(--primary)', announcedAt: 20 },
  ])[ME] === undefined,
  'an invalid later declaration clears rather than sticking to the old one',
);
assert(
  harvestDeclaredColors([
    { participantId: ME, color: null, announcedAt: 20 },
    { participantId: ME, color: PICKED, announcedAt: 10 },
  ])[ME] === undefined,
  'an older colored announce cannot undo a newer Auto',
);
const twoPeople = harvestDeclaredColors([
  { participantId: ME, color: PICKED, announcedAt: 10 },
  { participantId: OWNER, color: OTHER, announcedAt: 11 },
  { participantId: ME, color: null, announcedAt: 12 },
]);
assert(
  twoPeople[ME] === undefined && twoPeople[OWNER] === OTHER,
  'clearing one participant leaves the others alone',
);

if (failures === 0) {
  console.log('participant-self-color: all assertions passed');
} else {
  console.log(`participant-self-color: ${failures} assertion(s) FAILED`);
  process.exit(1);
}
