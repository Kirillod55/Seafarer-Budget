import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import { defineConfig } from 'vitest/config'
import pkg from './package.json' with { type: 'json' }

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  base: process.env.BUILD_TARGET === 'pages' ? '/Seafarer-Budget/' : './',
  plugins: [
    react(),
    VitePWA({
      registerType: 'prompt',
      manifest: {
        name: 'Seafarer Budget',
        short_name: 'Бюджет',
        lang: 'ru',
        display: 'standalone',
        start_url: './',
        scope: './',
        theme_color: '#0E0F12', // --bg (dark theme) in src/ui/tokens.css
        background_color: '#0E0F12', // --bg (dark theme)
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
        ],
      },
      workbox: {
        // Precache the app shell so it opens offline. Data comes from IndexedDB, and Supabase calls
        // are deliberately not matched by any runtime-caching rule, so they always go to the network.
        globPatterns: ['**/*.{js,css,html,png,svg,woff2}'],
        navigateFallback: 'index.html',
        cleanupOutdatedCaches: true,
      },
    }),
  ],
  build: {
    rolldownOptions: {
      output: {
        // the app's own code changes every release, the libraries rarely: separate chunks stay cached (and none is
        // over Vite's 500 kB warning — stage 2 carry-over, the main JS was 749 kB)
        codeSplitting: {
          groups: [
            { name: 'react', test: /node_modules[\/](react|react-dom|scheduler)[\/]/, priority: 3 },
            { name: 'supabase', test: /node_modules[\/]@supabase[\/]/, priority: 2 },
            { name: 'dexie', test: /node_modules[\/](dexie|dexie-react-hooks)[\/]/, priority: 2 },
            { name: 'vendor', test: /node_modules[\/]/, priority: 1 },
          ],
        },
      },
    },
  },
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('./supabase/functions/_shared', import.meta.url)),
    },
  },
  test: {
    environment: 'jsdom',
    pool: 'vmThreads',
    setupFiles: ['./src/test-setup.ts'],
    // a full run on all cores starves the jsdom screen tests past their 5 s timeout; 4 workers keep them stable
    maxWorkers: 4,
    include: ['src/**/*.test.{ts,tsx}', 'supabase/functions/_shared/**/*.test.ts', 'supabase/functions/fx-rates/**/*.test.ts', 'supabase/*.test.ts'],
  },
})
