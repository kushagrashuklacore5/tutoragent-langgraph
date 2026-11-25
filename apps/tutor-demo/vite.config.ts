import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The demo authenticates with a bearer token only. Cookies are stripped in BOTH directions so that a demo session can
// never read or replace the session of the main app (browser cookies are shared across localhost ports).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5195,
    strictPort: true,
    proxy: {
      '/api': {
        target: process.env.API_URL ?? 'http://127.0.0.1:8081',
        changeOrigin: false,
        configure: (proxy) => {
          proxy.on('proxyReq', (req) => req.removeHeader('cookie'))
          proxy.on('proxyRes', (res) => { delete res.headers['set-cookie'] })
        },
      },
    },
  },
  build: { target: 'es2022', sourcemap: false },
})
