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
    // Native webrtc-rs does not resolve Chromium's ephemeral `.local` host
    // candidates. Expose loopback/LAN host candidates in this isolated E2E
    // browser so the STUN-only native↔browser path is exercised even when the
    // public STUN service is unreachable from CI.
    launchOptions: { args: ['--disable-features=WebRtcHideLocalIpsWithMdns'] },
    // Invite URLs carry the room secret in the fragment. Playwright traces
    // record navigation arguments, so this spec must never retain a trace.
    trace: 'off',
    screenshot: 'only-on-failure',
  },
});
