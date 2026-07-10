import { expect, test, type Page } from '@playwright/test';

const inviteUrl = process.env.ATTN_BROWSER_INVITE_URL;
const contentCanary = process.env.ATTN_EXPECTED_CANARY ?? 'NARWHAL-TEAK-7429';
const secretCanary = process.env.ATTN_ROOM_SECRET_CANARY;

function frameText(payload: string | Buffer): string {
  return typeof payload === 'string' ? payload : payload.toString('utf8');
}

function attachWireCapture(page: Page): {
  wire: string[];
  deviceStatuses: number[];
  browserErrors: string[];
} {
  const wire: string[] = [];
  const deviceStatuses: number[] = [];
  const browserErrors: string[] = [];

  page.on('request', (request) => {
    wire.push(`HTTP ${request.method()} ${request.url()}\n${request.postData() ?? ''}`);
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
    wire.push(`WS ${socket.url()}`);
    socket.on('framesent', ({ payload }) => wire.push(`WS> ${frameText(payload)}`));
    socket.on('framereceived', ({ payload }) => wire.push(`WS< ${frameText(payload)}`));
  });
  page.on('pageerror', (error) => browserErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(message.text());
  });

  return { wire, deviceStatuses, browserErrors };
}

test('native share opens in hosted reviewer without leaking plaintext or keys', async ({
  page,
  context,
}) => {
  test.skip(!inviteUrl, 'ATTN_BROWSER_INVITE_URL is required');
  test.skip(!secretCanary, 'ATTN_ROOM_SECRET_CANARY is required');

  const capture = attachWireCapture(page);
  await page.goto(inviteUrl!, { waitUntil: 'domcontentloaded' });

  await expect.poll(() => new URL(page.url()).hash).toBe('');
  await page.waitForTimeout(750);
  await test.info().attach('bootstrap-diagnostics.txt', {
    body: Buffer.from(
      `${capture.wire.join('\n')}\n\nBrowser errors:\n${capture.browserErrors.join('\n')}`,
      'utf8',
    ),
    contentType: 'text/plain',
  });
  await expect.poll(() => capture.deviceStatuses.some((status) => status === 200 || status === 204)).toBe(true);
  await expect.poll(() => capture.wire.some((line) => line.startsWith('WS< '))).toBe(true);
  await test.info().attach('captured-wire.txt', {
    body: Buffer.from(capture.wire.join('\n'), 'utf8'),
    contentType: 'text/plain',
  });
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

  const observedWire = capture.wire.join('\n');
  expect(observedWire).not.toContain(contentCanary);
  expect(observedWire).not.toContain(secretCanary!);

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

  // The hosted receiver must not present controls that silently route through
  // native Wry IPC before the encrypted browser outbox exists.
  await expect(page.getByRole('button', { name: /resolve|accept|reject|comment/i })).toHaveCount(0);

  // Fragment-only keys are intentionally memory-only. A refresh after the
  // synchronous replaceState must fail closed instead of recovering a key.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByText('Invalid invite link')).toBeVisible();
  await expect(page.getByText(contentCanary, { exact: false })).toHaveCount(0);
  expect(capture.browserErrors).toEqual([]);
});
