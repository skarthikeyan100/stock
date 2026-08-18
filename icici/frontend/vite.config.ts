import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'fs'
import path from 'path'

const backendUrl = process.env.MOCK === 'true'
  ? 'http://localhost:4000'
  : 'http://localhost:3000';

const logFile = path.join(process.cwd(), 'requests.log');

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'request-logger',
      configureServer(server) {
        return () => {
          server.middlewares.use((req, _, next) => {
            const timestamp = new Date().toISOString();
            const method = req.method;
            const url = req.url;
            const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';
            const logMessage = `[${timestamp}] ${method} ${url} - IP: ${ip}\n`;

            console.log(logMessage.trim());
            fs.appendFileSync(logFile, logMessage);
            next();
          });
        };
      },
    },
  ],
  base: '/app/',
  build: {
    outDir: '../public/app',
    emptyOutDir: true,
  },
  server: {
    host: '0.0.0.0',
    port: 4000,
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
