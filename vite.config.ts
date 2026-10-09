import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';

// Each build gets an id; version.json next to the page lets open tabs notice a new deploy.
const BUILD = Date.now().toString(36);
const version = (): Plugin => ({
  name: 'version-json',
  apply: 'build',
  generateBundle() {
    this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ build: BUILD }) });
  },
});

// Build to a single self-contained index.html so the app can be opened
// straight from disk (double-click) with no server.
export default defineConfig({
  plugins: [react(), viteSingleFile(), version()],
  base: './',
  define: { __BUILD__: JSON.stringify(BUILD) },
});
