// Shared route→entry mapping for the unified hosted surface (attn-7xl.1.1).
//
// One origin serves three HTML entries with disjoint bundle graphs:
//
//   landing  /               → /index.html
//   app      /app, /open     → /app/index.html
//   review   /review/:roomId, /s/:shareId → /review/index.html
//
// This module is the single source of truth consumed by the Cloudflare
// worker (production rewrites), the Vite dev/preview middleware (local
// parity), and the app entry's client-side route parser. It must stay free
// of DOM, Svelte, and crypto imports so every consumer can load it.

import { normalizeEntryPath } from './entry-path';

export type HostedEntry = 'landing' | 'app' | 'review';

const SHARE_ID = /^[A-Za-z0-9_-]{22}$/u;
const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/**
 * The review document URL and the durable-share URL intentionally use
 * different identifiers. Room ids have a broad protocol envelope, while a
 * share id is exactly 16 canonical bytes (22 base64url characters).
 */
export type ReviewRoute =
  | { view: 'room'; roomId: string }
  | { view: 'share'; shareId: string };

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
export function entryRequestPath(entry: HostedEntry): '/' | '/app/' | '/review/' {
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
 * The desk's two URL intents live in the fragment, not the path: `/app#new`
 * asks for a fresh workspace, `/app#join` for the join-a-review panel.
 *
 * A caller must read this at the moment the surface that answers it mounts,
 * never from a copy taken at boot (attn-ze60.3). The desk unmounts when a
 * workspace opens and mounts again on the way back, so a boot-time snapshot
 * outlives the URL that justified it: the panel would reopen on a Back
 * navigation whose address bar says plain `/app`, having been closed — and the
 * hash removed — several screens earlier. The fragment is the only record that
 * stays honest, because closing the panel rewrites it.
 */
export function appHashIntent(hash: string): 'new' | 'join' | undefined {
  switch (hash) {
    case '#new':
      return 'new';
    case '#join':
      return 'join';
    default:
      return undefined;
  }
}

/**
 * Build the canonical URL for a workspace route (attn-1l2f.3).
 *
 * Every `/app/w/…` URL the app writes must come through here. Entry paths are
 * only constrained by `normalizeEntryPath`, which allows `#`, `?`, `%`, spaces
 * and unicode — all legal in a filename and all meaningful in a URL. Written
 * raw, `draft#1.md` becomes a fragment and `plan?.md` a query string, so a
 * reload or a copied link reopens the wrong document or none at all.
 *
 * `parseAppRoute` already decodes per segment, so this is the encoding half of
 * a round-trip that was previously only half-implemented.
 */
export function appWorkspaceUrl(workspaceId: string, filePath?: string): string {
  const base = `/app/w/${encodeURIComponent(workspaceId)}`;
  if (filePath === undefined || filePath.length === 0) return base;
  return `${base}/${filePath.split('/').map(encodeURIComponent).join('/')}`;
}

/**
 * Parse a deep path owned by the app entry. Workspaces are folder-shaped, so
 * everything after the workspace id is a normalized relative file path that
 * may contain nested segments (`/app/w/:workspaceId/docs/notes.md`).
 *
 * This parser is deliberately strict rather than treating every `/app/*`
 * spelling as the desk. A malformed URL must not open a plausible but wrong
 * local workspace; callers use `undefined` to render a proper not-found
 * recovery surface.
 */
export function parseAppRoute(pathname: string): AppRoute | undefined {
  if (pathname === '/open' || pathname === '/open/') return { view: 'open' };
  if (pathname === '/app' || pathname === '/app/') return { view: 'home' };
  if (pathname === '/app/storage' || pathname === '/app/storage/') return { view: 'storage' };

  const prefix = '/app/w/';
  if (!pathname.startsWith(prefix)) return undefined;
  const rawSegments = pathname.slice(prefix.length).split('/');
  // A trailing slash belongs to a workspace root only. File paths are stored
  // canonically, so `/path/to/file/` is a different, invalid spelling rather
  // than a route we silently repair.
  if (rawSegments.length === 2 && rawSegments[1] === '') rawSegments.pop();
  if (rawSegments.length === 0 || rawSegments.some((segment) => segment.length === 0)) return undefined;

  const workspaceId = decodeRouteSegment(rawSegments[0]);
  if (!workspaceId || workspaceId.length > 256 || workspaceId === '.' || workspaceId === '..') {
    return undefined;
  }
  if (rawSegments.length === 1) return { view: 'workspace', workspaceId, filePath: undefined };

  const fileSegments = rawSegments.slice(1).map(decodeRouteSegment);
  if (fileSegments.some((segment): segment is undefined => segment === undefined)) return undefined;
  try {
    return {
      view: 'workspace',
      workspaceId,
      filePath: normalizeEntryPath(fileSegments.join('/')),
    };
  } catch {
    return undefined;
  }
}

/** Parse a valid hosted review or durable-share locator, never a review state. */
export function parseReviewRoute(pathname: string): ReviewRoute | undefined {
  const room = /^\/review\/([A-Za-z0-9_-]{1,128})\/?$/u.exec(pathname);
  if (room) return { view: 'room', roomId: room[1]! };

  const share = /^\/s\/([A-Za-z0-9_-]{22})$/u.exec(pathname);
  if (share && isCanonicalShareId(share[1]!)) return { view: 'share', shareId: share[1]! };

  return undefined;
}

/**
 * Which document owns a path. `undefined` is intentional: callers must
 * return a 404 rather than silently substituting an unrelated product shell.
 */
export function hostedEntryForPath(pathname: string): HostedEntry | undefined {
  if (pathname === '/' || pathname === '/index.html' || /^\/homepage-alt\/?$/u.test(pathname)) {
    return 'landing';
  }
  if (parseAppRoute(pathname)) return 'app';
  if (parseReviewRoute(pathname)) return 'review';
  return undefined;
}

function decodeRouteSegment(raw: string): string | undefined {
  try {
    const decoded = decodeURIComponent(raw);
    // A percent-encoded path separator creates an ambiguous URL spelling.
    // Route boundaries must remain visible in the URL itself.
    if (decoded.length === 0 || /[\u0000-\u001f\u007f\\/]/u.test(decoded)) return undefined;
    return decoded;
  } catch {
    return undefined;
  }
}

function isCanonicalShareId(value: string): boolean {
  if (!SHARE_ID.test(value)) return false;
  const final = BASE64URL_ALPHABET.indexOf(value.at(-1)!);
  // 16 bytes leave four unused low bits in their 22nd base64url character.
  return final >= 0 && (final & 0x0f) === 0;
}
