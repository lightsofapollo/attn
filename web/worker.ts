import { buildContentSecurityPolicy, apexRedirectTarget } from './src/lib/hosted/csp';
import { entryRequestPath, hostedEntryForPath } from './src/lib/hosted/routes';

interface StaticAssets {
  fetch(request: Request): Promise<Response>;
}

interface Env {
  ASSETS: StaticAssets;
  /** Relay origin allowed by connect-src; set per environment in wrangler
   * config (staging: relay-staging.attn.sh, production: relay.attn.sh). */
  RELAY_ORIGIN: string;
}

const IMMUTABLE_ASSET = /\/[\w-]+-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/;

// Deep paths (`/app/w/:workspaceId/:filePath`, `/review/:roomId`) must serve
// their entry's HTML document rather than fall through the SPA handler, which
// only knows about the landing `index.html`. Hashed build assets live under
// `/assets/` and are never shadowed by these route prefixes.
function rewriteToEntryDocument(request: Request): Request {
  if (request.method !== 'GET' && request.method !== 'HEAD') return request;
  const url = new URL(request.url);
  const entry = hostedEntryForPath(url.pathname);
  if (entry === 'landing') return request;
  const canonical = entryRequestPath(entry);
  if (url.pathname === canonical) return request;
  url.pathname = canonical;
  url.search = '';
  return new Request(url.toString(), request);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // One origin, no `www` (product decision #1). Fragments — including
    // invite `#key=…` secrets — never reach the server and are reattached by
    // the browser across this redirect.
    const apexTarget = apexRedirectTarget(new URL(request.url));
    if (apexTarget) return Response.redirect(apexTarget, 308);

    const requestUrl = new URL(request.url);
    const landingReviewDemo =
      requestUrl.pathname === '/app'
      && requestUrl.searchParams.get('surface') === 'landing-review-demo';
    const response = await env.ASSETS.fetch(rewriteToEntryDocument(request));
    const headers = new Headers(response.headers);

    headers.set(
      'Content-Security-Policy',
      buildContentSecurityPolicy(env.RELAY_ORIGIN, landingReviewDemo ? "'self'" : "'none'"),
    );
    headers.set('Cross-Origin-Opener-Policy', 'same-origin');
    headers.set('Cross-Origin-Resource-Policy', 'same-origin');
    headers.set('Permissions-Policy', 'camera=(), geolocation=(), microphone=(), payment=(), usb=()');
    headers.set('Referrer-Policy', 'no-referrer');
    headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('X-Frame-Options', landingReviewDemo ? 'SAMEORIGIN' : 'DENY');

    const pathname = new URL(request.url).pathname;
    if (pathname === '/sw.js') {
      // The service worker must revalidate on every check so new versions
      // activate promptly.
      headers.set('Cache-Control', 'no-cache, no-transform');
    } else if (response.headers.get('content-type')?.includes('text/html')) {
      // `no-transform` prevents zone-level Browser Insights/Web Analytics
      // from injecting a third-party beacon into this zero-analytics surface.
      headers.set('Cache-Control', 'no-store, no-transform');
    } else if (IMMUTABLE_ASSET.test(pathname)) {
      headers.set('Cache-Control', 'public, max-age=31536000, immutable');
    }

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  },
};
