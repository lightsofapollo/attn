import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  reporter: [['list']],
  use: {
    ...devices['Desktop Chrome'],
    headless: true,
    // Invite URLs carry the room secret in the fragment. Playwright traces
    // record navigation arguments, so this spec must never retain a trace.
    trace: 'off',
    screenshot: 'only-on-failure',
  },
});
