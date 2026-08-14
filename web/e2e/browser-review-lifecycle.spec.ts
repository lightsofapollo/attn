import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type WebSocketRoute } from '@playwright/test';

// These are intentionally synthetic *capabilities*, not a canned session
// state. The review app parses them, derives scoped keys, performs its
// authenticated bootstrap request, and opens its ordinary WebSocket before the
// test relay returns the terminal condition. The browser never reaches an
// authenticated document state, so there is no forged review content or owner
// identity in this fixture.
const ROOM_ID = 'review-lifecycle-terminal';
const READ_CAPABILITY = Buffer.alloc(32, 0x5a).toString('base64url');
const SHARE_ID = Buffer.alloc(16, 0x34).toString('base64url');
const SHARE_LINK_SECRET = Buffer.alloc(32, 0x27).toString('base64url');

const POLICY = {
  mode: 'async',
  maxPeers: 4,
  maxSnapshotBytes: 1_048_576,
  maxEventBytes: 131_072,
  maxEvents: 100,
  expiresAt: Date.now() + 86_400_000,
  powBits: 12,
  deleteEventsAfterOwnerAck: false,
  allowBrowser: true,
  allowRemoteAgents: false,
};

function viewInvite(): string {
  return `/review/${ROOM_ID}#v=3&tier=view&read=${READ_CAPABILITY}`;
}

async function installRoomBootstrap(page: Page): Promise<void> {
  await page.route('**/v3/rooms/**/devices', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fulfill({ status: 405, body: 'view capability never registers a device' });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ policy: POLICY, devices: [] }),
    });
  });
}

async function installTerminalSocket(
  page: Page,
  code: number,
  reason: string,
): Promise<void> {
  await page.routeWebSocket(/\/v3\/rooms\/[^/]+\/socket/u, async (socket: WebSocketRoute) => {
    // The mocked endpoint opens like an ordinary routed WebSocket; wait one
    // turn so BrowserWsClient has installed its close handler before closing.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    if (code === 4005) {
      // Cursor expiry is intentionally announced with a typed error frame
      // before the 4005 close. BrowserWsClient maps that immediately so a
      // reviewer can recover without waiting for close/reconnect timing.
      socket.send(JSON.stringify({ type: 'error', code: 'ATTN_CURSOR_TOO_OLD', resyncFromSeq: 0 }));
      return;
    }
    await socket.close({ code, reason });
  });
}

async function expectNoAxeViolations(page: Page, context: string): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(
    results.violations.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      targets: violation.nodes.map((node) => node.target.join(' ')).slice(0, 5),
    })),
    `axe violations on ${context}`,
  ).toEqual([]);
}

async function expectErrorState(
  page: Page,
  expected: { kind: string; heading: string },
): Promise<void> {
  const error = page.locator('[data-slot="browser-review-error"]');
  await expect(error).toHaveAttribute('data-error-kind', expected.kind);
  await expect(error.getByRole('heading', { name: expected.heading })).toBeVisible();
  // Each terminal state keeps a visible privacy reassurance, but its precise
  // wording intentionally differs when no review material was ever opened.
  await expect(error.locator('section > p').nth(2)).not.toBeEmpty();
  await expect(error.getByRole('link', { name: 'Your Desk' })).toHaveAttribute('href', '/app');
  await expect(error.getByRole('link', { name: 'attn home' })).toHaveAttribute('href', '/');
}

test('missing or malformed capability stays in the branded recovery surface on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => localStorage.setItem('attn-theme', 'dark'));
  await page.goto(`/review/${ROOM_ID}`);

  await expectErrorState(page, {
    kind: 'invite_invalid',
    heading: 'This review link is incomplete',
  });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

  // The recovery path is keyboard-operable and takes focus directly into its
  // only transient text field; an invalid paste reports an accessible error
  // without exposing the capability in page text or an error message.
  const recover = page.getByRole('button', { name: 'Paste complete link' });
  await recover.focus();
  await page.keyboard.press('Enter');
  const input = page.getByRole('textbox', { name: 'Complete review link' });
  await expect(input).toBeFocused();
  await input.fill('https://example.test/not-a-review');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('alert')).toHaveText('Paste the complete attn review link, including the part after #.');

  const geometry = await page.locator('[data-slot="browser-review-error"] a, [data-slot="browser-review-error"] button')
    .evaluateAll((elements) => elements.map((element) => {
      const rect = element.getBoundingClientRect();
      return { label: element.textContent?.trim() ?? '', width: rect.width, height: rect.height };
    }));
  for (const control of geometry) {
    expect(control.height, `${control.label} needs a 44px touch target`).toBeGreaterThanOrEqual(44);
  }
  await expectNoAxeViolations(page, 'mobile invalid review capability');
});

for (const terminal of [
  { code: 4000, kind: 'admission_rejected', heading: 'This link no longer has access' },
  { code: 4001, kind: 'room_deleted', heading: 'This review is no longer available' },
  { code: 4002, kind: 'room_expired', heading: 'This review link has expired' },
  { code: 4005, kind: 'cursor_too_old', heading: 'Open this review from its original link' },
] as const) {
  test(`real reviewer transport close ${terminal.code} renders ${terminal.kind}`, async ({ page }) => {
    await installRoomBootstrap(page);
    await installTerminalSocket(page, terminal.code, `test ${terminal.kind}`);
    await page.goto(viewInvite());

    await expectErrorState(page, terminal);
    if (terminal.kind === 'cursor_too_old') {
      await expect(page.getByRole('button', { name: 'Paste complete link' })).toBeVisible();
    } else {
      await expect(page.getByRole('button', { name: 'Paste complete link' })).toHaveCount(0);
    }
  });
}

test('relay bootstrap failure presents a retryable, non-leaking connection state', async ({ page }) => {
  await page.route('**/v3/rooms/**/devices', (route) => route.abort('failed'));
  await page.goto(viewInvite());

  await expectErrorState(page, {
    kind: 'device_register',
    heading: 'Attn could not finish opening this review',
  });
  const retry = page.getByRole('button', { name: 'Retry connection' });
  await retry.focus();
  await expect(retry).toBeFocused();
  await expectNoAxeViolations(page, 'review bootstrap failure');
});

test('a real durable-share 404 renders the revoked terminal state', async ({ page }) => {
  await page.route('**/v3/shares/**', async (route) => {
    await route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
  });
  await page.goto(`/s/${SHARE_ID}#key=${SHARE_LINK_SECRET}`);

  await expectErrorState(page, {
    kind: 'share_revoked',
    heading: 'This review has ended',
  });
  await expect(page.getByRole('button', { name: 'Retry connection' })).toHaveCount(0);
});

test('an unavailable durable-share relay renders the retryable offline state', async ({ page }) => {
  await page.route('**/v3/shares/**', (route) => route.abort('failed'));
  await page.goto(`/s/${SHARE_ID}#key=${SHARE_LINK_SECRET}`);

  await expectErrorState(page, {
    kind: 'network',
    heading: 'Attn could not reach this review',
  });
  const retry = page.getByRole('button', { name: 'Retry connection' });
  await retry.focus();
  await expect(retry).toBeFocused();
});
