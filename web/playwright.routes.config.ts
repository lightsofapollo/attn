import { defineConfig, devices } from '@playwright/test';

// Routing smoke for the unified hosted surface (attn-7xl.1.1). Runs the real
// Cloudflare worker (rewrites + headers) via `wrangler dev` against the built
// dist-browser output. Invoke through `npm run test:e2e:routes`, which builds
// dist-browser first.
export default defineConfig({
  testDir: './e2e',
  testMatch: ['hosted-routes.spec.ts', 'hosted-shells.spec.ts'],
  timeout: 60_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  reporter: [['list']],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: 'http://127.0.0.1:8797',
    headless: true,
    trace: 'off',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'npx wrangler dev --config wrangler.jsonc --port 8797',
    url: 'http://127.0.0.1:8797/',
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
