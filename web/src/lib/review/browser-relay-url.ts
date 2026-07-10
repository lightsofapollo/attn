// Relay URL policy for the hosted browser reviewer.
//
// Production review traffic must use HTTPS/WSS. Plain HTTP is accepted only
// for an exact loopback hostname so local development and E2E tests can run
// without weakening a deployed build.

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export class BrowserRelayUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrowserRelayUrlError';
  }
}

/** Validate and normalize a relay base URL to an origin (without `/`). */
export function validateBrowserRelayUrl(raw: string | undefined): string {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new BrowserRelayUrlError('VITE_ATTN_RELAY_URL is required');
  }
  if (raw.trim() !== raw) {
    throw new BrowserRelayUrlError('relay URL must not contain surrounding whitespace');
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BrowserRelayUrlError('relay URL is not a valid absolute URL');
  }

  if (url.username || url.password) {
    throw new BrowserRelayUrlError('relay URL must not include credentials');
  }
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new BrowserRelayUrlError('relay URL must be an origin without a path, query, or fragment');
  }
  if (url.protocol === 'https:') return url.origin;
  if (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname)) return url.origin;

  throw new BrowserRelayUrlError('relay URL must use HTTPS (HTTP is loopback-only)');
}
