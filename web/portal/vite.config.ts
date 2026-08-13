import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The scripts run from the repo root (`vite build --config web/portal/...`), so
// `root` must be pinned to this directory — Vite otherwise resolves index.html
// against the cwd and fails to find an entry.
const here = fileURLToPath(new URL('.', import.meta.url));

// The customer account portal (design handoff 2026-08-07, "v2 workwear").
//
// Build output is deliberately FLAT — no `assets/` subdirectory. The static
// handler that serves this (src/portal/portalApi.ts) rejects any name
// containing a path separator before it touches the filesystem, which is the
// same traversal guard /admin and /board use. Emitting a nested assets dir
// would mean loosening that check for the sake of a folder, so we keep the
// filenames flat and the guard strict. Content hashes still give cache-busting.
export default defineConfig({
  root: here,
  // Served under /portal/, so asset URLs must be absolute from that prefix.
  base: '/portal/',
  plugins: [react()],
  // In production the API and the static app are the same origin (one Node
  // server), which is what makes the session cookie work at all. `npm run
  // portal:dev` serves the app from Vite instead, so /portal/api/* has to be
  // proxied to the real server or every request 404s and the cookie is never
  // set. Start that server alongside the dev server:
  //
  //   PORTAL_STATIC_DIR=web/portal/dist MCP_HTTP_PORT=8932 node dist/mcp/httpServer.js
  //
  // PORTAL_API_ORIGIN overrides the target if you run it on another port.
  server: {
    proxy: {
      '/portal/api': {
        target: process.env.PORTAL_API_ORIGIN ?? 'http://127.0.0.1:8932',
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        entryFileNames: '[name]-[hash].js',
        chunkFileNames: '[name]-[hash].js',
        assetFileNames: '[name]-[hash][extname]',
      },
    },
  },
});
