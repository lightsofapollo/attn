// The agent-comments bar pinned to the bottom of the comment rail.
//
//   cd web && npx tsx src/lib/review/agent-feedback-bar.test.ts
//
// Two halves. The view model (`agent-feedback-bar.ts`) and the copy
// controller run for real under Node: when the bar exists, what the count
// bubble shows per scope, how the scope toggle flips, and that copy-all
// resolves into a transient check. The component wiring is pinned against
// the COMPILED output of `AgentFeedbackBar.svelte` and the source of
// `ReviewMargin.svelte`: the hooks E2E scripts reach for, the absence of
// the old "Copy selected" control and its selection props, and the
// positioning contract (absolute at the rail's bottom, cards lifted above
// it via fitBottom's bottomClearance) — none of which throws when it
// regresses, so nothing else would notice.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { compile } from 'svelte/compiler';

import {
  AGENT_FEEDBACK_BAR_LABEL,
  COPIED_TITLE,
  COPY_ALL_TITLE,
  SCOPE_ICONS,
  SCOPE_TITLES,
  describeAgentFeedbackBar,
  nextFeedbackScope,
} from './agent-feedback-bar';
import { createCopyFeedbackController } from './copy-feedback-port';
import { markedFeedbackThreads } from './feedback-copy';
import type { Anchor, FeedbackRoute, ReviewEvent, Thread } from '../types';

interface CaseResult {
  name: string;
  ok: boolean;
  detail?: string;
}

const cases: Array<() => Promise<CaseResult>> = [];

