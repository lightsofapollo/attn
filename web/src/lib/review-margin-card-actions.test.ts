// Margin card actions are icon buttons; Copy lives in the header.
//
//   cd web && npx tsx src/lib/review-margin-card-actions.test.ts
//
// Two halves, in the same spirit as html-annotate-toggle.test.ts. Runes only
// compile through the Vite+svelte pipeline, so the card's markup is pinned at
// source level: every action button carries a `title` AND a matching
// `aria-label`, the agent toggle draws `user-check` when assigned and
// `user-round-x` when not, the selection checkbox and its props are gone, and
// Copy sits beside the meta chip rather than in the footer. The copy-feedback
// port is plain TypeScript, so its behaviour — check on success, no check on
// `false` or a throw, the timer restarting on a second success — runs for
// real here.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCopyFeedbackController } from './review/copy-feedback-port';

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

const libDir = path.dirname(fileURLToPath(import.meta.url));
const card = fs.readFileSync(path.join(libDir, 'ReviewMarginCard.svelte'), 'utf8');

/** Every `<button …>` opening tag in the card, with its attributes. */
const buttons = card.match(/<button\b[\s\S]*?>/g) ?? [];

/** The buttons that carry a `data-action` — the card's action set. */
function actionButton(action: string): string {
  const found = buttons.filter((b) => b.includes(`data-action="${action}"`));
  assert(found.length === 1, `expected exactly one data-action="${action}" button, got ${found.length}`);
  return found[0]!;
}

// ---------------------------------------------------------------------------
// 1. Icon-only action buttons, each named twice (tooltip + accessible name)
// ---------------------------------------------------------------------------

const ACTIONS: Record<string, string> = {
  reply: 'reply',
  resolve: 'check',
  unresolve: 'undo-2',
  accept: 'check',
  reject: 'x',
  reanchor: 'anchor',
  'discard-stale': 'trash-2',
  'cancel-reanchor': 'x',
  'for-agent': 'user-round-x',
  'copy-feedback': 'copy',
};

const ICON_COMPONENTS: Record<string, string> = {
  reply: 'ReplyIcon',
  check: 'CheckIcon',
  'undo-2': 'Undo2Icon',
  x: 'XIcon',
  anchor: 'AnchorIcon',
  'trash-2': 'Trash2Icon',
  'user-round-x': 'UserRoundXIcon',
  'user-check': 'UserCheckIcon',
  copy: 'CopyIcon',
};

for (const [action, icon] of Object.entries(ACTIONS)) {
  defineCase(`${action}: is an icon button with a title and a matching aria-label`, () => {
    const tag = actionButton(action);
    assert(tag.includes('rmc-icon-btn'), `${action} must use the icon-button variant`);
    const title = tag.match(/\btitle=(\{[^}]+\}|"[^"]+")/);
    const label = tag.match(/\baria-label=(\{[^}]+\}|"[^"]+")/);
    assert(title !== null, `${action} needs a title`);
    assert(label !== null, `${action} needs an aria-label`);
    assert(title[1] === label[1], `${action}: title and aria-label must be the same text`);
  });

  defineCase(`${action}: draws the lucide ${icon} glyph`, () => {
    assert(
      card.includes(`from '@lucide/svelte/icons/${icon}'`),
      `lucide ${icon} must be imported`,
    );
    // The glyph is the first icon rendered inside the button element.
    const tag = actionButton(action);
    const afterTag = card.slice(card.indexOf(tag) + tag.length);
    const body = afterTag.slice(0, afterTag.indexOf('</button>'));
    assert(
      body.includes(`<${ICON_COMPONENTS[icon]} `),
      `${action} must render ${ICON_COMPONENTS[icon]} (got: ${body.trim().slice(0, 120)})`,
    );
    assert(/aria-hidden="true"/.test(body), `${action}: the glyph is decorative, the label carries the name`);
  });
}

defineCase('the action buttons carry no visible text label', () => {
  for (const action of Object.keys(ACTIONS)) {
    const tag = actionButton(action);
    const afterTag = card.slice(card.indexOf(tag) + tag.length);
    const body = afterTag.slice(0, afterTag.indexOf('</button>'));
    const text = body
      .replace(/<[^>]+>/g, '')
      .replace(/\{[^}]*\}/g, '')
      .trim();
    assert(text === '', `${action} must be icon-only, found text "${text}"`);
  }
});

defineCase('pending suggestion labels survive as titles', () => {
  assert(card.includes("'Accepting…'") && card.includes("'Rejecting…'"), 'pending copy');
  const accept = actionButton('accept');
  assert(accept.includes('title={acceptLabel}'), 'Accept title is the live label');
  const reject = actionButton('reject');
  assert(reject.includes('title={rejectLabel}'), 'Reject title is the live label');
});

defineCase('Accept and Re-anchor keep the primary emphasis', () => {
  assert(actionButton('accept').includes('rmc-btn-primary'), 'Accept is primary');
  assert(actionButton('reanchor').includes('rmc-btn-primary'), 'Re-anchor is primary');
  assert(!actionButton('reject').includes('rmc-btn-primary'), 'Reject is not');
  assert(!actionButton('discard-stale').includes('rmc-btn-primary'), 'Discard is not');
});

