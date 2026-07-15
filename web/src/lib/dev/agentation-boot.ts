// Dev-only bootstrap for the Agentation feedback toolbar (agentation.com).
//
// Annotations sync to the agentation-mcp server on localhost:4747 (started by
// Claude Code via .mcp.json); the toolbar degrades to local-only clipboard
// output when the server is absent. Loaded from main.ts behind
// `import.meta.env.DEV`, and injected into the hosted (browser) dev server by
// the serve-only plugin in vite.browser.config.ts — never part of a build.

import { mount } from 'svelte';
import { Agentation } from 'agentation-svelte';

const AGENTATION_ROOT_ID = 'agentation-root';

// Automation runs (Playwright, --eval harnesses) must not get the toolbar:
// it fails axe scans (unnamed buttons, nested-interactive) and its floating
// FAB can intercept taps the test aimed at the app.
const isAutomation = typeof navigator !== 'undefined' && navigator.webdriver === true;

if (!isAutomation && !document.getElementById(AGENTATION_ROOT_ID)) {
  const host = document.createElement('div');
  host.id = AGENTATION_ROOT_ID;
  document.body.appendChild(host);
  // On phone widths the toolbar's default bottom-right anchor sits on top of
  // the app's thumb dock; float it above the dock. Dragging it (inline
  // left/top) still wins over this default.
  const style = document.createElement('style');
  style.textContent = `@media (max-width: 900px) {
    #${AGENTATION_ROOT_ID} .toolbar { bottom: calc(76px + env(safe-area-inset-bottom, 0px)); }
  }`;
  document.head.appendChild(style);
  mount(Agentation, {
    target: host,
    props: { endpoint: 'http://localhost:4747' },
  });
}

export {};
