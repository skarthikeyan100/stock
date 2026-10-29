import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const backendUrl = 'http://localhost:3000';

// Every backend route prefix the app calls (the dev server forwards these; anything else is served by Vite itself).
const API_PREFIXES = [
  '/order', '/optionstream', '/positionstream', '/niftystream', '/notificationstream', '/auth', '/users', '/admin', '/config',
  '/strategies', '/prism', '/demo', '/ant', '/kite', '/breeze', '/shoonya', '/broker', '/reconcile',
];

export default defineConfig({
  plugins: [react()],
  base: '/',
  build: {
    outDir: '../public',
    emptyOutDir: true,
  },
  server: {
    host: '0.0.0.0',
    port: 4000,
    proxy: Object.fromEntries(API_PREFIXES.map((p) => [p, backendUrl])),
  }
})
