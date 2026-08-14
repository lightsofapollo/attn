import { defineConfig, devices } from '@playwright/test';

// BrowserReviewApp lifecycle coverage needs a development server rather than
// the Worker build: a test-local /s/ capability is intentionally accepted only
// when Vite sets import.meta.env.DEV. Every case still mounts the real review
// entry and lets BrowserSession/the durable-share facade reach its own terminal
// state through an intercepted relay response.
export default defineConfig({
  testDir: './e2e',
  testMatch: 'browser-review-lifecycle.spec.ts',
  timeout: 60_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  reporter: [['list']],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: 'http://127.0.0.1:8798',
    headless: true,
    trace: 'off',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'npx vite --config vite.browser.config.ts --host 127.0.0.1 --port 8798 --strictPort',
    url: 'http://127.0.0.1:8798/',
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
