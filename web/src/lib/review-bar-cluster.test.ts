// The header action cluster: even spacing, and one glyph vocabulary for the
// rail toggle (attn-64iy.3 / attn-64iy.4).
//
// Both bugs this pins were reported from the same screenshot of the native
// header: "Spacing between the button groups is not even here", and "instead
// of the comment icon here use the panel right open and panel right close
// icons". They share a file, so they share a test.
//
// Run with:
//
//   cd web && npx tsx src/lib/review-bar-cluster.test.ts

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
const source = (relative: string): string =>
  fs.readFileSync(path.join(libDir, relative), 'utf8');

const bar = source('ReviewBar.svelte');
const peerStrip = source('PeerStrip.svelte');
const outbox = source('OutboxIndicator.svelte');
const snapshot = source('SnapshotBadge.svelte');
const frame = source('WorkspaceEditorFrame.svelte');

defineCase('no wrapper survives its empty child in the dock', () => {
  // THE BUG: `review-bar-peers` / `-snapshot` / `-outbox` were divs rendered
  // unconditionally inside a `gap-1.5` flex row. Their children each decide
  // their own presence, so an idle dock kept three zero-width flex items —
  // and a zero-width flex item still consumes a gap on both sides. That was
  // ~18px of dead space, all of it between the share control and the comments
  // toggle. Every child must BE the flex item, with no host box in between.
  // Matched as markup, not as a bare substring: the comment explaining the
  // deletion names these slots, and a test that tripped on its own rationale
  // would be a nuisance rather than a guard.
  for (const slot of ['review-bar-peers', 'review-bar-snapshot', 'review-bar-outbox']) {
    assert(
      !bar.includes(`data-slot="${slot}"`) && !bar.includes(`class="${slot}`),
      `${slot} is a wrapper that outlives its child — it must not come back`,
    );
  }
  for (const tag of ['<PeerStrip', '<SnapshotBadge', '<OutboxIndicator']) {
    assert(bar.includes(tag), `${tag} must still be mounted in the dock`);
  }
});

defineCase('each collapsing child carries its own flex sizing', () => {
  // The classes the deleted wrappers used to hold have to live somewhere, or
  // the strip stops shrinking when the dock is tight.
  const strip = peerStrip.slice(peerStrip.indexOf('class="peer-strip relative'));
  assert(
    strip.slice(0, 200).includes('min-w-0') && strip.slice(0, 200).includes('shrink'),
    'PeerStrip’s active root must carry the min-w-0 + shrink the wrapper had',
  );
  assert(
    outbox.slice(outbox.indexOf('class="outbox-indicator')).slice(0, 200).includes('shrink-0'),
    'OutboxIndicator’s root must carry shrink-0',
  );
  assert(
    snapshot.slice(snapshot.indexOf('class="snapshot-badge')).slice(0, 200).includes('shrink-0'),
    'SnapshotBadge’s root must carry shrink-0',
  );
});

defineCase('the empty peer strip generates no flex item', () => {
  // PeerStrip deliberately keeps an "No peers" announcement for assistive tech
  // rather than rendering nothing. That is only gap-free because `sr-only` is
  // position:absolute, which takes it out of flex flow. If the empty branch
  // ever became an ordinary element the spacing bug returns silently.
  const empty = peerStrip.slice(
    peerStrip.indexOf('peer-strip-empty'),
    peerStrip.indexOf('data-state="active"'),
  );
  assert(empty.length > 0, 'the empty peer-strip branch must still exist');
  assert(
    empty.includes('sr-only'),
    'the empty peer strip must stay sr-only (absolute) so it consumes no gap',
  );
});

defineCase('the divider is never drawn with nothing behind it', () => {
  // The divider introduces the cluster that follows the share control. It used
  // to render on `hasActiveRoom` alone, so an idle dock drew a separator
  // between a chip and three invisible wrappers.
  assert(
    bar.includes('const showRailToggle = $derived(railToggle && (hasActiveRoom || shareOpen))'),
    'the toggle/divider condition must be derived once and shared',
  );
  const dividerAt = bar.indexOf('bg-border/70');
  assert(dividerAt > 0, 'the divider must still exist');
  const beforeDivider = bar.slice(0, dividerAt);
  assert(
    beforeDivider.lastIndexOf('{#if showRailToggle}') > beforeDivider.lastIndexOf('{#if hasActiveRoom}'),
    'the divider must be gated on showRailToggle, not on hasActiveRoom',
  );
});

defineCase('the comments toggle appears with the dock, not after the mint', () => {
  // The dock mounts as soon as a share is being initiated (`shareOpen`), but
  // the toggle used to wait for `hasActiveRoom` — so it popped into a cluster
  // the user was already looking at when the room minted.
  assert(
    bar.includes('shareOpen'),
    'the toggle condition must consider a share being initiated',
  );
  const toggleAt = bar.indexOf('data-slot="review-bar-rail-toggle"');
  assert(toggleAt > 0, 'the rail toggle must still exist');
  const before = bar.slice(0, toggleAt);
  assert(
    before.lastIndexOf('{#if showRailToggle}') > before.lastIndexOf('{#if hasActiveRoom}'),
    'the toggle must hang off showRailToggle, not sit inside the hasActiveRoom block',
  );
});

defineCase('both rail toggles agree on the panel glyph pair', () => {
  // The header toggle and WorkspaceEditorFrame's rail-local toggle do the same
  // job; only one renders at a time (`railToggleInHeader`). If they disagreed
  // about which glyph means open, the affordance would change meaning with the
  // surface it appeared on.
  for (const [name, src] of [['ReviewBar', bar], ['WorkspaceEditorFrame', frame]] as const) {
    assert(
      src.includes("from '@lucide/svelte/icons/panel-right-close'")
        && src.includes("from '@lucide/svelte/icons/panel-right-open'"),
      `${name} must import both panel-right glyphs`,
    );
    const closeAt = src.indexOf('<PanelRightClose');
    const openAt = src.indexOf('<PanelRightOpen');
    assert(closeAt > 0 && openAt > 0, `${name} must render both glyphs`);
    assert(
      closeAt < openAt,
      `${name} must render PanelRightClose in the open branch first, matching its sibling`,
    );
  }
  // A speech bubble says "add a comment"; this control opens a panel.
  assert(
    !bar.includes('message-square-text') && !/<MessageSquareText\b/.test(bar),
    'the comment glyph must be gone from the rail toggle',
  );
});

defineCase('the rail toggle obeys the resting-ghost convention', () => {
  // Once the ShareChip beside it lost its permanent border (attn-64iy.6), a
  // permanently outlined toggle would have been the only bordered control left
  // in a row of ghosts — the same inconsistency, one seat over.
  const toggle = bar.slice(
    bar.indexOf('data-slot="review-bar-rail-toggle"') - 600,
    bar.indexOf('data-slot="review-bar-rail-toggle"') + 400,
  );
  assert(
    toggle.includes('border-primary/35 bg-primary/10 text-primary'),
    'the open rail must promote the toggle to the shared active treatment',
  );
  assert(
    toggle.includes('border-transparent'),
    'the resting toggle must be a borderless ghost',
  );
  assert(
    toggle.includes('aria-pressed={reviewStore.panelOpen}'),
    'the active state must be announced, not only painted',
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
