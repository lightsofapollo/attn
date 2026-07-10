import { expect, test, type Page } from '@playwright/test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const inviteUrl = process.env.ATTN_BROWSER_INVITE_URL;
const contentCanary = process.env.ATTN_EXPECTED_CANARY ?? 'NARWHAL-TEAK-7429';
const secretCanary = process.env.ATTN_ROOM_SECRET_CANARY;
const commentCanary = process.env.ATTN_COMMENT_CANARY ?? 'BROWSER-COMMENT-8127';
const replyCanary = process.env.ATTN_REPLY_CANARY ?? 'BROWSER-REPLY-4631';
const suggestionCanary = process.env.ATTN_SUGGESTION_CANARY ?? 'BROWSER-SUGGEST-9054';
const ownerHome = process.env.ATTN_OWNER_HOME;
const attnBin = process.env.ATTN_BIN;
const execFileAsync = promisify(execFile);

interface EnvelopePost {
  body: string;
  pow: string;
}

function frameText(payload: string | Buffer): string {
  return typeof payload === 'string' ? payload : payload.toString('utf8');
}

function attachWireCapture(page: Page): {
  wire: string[];
  deviceStatuses: number[];
  browserErrors: string[];
  envelopePosts: EnvelopePost[];
  websocketUrls: string[];
} {
  const wire: string[] = [];
  const deviceStatuses: number[] = [];
  const browserErrors: string[] = [];
  const envelopePosts: EnvelopePost[] = [];
  const websocketUrls: string[] = [];

  page.on('request', (request) => {
    wire.push(`HTTP ${request.method()} ${request.url()}\n${request.postData() ?? ''}`);
    if (/\/v2\/rooms\/[^/]+\/envelopes$/.test(new URL(request.url()).pathname)) {
      envelopePosts.push({
        body: request.postData() ?? '',
        pow: request.headers()['attn-pow'] ?? '',
      });
    }
  });
  page.on('response', (response) => {
    wire.push(`HTTP< ${response.status()} ${response.url()}`);
    if (/\/v2\/rooms\/[^/]+\/devices$/.test(new URL(response.url()).pathname)) {
      deviceStatuses.push(response.status());
    }
  });
  page.on('requestfailed', (request) => {
    wire.push(`HTTP! ${request.url()} ${request.failure()?.errorText ?? 'request failed'}`);
  });
  page.on('websocket', (socket) => {
    websocketUrls.push(socket.url());
    wire.push(`WS ${socket.url()}`);
    socket.on('framesent', ({ payload }) => wire.push(`WS> ${frameText(payload)}`));
    socket.on('framereceived', ({ payload }) => wire.push(`WS< ${frameText(payload)}`));
  });
  page.on('pageerror', (error) => browserErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(message.text());
  });

  return { wire, deviceStatuses, browserErrors, envelopePosts, websocketUrls };
}

async function selectEditorText(page: Page, needle: string): Promise<void> {
  const outcome = await page.evaluate((text) => {
    const view = (window as unknown as {
      __attnPmView?: {
        focus(): void;
        state: {
          doc: {
            descendants(callback: (node: { isText?: boolean; text?: string }, pos: number) => boolean): void;
          };
          selection: { constructor: { create(doc: unknown, from: number, to: number): unknown } };
          tr: { setSelection(selection: unknown): unknown };
        };
        dispatch(transaction: unknown): void;
      };
    }).__attnPmView;
    if (!view) return 'no-view';
    let range: { from: number; to: number } | null = null;
    view.state.doc.descendants((node, pos) => {
      if (range || !node.isText || !node.text) return !range;
      const index = node.text.indexOf(text);
      if (index < 0) return true;
      range = { from: pos + index, to: pos + index + text.length };
      return false;
    });
    if (!range) return 'not-found';
    view.focus();
    const selection = view.state.selection.constructor.create(
      view.state.doc,
      range.from,
      range.to,
    );
    view.dispatch(view.state.tr.setSelection(selection));
    document.dispatchEvent(new Event('selectionchange'));
    return 'selected';
  }, needle);
  expect(outcome).toBe('selected');
  await expect(page.locator('[data-slot="selection-toolbar"]')).toBeVisible();
}

async function nativeEval<T>(expression: string): Promise<T> {
  if (!attnBin || !ownerHome) throw new Error('ATTN_BIN and ATTN_OWNER_HOME are required');
  const { stdout } = await execFileAsync(attnBin, ['--eval', expression], {
    env: { ...process.env, ATTN_HOME: ownerHome },
    maxBuffer: 4 * 1024 * 1024,
  });
  return JSON.parse(stdout.trim()) as T;
}

async function nativeEventBodies(): Promise<Array<Record<string, unknown>>> {
  return nativeEval<Array<Record<string, unknown>>>(
    'window.__attn_review_store__?.events.map(event => JSON.parse(JSON.stringify(event.body))) || []',
  );
}

