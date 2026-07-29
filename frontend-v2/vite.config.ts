import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

// Port 5174 on purpose: the OLD editor keeps running on 5173 and must stay
// reachable for the whole rebuild. Nothing here touches ../frontend.
//
// The /api + /storage proxies only matter once VITE_DATA_SOURCE=api (phase 3).
// In the default mock mode the app makes no network calls at all, so the
// prototype runs with the backend down and Tailscale off.
// `api` builds must not carry the fixtures. lib/data imports both adapters
// statically (so `data` stays a synchronous export), which would otherwise pull
// ~688 KB of mock JSON into a bundle that talks to the real backend. Swapping
// the mock adapter for a stub lets Rollup drop the whole fixture tree.
const isApiBuild = process.env.VITE_DATA_SOURCE === 'api';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      ...(isApiBuild
        ? {
            './mock/adapter': fileURLToPath(
              new URL('./src/lib/data/mock/adapter.stub.ts', import.meta.url),
            ),
          }
        : {}),
    },
  },
  build: { assetsDir: 'static' },
  server: {
    port: 5174,
    strictPort: true,
    proxy: {
      '/api': 'http://127.0.0.1:8000',
      '/storage': 'http://127.0.0.1:8000',
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
