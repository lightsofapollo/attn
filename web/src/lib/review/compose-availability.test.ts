// No reachable path from a text selection inside a room to a silent no-op
// (attn-64iy.2).
//
// Run with:
//
//   cd web && npx tsx src/lib/review/compose-availability.test.ts

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  COMPOSE_FILE_NOT_SHARED,
  COMPOSE_HTML_SUGGEST_UNSUPPORTED,
  COMPOSE_PREPARING,
  COMPOSE_SUGGEST_NOT_GRANTED,
  resolveComposeAvailability,
  toolbarShouldRender,
  type ComposeContext,
} from './compose-availability';

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

const ready: ComposeContext = {
  hasRoom: true,
  roomHasSnapshot: true,
  fileHasSnapshot: true,
  fileSnapshotHasAnchors: true,
  grantTier: 'suggest',
};

const ctx = (over: Partial<ComposeContext>): ComposeContext => ({ ...ready, ...over });

defineCase('the happy path is ready for both actions', () => {
  assert(resolveComposeAvailability('comment', ready).status === 'ready', 'comment is ready');
  assert(resolveComposeAvailability('suggest', ready).status === 'ready', 'suggest is ready');
});

defineCase('no room means the affordance does not exist', () => {
  const a = resolveComposeAvailability('comment', ctx({ hasRoom: false }));
  assert(a.status === 'absent', 'outside a review room there is nothing to compose into');
  assert(!toolbarShouldRender(a), 'and therefore no toolbar to render');
});

defineCase('a share still landing reads as pending, not as a refusal', () => {
  // THE REGRESSION THAT MATTERED. Before attn-64iy.1 the browser dev loop sat
  // here permanently. Calling it "not shared" would have been a lie — the file
  // WAS shared; nothing had published a snapshot for it yet.
  const a = resolveComposeAvailability('comment', ctx({
    roomHasSnapshot: false,
    fileHasSnapshot: false,
    fileSnapshotHasAnchors: false,
  }));
  assert(a.status === 'pending', 'a room with no snapshots at all is still completing');
  assert(a.status === 'pending' && a.reason === COMPOSE_PREPARING, 'and says so');
  assert(toolbarShouldRender(a), 'the toolbar must stay on screen to say it');
});

defineCase('a file outside the share is blocked, and says which problem it is', () => {
  const a = resolveComposeAvailability('comment', ctx({
    fileHasSnapshot: false,
    fileSnapshotHasAnchors: false,
  }));
  assert(a.status === 'blocked', 'the room has snapshots, this file just is not one of them');
  assert(a.status === 'blocked' && a.reason === COMPOSE_FILE_NOT_SHARED, 'with the structural reason');
  assert(toolbarShouldRender(a), 'a blocked action still owes the user its reason');
});

defineCase('an unhydrated snapshot is a wait, not a wall', () => {
  const a = resolveComposeAvailability('comment', ctx({ fileSnapshotHasAnchors: false }));
  assert(a.status === 'pending', 'a pointer snapshot resolves itself once its blob lands');
});

defineCase('an HTML selector capability is a ready-to-anchor snapshot', () => {
  const a = resolveComposeAvailability('comment', ctx({
    fileSnapshotHasAnchors: false,
    fileSnapshotHasHtmlSelectors: true,
  }));
  assert(a.status === 'ready', 'HTML selector documents do not wait for a Markdown index');
});

defineCase('HTML documents permit comments but explicitly decline suggestions', () => {
  const html = ctx({
    fileSnapshotHasAnchors: false,
    fileSnapshotHasHtmlSelectors: true,
  });
  assert(resolveComposeAvailability('comment', html).status === 'ready', 'HTML comments are ready');
  const suggestion = resolveComposeAvailability('suggest', html);
  assert(suggestion.status === 'blocked', 'HTML suggestions are intentionally unsupported');
  assert(
    suggestion.status === 'blocked' && suggestion.reason === COMPOSE_HTML_SUGGEST_UNSUPPORTED,
    'the unsupported capability is named',
  );
});

defineCase('transient and structural are never confused', () => {
  // The two failures look identical from the composer's old bare `return`;
  // telling them apart is the entire point of this module.
  const landing = resolveComposeAvailability('comment', ctx({
    roomHasSnapshot: false,
    fileHasSnapshot: false,
    fileSnapshotHasAnchors: false,
  }));
  const notShared = resolveComposeAvailability('comment', ctx({
    fileHasSnapshot: false,
    fileSnapshotHasAnchors: false,
  }));
  assert(landing.status !== notShared.status, 'a wait must not present as a refusal');
});

defineCase('a comment-only invite is told plainly it cannot suggest', () => {
  const a = resolveComposeAvailability('suggest', ctx({ grantTier: 'comment' }));
  assert(a.status === 'blocked', 'the grant tier is a hard boundary');
  assert(a.status === 'blocked' && a.reason === COMPOSE_SUGGEST_NOT_GRANTED, 'and it is named');
  // Commenting is unaffected — a comment-tier invite exists to comment.
  assert(
    resolveComposeAvailability('comment', ctx({ grantTier: 'comment' })).status === 'ready',
    'a comment grant still comments',
  );
});

defineCase('the tier refusal beats a spinner that would lead nowhere', () => {
  // Ordering: without the grant, no amount of waiting helps, so "pending" here
  // would be a spinner with no destination.
  const a = resolveComposeAvailability('suggest', ctx({
    grantTier: 'comment',
    roomHasSnapshot: false,
    fileHasSnapshot: false,
    fileSnapshotHasAnchors: false,
  }));
  assert(a.status === 'blocked', 'the permanent reason must win over the transient one');
});

defineCase('every non-ready state carries a sentence', () => {
  const contexts: ComposeContext[] = [
    ctx({ roomHasSnapshot: false, fileHasSnapshot: false, fileSnapshotHasAnchors: false }),
    ctx({ fileHasSnapshot: false, fileSnapshotHasAnchors: false }),
    ctx({ fileSnapshotHasAnchors: false }),
    ctx({ grantTier: 'comment' }),
  ];
  for (const kind of ['comment', 'suggest'] as const) {
    for (const c of contexts) {
      const a = resolveComposeAvailability(kind, c);
      if (a.status === 'ready' || a.status === 'absent') continue;
      assert(
        a.reason.trim().length > 12,
        `${kind} in ${JSON.stringify(c)} must explain itself, not just decline`,
      );
    }
  }
});

defineCase('the callers actually consult it', () => {
  // A model nothing reads is decoration. These are the three sites whose bare
  // `return`s produced "I highlight text but nothing appears".
  const app = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '../../App.svelte'),
    'utf8',
  );
  assert(
    app.includes('toolbarShouldRender(commentAvailability)'),
    'the toolbar must render on availability, not vanish on a missing snapshot',
  );
  assert(
    app.includes("if (commentAvailability.status !== 'ready')"),
    'openCommentComposer must consult availability',
  );
  assert(
    app.includes("if (suggestAvailability.status !== 'ready')"),
    'openSuggestionComposer must consult availability',
  );
  assert(
    !app.includes("if (reviewStore.localGrantTier !== 'suggest') return;"),
    'the bare grant-tier return must be gone — it was the silent refusal',
  );
  const toolbar = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '../SelectionToolbar.svelte'),
    'utf8',
  );
  assert(
    toolbar.includes('disabled={!commentReady}') && toolbar.includes('disabled={!suggestReady}'),
    'an unavailable action must be disabled, not enabled-and-inert',
  );
  assert(
    toolbar.includes('data-slot="selection-toolbar-reason"'),
    'the reason must be visible text, not only a title attribute',
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
