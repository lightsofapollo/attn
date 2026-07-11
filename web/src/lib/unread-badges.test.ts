import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

interface CaseResult { name: string; ok: boolean; detail?: string }
const cases: Array<() => Promise<CaseResult>> = [];

function defineCase(name: string, fn: () => void | Promise<void>): void {
  cases.push(async () => {
    try {
      await fn();
      return { name, ok: true };
    } catch (error) {
      return { name, ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  });
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const libDir = path.dirname(fileURLToPath(import.meta.url));
const source = (relative: string): string => fs.readFileSync(path.join(libDir, relative), 'utf8');

defineCase('view-state IPC preserves visible and focused predicates', async () => {
  const messages: Array<Record<string, unknown>> = [];
  const root = globalThis as unknown as {
    window?: { ipc?: { postMessage(message: string): void }; __attn_init__?: { ipcToken: string } };
  };
  root.window = {
    __attn_init__: { ipcToken: 'test-token' },
    ipc: { postMessage: (message) => messages.push(JSON.parse(message) as Record<string, unknown>) },
  };
  const { reviewViewState } = await import('./ipc');
  reviewViewState('room-one', true, false);
  reviewViewState('room-one', true, true);
  assert(messages.length === 2, `expected 2 IPC messages, got ${messages.length}`);
  assert(messages[0]?.type === 'review_view_state', 'expected review_view_state message');
  assert(messages[0]?.roomVisible === true, 'visible predicate must be true');
  assert(messages[0]?.windowFocused === false, 'blurred predicate must remain false');
  assert(messages[1]?.windowFocused === true, 'focus transition must be reported');
});

defineCase('badge is capped, tokenized, and has an accessible count label', () => {
  const badge = source('UnreadBadge.svelte');
  assert(badge.includes("count > 99 ? '99+'"), 'badge must cap large counts');
  assert(badge.includes('bg-primary'), 'badge must use the existing primary token');
  assert(badge.includes('text-primary-foreground'), 'badge must use foreground token');
  assert(badge.includes('aria-label={`${count} ${label}`}'), 'badge must expose count to AT');
});

defineCase('peer, tab, tree, sidebar, room, and rail surfaces render unread badges', () => {
  const surfaces = [
    'PeerStrip.svelte',
    'TabBar.svelte',
    'ReviewFileTree.svelte',
    'Sidebar.svelte',
    'ReviewBar.svelte',
    '../App.svelte',
  ];
  for (const file of surfaces) {
    assert(source(file).includes('UnreadBadge'), `${file} must render UnreadBadge`);
  }
});

async function run(): Promise<void> {
  let failed = 0;
  for (const execute of cases) {
    const result = await execute();
    if (result.ok) console.log(`  ok  ${result.name}`);
    else {
      failed += 1;
      console.error(`  FAIL ${result.name}\n        ${result.detail}`);
    }
  }
  console.log(`\n${cases.length - failed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

void run();
