import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Maestros se sirve en /play/maestros/; el puente de Alma vive aparte en /play/_alma/alma.js (no se empaqueta).
export default defineConfig({
  plugins: [react()],
  base: '/play/maestros/',
  build: { target: 'es2020' },
  test: { include: ['tests/**/*.test.{ts,tsx}'], environment: 'node' },
});
