import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { viteSingleFile } from 'vite-plugin-singlefile';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';

export default defineConfig({
  /* Its own dep cache, not the shared `node_modules/.vite` default.
   *
   * This config and vite.browser.config.ts describe different apps — different
   * entries, different plugins (viteSingleFile here), different
   * `optimizeDeps.include` — so each dev server re-optimizes on startup and
   * rewrites the prebundled chunk hashes. Sharing one directory meant the
   * second server to start invalidated the first one's chunk names, and the
   * running page then 500s on every import with "The file does not exist at
   * node_modules/.vite/deps/chunk-XXXX.js ... which is in the optimize deps
   * directory". Running `task dev` and `npm run dev:browser` at the same time
   * is an ordinary thing to do (the two surfaces are meant to be compared), so
   * they get separate caches rather than a rule against it. Vitest already
   * nests under this directory the same way.
   */
  cacheDir: path.resolve('./node_modules/.vite/native'),
  plugins: [svelte(), tailwindcss(), viteSingleFile()],
  resolve: {
    alias: {
      $lib: path.resolve('./src/lib'),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
