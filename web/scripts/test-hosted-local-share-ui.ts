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
import { chromium, expect, type BrowserContext, type Page } from '@playwright/test';

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const relayRoot = path.resolve(webRoot, '..', 'relay');
const relayPort = 8793;
const appPort = 5177;
const relayUrl = `http://127.0.0.1:${relayPort}`;
const appUrl = `http://127.0.0.1:${appPort}`;
const commentMarker = 'LOCAL-OWNER-REVIEW-COMMENT-9173';
const suggestionMarker = 'LOCAL-OWNER-REVIEW-SUGGESTION-9173';
const sharedImageSource = '../images/pixel.png';
const remoteImageSource = 'https://images.attn.invalid/remote-share-image.png';
const unresolvedImageSource = 'data:;base64,';
const sharedPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const useExternalServers = process.env.ATTN_SHARE_UI_EXTERNAL === '1';

let relay: ChildProcessWithoutNullStreams | null = null;
let app: ChildProcessWithoutNullStreams | null = null;
let ownerContext: BrowserContext | null = null;
let reviewerContext: BrowserContext | null = null;
let offlineReviewerContext: BrowserContext | null = null;
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

function seedProfileDisplayName({ displayName }: { displayName: string }): void {
  // Playwright init scripts also run inside `srcdoc` frames. Those frames are
  // intentionally opaque-origin, where touching localStorage throws.
  if (window.location.protocol !== 'http:' && window.location.protocol !== 'https:') return;
  localStorage.setItem('attn.profile.displayName', displayName);
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

async function expectResolvedSharedImage(page: Page, label: string): Promise<void> {
  const wrapper = page.locator(`.md-image[data-src="${sharedImageSource}"]`);
  await wrapper.waitFor({ state: 'attached', timeout: 60_000 });
  await page.waitForFunction(
    (source) => document.querySelector(`.md-image[data-src="${source}"]`)?.getAttribute('data-loaded') === 'true',
    sharedImageSource,
    { timeout: 60_000 },
  );
  const image = wrapper.locator('img');
  await image.waitFor({ state: 'visible', timeout: 60_000 });
  const detail = await image.evaluate((element) => {
    const imageElement = element as HTMLImageElement;
    return {
      src: imageElement.getAttribute('src'),
      width: imageElement.naturalWidth,
      height: imageElement.naturalHeight,
      loaded: imageElement.parentElement?.getAttribute('data-loaded'),
    };
  });
  if (detail.loaded !== 'true' || detail.width !== 1 || detail.height !== 1 || !detail.src?.startsWith('blob:')) {
    throw new Error(`${label} did not render the verified local image: ${JSON.stringify(detail)}`);
  }
}

async function expectBlockedRemoteImage(page: Page, label: string): Promise<void> {
  const image = page.locator(`.md-image[data-src="${remoteImageSource}"] img`);
  await image.waitFor({ state: 'attached', timeout: 60_000 });
  await image.waitFor({ state: 'hidden', timeout: 60_000 });
  const detail = await image.evaluate((element) => ({
    src: element.getAttribute('src'),
    broken: element.parentElement?.getAttribute('data-broken'),
  }));
  if (detail.src !== unresolvedImageSource || detail.broken !== 'true') {
    throw new Error(`${label} did not retain a no-network remote-image fallback: ${JSON.stringify(detail)}`);
  }
}

async function expectAttemptedExternalImage(page: Page, label: string): Promise<void> {
  const image = page.locator(`.md-image[data-src="${remoteImageSource}"] img`);
  await image.waitFor({ state: 'attached', timeout: 60_000 });
  await page.waitForFunction(
    (source) => {
      const imageElement = document.querySelector(`.md-image[data-src="${source}"] img`);
      return imageElement?.getAttribute('src') === source
        && imageElement.parentElement?.getAttribute('data-broken') === 'true';
    },
    remoteImageSource,
    { timeout: 60_000 },
  );
  const detail = await image.evaluate((element) => ({
    src: element.getAttribute('src'),
    referrerPolicy: element.getAttribute('referrerpolicy'),
    broken: element.parentElement?.getAttribute('data-broken'),
  }));
  if (
    detail.src !== remoteImageSource
    || detail.referrerPolicy !== 'no-referrer'
    || detail.broken !== 'true'
  ) {
    throw new Error(`${label} did not attempt the approved HTTPS image safely: ${JSON.stringify(detail)}`);
  }
}

async function expectResolvedSharedHtmlImages(
  page: Page,
  label: string,
  externalImagesEnabled = false,
): Promise<void> {
  const frame = page.frameLocator('[data-slot="html-viewer"] iframe');
  const verified = frame.locator('#verified-html-image');
  await expect(verified).toBeVisible({ timeout: 60_000 });
  await expect(verified).toHaveJSProperty('naturalWidth', 1, { timeout: 60_000 });
  await expect(verified).toHaveJSProperty('naturalHeight', 1, { timeout: 60_000 });
  await expect(verified).toHaveAttribute('src', /^data:image\/png;base64,/u);

  const pictureImage = frame.locator('#picture-html-image');
  await expect(pictureImage).toBeVisible({ timeout: 60_000 });
  await expect(pictureImage).toHaveJSProperty('naturalWidth', 1, { timeout: 60_000 });
  const source = frame.locator('#verified-html-source');
  const srcset = await source.getAttribute('srcset');
  const expectedRemoteSrcset = externalImagesEnabled ? remoteImageSource : unresolvedImageSource;
  if (!srcset?.includes('data:image/png;base64,') || !srcset.includes(expectedRemoteSrcset)) {
    throw new Error(`${label} did not rewrite picture srcset safely: ${JSON.stringify(srcset)}`);
  }

  const remote = frame.locator('#remote-html-image');
  await expect(remote).toHaveAttribute(
    'src',
    externalImagesEnabled ? remoteImageSource : unresolvedImageSource,
    { timeout: 60_000 },
  );
  await expect(remote).toHaveJSProperty('naturalWidth', 0, { timeout: 60_000 });
  await expect(remote).toHaveAttribute('referrerpolicy', 'no-referrer');
  const sandbox = await page.locator('[data-slot="html-viewer"] iframe').getAttribute('sandbox');
  if (sandbox?.includes('allow-same-origin')) {
    throw new Error(`${label} weakened the opaque-origin HTML sandbox: ${sandbox}`);
  }
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

async function createInvite(owner: Page, options: { selectAll?: boolean } = {}): Promise<string> {
  await owner.locator('[data-slot="owner-header-share"]').click();
  const dialog = owner.getByRole('dialog', { name: 'Share files for review' });
  await dialog.waitFor({ state: 'visible' });
  if (options.selectAll) await dialog.getByRole('button', { name: 'Select all' }).click();
  await dialog.getByRole('button', { name: /Create review link/u }).click();
  const tierPicker = dialog.locator('select[aria-label="What this link allows"]');
  try {
    await tierPicker.selectOption('suggest', { timeout: 30_000 });
  } catch (error) {
    const resume = dialog.getByRole('button', { name: 'Resume publishing' });
    if (await resume.isVisible().catch(() => false)) {
      // A fresh browser workspace can race its writer lease on the first
      // publish. Exercise the product's recoverable resume action rather
      // than turning that transient fence into a false image-test failure.
      await resume.click();
      await tierPicker.selectOption('suggest', { timeout: 60_000 });
      return finishInvite(owner, dialog);
    }
    throw new Error(
      `review link did not become ready: ${JSON.stringify((await dialog.textContent() ?? '').trim())}`,
      { cause: error },
    );
  }
  return finishInvite(owner, dialog);
}

async function finishInvite(owner: Page, dialog: ReturnType<Page['getByRole']>): Promise<string> {
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
  await ownerContext.addInitScript(seedProfileDisplayName, { displayName: 'Owner agent' });
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
  await reviewerContext.addInitScript(seedProfileDisplayName, { displayName: 'Review agent' });
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

  // Run image behavior in a fresh one-document workspace so the established
  // comment/suggestion lifecycle above remains an independent baseline.
  const imageOwner = await ownerContext.newPage();
  captureBrowserFailures(imageOwner, 'image owner');
  const remoteRequests: string[] = [];
  imageOwner.on('request', (request) => {
    if (request.url().startsWith(remoteImageSource)) remoteRequests.push(request.url());
  });
  await imageOwner.goto(`${appUrl}/app#new`, { waitUntil: 'domcontentloaded' });
  await imageOwner.locator('input[type="file"][multiple][accept*="image"]').setInputFiles([
    {
      name: 'docs/review.md',
      mimeType: 'text/markdown',
      buffer: Buffer.from(
        `# Hosted image share\n\n![Verified chart](${sharedImageSource})\n\n![Remote fallback](${remoteImageSource})\n\n`,
      ),
    },
    {
      name: 'docs/preview.html',
      mimeType: 'text/html',
      buffer: Buffer.from(
        `<!doctype html><html><body>
          <img id="verified-html-image" src="${sharedImageSource}" alt="Verified chart">
          <picture>
            <source id="verified-html-source" srcset="${sharedImageSource} 1x, ${remoteImageSource} 2x">
            <img id="picture-html-image" src="${sharedImageSource}" alt="Picture chart">
          </picture>
          <img id="remote-html-image" src="${remoteImageSource}" alt="Remote fallback">
        </body></html>`,
      ),
    },
    { name: 'images/pixel.png', mimeType: 'image/png', buffer: sharedPng },
  ]);
  await imageOwner.getByRole('button', { name: 'review.md', exact: true }).waitFor({ state: 'visible' });
  await expectResolvedSharedImage(imageOwner, 'local owner');
  await expectAttemptedExternalImage(imageOwner, 'local owner');
  await imageOwner.getByRole('button', { name: 'preview.html', exact: true }).click();
  await expectResolvedSharedHtmlImages(imageOwner, 'local owner HTML document', true);
  await imageOwner.getByRole('button', { name: 'review.md', exact: true }).click();
  if (remoteRequests.length === 0) {
    throw new Error('local owner did not request the approved remote image');
  }
  const imageInvite = await createInvite(imageOwner, { selectAll: true });

  reviewerContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await reviewerContext.addInitScript(seedProfileDisplayName, { displayName: 'Image review agent' });
  const imageReviewer = await reviewerContext.newPage();
  captureBrowserFailures(imageReviewer, 'image reviewer');
  await imageReviewer.goto(imageInvite, { waitUntil: 'domcontentloaded' });
  await imageReviewer.locator('[data-slot="browser-review"]').waitFor({ state: 'visible' });
  await imageReviewer.waitForFunction(() => document.querySelector('[data-slot="browser-review"]')?.getAttribute('data-authoring-ready') === 'true');
  await imageReviewer.getByRole('button', { name: /review\.md/u }).click();
  await expectResolvedSharedImage(imageReviewer, 'live invited reviewer');
  await expectBlockedRemoteImage(imageReviewer, 'live invited reviewer');
  const loadExternalImages = imageReviewer.getByRole('button', { name: 'Load external images for this review' });
  await loadExternalImages.waitFor({ state: 'visible' });
  await loadExternalImages.click();
  await expectAttemptedExternalImage(imageReviewer, 'opted-in invited reviewer');
  await imageReviewer.getByRole('button', { name: /preview\.html/u }).click();
  await expectResolvedSharedHtmlImages(imageReviewer, 'opted-in invited reviewer HTML document', true);

  // A second reviewer tab owns a distinct in-memory Blob registry.
  const follower = await reviewerContext.newPage();
  captureBrowserFailures(follower, 'image follower');
  await follower.goto(imageInvite, { waitUntil: 'domcontentloaded' });
  await follower.locator('[data-slot="browser-review"]').waitFor({ state: 'visible' });
  await follower.getByRole('button', { name: /review\.md/u }).click();
  await expectResolvedSharedImage(follower, 'follower reviewer tab');
  await expectBlockedRemoteImage(follower, 'follower reviewer tab');
  await follower.close();

  // Reload destroys the reviewer surface and its Blob URLs. The fresh page
  // must hydrate and bind the asset again from the retained durable share.
  await imageReviewer.reload({ waitUntil: 'domcontentloaded' });
  await imageReviewer.locator('[data-slot="browser-review"]').waitFor({ state: 'visible' });
  await imageReviewer.waitForFunction(() => document.querySelector('[data-slot="browser-review"]')?.getAttribute('data-authoring-ready') === 'true');
  await expectResolvedSharedHtmlImages(imageReviewer, 'reloaded invited reviewer HTML document');
  await imageReviewer.getByRole('button', { name: /review\.md/u }).click();
  await expectResolvedSharedImage(imageReviewer, 'reloaded invited reviewer');
  await expectBlockedRemoteImage(imageReviewer, 'reloaded invited reviewer');
  await reviewerContext.close();
  reviewerContext = null;

  // Once every owner page is gone, a fresh reviewer has no ordinary live
  // owner connection to borrow. The stable share must restore its document
  // and image from the retained durable projection, then do it again after a
  // browser reload with an empty in-memory Blob registry.
  await ownerContext.close();
  ownerContext = null;
  offlineReviewerContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await offlineReviewerContext.addInitScript(seedProfileDisplayName, { displayName: 'Offline review agent' });
  const offlineReviewer = await offlineReviewerContext.newPage();
  captureBrowserFailures(offlineReviewer, 'offline reviewer');
  await offlineReviewer.goto(imageInvite, { waitUntil: 'domcontentloaded' });
  const offlineShell = offlineReviewer.locator('[data-slot="browser-review"]');
  await offlineShell.waitFor({ state: 'visible' });
  await offlineShell.waitFor({ state: 'attached' });
  await offlineReviewer.waitForFunction(() => document.querySelector('[data-slot="browser-review"]')?.getAttribute('data-owner-online') === 'false');
  await offlineReviewer.getByRole('button', { name: /preview\.html/u }).click();
  await expectResolvedSharedHtmlImages(offlineReviewer, 'owner-offline durable reviewer HTML document');
  await offlineReviewer.getByRole('button', { name: /review\.md/u }).click();
  await expectResolvedSharedImage(offlineReviewer, 'owner-offline durable reviewer');
  await expectBlockedRemoteImage(offlineReviewer, 'owner-offline durable reviewer');
  await offlineReviewer.reload({ waitUntil: 'domcontentloaded' });
  await offlineReviewer.locator('[data-slot="browser-review"]').waitFor({ state: 'visible' });
  await offlineReviewer.waitForFunction(() => document.querySelector('[data-slot="browser-review"]')?.getAttribute('data-owner-online') === 'false');
  await expectResolvedSharedImage(offlineReviewer, 'reloaded owner-offline durable reviewer');
  await expectBlockedRemoteImage(offlineReviewer, 'reloaded owner-offline durable reviewer');
  step('hosted image share survived follower, reload, and owner-offline durable review');

  if (diagnostics.some((line) => /\[attn drift\]/u.test(line))) {
    throw new Error(`projection drift detected:\n${diagnostics.filter((line) => /\[attn drift\]/u.test(line)).join('\n')}`);
  }
  // The blocked sources use a malformed local data URL, while the approved
  // HTTPS fixture intentionally cannot resolve. The DOM assertions above
  // distinguish a local policy fallback from an attempted external request.
  const browserErrors = diagnostics.filter((line) => (
    /(?:page error:|console error:)/u.test(line)
    && !/console error: Failed to load resource: net::ERR_(?:INVALID_URL|FILE_NOT_FOUND|NAME_NOT_RESOLVED)/u.test(line)
  ));
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
  await offlineReviewerContext?.close();
  await reviewerContext?.close();
  await ownerContext?.close();
  await browser?.close();
  if (!useExternalServers) {
    await stop(app);
    await stop(relay);
  }
  clearInterval(keepAlive);
}
