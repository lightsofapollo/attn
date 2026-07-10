import { expect, test, type Page } from '@playwright/test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const inviteUrl = process.env.ATTN_BROWSER_INVITE_URL;
const contentCanary = process.env.ATTN_EXPECTED_CANARY ?? 'NARWHAL-TEAK-7429';
const secretCanary = process.env.ATTN_ROOM_SECRET_CANARY;
const commentCanary = process.env.ATTN_COMMENT_CANARY ?? 'BROWSER-COMMENT-8127';
const replyCanary = process.env.ATTN_REPLY_CANARY ?? 'BROWSER-REPLY-4631';
const suggestionCanary = process.env.ATTN_SUGGESTION_CANARY ?? 'BROWSER-SUGGEST-9054';
const r2Canary = process.env.ATTN_R2_CANARY ?? 'R2-BROWSER-SEALED-2048';
const directCanary = process.env.ATTN_DIRECT_CANARY ?? 'BROWSER-DIRECT-2718';
const nativeDirectCanary = process.env.ATTN_NATIVE_DIRECT_CANARY ?? 'NATIVE-DIRECT-1618';
const fallbackCanary = process.env.ATTN_FALLBACK_CANARY ?? 'BROWSER-FALLBACK-3141';
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

function wireUrl(raw: string): string {
  const url = new URL(raw);
  if (url.searchParams.has('cap')) url.searchParams.set('cap', '[redacted]');
  return url.href;
}

