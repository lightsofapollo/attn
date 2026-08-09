import { defineConfig, devices } from '@playwright/test';

// The RAW BROWSER DEV LOOP (attn-bw2h.6).
//
// `vite.config.ts` serves the native frontend — `web/index.html` → `src/main.ts`
// → `src/App.svelte`. `task dev` points the wry webview at this same server, but
// opening it in an ordinary browser tab is a routine way to iterate on the UI,
// and that is the surface the share sheet was reported stuck on. There is no
// wry host there, so `installMockIpc()` stands in for the daemon.
//
// Deliberately NOT `playwright.routes.config.ts`: that one serves the HOSTED
// build (`vite.browser.config.ts` → `src/hosted/app/**`) through wrangler, whose
// share sheet is `ShareSheet.svelte` — a different component with a different
// transport. The two cannot share a config.
//
//   cd web && npx playwright test --config playwright.native-share.config.ts
const remoteBaseUrl = process.env.ATTN_NATIVE_SHARE_BASE_URL;
const PORT = 5176;

export default defineConfig({
  testDir: './e2e',
  // `browser-review-chrome.spec.ts` (attn-64iy) shares this config for the same
  // reason: it exercises the native frontend in an ordinary browser tab, which
  // is this config's whole subject.
  testMatch: [
    'native-share.spec.ts',
    'browser-review-chrome.spec.ts',
    'reading-palette.spec.ts',
  ],
  // The mint deadline is 15s and this suite waits it out on purpose, so the
  // per-test budget has to clear it with room for app boot.
  timeout: 90_000,
  expect: { timeout: 25_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  reporter: [['list']],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: remoteBaseUrl ?? `http://localhost:${PORT}`,
    headless: true,
    trace: 'off',
    screenshot: 'only-on-failure',
  },
  webServer: remoteBaseUrl
    ? undefined
    : {
        command: `npx vite --port ${PORT} --strictPort`,
        url: `http://localhost:${PORT}/`,
        reuseExistingServer: true,
        timeout: 120_000,
      },
});
