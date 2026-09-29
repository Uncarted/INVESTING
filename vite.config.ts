import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';

// Build to a single self-contained index.html so the app can be opened
// straight from disk (double-click) with no server.
export default defineConfig({
  plugins: [react(), viteSingleFile()],
  base: './',
});
