import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev only. In production nginx serves the build and proxies /api + /storage.
// The backend serves /storage itself (streaming from the connected bucket), so
// both proxies target the backend — there is no direct MinIO proxy anymore.
export default defineConfig({
  plugins: [react()],
  // Emit bundles under /static/ (not the default /assets/) so they don't
  // collide with the client-side `/assets` route under nginx's SPA fallback.
  build: { assetsDir: 'static' },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8000',
      '/storage': 'http://localhost:8000',
    },
  },
});
