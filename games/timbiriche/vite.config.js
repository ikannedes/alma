import { defineConfig } from "vite";

// Se sirve en /play/timbiriche/ dentro de Alma. El puente /play/_alma/alma.js se carga en tiempo de ejecución
// (import dinámico con @vite-ignore); se marca como externo para que el build no intente empaquetarlo.
export default defineConfig({
  base: "/play/timbiriche/",
  build: {
    target: "es2022",
    rollupOptions: {
      external: ["/play/_alma/alma.js"],
    },
  },
});
