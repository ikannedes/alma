// Construcción de "Batalla de torres" para servirse en /play/torres/ dentro de Alma.
// Ajustes tomados del build de publicación original (scripts/build-release.js de
// Moss & Ember): orden de ejecución estricto, sin minificar, assets sin incrustar.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vite";

const raiz = import.meta.dirname;

// Copia los textos de licencia al resultado (dist/licencias/) para servirlos con el juego.
function licencias() {
  const archivos = {
    "licencias/LICENSE.txt": "LICENSE",
    "licencias/NOTICE.txt": "NOTICE",
    "licencias/BarlowCondensed-OFL.txt": "public/licenses/BarlowCondensed-OFL.txt",
  };
  return {
    name: "alma-licencias",
    generateBundle() {
      for (const [fileName, origen] of Object.entries(archivos)) {
        this.emitFile({ type: "asset", fileName, source: readFileSync(resolve(raiz, origen)) });
      }
    },
  };
}

export default defineConfig({
  base: process.env.VITE_BASE || "/play/torres/",
  publicDir: false,
  plugins: [licencias()],
  build: {
    target: "esnext",
    minify: false,
    cssMinify: true,
    sourcemap: false,
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 4_000,
    rolldownOptions: {
      input: {
        index: resolve(raiz, "index.html"),
        arena: resolve(raiz, "arena.html"),
        licencias: resolve(raiz, "licencias.html"),
      },
      output: {
        strictExecutionOrder: true,
      },
    },
  },
  server: { port: 5174, open: false },
});
