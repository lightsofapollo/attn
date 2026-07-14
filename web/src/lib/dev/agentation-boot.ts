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

if (!document.getElementById(AGENTATION_ROOT_ID)) {
  const host = document.createElement('div');
  host.id = AGENTATION_ROOT_ID;
  document.body.appendChild(host);
  mount(Agentation, {
    target: host,
    props: { endpoint: 'http://localhost:4747' },
  });
}

export {};
