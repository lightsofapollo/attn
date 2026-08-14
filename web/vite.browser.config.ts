import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { defineConfig, type Connect, type Plugin } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';
import { entryHtmlPath, hostedEntryForPath } from './src/lib/hosted/routes';
import { THEME_PREFLIGHT_SCRIPT } from './src/lib/hosted/theme-preflight';

const webRoot = fileURLToPath(new URL('.', import.meta.url));
const hostedRoot = path.join(webRoot, 'hosted');
const browserDistRoot = path.join(webRoot, 'dist-browser');
const pushE2e = process.env.ATTN_PUSH_E2E === '1';
const stagingRelayOrigin = 'https://relay-staging.attn.sh';
const stagingWebOrigin = 'https://staging.attn.sh';
const devRelayTarget = process.env.ATTN_DEV_RELAY_TARGET ?? stagingRelayOrigin;
const devRelayTargetOrigin = new URL(devRelayTarget).origin;
const devRelayOrigin = process.env.ATTN_DEV_RELAY_ORIGIN
  ?? (devRelayTargetOrigin === stagingRelayOrigin ? stagingWebOrigin : devRelayTargetOrigin);
const devRelayProxy = {
  target: devRelayTarget,
  ws: true,
  changeOrigin: true,
  rewriteWsOrigin: true,
  headers: { origin: devRelayOrigin },
};

// Mirror the Cloudflare worker's strict document routing in dev and preview.
// Valid deep paths resolve to their entry; malformed paths receive the landing
// recovery document with a real 404 status. Module, asset, and Vite-internal
// requests never send `Accept: text/html`, so they retain ordinary static 404s.
function hostedEntryRewrites(): Plugin {
  const rewrite = (renderNotFound: () => Promise<string>): Connect.NextHandleFunction => (req, res, next) => {
    const accept = req.headers.accept ?? '';
    if ((req.method === 'GET' || req.method === 'HEAD') && accept.includes('text/html')) {
      const pathname = (req.url ?? '/').split(/[?#]/u)[0];
      const entry = hostedEntryForPath(pathname);
      if (entry) {
        req.url = entryHtmlPath(entry);
      } else {
        // Vite's static-file middleware always writes a 200 when it serves an
        // HTML file, even when a prior middleware set `res.statusCode`. Render
        // this one document here instead so development and preview preserve
        // the Worker contract: branded recovery body AND real 404 status.
        void renderNotFound()
          .then((html) => {
            res.statusCode = 404;
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            if (req.method === 'HEAD') res.end();
            else res.end(html);
          })
          .catch(next);
        return;
      }
    }
    next();
  };
  return {
    name: 'attn-hosted-entry-rewrites',
    configureServer(server) {
      server.middlewares.use(
        rewrite(async () =>
          server.transformIndexHtml(
            '/index.html',
            await readFile(path.join(hostedRoot, 'index.html'), 'utf8'),
          ),
        ),
      );
    },
    configurePreviewServer(server) {
      server.middlewares.use(rewrite(() => readFile(path.join(browserDistRoot, 'index.html'), 'utf8')));
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

// Stamp the theme onto <html> before the first paint (attn-n01r.22). The
// hosted entries carry blocking stylesheets, so CSS paints the PAPER ground
// well before the deferred module bundle runs initTheme() — a dark-mode
// visitor measured ~1.2 s of full-page paper-white on a slow link. This is the
// same mechanism the native app uses in web/index.html; it needs a CSP source
// hash here, which lives beside the script in src/lib/hosted/theme-preflight.ts.
// Injected at build AND serve so dev matches production.
function injectThemePreflight(): Plugin {
  return {
    name: 'attn-theme-preflight',
    transformIndexHtml: {
      order: 'pre',
      handler() {
        return [
          {
            tag: 'script',
            children: THEME_PREFLIGHT_SCRIPT,
            injectTo: 'head-prepend',
          },
        ];
      },
    },
  };
}

// Preload the two faces that paint above the fold (attn-n01r.28). The woff2 are
// only discovered after index-*.css parses — measured start 786/866 ms against
// an FCP of 816 ms on Fast 3G + 4x CPU, giving 900 ms and 836 ms of
// fallback-font text on the 74.88px serif h1. That swap is also the entire
// source of the page's CLS (the shift entries name #text, DIV.nav-right and
// A.button). Filenames are content-hashed, so they are read out of the emitted
// bundle rather than hard-coded — a stale hash here would preload a 404 and
// quietly make things worse.
function preloadAboveFoldFonts(): Plugin {
  const WANTED = [/source-serif-4-latin-wght-normal-.*\.woff2$/u, /source-sans-3-latin-wght-normal-.*\.woff2$/u];
  return {
    name: 'attn-preload-above-fold-fonts',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(_html, ctx) {
        const files = Object.keys(ctx.bundle ?? {});
        const hrefs = WANTED.map((pattern) => files.find((file) => pattern.test(file))).filter(
          (file): file is string => Boolean(file),
        );
        return hrefs.map((href) => ({
          tag: 'link',
          attrs: { rel: 'preload', as: 'font', type: 'font/woff2', crossorigin: '', href: `/${href}` },
          injectTo: 'head-prepend' as const,
        }));
      },
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
  plugins: [
    hostedEntryRewrites(),
    injectThemePreflight(),
    preloadAboveFoldFonts(),
    agentationDevToolbar(),
    chunkModulesManifest(),
    svelte(),
    tailwindcss(),
  ],
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
    // Dev-only same-origin relay proxy. Ordinary localhost development uses
    // staging so its public invite links and room storage stay paired. Set
    // ATTN_DEV_RELAY_TARGET for an explicit local relay; the browser then
    // makes SAME-ORIGIN /v1|/v2|/v3|/health calls (no CORS) and Vite forwards
    // them to that relay, WebSocket included.
    proxy: {
      // Browser WebSockets carry the app's arbitrary dev-server port in
      // `Origin`. Rewrite it to the relay environment so it can keep an
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
