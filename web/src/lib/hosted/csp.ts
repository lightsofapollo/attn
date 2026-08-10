// Content-Security-Policy for the hosted surface (attn-7xl.1.4).
//
// The policy is pinned except for the relay origin, which differs between
// staging (relay-staging.attn.sh) and production (relay.attn.sh) and is
// injected via the worker's RELAY_ORIGIN var. Everything else stays
// deliberately closed: no third-party scripts, analytics, or remote assets.

import { THEME_PREFLIGHT_SHA256 } from './theme-preflight';

const HTTPS_ORIGIN = /^https:\/\/[a-z0-9.-]+$/u;

export function buildContentSecurityPolicy(
  relayOrigin: string,
  frameAncestors: "'none'" | "'self'" = "'none'",
): string {
  if (!HTTPS_ORIGIN.test(relayOrigin)) {
    throw new Error(`relay origin must be a bare https origin: ${relayOrigin}`);
  }
  const relayWs = relayOrigin.replace('https:', 'wss:');
  return [
    "default-src 'none'",
    "base-uri 'none'",
    `connect-src 'self' ${relayOrigin} ${relayWs}`,
    "font-src 'self' data:",
    "form-action 'none'",
    `frame-ancestors ${frameAncestors}`,
    "frame-src 'self' blob: data:",
    "img-src 'self' blob: data:",
    "manifest-src 'self'",
    "media-src 'self' blob: data:",
    "object-src 'none'",
    // The checked-in Rust/comrak anchor index is loaded as WebAssembly when a
    // browser owner publishes Markdown. Permit only Wasm compilation; keep
    // string-to-code JavaScript evaluation disabled.
    //
    // The one inline script is the pre-paint theme stamp (attn-n01r.22),
    // admitted by source hash rather than by a nonce: a hash permits exactly
    // those bytes and nothing else, so it cannot be reused by injected markup.
    // csp.test.ts recomputes the hash from THEME_PREFLIGHT_SCRIPT and fails if
    // the two drift.
    `script-src 'self' 'wasm-unsafe-eval' '${THEME_PREFLIGHT_SHA256}'`,
    "style-src 'self' 'unsafe-inline'",
    "worker-src 'self'",
  ].join('; ');
}

/**
 * The unified origin has no `www` (product decision #1: one origin). Returns
 * the apex URL a `www.` request must 308 to, or undefined when the host is
 * already canonical.
 */
export function apexRedirectTarget(url: URL): string | undefined {
  if (!url.hostname.startsWith('www.')) return undefined;
  const target = new URL(url.toString());
  target.hostname = url.hostname.slice('www.'.length);
  return target.toString();
}
