// Landing entry (attn-7xl.1.1/.2). This chunk must stay free of the editor,
// markdown, and room-crypto graphs — scripts/check-route-bundles.mjs gates the
// built output.
import '@fontsource-variable/source-serif-4';
import '@fontsource-variable/source-sans-3';
import '@fontsource-variable/source-code-pro';
import '../src/hosted/chrome.css';
import '../src/hosted/landing/landing.css';
import { mount } from 'svelte';
import Landing from '../src/hosted/landing/Landing.svelte';
import NotFound from '../src/hosted/not-found/NotFound.svelte';
import { hostedEntryForPath } from '../src/lib/hosted/routes';
import { initTheme } from '../src/hosted/theme.svelte';

initTheme();
const target = document.getElementById('app');
if (!target) throw new Error('missing landing mount element');

// The worker and Vite use this same parser before serving an entry. Re-check
// here because a cached shell may be replayed after a navigation while offline.
// A failed route must never turn into a convincing but unrelated homepage.
const entry = hostedEntryForPath(window.location.pathname);
if (!entry) {
  document.body.dataset.route = 'not-found';
  mount(NotFound, { target });
} else if (/^\/homepage-alt\/?$/u.test(window.location.pathname)) {
  // Keep the shipped homepage intact while /homepage-alt carries the interactive
  // positioning study. The alternate stays in a lazy chunk so ordinary landing
  // visits do not pay for the demo state or its presentation CSS.
  document.body.dataset.route = 'landing-alt';
  const { default: AlternateLanding } = await import(
    '../src/hosted/landing-alt/AlternateLanding.svelte'
  );
  mount(AlternateLanding, { target });
} else {
  mount(Landing, { target });
}
document.body.dataset.hydrated = 'true';

// Install the app-shell service worker (attn-7xl.6.2); registration is
// best-effort and never blocks the page.
if ('serviceWorker' in navigator && !import.meta.env.DEV) {
  navigator.serviceWorker.register('/sw.js').catch(() => undefined);
}
