import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { defineConfig, type Connect, type Plugin } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';
import { entryHtmlPath, hostedEntryForPath } from './src/lib/hosted/routes';

const webRoot = fileURLToPath(new URL('.', import.meta.url));
const hostedRoot = path.join(webRoot, 'hosted');
const pushE2e = process.env.ATTN_PUSH_E2E === '1';
const devRelayTarget = process.env.ATTN_DEV_RELAY_TARGET ?? 'http://localhost:8787';
const devRelayOrigin = new URL(devRelayTarget).origin;
const devRelayProxy = {
  target: devRelayTarget,
  ws: true,
  changeOrigin: true,
  rewriteWsOrigin: true,
  headers: { origin: devRelayOrigin },
};

// Mirror the Cloudflare worker's deep-path rewrites (worker.ts) in dev and
// preview so `/app/w/:workspaceId/:filePath` and `/review/:roomId` resolve to
// the right HTML entry locally. Only document navigations are rewritten:
// module, asset, and Vite-internal requests never send `Accept: text/html`.
function hostedEntryRewrites(): Plugin {
  const rewrite: Connect.NextHandleFunction = (req, _res, next) => {
    const accept = req.headers.accept ?? '';
    if ((req.method === 'GET' || req.method === 'HEAD') && accept.includes('text/html')) {
      const pathname = (req.url ?? '/').split(/[?#]/u)[0];
      const entry = hostedEntryForPath(pathname);
      if (entry !== 'landing') req.url = entryHtmlPath(entry);
      else if (!pathname.slice(1).includes('.')) req.url = entryHtmlPath('landing');
    }
    next();
  };
  return {
    name: 'attn-hosted-entry-rewrites',
    configureServer(server) {
      server.middlewares.use(rewrite);
    },
    configurePreviewServer(server) {
      server.middlewares.use(rewrite);
    },
  };
}

// Dev-only: inject the Agentation feedback toolbar (agentation.com) into every
// hosted HTML entry. `apply: 'serve'` keeps it out of builds entirely; the
// /@fs/ path is needed because this config's root is web/hosted while the boot
// module lives under web/src (already inside server.fs.allow).
function agentationDevToolbar(): Plugin {
  return {
    name: 'attn-agentation-dev-toolbar',
    apply: 'serve',
    transformIndexHtml() {
      return [
        {
          tag: 'script',
          attrs: {
            type: 'module',
            src: `/@fs/${path.join(webRoot, 'src/lib/dev/agentation-boot.ts')}`,
          },
          injectTo: 'body',
        },
      ];
    },
  };
}

// Record which modules land in each emitted chunk so the route bundle gate
// (scripts/check-route-bundles.mjs) can match forbidden *code* precisely —
// page copy is allowed to say "ProseMirror" without tripping the gate.
function chunkModulesManifest(): Plugin {
  return {
    name: 'attn-chunk-modules-manifest',
    generateBundle(_options, bundle) {
      const chunkModules: Record<string, string[]> = {};
      for (const [fileName, output] of Object.entries(bundle)) {
        if (output.type === 'chunk') {
          chunkModules[fileName] = Object.keys(output.modules).map((id) =>
            id.startsWith(webRoot) ? id.slice(webRoot.length) : id,
          );
        }
      }
      this.emitFile({
        type: 'asset',
        fileName: '.vite/chunk-modules.json',
        source: JSON.stringify(chunkModules, null, 2),
      });
    },
  };
}

export default defineConfig({
  root: hostedRoot,
  envDir: webRoot,
  publicDir: path.join(hostedRoot, 'public'),
  appType: 'mpa',
  plugins: [hostedEntryRewrites(), agentationDevToolbar(), chunkModulesManifest(), svelte(), tailwindcss()],
  resolve: {
    alias: {
      $lib: path.join(webRoot, 'src/lib'),
    },
  },
  // The review entry loads BrowserReviewApp through a guarded dynamic import.
  // Prebundle its UI-only dependencies up front so Vite never performs a
  // first-navigation dependency-optimization reload after the invite fragment
  // has already been stripped from the address bar.
  optimizeDeps: {
    include: [
      '@lucide/svelte/icons/cloud-off',
      '@lucide/svelte/icons/inbox',
      '@lucide/svelte/icons/refresh-ccw',
      'tailwind-merge',
      'tailwind-variants',
    ],
  },
  server: {
    fs: {
      allow: [webRoot],
    },
    // Dev-only same-origin relay proxy. Set VITE_ATTN_RELAY_URL to the dev
    // origin (e.g. http://localhost:5173) and run a local relay on
    // ATTN_DEV_RELAY_TARGET (default http://localhost:8787): the browser then
    // makes SAME-ORIGIN /v1|/v2|/v3|/health calls (no CORS) and vite forwards
    // them to the relay, WebSocket included. This is what makes the share
    // workflow completable — and Playwright-testable — on localhost.
    proxy: {
      // Browser WebSockets carry the app's arbitrary dev-server port in
      // `Origin`. Rewrite it to the relay target so the relay can keep an
      // exact allowlist without every local Vite port being pre-registered.
      '/v3': { ...devRelayProxy },
      '/v2': { ...devRelayProxy },
      '/v1': { ...devRelayProxy },
      '/health': { target: devRelayTarget, changeOrigin: true },
    },
  },
  build: {
    outDir: path.join(webRoot, 'dist-browser'),
    emptyOutDir: true,
    target: 'es2022',
    // scripts/check-route-bundles.mjs walks the manifest to prove the landing
    // entry never preloads editor/markdown/crypto chunks.
    manifest: true,
    rollupOptions: {
      input: {
        landing: path.join(hostedRoot, 'index.html'),
        app: path.join(hostedRoot, 'app/index.html'),
        review: path.join(hostedRoot, 'review/index.html'),
        ...(pushE2e ? { pushE2e: path.join(hostedRoot, 'push-e2e/index.html') } : {}),
      },
    },
  },
});
