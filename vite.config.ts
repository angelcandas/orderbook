import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Cross-origin isolation is required for SharedArrayBuffer and
// performance.measureUserAgentSpecificMemory. Production hosting must send the
// same headers (see public/_headers for Cloudflare Pages / Netlify).
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  plugins: [react()],
  server: { headers: isolation },
  preview: { headers: isolation },
  worker: { format: 'es' },
  build: { target: 'es2022' },
});
