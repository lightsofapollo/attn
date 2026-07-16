// Public review-origin policy for the hosted owner shell. This stays outside
// lib/review so the mock shell can choose honest demo URLs without pulling any
// review protocol code into the app entry's static bundle.

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const PRODUCTION_RELAY_ORIGIN = 'https://relay.attn.sh';
const PRODUCTION_REVIEW_BASE = 'https://attn.sh/review';
const STAGING_RELAY_ORIGIN = 'https://relay-staging.attn.sh';
const STAGING_REVIEW_BASE = 'https://staging.attn.sh/review';

/**
 * Keep the public invite origin paired with the relay that stores the room.
 *
 * An ordinary localhost dev server has no public review origin of its own, so
 * it uses staging by default. Explicit loopback relay configurations (the
 * local-share and E2E commands) intentionally keep their links on localhost.
 */
export function resolveBrowserReviewBase(
  configuredShareOrigin: string | undefined,
  configuredRelayUrl: string | undefined,
  browserOrigin: string | undefined,
): string {
  if (configuredShareOrigin !== undefined && configuredShareOrigin.length > 0) {
    return `${new URL(configuredShareOrigin).origin}/review`;
  }
  if (browserOrigin === undefined) return PRODUCTION_REVIEW_BASE;

  const browser = new URL(browserOrigin);
  if (!LOOPBACK_HOSTS.has(browser.hostname)) return `${browser.origin}/review`;

  if (configuredRelayUrl !== undefined && configuredRelayUrl.length > 0) {
    const relay = new URL(configuredRelayUrl).origin;
    if (relay === STAGING_RELAY_ORIGIN) return STAGING_REVIEW_BASE;
    if (relay === PRODUCTION_RELAY_ORIGIN) return PRODUCTION_REVIEW_BASE;
    return `${browser.origin}/review`;
  }

  return STAGING_REVIEW_BASE;
}
