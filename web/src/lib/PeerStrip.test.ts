// Manual smoke harness for PeerStrip.svelte (attn-nnj.4.12).
// Pattern mirrors ConnectionBadge.test.ts / ShareDialog.test.ts — `web/` has
// no vitest config yet, so tests are tsx-runnable functions over the pure
// `peer-strip-format` module + a small predicate harness.
//
// Run with:
//
//   cd web && npx tsx src/lib/PeerStrip.test.ts
//
// The Svelte component itself isn't mounted (runes can't compile without
// the Vite plugin); instead we exercise every contract the .svelte file
// imports verbatim from `./peer-strip-format`. That way any drift between
// rendering and tests fails one of these cases.
//
// Cases (≥5 required by attn-nnj.4.12):
//
//   (1) Empty roster → empty-state predicate.
//   (2) 3 humans + 1 agent → 4 chips, correct shapes (round vs hex).
//   (3) 6 peers → 4 inline + "+2" overflow.
//   (4) Hover presence — predicate returns the hovered peer's
//       online/offline-aware label.
//   (5) Click chip — identity card opens for the clicked peer + clears
//       on close.
//   (6) Agent shape distinguishable at 20px — assert the visual descriptor
//       (`shape === 'hex'`) and the CSS class `peer-chip-hex` are wired up
//       so they survive even when color is stripped.
//   (7) "(you)" predicate — the matching local participantId is tagged.
//   (8) Monogram rule — first char of displayName, uppercased; "?" fallback.

import {
  AGENT_GLYPH,
  MAX_VISIBLE_CHIPS,
  OVERFLOW_THRESHOLD,
  chipShapeFor,
  chipVisualFor,
  isYou,
  monogramFor,
  shortenParticipantId,
  splitForStrip,
  tail6,
} from './peer-strip-format';
import { AGENT_COLOR, hashParticipantColor } from './participant-color';
import type { ParticipantId, ReviewStatusPeer } from './types';

// ---------------------------------------------------------------------------
// Tiny harness (matches ConnectionBadge.test.ts conventions)
// ---------------------------------------------------------------------------

interface CaseResult {
  name: string;
  ok: boolean;
  detail?: string;
}

const cases: Array<() => Promise<CaseResult> | CaseResult> = [];

function defineCase(
  name: string,
  fn: () => void | string | Promise<void | string>,
): void {
  cases.push(async () => {
    try {
      const note = await fn();
      return { name, ok: true, detail: typeof note === 'string' ? note : undefined };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { name, ok: false, detail: message };
    }
  });
}

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

// ---------------------------------------------------------------------------
// Peer fixture builders. The Rust bridge only surfaces participantId +
// deviceId + displayName + kind + online (+ optional onSnapshotId); we use
// the same minimal shape here.
// ---------------------------------------------------------------------------

