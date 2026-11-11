import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Allow importing ../tags/tags.csv so the sticker list has one source.
  server: {
    port: 5173,
    fs: { allow: ['..'] },
    // Local ingest, so the app calls /api exactly like production (works from phones on the LAN too).
    // API_PROXY=https://queuesense-one.vercel.app npm run dev  -> use the live API instead.
    proxy: { '/api': { target: process.env.API_PROXY || 'http://127.0.0.1:8081', changeOrigin: true } },
  },
});
