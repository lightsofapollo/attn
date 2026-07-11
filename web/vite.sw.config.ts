import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { defineConfig } from 'vite';

const webRoot = fileURLToPath(new URL('.', import.meta.url));

// Builds the service worker into a STABLE, unhashed /sw.js (attn-7xl.6.2).
// Runs after the main browser build (see build:browser) and must not empty
// dist-browser.
export default defineConfig({
  publicDir: false,
  build: {
    outDir: path.join(webRoot, 'dist-browser'),
    emptyOutDir: false,
    target: 'es2022',
    lib: {
      entry: path.join(webRoot, 'src/hosted/sw/sw.ts'),
      formats: ['iife'],
      name: 'attnSw',
      fileName: () => 'sw.js',
    },
    rollupOptions: {
      output: { inlineDynamicImports: true },
    },
  },
});
