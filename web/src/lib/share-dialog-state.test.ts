// Regression suite for the share sheet's phase → presentation rules
// (attn-vlmz.1.2 / attn-11g4.1.2).
//
// Run with:
//
//   cd web && npx tsx src/lib/share-dialog-state.test.ts
//
// The bug this exists to prevent: `phase` reaching 'ready' while the invite
// URL was still empty. The template fell through to its loading skeleton —
// three pulsing rows labelled "View link / Comment link / Suggest link" — and
// nothing could ever clear it, because the mint timeout returns early unless
// the phase is still 'minting'. It looked like finished UI, so deleting the
// feature was proposed. The state machine now makes that state unrepresentable
// by resolving it to an explicit error that carries a retry.
//
// Cases 1-4 test the extracted decision directly. Case 5 is a source-shape
// assert (same technique as native-header-parity.test.ts): the decision is
// only worth anything if the template actually renders the RESOLVED phase, so
// pin the couple of template facts that would silently reintroduce the bug.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EMPTY_INVITE_MESSAGE,
  RELAY_ERROR_MESSAGE,
  resolveSharePhase,
  resolveSharePresentation,
  type SharePhase,
} from './share-dialog-state';

// ---------------------------------------------------------------------------
// Tiny harness — same shape as ShareDialog.test.ts.
// ---------------------------------------------------------------------------

interface CaseResult {
  name: string;
  ok: boolean;
  detail?: string;
}

const cases: Array<() => CaseResult> = [];

