// Landing entry (attn-7xl.1.1/.2). This chunk must stay free of the editor,
// markdown, and room-crypto graphs — scripts/check-route-bundles.mjs gates the
// built output.
import '@fontsource-variable/source-serif-4';
import '@fontsource-variable/source-sans-3';
import '@fontsource-variable/source-code-pro';
import '../src/hosted/landing/landing.css';
import { mount } from 'svelte';
import Landing from '../src/hosted/landing/Landing.svelte';
import { initTheme } from '../src/hosted/landing/theme.svelte';

initTheme();
const target = document.getElementById('app');
if (!target) throw new Error('missing landing mount element');
mount(Landing, { target });
document.body.dataset.hydrated = 'true';
