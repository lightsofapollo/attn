#!/usr/bin/env -S npx tsx

/**
 * A real hosted owner/reviewer lifecycle against disposable local relay +
 * Vite processes. This is deliberately not a mocked BrowserSession test:
 * it proves the browser UI's durable contract across three owner surfaces:
 *
 *   owner editor ── encrypted relay ── isolated reviewer
 *       │                                  │
 *       ├── passive owner workspace          └── comment + suggestion
 *       └── already-open owner Desk ── live count refresh
 *
 * The assertions are intentionally UI-visible. They prove that review
 * history survives the reviewer's disconnect and the owner’s reload, while
 * Desk counts are derived from unresolved durable work (not “live”).
 *
 * Run: npm run test:share-ui:live
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type BrowserContext, type Page } from '@playwright/test';

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const relayRoot = path.resolve(webRoot, '..', 'relay');
const relayPort = 8793;
const appPort = 5177;
const relayUrl = `http://127.0.0.1:${relayPort}`;
const appUrl = `http://127.0.0.1:${appPort}`;
const commentMarker = 'LOCAL-OWNER-REVIEW-COMMENT-9173';
const suggestionMarker = 'LOCAL-OWNER-REVIEW-SUGGESTION-9173';
const useExternalServers = process.env.ATTN_SHARE_UI_EXTERNAL === '1';

let relay: ChildProcessWithoutNullStreams | null = null;
let app: ChildProcessWithoutNullStreams | null = null;
let ownerContext: BrowserContext | null = null;
let reviewerContext: BrowserContext | null = null;
let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
const diagnostics: string[] = [];
// Playwright's locator waits use unref'd timers. Keep a real handle while the
// standalone gate owns browser contexts, otherwise Node may exit between two
// awaited UI assertions even though `main()` has not completed.
const keepAlive = setInterval(() => undefined, 1_000);

function step(label: string): void {
  console.log(`share-ui: ${label}`);
}

function start(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): ChildProcessWithoutNullStreams {
  const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (chunk) => diagnostics.push(String(chunk)));
  child.stderr.on('data', (chunk) => diagnostics.push(String(chunk)));
  child.on('error', (error) => diagnostics.push(`could not start ${command}: ${error.message}\n`));
  child.on('exit', (code, signal) => diagnostics.push(`${path.basename(command)} exited (${code ?? signal ?? 'unknown'})\n`));
  return child;
}

async function waitFor(
  url: string,
  label: string,
  child: ChildProcessWithoutNullStreams,
  html = false,
): Promise<void> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`${label} exited before becoming ready: ${diagnostics.slice(-20).join('')}`);
    }
    try {
      const response = await fetch(url, html ? { headers: { Accept: 'text/html' } } : undefined);
      if (response.ok) return;
    } catch {
      // The process is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${label} did not become ready`);
}

async function stop(child: ChildProcessWithoutNullStreams | null): Promise<void> {
  if (!child || child.exitCode !== null || child.killed) return;
  child.kill('SIGTERM');
  await Promise.race([
    once(child, 'exit').then(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, 10_000)),
  ]);
  if (child.exitCode === null && !child.killed) child.kill('SIGKILL');
}

function captureBrowserFailures(page: Page, label: string): void {
  page.on('pageerror', (error) => diagnostics.push(`${label} page error: ${error.message}`));
  page.on('console', (message) => {
    const text = message.text();
    if (message.type() === 'error' || /\[attn drift\]/u.test(text)) {
      diagnostics.push(`${label} console ${message.type()}: ${text}`);
    }
  });
}

async function selectText(page: Page, needle: string): Promise<void> {
  const result = await page.evaluate((text) => {
    const view = (window as unknown as { __attnPmView?: { dom: HTMLElement } }).__attnPmView;
    if (!view) return 'missing-editor';
    const walker = document.createTreeWalker(view.dom, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      const index = node.nodeValue?.indexOf(text) ?? -1;
      if (index >= 0) {
        const range = document.createRange();
        range.setStart(node, index);
        range.setEnd(node, index + text.length);
        const selection = window.getSelection();
        if (!selection) return 'missing-selection';
        selection.removeAllRanges();
        selection.addRange(range);
        document.dispatchEvent(new Event('selectionchange'));
        return 'selected';
      }
      node = walker.nextNode();
    }
    return 'missing-text';
  }, needle);
  if (result !== 'selected') throw new Error(`could not select ${needle}: ${result}`);
  await page.locator('[data-slot="selection-toolbar"]').waitFor({ state: 'visible' });
}

async function waitForOwnerTextRebase(
  page: Page,
  replacement: string,
  prior: string,
): Promise<void> {
  // The transition synchronously rotates the owner binding, then the new
  // EditorView is mounted on the next task. A short explicit settle keeps the
  // standalone script observable even under runners that unref Playwright's
  // long polling timers.
  await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
  const latest = await page.locator('[data-body-text] .ProseMirror').textContent() ?? '';
  // Remote-cursor and review-decoration DOM can split a text node around the
  // reviewer's display name, so assert the distinctive marker edges rather
  // than assume one contiguous DOM text node.
  if (
    latest.includes(replacement.slice(0, 16))
    && latest.includes(replacement.slice(-16))
    && !latest.includes(prior)
  ) return;
  throw new Error(`owner editor did not rebase accepted text; latest=${JSON.stringify(latest)}`);
}

async function currentWorkspaceId(page: Page): Promise<string> {
  const id = await page.evaluate(() => {
    const match = window.location.pathname.match(/^\/app\/w\/([^/]+)/u);
    return match?.[1] ?? null;
  });
  if (!id) throw new Error('owner did not navigate to a workspace route');
  return id;
}

async function createInvite(owner: Page): Promise<string> {
  await owner.locator('[data-slot="owner-header-share"]').click();
  const dialog = owner.getByRole('dialog', { name: 'Share files for review' });
  await dialog.waitFor({ state: 'visible' });
  await dialog.getByRole('button', { name: /Create review link/u }).click();
  await dialog.locator('select[aria-label="What this link allows"]').selectOption('suggest');
  const chip = dialog.locator('.share-link-chip');
  await chip.click();
  const invite = await chip.locator('code').textContent();
  if (!invite || !/\/s\/[^#]+#key=/u.test(invite)) {
    throw new Error('created invite did not expose a local secret-bearing /s link');
  }
  await owner.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  return invite;
}

async function main(): Promise<void> {
  if (useExternalServers) {
    const relayResponse = await fetch(`${relayUrl}/health`);
    const appResponse = await fetch(`${appUrl}/app`, { headers: { Accept: 'text/html' } });
    if (!relayResponse.ok || !appResponse.ok) throw new Error('externally managed local servers are not ready');
  } else {
    relay = start(
      path.join(relayRoot, 'node_modules', '.bin', 'wrangler'),
      [
        'dev', '--local', '--port', String(relayPort),
        '--var', 'QUOTA_ALLOW_UNATTRIBUTED_CREATES:true',
        '--var', `ALLOWED_BROWSER_ORIGINS:${appUrl}`,
        '--var', 'BLOB_CAP_SIGNING_KEY:local-share-ui-blob-cap-signing-key-32bytes',
      ],
      relayRoot,
      process.env,
    );
    await waitFor(`${relayUrl}/health`, 'local relay', relay);

    app = start(
      path.join(webRoot, 'node_modules', '.bin', 'vite'),
      ['--config', 'vite.browser.config.ts', '--host', '127.0.0.1', '--port', String(appPort), '--strictPort'],
      webRoot,
      {
        ...process.env,
        ATTN_DEV_RELAY_TARGET: relayUrl,
        ATTN_DEV_RELAY_ORIGIN: appUrl,
        // The local relay has a strict browser-origin allowlist. Pointing the
        // client directly at it preserves the app origin in the browser's
        // WebSocket Origin header; the Vite proxy rewrites that header and
        // therefore correctly fails closed with 403.
        VITE_ATTN_RELAY_URL: relayUrl,
      },
    );
    await waitFor(`${appUrl}/app`, 'hosted app', app, true);
  }

  browser = await chromium.launch({ headless: true });
  ownerContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  // The product correctly asks a first-time owner to choose a display name
  // after a room becomes active. This lifecycle gate is about durable review
  // convergence, so provide that ordinary prerequisite before navigation.
  await ownerContext.addInitScript(() => {
    localStorage.setItem('attn.profile.displayName', 'Owner agent');
  });
  const owner = await ownerContext.newPage();
  captureBrowserFailures(owner, 'owner');
  await owner.goto(`${appUrl}/app#new`, { waitUntil: 'domcontentloaded' });
  const editor = owner.locator('[data-body-text] .ProseMirror');
  await editor.waitFor({ state: 'visible' });
  await editor.pressSequentially('A durable review survives every connection state.');
  await owner.locator('[data-commits]').waitFor({ state: 'attached' });
  await owner.waitForFunction(() => Number(document.querySelector('[data-commits]')?.getAttribute('data-commits')) > 0);
  const workspaceId = await currentWorkspaceId(owner);
  step('owner workspace saved');

  const invite = await createInvite(owner);
  step('owner published suggest invite');
  const passive = await ownerContext.newPage();
  captureBrowserFailures(passive, 'passive owner');
  await passive.goto(owner.url(), { waitUntil: 'domcontentloaded' });
  await passive.locator('[data-app-view="workspace"]').waitFor({ state: 'visible' });
  const passiveRail = passive.locator('[data-slot="review-bar-rail-toggle"]');
  await passiveRail.waitFor({ state: 'visible' });
  if (await passiveRail.getAttribute('data-active') !== 'true') await passiveRail.click();

  // Keep this Desk open *before* reviewer activity. The review-doorbell must
  // update it live; a late open would only prove initial read-time counting.
  const desk = await ownerContext.newPage();
  captureBrowserFailures(desk, 'desk');
  await desk.goto(`${appUrl}/app`, { waitUntil: 'domcontentloaded' });
  await desk.locator(`[data-workspace-id="${workspaceId}"]`).waitFor({ state: 'visible' });
  if (await desk.locator(`[data-workspace-id="${workspaceId}"] [data-slot="review-counts"]`).count() !== 0) {
    throw new Error('freshly shared workspace unexpectedly has review work before the reviewer acts');
  }
  step('owner passive tab and Desk opened before review activity');

  reviewerContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await reviewerContext.addInitScript(() => {
    localStorage.setItem('attn.profile.displayName', 'Review agent');
  });
  const reviewer = await reviewerContext.newPage();
  captureBrowserFailures(reviewer, 'reviewer');
  await reviewer.goto(invite, { waitUntil: 'domcontentloaded' });
  const reviewerShell = reviewer.locator('[data-slot="browser-review"]');
  await reviewerShell.waitFor({ state: 'visible' });
  await reviewerShell.waitFor({ state: 'attached' });
  await reviewer.waitForFunction(() => document.querySelector('[data-slot="browser-review"]')?.getAttribute('data-authoring-ready') === 'true');
  await reviewer.waitForFunction(() => Boolean((window as unknown as { __attnPmView?: unknown }).__attnPmView));
  step('reviewer authoring ready');

  await selectText(reviewer, 'durable review');
  await reviewer.locator('[data-slot="selection-toolbar-comment"]').click();
  await reviewer.locator('.comment-composer textarea').fill(commentMarker);
  await reviewer.getByRole('button', { name: 'Submit' }).click();
  await reviewer.locator('.comment-composer').waitFor({ state: 'hidden' });

  await selectText(reviewer, 'connection state');
  await reviewer.locator('[data-slot="selection-toolbar-suggest"]').click();
  await reviewer.locator('[data-slot="suggestion-composer-text"]').fill(suggestionMarker);
  await reviewer.locator('[data-slot="suggestion-composer-note"]').fill('durable lifecycle gate');
  await reviewer.locator('[data-slot="suggestion-composer-submit"]').click();
  await reviewer.locator('.suggestion-composer').waitFor({ state: 'hidden' });
  step('reviewer submitted comment and suggestion');

  const passiveCards = passive.locator('[data-testid="review-margin-card"]');
  await passiveCards.filter({ hasText: commentMarker }).waitFor({ state: 'visible', timeout: 60_000 });
  await passiveCards.filter({ hasText: suggestionMarker }).waitFor({ state: 'visible', timeout: 60_000 });

  const deskCounts = desk.locator(`[data-workspace-id="${workspaceId}"] [data-slot="review-counts"]`);
  await deskCounts.waitFor({ state: 'visible', timeout: 60_000 });
  await deskCounts.getByText('1 suggestion', { exact: true }).waitFor({ state: 'visible' });
  await deskCounts.getByText('1 comment', { exact: true }).waitFor({ state: 'visible' });
  step('passive workspace and already-open Desk converged');

  const railToggle = owner.locator('[data-slot="review-bar-rail-toggle"]');
  await railToggle.waitFor({ state: 'visible', timeout: 60_000 });
  if (await railToggle.getAttribute('data-active') !== 'true') await railToggle.click();
  const ownerCards = owner.locator('[data-testid="review-margin-card"]');
  const commentCard = ownerCards.filter({ hasText: commentMarker });
  const suggestionCard = ownerCards.filter({ hasText: suggestionMarker });
  await commentCard.waitFor({ state: 'visible' });
  await suggestionCard.waitFor({ state: 'visible' });
  await commentCard.getByRole('button', { name: 'Resolve' }).click();
  await suggestionCard.getByRole('button', { name: 'Accept' }).click();
  step('owner resolved comment and accepted suggestion');

  // Accepting a suggestion transitions the published epoch. The owner editor
  // must re-seed on that authenticated base rather than merely recording a
  // terminal ledger event behind a stale live document.
  await waitForOwnerTextRebase(owner, suggestionMarker, 'connection state');

  await desk.waitForFunction((id) => (
    document.querySelector(`[data-workspace-id="${id}"] [data-slot="review-counts"]`) === null
  ), workspaceId, { timeout: 60_000 });
  try {
    await passive.waitForFunction(
      () => document.querySelectorAll('[data-testid="review-margin-resolved-chip"]').length >= 2,
      undefined,
      { timeout: 60_000 },
    );
  } catch {
    const debug = await passive.evaluate(() => ({
      chips: document.querySelectorAll('[data-testid="review-margin-resolved-chip"]').length,
      cards: document.querySelectorAll('[data-testid="review-margin-card"]').length,
      rail: document.querySelector('[data-slot="review-margin"]')?.getAttribute('data-rail-mode') ?? null,
      collab: (window as unknown as { __attnCollabDebug?: unknown }).__attnCollabDebug ?? null,
    }));
    throw new Error(`passive projection did not render resolved history: ${JSON.stringify(debug)}`);
  }

  // Leaving the live reviewer must not erase the two decisions. Reloading the
  // passive owner is a fresh projection from IndexedDB, not a warm store.
  await reviewerContext.close();
  reviewerContext = null;
  await passive.reload({ waitUntil: 'domcontentloaded' });
  await passive.waitForFunction(() => document.querySelectorAll('[data-testid="review-margin-resolved-chip"]').length >= 2, undefined, { timeout: 60_000 });
  await desk.reload({ waitUntil: 'domcontentloaded' });
  if (await desk.locator(`[data-workspace-id="${workspaceId}"] [data-slot="review-counts"]`).count() !== 0) {
    throw new Error('resolved review history was incorrectly counted as open Desk work after reload');
  }

  // The same saved threads must remain available through the mobile Review
  // sheet after the live reviewer has gone away. Use the same browser context
  // (and therefore the same IndexedDB) but a fresh narrow route load, then
  // repeat after reload to prove this is durable projection state rather than
  // a warm desktop store or a live connection indicator.
  const mobile = await ownerContext.newPage();
  captureBrowserFailures(mobile, 'mobile owner');
  await mobile.setViewportSize({ width: 390, height: 844 });
  await mobile.goto(owner.url(), { waitUntil: 'domcontentloaded' });
  const mobileReview = mobile.locator('.thumb-dock').getByRole('button', { name: 'Review' });
  await mobileReview.waitFor({ state: 'visible', timeout: 60_000 });
  await mobileReview.click();
  const mobileSheet = mobile.getByRole('dialog', { name: 'Review · 0' });
  await mobileSheet.waitFor({ state: 'visible' });
  await mobileSheet.locator('[data-testid="review-margin-resolved-chip"]').nth(1).waitFor({
    state: 'visible', timeout: 60_000,
  });
  await mobile.reload({ waitUntil: 'domcontentloaded' });
  const reloadedMobileReview = mobile.locator('.thumb-dock').getByRole('button', { name: 'Review' });
  await reloadedMobileReview.waitFor({ state: 'visible', timeout: 60_000 });
  await reloadedMobileReview.click();
  const reloadedMobileSheet = mobile.getByRole('dialog', { name: 'Review · 0' });
  await reloadedMobileSheet.locator('[data-testid="review-margin-resolved-chip"]').nth(1).waitFor({
    state: 'visible', timeout: 60_000,
  });
  step('resolved history survived reviewer disconnect and reload');

  if (diagnostics.some((line) => /\[attn drift\]/u.test(line))) {
    throw new Error(`projection drift detected:\n${diagnostics.filter((line) => /\[attn drift\]/u.test(line)).join('\n')}`);
  }
  const browserErrors = diagnostics.filter((line) => /(?:page error:|console error:)/u.test(line));
  if (browserErrors.length > 0) {
    throw new Error(`browser errors detected:\n${browserErrors.join('\n')}`);
  }
  console.log('hosted-local-share-ui: all green');
}

try {
  await main();
} catch (error) {
  console.error('hosted-local-share-ui: failed', error);
  const relevant = diagnostics.filter((line) => !/vite v|ready in|Local:/u.test(line)).slice(-80);
  if (relevant.length > 0) console.error(relevant.join(''));
  process.exitCode = 1;
} finally {
  await reviewerContext?.close();
  await ownerContext?.close();
  await browser?.close();
  if (!useExternalServers) {
    await stop(app);
    await stop(relay);
  }
  clearInterval(keepAlive);
}
