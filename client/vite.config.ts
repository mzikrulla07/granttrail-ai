import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The browser only ever talks to /api on the same origin. In development Vite
// proxies /api to the Express server; no API keys or secrets exist client-side.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: 'http://localhost:3001', changeOrigin: false },
    },
  },
  preview: { port: 4173 },
  build: { outDir: 'dist', sourcemap: false },
});
