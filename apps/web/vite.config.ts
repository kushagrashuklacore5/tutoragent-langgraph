import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// The API runs separately (node apps/api/src/main.ts). In development the SPA proxies /api to it so the
// session cookie stays first-party; ALLOWED_ORIGINS on the API must include this dev origin.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: { '/api': { target: process.env.API_URL ?? 'http://127.0.0.1:8080', changeOrigin: false } },
  },
  build: { target: 'es2022', sourcemap: false },
})
