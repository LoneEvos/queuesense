import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Allow importing ../tags/tags.csv so the sticker list has one source.
  server: {
    port: 5173,
    fs: { allow: ['..'] },
    // Local ingest, so the app calls /api exactly like production (works from phones on the LAN too).
    proxy: { '/api': 'http://127.0.0.1:8081' },
  },
});
