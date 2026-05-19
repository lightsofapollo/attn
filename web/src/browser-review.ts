// Browser entry point for the hosted review surface (attn-nnj.9.4).
//
// Loaded by a separate HTML page (e.g. `web/review.html`) rather than
// `index.html`, so the production review URL `https://attn.dev/review/<roomId>`
// boots straight into a reviewer-only Svelte app with no sidebar, no tabs,
// no share dialog, no editor write surface.
//
// Wire shape:
//
//   <html><body>
//     <div id="app"></div>
//     <script type="module" src="/src/browser-review.ts"></script>
//   </body></html>
//
// `BrowserReviewApp` constructs its own `BrowserSession` from `window.location`
// when no `session` prop is passed, so this file is just the mount.

import { mount } from 'svelte';
import BrowserReviewApp from './BrowserReviewApp.svelte';
import '@fontsource-variable/source-serif-4';
import '@fontsource-variable/source-serif-4/opsz-italic.css';
import '@fontsource-variable/source-sans-3';
import '@fontsource-variable/source-code-pro';
import 'katex/dist/katex.min.css';
import './app.css';
import '../styles/base.css';
import '../styles/prosemirror.css';
import '../styles/syntax.css';

const target = document.getElementById('app');
if (!target) {
  throw new Error('attn-browser-review: missing #app mount element');
}

target.style.display = '';
mount(BrowserReviewApp, { target });