defineCase('automation hooks are unchanged', () => {
  assert(actionButton('reply').includes('data-slot="review-reply-toggle"'), 'reply slot');
  assert(actionButton('unresolve').includes('data-testid="review-margin-card-unresolve"'), 'unresolve testid');
  assert(actionButton('reanchor').includes('data-testid="review-margin-card-reanchor"'), 'reanchor testid');
  assert(actionButton('discard-stale').includes('data-testid="review-margin-card-discard-stale"'), 'discard testid');
  assert(actionButton('cancel-reanchor').includes('data-testid="review-margin-card-cancel-reanchor"'), 'cancel testid');
});

defineCase('icon buttons are borderless 24px ghost squares with a visible focus ring', () => {
  assert(/\.rmc-icon-btn \{[^}]*width: 24px;[^}]*height: 24px;/s.test(card), '24px square');
  assert(/\.rmc-icon-btn \{[^}]*border: 0;[^}]*background: transparent;/s.test(card), 'no border, no fill at rest');
  assert(/\.rmc-icon-btn:focus-visible \{/.test(card), 'focus-visible ring on the icon button');
});

defineCase('card action row sits at the trailing (right) edge', () => {
  assert(/\.rmc-actions \{[^}]*justify-content: flex-end;/s.test(card), 'actions are right-aligned');
});

// ---------------------------------------------------------------------------
// 2. The agent-assignment toggle
// ---------------------------------------------------------------------------

