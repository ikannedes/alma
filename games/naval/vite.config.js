import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Alma: el juego se sirve en /play/naval/ (el puente vive aparte en /play/_alma/alma.js y no se empaqueta).
export default defineConfig({
  plugins: [react()],
  base: '/play/naval/',
  test: {
    environment: 'node',
  },
});
