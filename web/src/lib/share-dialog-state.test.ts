// Regression suite for the share sheet's phase → presentation rules
// (attn-vlmz.1.2 / attn-11g4.1.2 / attn-bw2h.6).
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
// Sections 1-3 test the extracted decision directly. Section 4 is a
// source-shape assert (same technique as native-header-parity.test.ts): the
// decision is only worth anything if the template actually renders the
// RESOLVED phase, so pin the couple of template facts that would silently
// reintroduce the bug. Section 5 does both for the sheet's other pending
// state — the verify-key fingerprint, which had no deadline at all.
//
// What is NOT testable here: the mint timer itself lives in component state
// that `tsx` cannot reach. `e2e/native-share-deadline.spec.ts` covers it in a
// real browser against the raw dev loop.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EMPTY_INVITE_MESSAGE,
  FINGERPRINT_PLACEHOLDER,
  MINT_TIMEOUT_MESSAGE,
  resolveFingerprintPresentation,
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
  assert(
    view.errorMessage === MINT_TIMEOUT_MESSAGE,
    `expected the deadline message, got "${view.errorMessage}"`,
  );
  // A deadline expiry establishes neither of the claims the old copy made
  // (attn-bw2h.6). The mint may have reached the relay and even published
  // before failing to answer in time, so asserting either one is a guess —
  // and "nothing left this machine" is a guess about privacy.
  assert(
    !/relay/iu.test(view.errorMessage),
    'a timeout must not blame the relay — we never learned where it failed',
  );
  assert(
    !/left this machine|stayed local|never left/iu.test(view.errorMessage),
    'a timeout must not claim the data stayed local — the room may already exist',
  );
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
// (5) The verify-key fingerprint is the sheet's other deadline-free pending
// state (attn-bw2h.6). `crypto.subtle` is undefined on an insecure
// non-loopback origin, so `ownerKeyFingerprint` throws when a dev server is
// reached over a LAN IP. The rejection used to escape an async `$effect` and
// leave the em-dash placeholder up forever — under a label instructing the
// owner to read it aloud as an identity check. A failed digest must be
// distinguishable from an absent key, and must never be copyable.
// ---------------------------------------------------------------------------

defineCase('fingerprint: absent key renders the placeholder and offers nothing to copy', () => {
  const view = resolveFingerprintPresentation('', '', false);
  assert(view.status === 'absent', `expected absent, got ${view.status}`);
  assert(view.text === FINGERPRINT_PLACEHOLDER, 'absent must render the placeholder');
  assert(!view.copyable, 'there is no fingerprint to copy without a key');
});

defineCase('fingerprint: a key with no digest yet is pending, not ready', () => {
  const view = resolveFingerprintPresentation('key-material', '', false);
  assert(view.status === 'pending', `expected pending, got ${view.status}`);
  assert(!view.copyable, 'a pending digest must not be copyable');
  // A digest that came back AS the placeholder is not a fingerprint either.
  const echoed = resolveFingerprintPresentation('key-material', FINGERPRINT_PLACEHOLDER, false);
  assert(echoed.status === 'pending', 'an echoed placeholder must not read as ready');
});

defineCase('fingerprint: a rejected digest is failed, not silently absent', () => {
  const view = resolveFingerprintPresentation('key-material', '', true);
  assert(view.status === 'failed', `expected failed, got ${view.status}`);
  assert(!view.copyable, 'a failed digest must not be copyable');
  // The whole point: `failed` and `absent` render the same text, so the STATUS
  // is what the template must branch on to say anything at all.
  const absent = resolveFingerprintPresentation('', '', true);
  assert(absent.status === 'absent', 'no key at all outranks a stale failure flag');
  assert(view.text === absent.text, 'both render the placeholder — only status separates them');
});

defineCase('fingerprint: a real digest is ready and copyable', () => {
  const view = resolveFingerprintPresentation('key-material', '535c 110a 9c95', false);
  assert(view.status === 'ready', `expected ready, got ${view.status}`);
  assert(view.text === '535c 110a 9c95', 'ready must render the digest itself');
  assert(view.copyable, 'a real fingerprint is the one thing here worth copying');
});

defineCase('fingerprint: the placeholder matches the one fingerprint.ts returns', () => {
  const libDir = path.dirname(fileURLToPath(import.meta.url));
  const source = fs.readFileSync(path.join(libDir, 'review/fingerprint.ts'), 'utf8');
  assert(
    source.includes(`return '${FINGERPRINT_PLACEHOLDER}';`),
    'FINGERPRINT_PLACEHOLDER must stay identical to the empty-key return in fingerprint.ts',
  );
});

defineCase('ShareDialog renders the resolved fingerprint status', () => {
  const libDir = path.dirname(fileURLToPath(import.meta.url));
  const dialog = fs.readFileSync(path.join(libDir, 'ShareDialog.svelte'), 'utf8');

  assert(
    dialog.includes('resolveFingerprintPresentation(ownerSigningKey'),
    'ShareDialog must derive the fingerprint row from the resolver',
  );
  // The rejection has to be caught INSIDE the effect. Letting it escape is
  // precisely what pinned the placeholder on screen with no way out.
  assert(
    /catch\s*\{[^}]*fingerprintFailed = true/su.test(dialog),
    'the fingerprint effect must catch its own rejection and record the failure',
  );
  assert(
    dialog.includes('disabled={!fingerprintView.copyable}'),
    'the copy button must be disabled unless there is a real fingerprint',
  );
  assert(
    dialog.includes('share-fingerprint-unavailable'),
    'a failed digest must say so rather than sit on em-dashes',
  );
  assert(
    !/\{fingerprint\}/u.test(dialog),
    'the raw fingerprint state must not be rendered directly — status carries the meaning',
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
