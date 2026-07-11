// attn service worker (attn-7xl.6.2). Built by vite.sw.config.ts into the
// stable, unhashed `/sw.js`. All caching decisions live in the unit-tested
// policy module — this file is plumbing only.
//
// Contract: cache-first for immutable hashed assets, network-first for
// navigations with the last-known entry shell as offline fallback, versioned
// caches cleaned on activate, and nothing else ever cached — no user
// content, no room APIs, no query-string URLs, no error payloads.

/// <reference lib="webworker" />

import {
  ASSET_CACHE,
  SHELL_CACHE,
  decideFetch,
  mayCacheAssetResponse,
  mayCacheShellResponse,
} from '../../lib/hosted/sw-policy';

declare const self: ServiceWorkerGlobalScope & typeof globalThis;

const SHELL_PATHS: Array<'/' | '/app/' | '/review/'> = ['/', '/app/', '/review/'];
const CURRENT_CACHES = new Set([SHELL_CACHE, ASSET_CACHE]);

self.addEventListener('install', (event: ExtendableEvent) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // Best-effort priming; navigations refresh these copies on success.
      await Promise.all(
        SHELL_PATHS.map(async (path) => {
          try {
            const response = await fetch(path, { cache: 'no-store' });
            if (
              mayCacheShellResponse({
                ok: response.ok,
                status: response.status,
                type: response.type,
                contentType: response.headers.get('content-type'),
              })
            ) {
              await cache.put(path, response);
            }
          } catch {
            // Offline install: the fallback fills in on the next success.
          }
        }),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event: ExtendableEvent) => {
  event.waitUntil(
    (async () => {
      // Versioned activation: retire every cache this version doesn't own.
      const names = await caches.keys();
      await Promise.all(
        names.filter((name) => !CURRENT_CACHES.has(name)).map((name) => caches.delete(name)),
      );
      await self.clients.claim();
      // Explicit update state: tell open pages a new shell is active.
      const clients = await self.clients.matchAll({ type: 'window' });
      for (const client of clients) {
        client.postMessage({ type: 'attn-shell-updated', cache: SHELL_CACHE });
      }
    })(),
  );
});

self.addEventListener('fetch', (event: FetchEvent) => {
  const decision = decideFetch({
    method: event.request.method,
    url: event.request.url,
    mode: event.request.mode,
    swOrigin: self.location.origin,
  });
  if (decision.kind === 'bypass') return;

  if (decision.kind === 'asset-cache-first') {
    event.respondWith(
      (async () => {
        const cache = await caches.open(ASSET_CACHE);
        const cached = await cache.match(event.request);
        if (cached) return cached;
        const response = await fetch(event.request);
        if (mayCacheAssetResponse({ ok: response.ok, status: response.status, type: response.type })) {
          await cache.put(event.request, response.clone());
        }
        return response;
      })(),
    );
    return;
  }

  // navigation-network-first
  event.respondWith(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      try {
        const response = await fetch(event.request);
        if (
          mayCacheShellResponse({
            ok: response.ok,
            status: response.status,
            type: response.type,
            contentType: response.headers.get('content-type'),
          })
        ) {
          await cache.put(decision.shellPath, response.clone());
        }
        return response;
      } catch {
        const fallback = await cache.match(decision.shellPath);
        if (fallback) return fallback;
        return new Response('attn is offline and no shell is cached yet.', {
          status: 503,
          headers: { 'content-type': 'text/plain; charset=utf-8' },
        });
      }
    })(),
  );
});
