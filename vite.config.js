import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // 1. Proxy Login (REST)
      '/token': {
        target: 'https://api.nommia.io',
        changeOrigin: true,
        secure: false
      },
      // 2. Proxy for fetching server configuration
      '/settings': {
        target: 'https://api.nommia.io',
        changeOrigin: true,
        secure: false
      },
      // 3. Proxy WebSocket (Admin Node) - Using Vanex's shared admin platform
      // Nommia uses XValley's shared infrastructure
      '/ws-admin': {
        target: 'wss://platform-admin.vanex.site',
        ws: true,
        changeOrigin: true,
        secure: false,
        rewrite: (path) => path.replace(/^\/ws-admin/, '/ws')
      }
    }
  }
})