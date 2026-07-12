import { defineConfig, devices } from '@playwright/test';

// Real-browser persistence validation for workspace storage v3
// (attn-7xl.2.7): Chromium and WebKit exercise the actual IndexedDB, OPFS,
// and WebCrypto implementations through the Vite dev server's TS transform.
// Run via `npm run test:e2e:storage`.
export default defineConfig({
  testDir: './e2e',
  testMatch: [
    'hosted-storage.spec.ts',
    'hosted-reader.spec.ts',
    'hosted-lease-handoff.spec.ts',
  ],
  timeout: 90_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5197',
    headless: true,
    trace: 'off',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  webServer: {
    command: 'npm run dev:browser -- --port 5197 --strictPort',
    url: 'http://localhost:5197/',
    reuseExistingServer: true,
    timeout: 180_000,
  },
});