defineCase('assign toggle: user-check when assigned, user-round-x when not', () => {
  const tag = actionButton('for-agent');
  const afterTag = card.slice(card.indexOf(tag) + tag.length);
  const body = afterTag.slice(0, afterTag.indexOf('</button>'));
  assert(
    /\{#if forAgent\}\s*<UserCheckIcon\b[\s\S]*?\{:else\}\s*<UserRoundXIcon\b/.test(body),
    'the glyph must switch on forAgent',
  );
  assert(tag.includes('aria-pressed={forAgent}'), 'a toggle exposes pressed state');
  assert(tag.includes('class:active={forAgent}'), 'the accent tint stays as reinforcement');
  assert(
    card.includes("forAgent ? 'Assigned to agent (click to unassign)' : 'Assign to agent'"),
    'the two titles',
  );
});

defineCase('assign toggle: shares the Reply/Resolve row, no divider row', () => {
  assert(!card.includes('rmc-feedback-actions'), 'the separate feedback row is gone');
  assert(card.includes('{#snippet agentToggle()}'), 'the toggle is one snippet');
  const footer = card.slice(card.indexOf('<footer class="rmc-actions">'), card.indexOf('</footer>'));
  const commentBranch = footer.slice(footer.indexOf("{:else if kind === 'comment'}"));
  assert(commentBranch.includes('data-action="reply"'), 'Reply in the comment branch');
  assert(commentBranch.includes('data-action="resolve"'), 'Resolve in the comment branch');
  assert(commentBranch.includes('{@render agentToggle()}'), 'the toggle renders in the same footer branch');
});

defineCase('the selection checkbox and its props are gone', () => {
  assert(!card.includes('type="checkbox"'), 'no checkbox');
  assert(!card.includes('selectedForAgent'), 'no selectedForAgent prop');
  assert(!card.includes('onToggleFeedbackSelection'), 'no onToggleFeedbackSelection prop');
  assert(!card.includes('Include in Copy selected'), 'no batch-selection copy');
});

// ---------------------------------------------------------------------------
// 3. Copy in the header
// ---------------------------------------------------------------------------

defineCase('copy: sits in the header immediately after the meta chip', () => {
  const header = card.slice(card.indexOf('<header class="rmc-header">'), card.indexOf('</header>'));
  assert(header.includes('data-action="copy-feedback"'), 'copy button is inside the header');
  const metaEnd = header.indexOf('data-testid="review-margin-card-meta"');
  const copyAt = header.indexOf('data-action="copy-feedback"');
  assert(metaEnd !== -1 && copyAt > metaEnd, 'copy follows the meta chip');
  const copyOpen = header.lastIndexOf('<button', copyAt);
  const between = header.slice(metaEnd, copyOpen);
  assert(!/<button\b/.test(between), 'nothing else sits between the chip and Copy');
  const footer = card.slice(card.indexOf('<footer class="rmc-actions">'), card.indexOf('</footer>'));
  assert(!footer.includes('copy-feedback'), 'and it is no longer in the footer');
});

defineCase('copy: rendered for every comment card, enabled regardless of assignment', () => {
  const header = card.slice(card.indexOf('<header class="rmc-header">'), card.indexOf('</header>'));
  const copyAt = header.indexOf('data-action="copy-feedback"');
  const guard = header.slice(0, copyAt).lastIndexOf("{#if kind === 'comment'}");
  assert(guard !== -1, 'gated on kind === comment only');
  const tag = actionButton('copy-feedback');
  assert(!tag.includes('disabled={!forAgent}'), 'no longer disabled when unassigned');
  assert(tag.includes('onclick={copyForAgent}'), 'wired to the copy handler');
  assert(/function copyForAgent\(e: MouseEvent\): void \{\s*e\.stopPropagation\(\);/.test(card), 'click does not activate the card');
});

defineCase('copy: swaps to a check with a "Copied" title and a polite announcement', () => {
  assert(card.includes("copied ? 'Copied' : 'Copy comment'"), 'label flips with the state');
  const tag = actionButton('copy-feedback');
  const afterTag = card.slice(card.indexOf(tag) + tag.length);
  const body = afterTag.slice(0, afterTag.indexOf('</button>'));
  assert(/\{#if copied\}\s*<CheckIcon\b[\s\S]*?\{:else\}\s*<CopyIcon\b/.test(body), 'check while copied, copy otherwise');
  assert(
    /<span class="rmc-sr-only" role="status" aria-live="polite" data-slot="copy-feedback-status">/.test(card),
    'a visually-hidden polite live region',
  );
  assert(card.includes('$effect(() => () => copyController.dispose())'), 'the reset timer is cleared on unmount');
});

defineCase('copy: the prop contract accepts Promise<boolean> | boolean | void', () => {
  assert(card.includes('onCopyFeedback?: CopyFeedbackAction;'), 'prop typed through the port');
  const port = fs.readFileSync(path.join(libDir, 'review/copy-feedback-port.ts'), 'utf8');
  assert(
    port.includes('export type CopyFeedbackAction = () => Promise<boolean | void> | boolean | void;'),
    'port type',
  );
  assert(port.includes('export const COPIED_RESET_MS = 1500;'), 'about 1500 ms');
});

// ---------------------------------------------------------------------------
// 4. Copy-feedback port behaviour
// ---------------------------------------------------------------------------

const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

defineCase('port: a handler returning nothing shows the check, then clears it', async () => {
  const reports: boolean[] = [];
  const c = createCopyFeedbackController((v) => reports.push(v), 10);
  const ok = await c.run(() => undefined);
  assert(ok === true, 'void result counts as success');
  assert(reports.join(',') === 'true', `check shown immediately, got [${reports.join(',')}]`);
  await tick(25);
  assert(reports.join(',') === 'true,false', `check cleared after the delay, got [${reports.join(',')}]`);
  c.dispose();
});

defineCase('port: a handler resolving true shows the check', async () => {
  const reports: boolean[] = [];
  const c = createCopyFeedbackController((v) => reports.push(v), 10);
  const ok = await c.run(async () => true);
  assert(ok === true && reports[0] === true, 'async true is success');
  c.dispose();
});

defineCase('port: a handler returning false shows no check', async () => {
  const reports: boolean[] = [];
  const c = createCopyFeedbackController((v) => reports.push(v), 10);
  const ok = await c.run(() => false);
  assert(ok === false, 'false is a failed copy');
  await tick(20);
  assert(reports.length === 0, `no report on failure, got [${reports.join(',')}]`);
  c.dispose();
});

defineCase('port: a throwing handler shows no check', async () => {
  const reports: boolean[] = [];
  const c = createCopyFeedbackController((v) => reports.push(v), 10);
  const ok = await c.run(async () => {
    throw new Error('clipboard denied');
  });
  assert(ok === false, 'a throw is a failed copy');
  await tick(20);
  assert(reports.length === 0, `no report on throw, got [${reports.join(',')}]`);
  c.dispose();
});

defineCase('port: no handler is a no-op', async () => {
  const reports: boolean[] = [];
  const c = createCopyFeedbackController((v) => reports.push(v), 10);
  const ok = await c.run(undefined);
  assert(ok === false && reports.length === 0, 'nothing happens without a handler');
  c.dispose();
});

defineCase('port: a second success restarts the clock instead of cutting the first short', async () => {
  const reports: boolean[] = [];
  const c = createCopyFeedbackController((v) => reports.push(v), 30);
  await c.run(() => true);
  await tick(15);
  await c.run(() => true);
  await tick(20);
  // 35ms after the first click, but only 20ms after the second: still shown.
  assert(reports.join(',') === 'true,true', `still copied, got [${reports.join(',')}]`);
  await tick(20);
  assert(reports.join(',') === 'true,true,false', `cleared once, got [${reports.join(',')}]`);
  c.dispose();
});

defineCase('port: dispose cancels a pending reset', async () => {
  const reports: boolean[] = [];
  const c = createCopyFeedbackController((v) => reports.push(v), 10);
  await c.run(() => true);
  c.dispose();
  await tick(25);
  assert(reports.join(',') === 'true', `no report after dispose, got [${reports.join(',')}]`);
});

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

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
console.log(`review-margin-card actions: ${passed} passed, ${failures.length} failed`);
if (failures.length > 0) process.exit(1);
