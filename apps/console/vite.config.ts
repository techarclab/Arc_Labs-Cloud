import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In development the console runs on :3002 and forwards /api to the backend on :3000.
// In Docker, nginx does the same forwarding (infra/console/nginx.conf).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 3002,
    proxy: { '/api': process.env.ARC_API_ORIGIN ?? 'http://localhost:3000' },
  },
});
