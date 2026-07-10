interface StaticAssets {
  fetch(request: Request): Promise<Response>;
}

interface Env {
  ASSETS: StaticAssets;
}

const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "base-uri 'none'",
  "connect-src 'self' https://relay-staging.attn.sh wss://relay-staging.attn.sh",
  "font-src 'self' data:",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "frame-src 'self' blob: data:",
  "img-src 'self' blob: data:",
  "manifest-src 'self'",
  "media-src 'self' blob: data:",
  "object-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "worker-src 'self'",
].join('; ');

const IMMUTABLE_ASSET = /\/[\w-]+-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const response = await env.ASSETS.fetch(request);
    const headers = new Headers(response.headers);

    headers.set('Content-Security-Policy', CONTENT_SECURITY_POLICY);
    headers.set('Cross-Origin-Opener-Policy', 'same-origin');
    headers.set('Cross-Origin-Resource-Policy', 'same-origin');
    headers.set('Permissions-Policy', 'camera=(), geolocation=(), microphone=(), payment=(), usb=()');
    headers.set('Referrer-Policy', 'no-referrer');
    headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('X-Frame-Options', 'DENY');

    const pathname = new URL(request.url).pathname;
    if (response.headers.get('content-type')?.includes('text/html')) {
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
