// Local workspace app entry (attn-7xl.1.1/.3/.3.2). Boots the storage-backed
// workspace service by default; `?shell=<scenario>` keeps the mock service so
// every degraded state stays directly reachable for tests and screenshots.
//
// The real service pulls the crypto/storage graph, so it is loaded via
// dynamic import — scripts/check-route-bundles.mjs gates the app entry's
// STATIC graph against those modules.
import '@fontsource-variable/source-serif-4';
import '@fontsource-variable/source-sans-3';
import '@fontsource-variable/source-code-pro';
import '../../src/hosted/chrome.css';
import '../../src/hosted/app/app-shell.css';
import { mount } from 'svelte';
import { parseAppRoute } from '../../src/lib/hosted/routes';
import AppShell from '../../src/hosted/app/AppShell.svelte';
import { MockWorkspaceService, shellScenarioFromSearch } from '../../src/hosted/app/mock-service';
import type { WorkspaceAppService } from '../../src/hosted/app/types';
import { initTheme } from '../../src/hosted/theme.svelte';

async function bootstrap(): Promise<void> {
  initTheme();
  const target = document.getElementById('app');
  if (!target) throw new Error('missing app mount element');

  const scenario = shellScenarioFromSearch(window.location.search);
  let service: WorkspaceAppService;
  if (scenario === 'real') {
    const { RealWorkspaceAppService } = await import('../../src/hosted/app/real-service');
    service = await RealWorkspaceAppService.open();
  } else {
    service = new MockWorkspaceService(scenario);
  }

  const route = parseAppRoute(window.location.pathname);
  mount(AppShell, {
    target,
    props: {
      service,
      route,
      newIntent: route?.view === 'home' && window.location.hash === '#new',
    },
  });
  document.body.dataset.hydrated = 'true';
}

void bootstrap().catch((error: unknown) => {
  const target = document.getElementById('app');
  if (!target) return;
  target.textContent =
    'This browser currently blocks local document storage, so the desk could not open.';
  target.setAttribute('role', 'alert');
  document.body.dataset.hydrated = 'true';
  console.error('[attn] desk bootstrap failed', error);
});

// Install the app-shell service worker (attn-7xl.6.2); registration is
// best-effort and never blocks the page.
if ('serviceWorker' in navigator && !import.meta.env.DEV) {
  navigator.serviceWorker.register('/sw.js').catch(() => undefined);
}
