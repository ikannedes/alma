import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// Un solo dist/index.html con todo adentro: se abre con doble clic, como mot_studio
export default defineConfig({ base: './', plugins: [viteSingleFile()] });