function defineCase(name: string, fn: () => void | string): void {
  cases.push(() => {
    try {
      const note = fn();
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

const CLI = "npx attnmd review join 'attn://review/abc#k=1'";

// ---------------------------------------------------------------------------
// (1) THE regression: ready + empty invite URL must surface an error.
// ---------------------------------------------------------------------------

defineCase('ready with an empty invite URL surfaces an error, never a skeleton', () => {
  const view = resolveSharePresentation({
    phase: 'ready',
    inviteUrl: '',
    cliCommand: '',
    daemonErrorMessage: '',
  });
  assert(view.phase === 'error', `expected phase=error, got ${view.phase}`);
  assert(view.errorMessage === EMPTY_INVITE_MESSAGE, `expected the empty-invite message, got "${view.errorMessage}"`);
  assert(view.errorMessage.length > 0, 'an error phase must always carry a message');
  // Nothing copyable — the card must not offer an action over an absent link.
  assert(view.primary.kind === 'pending', `expected no primary action, got ${view.primary.kind}`);
  // And it must hold even when a stale CLI string is somehow still around.
  const withStaleCli = resolveSharePresentation({
    phase: 'ready',
    inviteUrl: '',
    cliCommand: CLI,
    daemonErrorMessage: '',
  });
  assert(withStaleCli.phase === 'error', 'an invite-less ready must not be rescued by a leftover CLI string');
});

defineCase('a daemon message outranks the generic empty-invite text', () => {
  const view = resolveSharePresentation({
    phase: 'ready',
    inviteUrl: '',
    cliCommand: '',
    daemonErrorMessage: 'relay rejected the room: quota exceeded',
  });
  assert(view.phase === 'error', `expected phase=error, got ${view.phase}`);
  assert(
    view.errorMessage === 'relay rejected the room: quota exceeded',
    `expected the daemon's own message, got "${view.errorMessage}"`,
  );
});

defineCase('a timed-out mint still explains itself', () => {
  const view = resolveSharePresentation({
    phase: 'error',
    inviteUrl: '',
    cliCommand: '',
    daemonErrorMessage: '',
  });
  assert(view.errorMessage === RELAY_ERROR_MESSAGE, `expected the relay message, got "${view.errorMessage}"`);
});

// ---------------------------------------------------------------------------
// (2) Ready with a usable URL stays ready and offers exactly one action.
// ---------------------------------------------------------------------------

defineCase('ready with a CLI one-liner offers the command', () => {
  const view = resolveSharePresentation({
    phase: 'ready',
    inviteUrl: 'attn://review/abc#k=1',
    cliCommand: CLI,
    daemonErrorMessage: '',
  });
  assert(view.phase === 'ready', `expected phase=ready, got ${view.phase}`);
  assert(view.errorMessage === '', 'a ready phase must carry no error text');
  assert(view.primary.kind === 'command', `expected a command action, got ${view.primary.kind}`);
  assert(view.primary.text === CLI, `expected the CLI text, got "${view.primary.text}"`);
});

// The hosted build mints an HTTPS invite with no `attn://` URL behind it, so
// `cliCommand` is ''. This used to leave the primary card showing "Minting
// room…" forever even though the share had completed.
defineCase('ready without a CLI one-liner offers the link itself, not a spinner', () => {
  const view = resolveSharePresentation({
    phase: 'ready',
    inviteUrl: 'https://staging.attn.sh/s/abc#key=1',
    cliCommand: '',
    daemonErrorMessage: '',
  });
  assert(view.phase === 'ready', `expected phase=ready, got ${view.phase}`);
  assert(view.primary.kind === 'link', `expected a link action, got ${view.primary.kind}`);
  assert(
    view.primary.text === 'https://staging.attn.sh/s/abc#key=1',
    `expected the invite URL, got "${view.primary.text}"`,
  );
});

defineCase('a resolved ready phase always has something to copy', () => {
  const urls = ['attn://review/a#k=1', 'https://attn.sh/s/a#key=1'];
  const commands = ['', CLI];
  for (const inviteUrl of urls) {
    for (const cliCommand of commands) {
      const view = resolveSharePresentation({ phase: 'ready', inviteUrl, cliCommand, daemonErrorMessage: '' });
      if (view.phase !== 'ready') continue;
      assert(
        view.primary.kind !== 'pending' && view.primary.text.length > 0,
        `ready must never be pending (url="${inviteUrl}", cli="${cliCommand}")`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// (3) Pre-ready phases are untouched — the mint timeout owns them.
// ---------------------------------------------------------------------------

defineCase('configure and minting pass through unchanged', () => {
  for (const phase of ['configure', 'minting'] as SharePhase[]) {
    const view = resolveSharePresentation({ phase, inviteUrl: '', cliCommand: '', daemonErrorMessage: '' });
    assert(view.phase === phase, `expected ${phase} to pass through, got ${view.phase}`);
    assert(view.primary.kind === 'pending', `${phase} must offer nothing to copy`);
    assert(view.errorMessage === '', `${phase} must carry no error text`);
  }
  assert(resolveSharePhase('minting', '') === 'minting', 'minting with no URL is a wait, not a failure');
});

// ---------------------------------------------------------------------------
// (4) The template must consume the resolved phase, or none of this matters.
// ---------------------------------------------------------------------------

defineCase('ShareDialog renders the resolved phase, not the raw one', () => {
  const libDir = path.dirname(fileURLToPath(import.meta.url));
  const dialog = fs.readFileSync(path.join(libDir, 'ShareDialog.svelte'), 'utf8');

  assert(
    dialog.includes('resolveSharePresentation({'),
    'ShareDialog must derive its presentation from the resolver',
  );
  for (const flag of ['isMinting', 'isConfiguring', 'isReady', 'isError']) {
    assert(
      dialog.includes(`const ${flag} = $derived(presentation.phase ===`),
      `${flag} must be derived from the RESOLVED phase, not the raw \`phase\` state`,
    );
  }
  // The stuck skeleton was the `{:else}` of this gate. With ready implying a
  // usable URL, the gate is a bare `isReady` and the else-branch belongs to
  // minting alone, which MINT_TIMEOUT_MS bounds.
  assert(
    dialog.includes('{#if isReady}'),
    'the tier-links gate must be a bare isReady now that ready implies a usable invite',
  );
  assert(
    !dialog.includes('isReady && inviteUrl.length > 0'),
    'a second URL check in the template would resurrect the unreachable-skeleton branch',
  );
  // The file scan has the same "spinner with no deadline" failure mode.
  assert(
    dialog.includes('fileScanTimedOut') && dialog.includes('FILE_SCAN_TIMEOUT_MS'),
    'the file scan must be bounded too — no spinner in this dialog may run forever',
  );
  // The other half of "ready implies a usable invite": a usable invite must
  // not be thrown away. Gating the open effect on `existingInviteUrl` alone
  // sent hosted mints — HTTPS invite, no `attn://` — back to the file picker
  // on a share that had just succeeded. Verified in a browser; pinned here.
  assert(
    dialog.includes('if (existingRoomId !== null && inviteUrl.length > 0)'),
    'the open effect must gate on the RESOLVED invite URL, not the native-only one',
  );
});

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

interface NodeProcessShape {
  exit?: (code: number) => void;
}

let passed = 0;
let failed = 0;
for (const run of cases) {
  const r = run();
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
  const nodeProcess = (globalThis as unknown as { process?: NodeProcessShape }).process;
  nodeProcess?.exit?.(1);
}
