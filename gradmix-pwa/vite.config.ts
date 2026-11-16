import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import { gradmixCatalogPlugin } from './vite-catalog-plugin.ts';

// Worker local de salas y links de playlist (`npm run dev:api`).
const LOCAL_API = 'http://127.0.0.1:8787';

export default defineConfig({
  plugins: [
    tailwindcss(),
    svelte(),
    gradmixCatalogPlugin(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: false,
      manifest: false,
      workbox: {
        importScripts: ['/sw-media-controls.js'],
        globPatterns: ['**/*.{js,css,html,svg,png,ico,woff2,json}'],
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        skipWaiting: true,
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//],
      },
      devOptions: {
        enabled: false,
      },
    }),
  ],
  worker: {
    format: 'es',
  },
  server: {
    host: true,
    allowedHosts: true,
    proxy: {
      '/api/rooms': { target: LOCAL_API, changeOrigin: true, ws: true },
      '/api/bundles': { target: LOCAL_API, changeOrigin: true },
    },
  },
  preview: {
    host: true,
    allowedHosts: true,
    proxy: {
      '/api/rooms': { target: LOCAL_API, changeOrigin: true, ws: true },
      '/api/bundles': { target: LOCAL_API, changeOrigin: true },
    },
  },
});
