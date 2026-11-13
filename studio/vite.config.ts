import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In dev, /api is proxied to a local rslides (see RSLIDES_URL). In the container, nginx does the same.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: { '/api': process.env.RSLIDES_URL ?? 'http://localhost:8080' },
  },
});
