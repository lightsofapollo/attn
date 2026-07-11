// Shared route→entry mapping for the unified hosted surface (attn-7xl.1.1).
//
// One origin serves three HTML entries with disjoint bundle graphs:
//
//   landing  /               → /index.html
//   app      /app, /open     → /app/index.html
//   review   /review/:roomId → /review/index.html
//
// This module is the single source of truth consumed by the Cloudflare
// worker (production rewrites), the Vite dev/preview middleware (local
// parity), and the app entry's client-side route parser. It must stay free
// of DOM, Svelte, and crypto imports so every consumer can load it.

export type HostedEntry = 'landing' | 'app' | 'review';

const REVIEW_PATH = /^\/review(?:\/|$)/u;
const APP_PATH = /^\/(?:app|open)(?:\/|$)/u;

/** Which HTML entry owns a request path. Unknown paths fall to the landing. */
export function hostedEntryForPath(pathname: string): HostedEntry {
  if (REVIEW_PATH.test(pathname)) return 'review';
  if (APP_PATH.test(pathname)) return 'app';
  return 'landing';
}

/** The built HTML document that serves a given entry. */
export function entryHtmlPath(entry: HostedEntry): string {
  switch (entry) {
    case 'review':
      return '/review/index.html';
    case 'app':
      return '/app/index.html';
    case 'landing':
      return '/index.html';
  }
}

/**
 * Canonical asset-request path for an entry's document. The Cloudflare assets
 * binding auto-redirects explicit `…/index.html` URLs to their directory form,
 * so the worker must rewrite deep navigations to these paths to avoid leaking
 * a visible 307 that would rewrite the address bar.
 */
export function entryRequestPath(entry: HostedEntry): string {
  switch (entry) {
    case 'review':
      return '/review/';
    case 'app':
      return '/app/';
    case 'landing':
      return '/';
  }
}

export type AppRoute =
  | { view: 'home' }
  | { view: 'storage' }
  | { view: 'open' }
  | { view: 'workspace'; workspaceId: string; filePath: string | undefined };

/**
 * Parse a deep path owned by the app entry. Workspaces are folder-shaped, so
 * everything after the workspace id is a normalized relative file path that
 * may contain nested segments (`/app/w/:workspaceId/docs/notes.md`).
 */
export function parseAppRoute(pathname: string): AppRoute | undefined {
  if (!APP_PATH.test(pathname)) return undefined;
  const segments = pathname.split('/').filter((segment) => segment.length > 0);
  if (segments[0] === 'open') return segments.length === 1 ? { view: 'open' } : undefined;
  if (segments.length === 1) return { view: 'home' };
  if (segments[1] === 'storage') return segments.length === 2 ? { view: 'storage' } : undefined;
  if (segments[1] === 'w' && segments.length >= 3) {
    let workspaceId: string;
    let fileSegments: string[];
    try {
      workspaceId = decodeURIComponent(segments[2]);
      fileSegments = segments.slice(3).map((segment) => decodeURIComponent(segment));
    } catch {
      return undefined;
    }
    if (fileSegments.some((segment) => segment === '.' || segment === '..')) return undefined;
    return {
      view: 'workspace',
      workspaceId,
      filePath: fileSegments.length > 0 ? fileSegments.join('/') : undefined,
    };
  }
  return undefined;
}