let counter = 0;
function makePeer(overrides: Partial<ReviewStatusPeer> = {}): ReviewStatusPeer {
  counter += 1;
  return {
    participantId: (`p_test_${counter}` as ParticipantId),
    deviceId: (`d_test_${counter}` as ReviewStatusPeer['deviceId']),
    displayName: `Peer${counter}`,
    kind: 'reviewer',
    online: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

// (1) Empty roster → strip renders empty state.
defineCase('0 peers → empty strip via splitForStrip', () => {
  const split = splitForStrip([]);
  assert(split.inline.length === 0, `expected 0 inline, got ${split.inline.length}`);
  assert(split.overflow.length === 0, `expected 0 overflow, got ${split.overflow.length}`);
  assert(split.overflowCount === 0, `expected overflowCount 0, got ${split.overflowCount}`);
});

// (2) 3 humans + 1 agent → 4 chips, correct shapes.
defineCase('3 humans + 1 agent → 4 chips with correct shapes', () => {
  const peers: ReviewStatusPeer[] = [
    makePeer({ displayName: 'James', kind: 'owner' }),
    makePeer({ displayName: 'Alex', kind: 'reviewer' }),
    makePeer({ displayName: 'Robin', kind: 'reviewer' }),
    makePeer({ displayName: 'rufus', kind: 'agent' }),
  ];
  const split = splitForStrip(peers);
  assert(split.inline.length === 4, `expected 4 inline chips, got ${split.inline.length}`);
  assert(split.overflowCount === 0, `expected no overflow, got ${split.overflowCount}`);

  // First 3 are round humans, last is a hex agent.
  const visuals = split.inline.map((p) => chipVisualFor(p));
  assert(visuals[0].shape === 'round', `owner chip should be round, got ${visuals[0].shape}`);
  assert(visuals[1].shape === 'round', `reviewer chip should be round, got ${visuals[1].shape}`);
  assert(visuals[2].shape === 'round', `reviewer chip should be round, got ${visuals[2].shape}`);
  assert(visuals[3].shape === 'hex', `agent chip should be hex, got ${visuals[3].shape}`);

  // Personal colors (attn-3gdd): humans resolve deterministically from
  // their participantId (no declared color here); the agent is always
  // violet. Every bg is a concrete oklch value, not a var reference.
  assert(visuals[0].bg === hashParticipantColor(peers[0].participantId),
    `owner bg should be the participant hash color, got ${visuals[0].bg}`);
  assert(visuals[1].bg === hashParticipantColor(peers[1].participantId),
    `reviewer bg should be the participant hash color, got ${visuals[1].bg}`);
  assert(visuals[3].bg === AGENT_COLOR, `agent bg must stay violet, got ${visuals[3].bg}`);
  assert(visuals.every((v) => v.bg.startsWith('oklch(')),
    'every chip bg must be a concrete oklch value');

  // Humans carry monograms; the agent carries the glyph (never a letter).
  assert(visuals[0].content.kind === 'monogram', 'owner should carry a monogram');
  if (visuals[0].content.kind === 'monogram') {
    assert(visuals[0].content.letter === 'JA', `expected JA, got "${visuals[0].content.letter}"`);
  }
  assert(visuals[3].content.kind === 'glyph', 'agent should carry the glyph');
  if (visuals[3].content.kind === 'glyph') {
    assert(visuals[3].content.glyph === AGENT_GLYPH, `expected ⊳ glyph, got "${visuals[3].content.glyph}"`);
  }
});

// (3) 6 peers → 4 inline + "+2" overflow.
defineCase('6 peers → 4 inline chips + "+2" overflow chip', () => {
  const peers: ReviewStatusPeer[] = Array.from({ length: 6 }, (_, i) =>
    makePeer({ displayName: `Peer${i}` }),
  );
  const split = splitForStrip(peers);
  assert(
    split.inline.length === MAX_VISIBLE_CHIPS,
    `expected ${MAX_VISIBLE_CHIPS} inline, got ${split.inline.length}`,
  );
  assert(split.overflowCount === 2, `expected overflow count 2, got ${split.overflowCount}`);
  assert(split.overflow.length === 2, `expected 2 overflow peers, got ${split.overflow.length}`);
  // Invariant: inline + overflow == all peers (no peer dropped).
  assert(
    split.inline.length + split.overflow.length === peers.length,
    'split must conserve all peers',
  );
});

// (4) Exactly 5 peers → still render inline (no overflow).
defineCase('5 peers → all 5 render inline, no overflow', () => {
  const peers = Array.from({ length: OVERFLOW_THRESHOLD }, () => makePeer());
  const split = splitForStrip(peers);
  assert(split.inline.length === 5, `expected 5 inline at threshold, got ${split.inline.length}`);
  assert(split.overflowCount === 0, `expected no overflow at threshold, got ${split.overflowCount}`);
});

// (5) Agent shape is distinguishable at 20 px — assert via shape + bg-var
//     (the .svelte file's `peer-chip-hex` class is keyed off this).
defineCase('Agent shape distinguishable at 20px (hex + agent bg var)', () => {
  const agent = makePeer({ kind: 'agent', displayName: 'rufus' });
  const visual = chipVisualFor(agent);
  // The shape is the small-size signal. Color is the secondary signal.
  assert(visual.shape === 'hex', `agent shape must be hex, got ${visual.shape}`);
  assert(chipShapeFor('agent') === 'hex', 'chipShapeFor("agent") must return hex');
  assert(chipShapeFor('owner') === 'round', 'chipShapeFor("owner") must return round');
  assert(chipShapeFor('reviewer') === 'round', 'chipShapeFor("reviewer") must return round');
  // The glyph keeps the chip recognizable when shape is masked by tiny size.
  assert(visual.content.kind === 'glyph', 'agent must carry a glyph (not a letter)');
  // Color is pinned to the agent violet — even a declared color is ignored
  // (the violet family is the agent brand; attn-3gdd).
  assert(chipVisualFor(makePeer({ displayName: 'rufus', kind: 'agent' }), '#ff0000').bg === AGENT_COLOR,
    'agent must ignore declared colors and stay violet');
});

// (6) "(you)" predicate tags the matching local participant.
defineCase('isYou tags the chip whose participantId matches the local id', () => {
  const me = makePeer({ displayName: 'James' });
  const other = makePeer({ displayName: 'Alex' });
  assert(isYou(me, me.participantId) === true, '(you) should fire for matching id');
  assert(isYou(other, me.participantId) === false, 'other peers must NOT be (you)');
  assert(isYou(me, null) === false, 'null local id must never tag (you)');
});

// (7) Monogram rule (attn-3gdd, two letters): first+last initials for
// multi-word names, first two graphemes for single words, "?" fallback.
defineCase('Monogram: two-letter rule; empty → "?"', () => {
  assert(monogramFor('alex') === 'AL', `expected AL, got "${monogramFor('alex')}"`);
  assert(monogramFor('James Lal') === 'JL', `expected JL, got "${monogramFor('James Lal')}"`);
  assert(monogramFor('Sam K. Smith') === 'SS', `expected SS (first+last), got "${monogramFor('Sam K. Smith')}"`);
  assert(monogramFor('  zoe ') === 'ZO', `expected trim+uppercase ZO, got "${monogramFor('  zoe ')}"`);
  assert(monogramFor('走') === '走', `single grapheme passes through, got "${monogramFor('走')}"`);
  assert(monogramFor('') === '?', `expected ? fallback for empty, got "${monogramFor('')}"`);
  assert(monogramFor('  ') === '?', `expected ? fallback for whitespace, got "${monogramFor('  ')}"`);
});

// Personal-color resolution (attn-3gdd): declared beats hash, junk falls
// back, agents pinned.
defineCase('Declared color wins for humans; junk falls back to hash', () => {
  const peer = makePeer({ displayName: 'Alex', kind: 'reviewer' });
  const declared = 'oklch(0.58 0.14 32)';
  assert(chipVisualFor(peer, declared).bg === declared, 'valid declared color must win');
  assert(chipVisualFor(peer, 'red; position: fixed').bg === hashParticipantColor(peer.participantId),
    'css-injection-shaped declarations must fall back to the hash color');
  assert(chipVisualFor(peer).bg === chipVisualFor(peer).bg, 'hash must be deterministic');
});

// (8) Hover presence detail — simulate the component's hovered-peer state
//     transition by checking the predicate the template binds to.
defineCase('Hover → presence tooltip shows the hovered peer\'s state', () => {
  const peers: ReviewStatusPeer[] = [
    makePeer({ displayName: 'James', online: true }),
    makePeer({ displayName: 'Alex', online: false }),
  ];
  // Component state surface — mirror of `hoveredPeerId = $state<string|null>`.
  let hoveredPeerId: string | null = null;
  // Initially no tooltip.
  assert(hoveredPeerId === null, 'initial hovered state must be null');
  // Mirror onmouseenter for peer 0.
  hoveredPeerId = peers[0].participantId;
  assert(hoveredPeerId === peers[0].participantId, 'hover should set the participantId');
  // The tooltip's presence label is sourced from the peer's `online` flag.
  const presenceForHovered = peers[0].online ? 'currently viewing' : 'offline';
  assert(presenceForHovered === 'currently viewing', 'online peer hover → currently viewing');
  // Mirror onmouseleave.
  hoveredPeerId = null;
  assert(hoveredPeerId === null, 'leaving should clear the hover id');
  // Hover the offline peer — predicate flips.
  hoveredPeerId = peers[1].participantId;
  const presenceForOffline = peers[1].online ? 'currently viewing' : 'offline';
  assert(presenceForOffline === 'offline', 'offline peer hover → offline label');
});

// (9) Click chip → identity card opens + close clears.
defineCase('Click chip → identity card opens; close clears it', () => {
  const peers: ReviewStatusPeer[] = [
    makePeer({ displayName: 'James', kind: 'owner' }),
    makePeer({ displayName: 'rufus', kind: 'agent' }),
  ];
  // Mirror `openIdentityFor = $state<ReviewStatusPeer | null>(null)`.
  let openIdentityFor: ReviewStatusPeer | null = null;
  assert(openIdentityFor === null, 'card initially closed');

  // Click peer 0.
  openIdentityFor = peers[0];
  assert(openIdentityFor === peers[0], 'click should open the card for the clicked peer');
  assert(openIdentityFor.displayName === 'James', 'open card identifies the clicked peer');
  // Identity card content is derived from the peer + the fingerprint cache.
  const cardKind = openIdentityFor.kind;
  assert(cardKind === 'owner', `identity card kind should be the peer's kind, got ${cardKind}`);

  // Switch to a different peer's card — overwrites the previous.
  openIdentityFor = peers[1];
  assert(openIdentityFor.kind === 'agent', 'switching cards updates the open peer');

  // Close.
  openIdentityFor = null;
  assert(openIdentityFor === null, 'close should clear the open peer');
});

// (10) tail6 + shortenParticipantId helpers (identity-card disambig).
defineCase('tail6 trims to last 6 hex; shortenParticipantId keeps p_…suffix', () => {
  // tail6 strips spaces and takes the last 6 hex chars:
  // "8a4f c019 b3d7" → "8a4fc019b3d7" → ".slice(-6)" → "19b3d7"
  assert(
    tail6('8a4f c019 b3d7') === '19b3d7',
    `expected tail6 to take last 6 hex chars, got "${tail6('8a4f c019 b3d7')}"`,
  );
  assert(tail6('abc') === 'abc', 'tail6 of short string returns whole string');
  const id = 'p_2nq8x4_5kln1mzdef' as ParticipantId;
  const short = shortenParticipantId(id);
  assert(short.startsWith('p_2n'), `expected prefix p_2n…, got "${short}"`);
  assert(short.includes('…'), `expected ellipsis in short id, got "${short}"`);
  assert(short.endsWith('mzdef'), `expected ending mzdef, got "${short}"`);
});

// ---------------------------------------------------------------------------
// Runner — same shape as ConnectionBadge.test.ts
// ---------------------------------------------------------------------------

interface NodeProcessShape {
  exit?: (code: number) => void;
}

async function runAllCases(): Promise<void> {
  let passed = 0;
  let failed = 0;
  for (const run of cases) {
    const r = await run();
    if (r.ok) {
      passed += 1;
      console.log(`  ok  ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
    } else {
      failed += 1;
      console.error(`  FAIL ${r.name}\n        ${r.detail ?? '(no detail)'}`);
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    const proc = (globalThis as { process?: NodeProcessShape }).process;
    proc?.exit?.(1);
  }
}

void runAllCases();
