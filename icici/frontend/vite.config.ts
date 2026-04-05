import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const backendUrl = process.env.MOCK === 'true'
  ? 'http://localhost:4000'
  : 'http://localhost:3000';

export default defineConfig({
  plugins: [react()],
  base: '/app/',
  build: {
    outDir: '../public/app',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/order': backendUrl,
      '/squareoff': backendUrl,
      '/trades': backendUrl,
      '/optionstream': backendUrl,
      '/positionstream': backendUrl,
      '/niftystream': backendUrl,
      '/auth': backendUrl,
      '/users': backendUrl,
      '/config': backendUrl,
      '/documents': backendUrl,
      '/settarget': backendUrl,
    }
  }
})
