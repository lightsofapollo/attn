// One active/pressed convention for the native header icon cluster
// (attn-11g4.6), plus the snapshot glyph swap.
//
// Run with:
//
//   cd web && npx tsx src/lib/header-icon-states.test.ts

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

const app = source('../App.svelte');
const badge = source('SnapshotBadge.svelte');
const shareChip = source('ShareChip.svelte');

defineCase('the snapshot control uses file-clock, not a camera', () => {
  assert(
    badge.includes("from '@lucide/svelte/icons/file-clock'"),
    'a snapshot is a point-in-time copy of a file — the glyph must say that',
  );
  assert(
    !badge.includes("icons/camera"),
    'the camera import must be gone: it reads as "take a screenshot", which attn also does',
  );
  assert(!/<Camera\b/.test(badge), 'no Camera glyph may remain in any badge state');
  const clocks = badge.match(/<FileClock\b/g) ?? [];
  assert(
    clocks.length === 3,
    `all three snapshot states must carry the new glyph (found ${clocks.length})`,
  );
});

defineCase('interactive header icons share one active treatment', () => {
  // The accent + a fill + an outline, never the accent alone (PRODUCT.md:
  // an active state must not be conveyed by colour alone).
  const ACTIVE = 'border-primary/35 bg-primary/10 text-primary';
  assert(
    badge.includes(ACTIVE),
    'the snapshot chip must use the shared active treatment',
  );
  assert(
    app.includes(ACTIVE),
    'the header settings button must use the same active treatment',
  );
  assert(
    badge.includes("CHIP_REST") && badge.includes('border-transparent'),
    'the resting state must be a borderless ghost so the active outline is a real change',
  );
});

defineCase('the compact share chip obeys the same resting-ghost rule', () => {
  // attn-64iy.6. The convention case above asserted only against App.svelte
  // and SnapshotBadge.svelte, which is exactly how ShareChip drifted: its
  // compact variant wore `border-primary/30 bg-primary/5` permanently and was
  // reported as "the lightning bolt should not have a border around it if the
  // save icon does not". Pin the compact variant here so it cannot drift back.
  const ACTIVE = 'border-primary/35 bg-primary/10 text-primary';
  assert(
    shareChip.includes(`const CHIP_ACTIVE = '${ACTIVE} hover:bg-primary/15'`),
    'the compact share chip must promote to the shared active treatment',
  );
  for (const rest of ['CHIP_REST_LIVE', 'CHIP_REST_OFFLINE']) {
    const decl = shareChip.slice(shareChip.indexOf(`const ${rest} =`));
    assert(decl.length > 0, `${rest} must exist`);
    assert(
      decl.slice(0, 160).includes('border-transparent'),
      `${rest} must be a borderless ghost, not a bordered pill`,
    );
  }
  // The demotion must not cost the live room its standing disclosure: the
  // resting live chip keeps the accent, and the state is still carried by a
  // glyph swap so it never rests on colour alone (PRODUCT.md).
  assert(
    shareChip.slice(shareChip.indexOf('const CHIP_REST_LIVE =')).slice(0, 160).includes('text-primary'),
    'the resting live chip keeps the primary accent',
  );
  for (const glyph of ['<Zap', '<Wifi', '<CloudOff']) {
    assert(shareChip.includes(glyph), `the connection glyph swap must survive (${glyph})`);
  }
  // The TEXT variant is a labelled chip in a wide bar, not a member of an icon
  // cluster — it is deliberately exempt, so its bordered treatment must remain
  // reachable rather than being collapsed into the compact one.
  assert(
    shareChip.includes("'border-primary/30 bg-primary/5 text-primary hover:bg-primary/10'"),
    'the non-compact text variant keeps its own bordered treatment',
  );
});

defineCase('active state is reported programmatically, not just painted', () => {
  const settings = app.slice(app.indexOf('data-slot="native-header-settings"'));
  assert(
    settings.slice(0, 400).includes('aria-pressed={settingsOpen}'),
    'the settings toggle must expose its pressed state',
  );
  assert(
    settings.slice(0, 400).includes("data-active={settingsOpen ? 'true' : 'false'}"),
    'the settings toggle needs a stable automation hook for the active state',
  );
  // The snapshot chips are popover triggers, so `aria-expanded` (already
  // present) is the correct state property — `aria-pressed` on top of
  // `aria-haspopup` would double-announce.
  const chips = badge.match(/data-slot="snapshot-badge-chip"/g) ?? [];
  const actives = badge.match(/data-active=\{popoverOpen \? 'true' : 'false'\}/g) ?? [];
  assert(
    chips.length === actives.length && chips.length === 4,
    `every snapshot chip must report its active state (${chips.length} chips, ${actives.length} flags)`,
  );
  assert(
    (badge.match(/aria-expanded=\{popoverOpen\}/g) ?? []).length === 4,
    'every popover trigger must keep aria-expanded',
  );
});

defineCase('the save-status glyph stays non-interactive', () => {
  // Ambiguity resolved (attn-11g4.6): the reporter's crop was the save chip,
  // but it is a live region reporting document state — it has no surface to
  // open, so it gets no pressed state and no click target.
  const chip = app.slice(
    app.indexOf('data-slot="native-save-chip"'),
    app.indexOf('data-slot="native-save-chip-label"'),
  );
  assert(chip.length > 0, 'the native save chip must still exist');
  assert(chip.includes('role="status"'), 'the save chip stays a live region');
  assert(!chip.includes('aria-pressed'), 'a status region has no pressed state');
  assert(!chip.includes('onclick'), 'the save chip must not become a control by accident');
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
