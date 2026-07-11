import { defineConfig, devices } from '@playwright/test';

// Routing, shell, and accessibility validation for the unified hosted
// surface (attn-7xl.1.1/.3/.5). By default this runs the real Cloudflare
// worker (rewrites + headers) via `wrangler dev` against the built
// dist-browser output — invoke through `npm run test:e2e:routes`, which
// builds dist-browser first. Set ATTN_ROUTES_BASE_URL to run the same suite
// against a deployed origin (e.g. https://staging.attn.sh).
const remoteBaseUrl = process.env.ATTN_ROUTES_BASE_URL;

export default defineConfig({
  testDir: './e2e',
  testMatch: ['hosted-routes.spec.ts', 'hosted-shells.spec.ts', 'hosted-a11y.spec.ts'],
  timeout: 60_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  reporter: [['list']],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: remoteBaseUrl ?? 'http://127.0.0.1:8797',
    headless: true,
    trace: 'off',
    screenshot: 'only-on-failure',
  },
  webServer: remoteBaseUrl
    ? undefined
    : {
        command: 'npx wrangler dev --config wrangler.jsonc --port 8797',
        url: 'http://127.0.0.1:8797/',
        reuseExistingServer: true,
        timeout: 120_000,
      },
});
