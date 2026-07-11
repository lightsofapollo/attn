// Local workspace app entry (attn-7xl.1.1/.3). Renders the designed page
// shells against an injected mock workspace service; attn-7xl.3 swaps the
// mock for the storage-backed service without changing the shells. This
// chunk must stay free of the editor/markdown/crypto graphs —
// scripts/check-route-bundles.mjs gates the built output.
import '@fontsource-variable/source-serif-4';
import '@fontsource-variable/source-sans-3';
import '@fontsource-variable/source-code-pro';
import '../../src/hosted/tokens.css';
import '../../src/hosted/app/app-shell.css';
import { mount } from 'svelte';
import { parseAppRoute } from '../../src/lib/hosted/routes';
import AppShell from '../../src/hosted/app/AppShell.svelte';
import { MockWorkspaceService, shellScenarioFromSearch } from '../../src/hosted/app/mock-service';
import { initTheme } from '../../src/hosted/theme.svelte';

initTheme();

const route = parseAppRoute(window.location.pathname);
const service = new MockWorkspaceService(shellScenarioFromSearch(window.location.search));
const target = document.getElementById('app');
if (!target) throw new Error('missing app mount element');

mount(AppShell, {
  target,
  props: {
    service,
    route,
    newIntent: route?.view === 'home' && window.location.hash === '#new',
  },
});
document.body.dataset.hydrated = 'true';
