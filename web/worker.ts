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
// their entry's HTML document. Unknown browser navigations instead borrow the
// landing document solely to render its branded recovery state, then retain a
// real 404 status. Hashed build assets are never shadowed by either behavior.
function rewriteToEntryDocument(request: Request): { request: Request; notFound: boolean } {
  if (request.method !== 'GET' && request.method !== 'HEAD') return { request, notFound: false };
  const url = new URL(request.url);
  const entry = hostedEntryForPath(url.pathname);
  if (!entry) {
    // Asset and API requests keep the asset binding's ordinary 404. A direct
    // document navigation gets the branded page without pretending it exists.
    if (!request.headers.get('accept')?.includes('text/html')) return { request, notFound: false };
    url.pathname = entryRequestPath('landing');
    url.search = '';
    return { request: new Request(url.toString(), request), notFound: true };
  }
  const canonical = entryRequestPath(entry);
  if (url.pathname === canonical) return { request, notFound: false };
  url.pathname = canonical;
  url.search = '';
  return { request: new Request(url.toString(), request), notFound: false };
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
    const rewrite = rewriteToEntryDocument(request);
    const response = await env.ASSETS.fetch(rewrite.request);
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
    /* The alternate homepage is a positioning study, not a shipping surface
       (attn-n01r.38). It carries <meta name="robots" content="noindex"> in
       svelte:head, but that is rendered client-side, so a crawler that does not
       execute JS never sees it — and routes.ts's fallback means the path is
       served to anyone who guesses it. An origin header does not depend on the
       bundle running. */
    if (requestUrl.pathname === '/homepage-alt' || requestUrl.pathname === '/homepage-alt/') {
      headers.set('X-Robots-Tag', 'noindex, nofollow');
    }
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
      status: rewrite.notFound ? 404 : response.status,
      statusText: rewrite.notFound ? 'Not Found' : response.statusText,
      headers,
    });
  },
};
