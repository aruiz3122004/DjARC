import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const root = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(root, '..');
const outDir = path.resolve(projectRoot, 'api');

/**
 * Vercel sólo copia el contenido de `api/` dentro de cada función serverless, así que
 * las funciones no pueden importar `server/` ni `src/` en tiempo de ejecución.
 * Aquí empaquetamos cada ruta como un único `.js` autocontenido dentro de `api/`.
 */
const entries = {
  'catalog/trending': 'server/api/catalog/trending.ts',
  'catalog/search': 'server/api/catalog/search.ts',
  'catalog/stream': 'server/api/catalog/stream.ts',
};

fs.rmSync(outDir, { recursive: true, force: true });

for (const [name, file] of Object.entries(entries)) {
  await build({
    root: projectRoot,
    configFile: false,
    logLevel: 'warn',
    build: {
      ssr: true,
      emptyOutDir: false,
      copyPublicDir: false,
      minify: false,
      target: 'node22',
      outDir,
      rollupOptions: {
        input: path.resolve(projectRoot, file),
        output: {
          format: 'esm',
          entryFileNames: `${name}.js`,
        },
      },
    },
  });
}

console.log(`Funciones serverless generadas en ${path.relative(projectRoot, outDir)}/`);
