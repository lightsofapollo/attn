import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  // In CI the hosted suite runs everything on one box — Miniflare relay, Vite,
  // the native webview and several Chromium contexts — so a case can lose a
  // race it wins comfortably against a deployed environment. Observed locally:
  // three runs, three different assertions, none reproducible. Retry those.
  //
  // This cannot hide a real regression: a deterministic break fails every
  // attempt. It only absorbs contention. Locally retries stay off so a flake
  // is visible while you are looking at it (attn-6q7b).
  retries: process.env.CI ? 2 : 0,
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
