import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';

const webRoot = fileURLToPath(new URL('.', import.meta.url));
const hostedRoot = path.join(webRoot, 'hosted');

export default defineConfig({
  root: hostedRoot,
  envDir: webRoot,
  publicDir: false,
  plugins: [svelte(), tailwindcss()],
  resolve: {
    alias: {
      $lib: path.join(webRoot, 'src/lib'),
    },
  },
  // The hosted entry loads BrowserReviewApp through a guarded dynamic import.
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
  },
  build: {
    outDir: path.join(webRoot, 'dist-browser'),
    emptyOutDir: true,
    target: 'es2022',
  },
});
