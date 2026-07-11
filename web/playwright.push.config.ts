import { defineConfig, devices } from '@playwright/test';

const relayOrigin = 'http://127.0.0.1:8799';

export default defineConfig({
  testDir: './e2e',
  testMatch: 'browser-push.spec.ts',
  timeout: 90_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  reporter: [['list']],
  use: { baseURL: 'http://127.0.0.1:8798', headless: true, trace: 'off' },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
  ],
  webServer: [{
      command: `ATTN_PUSH_E2E=1 VITE_ATTN_RELAY_URL=${relayOrigin} npm run build:browser && npx vite preview --config vite.browser.config.ts --host 127.0.0.1 --port 8798`,
      url: 'http://127.0.0.1:8798/', reuseExistingServer: false, timeout: 120_000,
    }, {
      command: `cd ../relay && npx wrangler dev --local --port 8799 --var ALLOWED_BROWSER_ORIGINS:http://127.0.0.1:8798 --var QUOTA_ALLOW_UNATTRIBUTED_CREATES:true --var TEST_PUSH_ENDPOINT_ORIGIN:http://127.0.0.1:8800 --var VAPID_PUBLIC_KEY:BKOaMoQCJMzoFLApwG1J8FvD2rB3JECjlJ_ZU2qhp4tUGJSfB2Z-5OI6wxAVDd2DilYJoXLRkN0bOSDRA32s7HI --var VAPID_SUBJECT:mailto:relay-tests@attn.sh --var VAPID_PRIVATE_JWK:'{"kty":"EC","x":"o5oyhAIkzOgUsCnAbUnwW8PasHckQKOUn9lTaqGni1Q","y":"GJSfB2Z-5OI6wxAVDd2DilYJoXLRkN0bOSDRA32s7HI","crv":"P-256","d":"5jxhim-klclQknmN_V_qLFPmXvv7TUAkwzxGE9-mDyA"}'`,
      url: 'http://127.0.0.1:8799/health', reuseExistingServer: false, timeout: 120_000,
    }],
});