test('native share opens in hosted reviewer without leaking plaintext or keys', async ({
  page,
  context,
}) => {
  test.skip(!inviteUrl, 'ATTN_BROWSER_INVITE_URL is required');
  test.skip(!secretCanary, 'ATTN_ROOM_SECRET_CANARY is required');
  test.skip(!ownerHome || !attnBin, 'ATTN_OWNER_HOME and ATTN_BIN are required');

  await page.addInitScript(() => {
    const calls: string[] = [];
    (window as unknown as { __attnIpcCalls: string[] }).__attnIpcCalls = calls;
    Object.defineProperty(window, 'ipc', {
      configurable: true,
      value: { postMessage: (payload: string) => calls.push(payload) },
    });
  });
  const capture = attachWireCapture(page);
  await page.goto(inviteUrl!, { waitUntil: 'domcontentloaded' });

  await expect.poll(() => new URL(page.url()).hash).toBe('');
  await page.waitForTimeout(750);
  if (process.env.E2E_DEBUG_WIRE === '1') {
    console.log(`${capture.wire.join('\n')}\n\nBrowser errors:\n${capture.browserErrors.join('\n')}`);
  }
  await test.info().attach('bootstrap-diagnostics.txt', {
    body: Buffer.from(
      `${capture.wire.join('\n')}\n\nBrowser errors:\n${capture.browserErrors.join('\n')}`,
      'utf8',
    ),
    contentType: 'text/plain',
  });
  await expect.poll(() => capture.deviceStatuses.some((status) => status === 200 || status === 204)).toBe(true);
  await expect.poll(() => capture.wire.some((line) => line.startsWith('WS< '))).toBe(true);
  await expect(page.locator('[data-slot="browser-review"]')).toHaveAttribute('data-authoring-ready', 'true');
  await page.getByRole('button', { name: 'Hosted review canary' }).click();
  await expect(page.getByRole('heading', { name: 'Hosted review canary' })).toBeVisible();
  await expect(page.getByText(contentCanary, { exact: false })).toBeVisible();

  const taskCheckbox = page.locator('.task-list-item input[type="checkbox"]').first();
  await expect(taskCheckbox).toBeDisabled();
  await taskCheckbox.click({ force: true });
  await expect(taskCheckbox).not.toBeChecked();

  await page.getByRole('button', { name: 'Folder sibling canary' }).click();
  await expect(page.getByRole('heading', { name: 'Folder sibling canary' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Hosted review canary' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Hosted review canary' }).click();
  await expect(page.getByRole('heading', { name: 'Hosted review canary' })).toBeVisible();

  // Queue a comment while offline. The browser must keep only its sealed
  // envelope, recover transport delivery, and receive the encrypted echo.
  const postsBeforeOffline = capture.envelopePosts.length;
  const receivedFramesBeforeOffline = capture.wire.filter((line) => line.startsWith('WS< ')).length;
  await context.setOffline(true);
  await selectEditorText(page, 'Hosted review');
  await page.locator('[data-slot="selection-toolbar-comment"]').click();
  await page.locator('.comment-composer textarea').fill(commentCanary);
  await page.getByRole('button', { name: 'Submit' }).click();
  await expect(page.locator('[data-slot="browser-review"]')).toHaveAttribute('data-outbox-pending', '1');
  await context.setOffline(false);
  await expect(page.locator('[data-slot="browser-review"]')).toHaveAttribute('data-outbox-pending', '0');
  await expect.poll(() => capture.envelopePosts.length).toBeGreaterThan(postsBeforeOffline);
  await expect.poll(
    () => capture.wire.filter((line) => line.startsWith('WS< ')).length,
  ).toBeGreaterThan(receivedFramesBeforeOffline);

  const commentCard = page
    .locator('[data-testid="review-margin-card"]')
    .filter({ hasText: commentCanary });
  await expect(commentCard).toBeVisible();
  const nativeBridgeDebug = await nativeEval<unknown>(
    `({
      reviewEventType: typeof window.__attn__?.reviewEvent,
      eventCount: window.__attn_review_store__?.events.length ?? -1,
      eventTypes: window.__attn_review_store__?.events.map(item => item.body?.type) ?? []
    })`,
  );
  await test.info().attach('native-bridge-debug.json', {
    body: Buffer.from(JSON.stringify(nativeBridgeDebug), 'utf8'),
    contentType: 'application/json',
  });
  await expect.poll(async () => {
    const bodies = await nativeEventBodies();
    return bodies.some((body) => body.type === 'comment_created' && body.body === commentCanary);
  }).toBe(true);

  // Select the browser-authored file in the native owner and expand the rail;
  // the card must render there, not merely exist in its local event log.
  await nativeEval<boolean>(
    `(() => {
      const store = window.__attn_review_store__;
      const event = store?.events.find(item => item.body?.type === 'comment_created');
      const anchor = event?.body?.anchor;
      if (!store || !anchor) return false;
      store.setCurrentFile(anchor.fileId);
      store.setCurrentSnapshot(anchor.snapshotId);
      store.panelOpen = true;
      return true;
    })()`,
  );
  await expect.poll(async () => (await nativeEval<string>('document.body.innerText')).includes(commentCanary)).toBe(true);

  await commentCard.getByRole('button', { name: 'Reply' }).click();
  await commentCard.locator('[data-slot="review-reply-composer"] textarea').fill(replyCanary);
  await commentCard.getByRole('button', { name: 'Send' }).click();
  await expect(commentCard.getByText(replyCanary, { exact: true })).toBeVisible();
  await expect.poll(async () => {
    const bodies = await nativeEventBodies();
    return bodies.some((body) => body.type === 'comment_created' && body.body === replyCanary);
  }).toBe(true);
  await expect.poll(async () => (await nativeEval<string>('document.body.innerText')).includes(replyCanary)).toBe(true);

  await selectEditorText(page, 'boundary marker');
  await page.locator('[data-slot="selection-toolbar-suggest"]').click();
  await page.locator('[data-slot="suggestion-composer-text"]').fill(suggestionCanary);
  await page.locator('[data-slot="suggestion-composer-note"]').fill('encrypted browser suggestion');
  await page.locator('[data-slot="suggestion-composer-submit"]').click();
  const suggestionCard = page
    .locator('[data-testid="review-margin-card"]')
    .filter({ hasText: suggestionCanary });
  await expect(suggestionCard).toBeVisible();
  await expect(suggestionCard.getByRole('button', { name: 'Accept' })).toHaveCount(0);
  await expect(suggestionCard.getByRole('button', { name: 'Reject' })).toHaveCount(0);
  await expect.poll(async () => {
    const bodies = await nativeEventBodies();
    return bodies.some((body) => {
      if (body.type !== 'suggestion_created') return false;
      const operation = body.operation as { replacement?: unknown } | undefined;
      return operation?.replacement === suggestionCanary;
    });
  }).toBe(true);
  await expect.poll(async () => (await nativeEval<string>('document.body.innerText')).includes(suggestionCanary)).toBe(true);
  await expect.poll(async () => (await nativeEval<string>('document.body.innerText')).includes('Accept')).toBe(true);

  await commentCard.getByRole('button', { name: 'Resolve' }).click();
  await expect.poll(async () => {
    const bodies = await nativeEventBodies();
    return bodies.some((body) => body.type === 'comment_resolved');
  }).toBe(true);
  await expect.poll(async () =>
    nativeEval<number>("document.querySelectorAll('[data-testid=review-margin-resolved-chip]').length"),
  ).toBeGreaterThan(0);

  const ipcCalls = await page.evaluate(
    () => (window as unknown as { __attnIpcCalls?: string[] }).__attnIpcCalls ?? [],
  );
  expect(ipcCalls).toEqual([]);

  const observedWire = capture.wire.join('\n');
  expect(observedWire).not.toContain(contentCanary);
  expect(observedWire).not.toContain(secretCanary!);
  expect(observedWire).not.toContain(commentCanary);
  expect(observedWire).not.toContain(replyCanary);
  expect(observedWire).not.toContain(suggestionCanary);
  expect(observedWire).not.toContain('encrypted browser suggestion');
  expect(capture.envelopePosts.every((post) => post.pow.length > 0)).toBe(true);
  await test.info().attach('captured-wire.txt', {
    body: Buffer.from(observedWire, 'utf8'),
    contentType: 'text/plain',
  });

  const browserPersistence = await page.evaluate(async () => ({
    localStorageKeys: Object.keys(localStorage),
    sessionStorageKeys: Object.keys(sessionStorage),
    indexedDbNames:
      typeof indexedDB.databases === 'function'
        ? (await indexedDB.databases()).map((database) => database.name ?? '')
        : [],
  }));
  expect(browserPersistence).toEqual({
    localStorageKeys: [],
    sessionStorageKeys: [],
    indexedDbNames: [],
  });
  expect(await context.cookies()).toEqual([]);

  // Fragment-only keys are intentionally memory-only. A refresh after the
  // synchronous replaceState must fail closed instead of recovering a key.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByText('Invalid invite link')).toBeVisible();
  await expect(page.getByText(contentCanary, { exact: false })).toHaveCount(0);
  const unexpectedBrowserErrors = capture.browserErrors.filter(
    (message) => !message.includes('net::ERR_INTERNET_DISCONNECTED'),
  );
  expect(unexpectedBrowserErrors).toEqual([]);
});