function attachWireCapture(page: Page): {
  wire: string[];
  deviceStatuses: number[];
  browserErrors: string[];
  envelopePosts: EnvelopePost[];
  requestUrls: string[];
  websocketUrls: string[];
} {
  const wire: string[] = [];
  const deviceStatuses: number[] = [];
  const browserErrors: string[] = [];
  const envelopePosts: EnvelopePost[] = [];
  const requestUrls: string[] = [];
  const websocketUrls: string[] = [];

  page.on('request', (request) => {
    requestUrls.push(request.url());
    wire.push(`HTTP ${request.method()} ${wireUrl(request.url())}\n${request.postData() ?? ''}`);
    if (/\/v2\/rooms\/[^/]+\/envelopes$/.test(new URL(request.url()).pathname)) {
      envelopePosts.push({
        body: request.postData() ?? '',
        pow: request.headers()['attn-pow'] ?? '',
      });
    }
  });
  page.on('response', (response) => {
    wire.push(`HTTP< ${response.status()} ${wireUrl(response.url())}`);
    if (/\/v2\/rooms\/[^/]+\/devices$/.test(new URL(response.url()).pathname)) {
      deviceStatuses.push(response.status());
    }
  });
  page.on('requestfailed', (request) => {
    wire.push(`HTTP! ${wireUrl(request.url())} ${request.failure()?.errorText ?? 'request failed'}`);
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

  return { wire, deviceStatuses, browserErrors, envelopePosts, requestUrls, websocketUrls };
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

test('missing, malformed, and wrong invite keys fail closed without relay contact', async ({ context }) => {
  test.skip(!inviteUrl, 'ATTN_BROWSER_INVITE_URL is required');
  test.skip(!secretCanary, 'ATTN_ROOM_SECRET_CANARY is required');

  const valid = new URL(inviteUrl!);
  const wrongSecret = `${secretCanary![0] === 'A' ? 'B' : 'A'}${secretCanary!.slice(1)}`;
  const cases = [
    { name: 'missing', url: `${valid.origin}${valid.pathname}` },
    { name: 'malformed', url: `${valid.origin}${valid.pathname}#key=not-base64url!` },
    { name: 'wrong', url: `${valid.origin}${valid.pathname}#key=${wrongSecret}` },
  ];

  for (const invalid of cases) {
    const page = await context.newPage();
    const capture = attachWireCapture(page);
    await page.goto(invalid.url, { waitUntil: 'domcontentloaded' });
    await expect.poll(() => new URL(page.url()).hash, { message: `${invalid.name} fragment stripped` })
      .toBe('');
    const error = page.locator('[data-slot="browser-review-error"]');
    await expect(error).toHaveAttribute('data-error-kind', 'invite_invalid');
    await expect(error.getByText('Invalid invite link', { exact: true })).toBeVisible();
    // Negative network assertions need a bounded settle window so a future
    // delayed bootstrap task cannot schedule relay work just after the error
    // UI renders and escape the capture below.
    await page.waitForTimeout(500);
    const visible = await error.textContent();
    expect(visible).not.toContain(secretCanary);
    expect(visible).not.toContain(wrongSecret);
    expect(
      capture.requestUrls.filter((url) => new URL(url).pathname.startsWith('/v2/rooms/')),
      `${invalid.name} invite must make no relay room request, including failed requests`,
    ).toEqual([]);
    expect(capture.deviceStatuses, `${invalid.name} invite must fail before relay registration`).toEqual([]);
    expect(
      capture.websocketUrls.filter((url) => /\/v2\/rooms\/[^/]+\/socket$/u.test(new URL(url).pathname)),
      `${invalid.name} invite must fail before relay WebSocket`,
    ).toEqual([]);
    expect(capture.browserErrors, `${invalid.name} invite should use the normal error UI`).toEqual([]);
    await page.close();
  }
});

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
    const NativePeerConnection = window.RTCPeerConnection;
    const peerConnections: RTCPeerConnection[] = [];
    const TrackedPeerConnection = function (configuration?: RTCConfiguration) {
      const peer = new NativePeerConnection(configuration);
      peerConnections.push(peer);
      return peer;
    } as unknown as typeof RTCPeerConnection;
    TrackedPeerConnection.prototype = NativePeerConnection.prototype;
    Object.defineProperty(window, 'RTCPeerConnection', { configurable: true, value: TrackedPeerConnection });
    (window as unknown as { __attnPeerConnections: RTCPeerConnection[] }).__attnPeerConnections = peerConnections;
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
  let browserDirectState: string | null = null;
  try {
    await expect(page.locator('[data-slot="browser-review"]')).toHaveAttribute(
      'data-connection',
      'live_direct',
    );
    browserDirectState = 'live_direct';
  } catch (error) {
    browserDirectState = await page.locator('[data-slot="browser-review"]').getAttribute('data-connection');
    const diagnostics = await page.evaluate(async () => {
      const peers = (window as unknown as { __attnPeerConnections?: RTCPeerConnection[] })
        .__attnPeerConnections ?? [];
      return Promise.all(peers.map(async (peer) => {
        const stats = [...(await peer.getStats()).values()]
          .filter((stat) => ['candidate-pair', 'local-candidate', 'remote-candidate', 'transport'].includes(stat.type))
          .map((stat) => ({
            type: stat.type,
            state: stat.state,
            candidateType: stat.candidateType,
            protocol: stat.protocol,
            localCandidateId: stat.localCandidateId,
            remoteCandidateId: stat.remoteCandidateId,
          }));
        return {
          connectionState: peer.connectionState,
          iceConnectionState: peer.iceConnectionState,
          iceGatheringState: peer.iceGatheringState,
          signalingState: peer.signalingState,
          stats,
        };
      }));
    });
    await test.info().attach('webrtc-diagnostics.json', {
      body: Buffer.from(JSON.stringify(diagnostics), 'utf8'),
      contentType: 'application/json',
    });
    console.log(`WebRTC diagnostics: ${JSON.stringify(diagnostics)}`);
    console.log(`WebRTC error: ${await page.locator('[data-slot="browser-review"]').getAttribute('data-direct-error')}`);
    throw error;
  }
  expect(browserDirectState).toBe('live_direct');
  await expect.poll(() => nativeEval<string>(
    'window.__attn_review_store__?.connection || "offline"',
  )).toBe('live_direct');
  await page.getByRole('button', { name: 'Hosted review canary' }).click();
  await expect(page.getByRole('heading', { name: 'Hosted review canary' })).toBeVisible();
  await expect(page.getByText(contentCanary, { exact: false })).toBeVisible();

  const taskCheckbox = page.locator('.task-list-item input[type="checkbox"]').first();
  await expect(taskCheckbox).toBeDisabled();
  await taskCheckbox.click({ force: true });
  await expect(taskCheckbox).not.toBeChecked();

  // A second ephemeral browser joins the same native-owned room. Its relay
  // WebSocket intentionally drops event frames after the direct mesh opens;
  // receiving the comment therefore proves the exact encrypted envelope also
  // traversed the `attn-review` DataChannel.
  const peerPage = await context.newPage();
  await peerPage.addInitScript(() => {
    let dropMailboxEvents = false;
    Object.defineProperty(window, '__attnDropMailboxEvents', {
      configurable: true,
      get: () => dropMailboxEvents,
      set: (value: boolean) => { dropMailboxEvents = value; },
    });
    const NativeWebSocket = window.WebSocket;
    class FilteringWebSocket extends NativeWebSocket {
      private forwardedMessage: ((this: WebSocket, ev: MessageEvent) => unknown) | null = null;
      override set onmessage(handler: ((this: WebSocket, ev: MessageEvent) => unknown) | null) {
        this.forwardedMessage = handler;
        super.onmessage = (event) => {
          if (dropMailboxEvents && typeof event.data === 'string') {
            try {
              const frame = JSON.parse(event.data) as { type?: string; envelope?: { kind?: string } };
              if (frame.type === 'envelope' && frame.envelope?.kind === 'event') return;
            } catch {
              // Non-JSON HMR/control traffic is forwarded unchanged.
            }
          }
          this.forwardedMessage?.call(this, event);
        };
      }
      override get onmessage(): ((this: WebSocket, ev: MessageEvent) => unknown) | null {
        return this.forwardedMessage;
      }
    }
    Object.defineProperty(window, 'WebSocket', { configurable: true, value: FilteringWebSocket });
  });
  await peerPage.goto(inviteUrl!, { waitUntil: 'domcontentloaded' });
  await expect(peerPage.locator('[data-slot="browser-review"]')).toHaveAttribute('data-authoring-ready', 'true');
  await peerPage.getByRole('button', { name: 'Hosted review canary' }).click();
  await expect(peerPage.getByText(contentCanary, { exact: false })).toBeVisible();
  await expect(peerPage.locator('[data-slot="browser-review"]')).toHaveAttribute('data-connection', 'live_direct');
  await expect(page.locator('[data-slot="browser-review"]')).toHaveAttribute('data-connection', 'live_direct');
  await peerPage.evaluate(() => {
    (window as unknown as { __attnDropMailboxEvents: boolean }).__attnDropMailboxEvents = true;
  });
  await selectEditorText(page, 'Read-only browser task');
  await page.locator('[data-slot="selection-toolbar-comment"]').click();
  await page.locator('.comment-composer textarea').fill(directCanary);
  await page.getByRole('button', { name: 'Submit' }).click();
  await expect(peerPage.locator('[data-testid="review-margin-card"]').filter({ hasText: directCanary })).toBeVisible();
  await expect.poll(async () => {
    const bodies = await nativeEventBodies();
    return bodies.some((body) => body.type === 'comment_created' && body.body === directCanary);
  }).toBe(true);
  const nativeCommentSent = await nativeEval<boolean>(
    `(() => {
      const store = window.__attn_review_store__;
      const root = store?.events.find(item => item.body?.type === 'comment_created' && item.body?.body === ${JSON.stringify(directCanary)});
      if (!root?.body?.anchor || !window.ipc?.postMessage) return false;
      window.ipc.postMessage(JSON.stringify({
        type: 'review_create_comment',
        token: window.__attn_ipc_token__,
        roomId: root.meta.roomId,
        anchor: root.body.anchor,
        body: ${JSON.stringify(nativeDirectCanary)}
      }));
      return true;
    })()`,
  );
  expect(nativeCommentSent).toBe(true);
  await expect(peerPage.locator('[data-testid="review-margin-card"]').filter({ hasText: nativeDirectCanary })).toBeVisible();
  // The direct-path proof is complete; keep this browser alive for the later
  // browser-to-browser suggestion parity check, but restore its mailbox event
  // stream so the intervening offline/reconnect sequence is not coupled to
  // DataChannel recovery timing.
  await peerPage.evaluate(() => {
    (window as unknown as { __attnDropMailboxEvents: boolean }).__attnDropMailboxEvents = false;
  });
  await expect(page.locator('[data-slot="browser-review"]')).toHaveAttribute('data-connection', 'live_direct');

  await page.getByRole('button', { name: 'Folder sibling canary' }).click();
  await expect(page.getByRole('heading', { name: 'Folder sibling canary' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Hosted review canary' })).toHaveCount(0);
  if (process.env.E2E_DEBUG_WIRE === '1') {
    await page.waitForTimeout(1_000);
    console.log(`R2 diagnostics:\n${capture.wire.filter((line) => line.includes('/blobs/')).join('\n')}\n${capture.browserErrors.join('\n')}`);
  }
  await page.getByRole('button', { name: 'R2 snapshot canary' }).click();
  await expect(page.getByText(/Large document loaded in safe mode/)).toBeVisible();
  await expect(page.getByText(r2Canary, { exact: false })).toBeVisible();
  await expect.poll(() => capture.wire.some((line) => /\/blobs\/[^?]+\?cap=/.test(line))).toBe(true);
  await page.getByRole('button', { name: 'Hosted review canary' }).click();
  await expect(page.getByRole('heading', { name: 'Hosted review canary' })).toBeVisible();
  await page.getByRole('button', { name: 'R2 snapshot canary' }).click();
  await expect(page.getByText(r2Canary, { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Hosted review canary' }).click();

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
  await expect(page.locator('[data-slot="browser-review"]')).toHaveAttribute('data-connection', 'live_direct');

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
  const peerSuggestionCard = peerPage
    .locator('[data-testid="review-margin-card"]')
    .filter({ hasText: suggestionCanary });
  await expect(peerSuggestionCard).toBeVisible();
  await expect(peerSuggestionCard.getByRole('button', { name: 'Accept' })).toHaveCount(0);
  await expect(peerSuggestionCard.getByRole('button', { name: 'Reject' })).toHaveCount(0);
  await peerPage.close();

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
  expect(observedWire).not.toContain(directCanary);
  expect(observedWire).not.toContain(nativeDirectCanary);
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

  // Re-open the invite and explicitly opt into encrypted local recovery.
  // This is intentionally separate from the default-mode proof above.
  await page.goto('about:blank');
  await page.goto(inviteUrl!, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('[data-slot="browser-review"]')).toHaveAttribute(
    'data-authoring-ready',
    'true',
  );
  await page.getByRole('button', { name: 'Hosted review canary' }).click();
  await expect(page.getByText(contentCanary, { exact: false })).toBeVisible();
  await page.locator('[data-slot="browser-remember-room"]').click();
  if (process.env.E2E_DEBUG_WIRE === '1') {
    await page.waitForTimeout(500);
    console.log(`Remember errors:\n${capture.browserErrors.join('\n')}`);
  }
  await expect(page.getByText(/^Remembered(?: on this browser|; browser may evict local data)$/)).toBeVisible();

  const rememberedAudit = await page.evaluate(async () => {
    const databaseName = 'attn-browser-review';
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(databaseName);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const names = Array.from(db.objectStoreNames);
      const transaction = db.transaction(names, 'readonly');
      const records: Record<string, unknown[]> = {};
      await Promise.all(names.map(async (name) => {
        records[name] = await new Promise<unknown[]>((resolve, reject) => {
          const request = transaction.objectStore(name).getAll();
          request.onsuccess = () => resolve(request.result as unknown[]);
          request.onerror = () => reject(request.error);
        });
      }));
      const rootRecord = (records.room_keys?.[0] ?? null) as { rootKey?: CryptoKey } | null;
      let exportRejected = false;
      if (rootRecord?.rootKey) {
        try {
          await crypto.subtle.exportKey('raw', rootRecord.rootKey);
        } catch {
          exportRejected = true;
        }
      }
      return {
        names,
        serialized: JSON.stringify(records),
        rootExtractable: rootRecord?.rootKey?.extractable ?? null,
        exportRejected,
        localStorageKeys: Object.keys(localStorage),
        sessionStorageKeys: Object.keys(sessionStorage),
      };
    } finally {
      db.close();
    }
  });
  expect(rememberedAudit.names).toContain('room_keys');
  expect(rememberedAudit.rootExtractable).toBe(false);
  expect(rememberedAudit.exportRejected).toBe(true);
  expect(rememberedAudit.localStorageKeys).toEqual([]);
  expect(rememberedAudit.sessionStorageKeys).toEqual([]);
  for (const plaintext of [
    contentCanary,
    directCanary,
    nativeDirectCanary,
    commentCanary,
    replyCanary,
    suggestionCanary,
    r2Canary,
    'encrypted browser suggestion',
    secretCanary!,
  ]) {
    expect(rememberedAudit.serialized).not.toContain(plaintext);
  }

  // The fragment is gone, so this reload can succeed only through the
  // non-extractable remembered key plus exact sealed envelope replay.
  const subscribeCountBeforeReload = capture.wire.filter((line) => line.startsWith('WS> ')).length;
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByText(/^Remembered(?: on this browser|; browser may evict local data)$/)).toBeVisible();
  await expect(page.locator('[data-slot="browser-review"]')).toHaveAttribute(
    'data-authoring-ready',
    'true',
  );
  await page.getByRole('button', { name: 'Hosted review canary' }).click();
  await expect(page.getByText(contentCanary, { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Folder sibling canary' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'R2 snapshot canary' })).toBeVisible();
  const recoveredSuggestion = page
    .locator('[data-testid="review-margin-card"]')
    .filter({ hasText: suggestionCanary });
  await expect(recoveredSuggestion).toBeVisible();
  await page.getByRole('button', { name: /Resolved comment by .* — view details/ }).click();
  const recoveredComment = page
    .locator('[data-testid="review-margin-card"][data-state="resolved"]')
    .filter({ hasText: commentCanary });
  await expect(recoveredComment).toContainText(replyCanary);
  await expect.poll(
    () => capture.wire.filter((line) => line.startsWith('WS> ')).length,
  ).toBeGreaterThan(subscribeCountBeforeReload);

  const allObservedWire = capture.wire.join('\n');
  for (const plaintext of [contentCanary, directCanary, nativeDirectCanary, commentCanary, replyCanary, suggestionCanary, r2Canary, secretCanary!]) {
    expect(allObservedWire).not.toContain(plaintext);
  }
  const unexpectedBrowserErrors = capture.browserErrors.filter(
    (message) => !message.includes('net::ERR_INTERNET_DISCONNECTED'),
  );
  expect(unexpectedBrowserErrors).toEqual([]);
});

test('forced WebRTC failure stays honest and converges through encrypted mailbox', async ({ page }) => {
  test.skip(!inviteUrl, 'ATTN_BROWSER_INVITE_URL is required');
  test.skip(!ownerHome || !attnBin, 'ATTN_OWNER_HOME and ATTN_BIN are required');
  await page.addInitScript(() => {
    class FailedDataChannel {
      readonly label = 'attn-review';
      readyState: RTCDataChannelState = 'connecting';
      binaryType: BinaryType = 'arraybuffer';
      onopen: (() => void) | null = null;
      onclose: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      close(): void { this.readyState = 'closed'; this.onclose?.(); }
      send(): void {}
    }
    class FailedPeerConnection {
      localDescription: RTCSessionDescriptionInit | null = null;
      remoteDescription: RTCSessionDescriptionInit | null = null;
      connectionState: RTCPeerConnectionState = 'new';
      iceConnectionState: RTCIceConnectionState = 'new';
      onicecandidate: ((event: RTCPeerConnectionIceEvent) => void) | null = null;
      ondatachannel: ((event: RTCDataChannelEvent) => void) | null = null;
      onconnectionstatechange: (() => void) | null = null;
      oniceconnectionstatechange: (() => void) | null = null;
      constructor() {
        setTimeout(() => this.failIce(), 10);
      }
      async createOffer(): Promise<RTCSessionDescriptionInit> { return { type: 'offer', sdp: 'v=0\r\n' }; }
      async createAnswer(): Promise<RTCSessionDescriptionInit> { return { type: 'answer', sdp: 'v=0\r\n' }; }
      async setLocalDescription(description: RTCSessionDescriptionInit): Promise<void> {
        this.localDescription = description;
      }
      async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
        this.remoteDescription = description;
      }
      async addIceCandidate(): Promise<void> {}
      createDataChannel(): RTCDataChannel {
        return new FailedDataChannel() as unknown as RTCDataChannel;
      }
      restartIce(): void { setTimeout(() => this.failIce(), 10); }
      close(): void { this.connectionState = 'closed'; }
      private failIce(): void {
        if (this.connectionState === 'closed') return;
        this.iceConnectionState = 'failed';
        this.connectionState = 'failed';
        this.oniceconnectionstatechange?.();
        this.onconnectionstatechange?.();
      }
    }
    Object.defineProperty(window, 'RTCPeerConnection', {
      configurable: true,
      value: FailedPeerConnection,
    });
  });
  const capture = attachWireCapture(page);
  await page.goto(inviteUrl!, { waitUntil: 'domcontentloaded' });
  const shell = page.locator('[data-slot="browser-review"]');
  await expect(shell).toHaveAttribute('data-authoring-ready', 'true');
  await expect(shell).toHaveAttribute('data-connection', 'direct_failed');
  await page.getByRole('button', { name: 'Hosted review canary' }).click();
  await expect(page.getByText(contentCanary, { exact: false })).toBeVisible();
  await selectEditorText(page, 'Shared by native');
  await page.locator('[data-slot="selection-toolbar-comment"]').click();
  await page.locator('.comment-composer textarea').fill(fallbackCanary);
  await page.getByRole('button', { name: 'Submit' }).click();
  await expect(shell).toHaveAttribute('data-outbox-pending', '0');
  await expect(page.locator('[data-testid="review-margin-card"]').filter({ hasText: fallbackCanary })).toBeVisible();
  await expect.poll(async () => {
    const bodies = await nativeEventBodies();
    return bodies.some((body) => body.type === 'comment_created' && body.body === fallbackCanary);
  }).toBe(true);
  const observedWire = capture.wire.join('\n');
  expect(observedWire).not.toContain(fallbackCanary);
  expect(capture.envelopePosts.some((post) => post.body.includes('"kind":"signal"'))).toBe(true);
  expect(capture.envelopePosts.some((post) => post.body.includes('"kind":"event"'))).toBe(true);
});
