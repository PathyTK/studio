import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In dev, /api is proxied to a local rslides (see RSLIDES_URL). In the container, nginx does the same.
// On Vercel the accounts/AI/annotation API runs as serverless functions (../api) but the slide renderer (rslides)
// lives elsewhere, so the build needs its URL in VITE_RENDERING_API. Without it there is nothing to show slides
// from, so Vercel builds fall back to the backend-free demo. Set VITE_DEMO explicitly to force either mode.
const demo = process.env.VITE_DEMO ?? (process.env.VERCEL && !process.env.VITE_RENDERING_API ? 'true' : 'false');

export default defineConfig({
  plugins: [react()],
  define: { 'import.meta.env.VITE_DEMO': JSON.stringify(demo) },
  server: {
    proxy: { '/api': process.env.RSLIDES_URL ?? 'http://localhost:8080' },
  },
});
