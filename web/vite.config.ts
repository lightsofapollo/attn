import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { viteSingleFile } from 'vite-plugin-singlefile';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';

export default defineConfig({
  plugins: [tailwindcss(), svelte(), viteSingleFile()],
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