function defineCase(name: string, fn: () => void | Promise<void>): void {
  cases.push(async () => {
    try {
      await fn();
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

const here = path.dirname(fileURLToPath(import.meta.url));
const libDir = path.resolve(here, '..');
const source = (relative: string): string => fs.readFileSync(path.join(libDir, relative), 'utf8');

function compiled(relative: string): string {
  const filename = path.join(libDir, relative);
  return compile(fs.readFileSync(filename, 'utf8'), { generate: 'client', filename }).js.code;
}

// --- thread fixtures (same shape as feedback.test.ts) -----------------------

const anchor: Anchor = {
  v: 2,
  fileId: 'file-plan',
  snapshotId: 'snap-plan',
  baseHash: 'hash',
  position: { byteRange: [12, 28], lineRange: [3, 4] },
  quote: {
    exact: 'Selected source',
    exactHash: 'quote-hash',
    normalized: 'Selected source',
    normalizedHash: 'normalized-hash',
  },
};

function commentEvent(threadId: string, fileId: string): ReviewEvent {
  return {
    meta: {
      v: 2,
      eventId: `event-${threadId}`,
      roomId: 'room-a',
      authorId: 'human-a',
      deviceId: 'device-human-a',
      createdAt: 1,
      parentEventIds: [],
    },
    body: {
      type: 'comment_created',
      threadId,
      anchor: { ...anchor, fileId },
      body: `Comment on ${threadId}`,
    },
    auth: { signature: 'sig', signingKeyId: 'key' },
  };
}

function thread(id: string, fileId: string, resolved = false): Thread {
  return {
    id,
    rootEvent: commentEvent(id, fileId),
    replies: [],
    resolved,
    anchor: { ...anchor, fileId },
    resolvedAnchor: {
      status: 'exact',
      confidence: 1,
      currentRange: { byteRange: [12, 28], lineRange: [3, 4] },
      reason: 'base_hash_match',
    },
  };
}

const planA = thread('plan-a', 'file-plan');
const planB = thread('plan-b', 'file-plan');
const notesA = thread('notes-a', 'file-notes');
const notesResolved = thread('notes-resolved', 'file-notes', true);

const fileThreads = [planA, planB];
const projectThreads = [planA, planB, notesA, notesResolved];

const routes: Record<string, FeedbackRoute> = {
  'plan-a': { marked: true, revision: 1, updatedAt: 0 },
  'notes-a': { marked: true, revision: 1, updatedAt: 0 },
  'notes-resolved': { marked: true, revision: 1, updatedAt: 0 },
};

// --- view model ---------------------------------------------------------------

defineCase('the bar exists only while the room has a marked, unresolved thread', () => {
  const none = describeAgentFeedbackBar({ scope: 'file', scopeCount: 0, projectCount: 0 });
  assert(!none.visible, 'no marked threads → no bar');

  const onlyResolvedOrUnmarked = markedFeedbackThreads([planB, notesResolved], routes);
  assert(onlyResolvedOrUnmarked.length === 0, 'resolved and unmarked threads do not count');
  const hidden = describeAgentFeedbackBar({
    scope: 'file',
    scopeCount: 0,
    projectCount: onlyResolvedOrUnmarked.length,
  });
  assert(!hidden.visible, 'a resolved marked thread must not summon the bar');

  const marked = markedFeedbackThreads(projectThreads, routes);
  const shown = describeAgentFeedbackBar({
    scope: 'file',
    scopeCount: markedFeedbackThreads(fileThreads, routes).length,
    projectCount: marked.length,
  });
  assert(shown.visible, 'a marked unresolved thread anywhere in the room shows the bar');
});

defineCase('the count bubble follows the copy scope', () => {
  const fileCount = markedFeedbackThreads(fileThreads, routes).length;
  const projectCount = markedFeedbackThreads(projectThreads, routes).length;
  assert(fileCount === 1, `expected 1 marked thread in this file, got ${fileCount}`);
  assert(projectCount === 2, `expected 2 marked threads in the project, got ${projectCount}`);

  const file = describeAgentFeedbackBar({ scope: 'file', scopeCount: fileCount, projectCount });
  assert(file.count === 1, 'file scope counts this file only');
  assert(!file.copyDisabled, 'copy-all is live when the scope has threads');

  const project = describeAgentFeedbackBar({ scope: 'project', scopeCount: projectCount, projectCount });
  assert(project.count === 2, 'project scope counts the whole room');

  // A file with nothing marked still shows the bar (the room has marks),
  // but copy-all has nothing to copy.
  const emptyFile = describeAgentFeedbackBar({ scope: 'file', scopeCount: 0, projectCount });
  assert(emptyFile.visible && emptyFile.count === 0 && emptyFile.copyDisabled,
    'an unmarked file inside a marked room shows 0 and disables copy-all');
});

defineCase('the scope toggle flips between the file and folder glyphs', () => {
  const file = describeAgentFeedbackBar({ scope: 'file', scopeCount: 1, projectCount: 2 });
  assert(file.scopeIcon === 'file', 'file scope shows the file glyph');
  assert(!file.projectScope, 'aria-pressed is off for file scope');
  assert(file.scopeTitle === SCOPE_TITLES.file, 'file scope title');
  assert(file.scopeTitle === 'Switch to Project Scope', 'file scope offers the project scope');

  const flipped = nextFeedbackScope(file.scope);
  assert(flipped === 'project', 'file → project');
  const project = describeAgentFeedbackBar({ scope: flipped, scopeCount: 2, projectCount: 2 });
  assert(project.scopeIcon === 'folder-open', 'project scope shows the open-folder glyph');
  assert(project.projectScope, 'aria-pressed is on for project scope');
  assert(project.scopeTitle === SCOPE_TITLES.project, 'project scope title');
  assert(project.scopeTitle === 'Switch to File Scope', 'project scope offers the file scope');
  assert(nextFeedbackScope(project.scope) === 'file', 'project → file');
  assert(new Set(Object.values(SCOPE_ICONS)).size === 2, 'the two scopes never share a glyph');
});

defineCase('copy-all resolves into a transient check, and a failure shows none', async () => {
  const reports: boolean[] = [];
  const controller = createCopyFeedbackController((copied) => reports.push(copied), 10);

  const ok = await controller.run(async () => true);
  assert(ok, 'a successful copy resolves true');
  assert(reports.join() === 'true', 'the check shows right after success');
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert(reports.join() === 'true,false', 'the check reverts after the reset window');

  const blocked = await controller.run(async () => false);
  assert(!blocked, 'a blocked clipboard resolves false');
  assert(reports.join() === 'true,false', 'no check is shown for a failed copy');
  controller.dispose();
});

// --- component wiring ---------------------------------------------------------

defineCase('AgentFeedbackBar compiles with the row hooks and the copy/check swap', () => {
  const out = compiled('AgentFeedbackBar.svelte');
  for (const hook of [
    'agent-feedback-dock',
    'agent-feedback-bar',
    'agent-feedback-count',
    'feedback-scope',
    'copy-all-feedback',
    'copy-all-feedback-status',
  ]) {
    assert(out.includes(hook), `compiled bar must carry ${JSON.stringify(hook)}`);
  }
  const src = source('AgentFeedbackBar.svelte');
  // The label and titles reach the markup through the shared constants, so
  // the row and the model can never disagree on the words.
  for (const [name, value] of [
    ['AGENT_FEEDBACK_BAR_LABEL', AGENT_FEEDBACK_BAR_LABEL],
    ['COPY_ALL_TITLE', COPY_ALL_TITLE],
    ['COPIED_TITLE', COPIED_TITLE],
  ] as const) {
    const uses = src.match(new RegExp(`\\b${name}\\b`, 'g'))?.length ?? 0;
    assert(uses >= 2, `the bar must render ${name} (${JSON.stringify(value)}) from the model constants`);
    assert(!src.includes(`="${value}"`) && !src.includes(`>${value}<`),
      `${JSON.stringify(value)} must not be duplicated as a markup literal`);
  }
  assert(/aria-live="polite"/.test(src), 'the copied announcement is a polite live region');
  assert(/role="status"/.test(src), 'notices keep role="status"');
  assert(/aria-pressed=\{model\.projectScope\}/.test(src), 'the scope toggle exposes aria-pressed');
  assert(/FolderOpenIcon/.test(src) && /FileIcon/.test(src), 'both scope glyphs are wired');
  assert(/CheckIcon/.test(src) && /CopyIcon/.test(src), 'the copy glyph swaps to a check');
  assert(/createCopyFeedbackController/.test(src), 'the check timing comes from the shared controller');
  assert(!/Copy selected/.test(src), 'no "Copy selected" control');
  assert(!/Copied \$\{/.test(src), 'no visible "Copied N feedback items" notice');
});

defineCase('ReviewMargin mounts the bar at the bottom, gated on marked threads', () => {
  const src = source('ReviewMargin.svelte');
  assert(/const showFeedbackDock = \$derived\(projectMarkedFeedback\.length > 0\);/.test(src),
    'the dock trigger is "any marked thread in the room"');
  assert(/\{#if showFeedbackDock\}[\s\S]*?<AgentFeedbackBar/.test(src),
    'the bar renders only while the dock is shown');
  assert(/onCopyAll=\{\(\) => copyFeedback\(markedFeedback\)\}/.test(src),
    'copy-all copies the current scope');
  assert(/async function copyFeedback\(targets: Thread\[\]\): Promise<boolean>/.test(src),
    'copyFeedback reports success as a boolean for the card and the bar');
  assert(/onCopyFeedback=\{\(\) => copyFeedback\(\[t\]\)\}/.test(src),
    'every card gets the per-card copy');
  assert(!/isForAgent\(t\)\s*\?\s*\(\)\s*=>\s*copyFeedback/.test(src),
    'per-card copy must not be gated on the for-agent mark');

  for (const gone of [
    'Copy selected',
    'selectedFeedbackIds',
    'selectedForAgent=',
    'onToggleFeedbackSelection=',
    'setFeedbackSelected',
    'feedback-batch',
    'Copied ${',
  ]) {
    assert(!src.includes(gone), `ReviewMargin must no longer contain ${JSON.stringify(gone)}`);
  }

  assert(/\.review-margin-feedback-dock \{[\s\S]*?position: absolute;[\s\S]*?bottom: 0;/.test(src),
    'the dock is absolute at the rail bottom in the anchored layout');
  assert(/\.review-margin-feedback-dock\.stacked \{[\s\S]*?position: sticky;/.test(src),
    'the dock is sticky inside the scrolling bottom sheet');
  assert(/cardBottomClearance = \$derived\(feedbackDockClearance \+ RAIL_BOTTOM_GAP\)/.test(src)
    && /bottomClearance: cardBottomClearance/.test(src),
    'fitBottom lifts on-screen cards above the dock, with a gap');
  const frame = fs.readFileSync(path.join(libDir, 'WorkspaceEditorFrame.svelte'), 'utf8');
  assert(!frame.includes('relative mb-2 min-h-0 flex-1 overflow-hidden'),
    'the rail body has no bottom margin, so the dock sits flush with the window edge');
  assert(/bind:clientHeight=\{feedbackDockHeight\}/.test(src),
    'the clearance is the measured dock height (fallback textarea included)');
  assert(!/projectMarkedFeedback\.length > 0 \? 88/.test(src),
    'the 88px top-clearance special case is gone');
});

let passed = 0;
const failures: string[] = [];
for (const run of cases) {
  const result = await run();
  if (result.ok) {
    passed += 1;
    console.log(`PASS ${result.name}`);
  } else {
    failures.push(result.name);
    console.error(`FAIL ${result.name}\n${result.detail ?? ''}`);
  }
}
console.log(`agent feedback bar: ${passed} passed, ${failures.length} failed`);
if (failures.length > 0) process.exit(1);
