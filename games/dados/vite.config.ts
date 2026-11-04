import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],

  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },

  // GitHub Pages serves a project site from https://<user>.github.io/<repo>/,
  // so assets need that prefix. The deploy workflow sets VITE_BASE=/<repo>/;
  // local dev and any root-hosted deployment fall back to "/".
  base: process.env.VITE_BASE || '/play/dados/',   // Alma: se sirve en /play/dados/

  build: {
    // Three.js dwarfs every other dependency and rarely changes. Splitting it
    // into its own chunk keeps the application chunk small and cacheable across
    // releases instead of re-downloading the engine on every deploy.
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: 'three', test: /node_modules[\\/]three[\\/]/ },
            { name: 'react', test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/ },
          ],
        },
      },
    },
    chunkSizeWarningLimit: 700,
  },

  server: {
    port: 5173,
    open: false,
  },
})
