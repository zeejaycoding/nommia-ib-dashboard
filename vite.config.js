import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: './',
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
      // 3. Proxy WebSocket - ADMIN (Backoffice operations: users, accounts, settings)
      '/ws-admin': {
        target: 'wss://platform-admin.vanex.site',
        ws: true,
        changeOrigin: true,
        secure: false,
        rewrite: (path) => path.replace(/^\/ws-admin/, '/ws')
      },
      // 4. Proxy WebSocket - TRADE (Trading operations: trades, deposits, transactions)
      '/ws-trade': {
        target: 'wss://platform-trade.vanex.site',
        ws: true,
        changeOrigin: true,
        secure: false,
        rewrite: (path) => path.replace(/^\/ws-trade/, '/ws')
      }
    }
  }
})