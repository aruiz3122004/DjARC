# `gradmix-pwa` — Módulo Frontend & Catálogo

Este directorio contiene la aplicación web progresiva (**Svelte 5 + TypeScript + Vite + Tailwind CSS v4**) y el plugin de catálogo para desarrollo ([vite-catalog-plugin.ts](vite-catalog-plugin.ts)) de **GradMix**.

> Las salas colaborativas y los links de playlist viven en el Worker de Cloudflare: [`../gradmix-api`](../gradmix-api). En desarrollo se ejecuta en local y Vite proxea `/api/rooms` y `/api/bundles` hacia él, así que no hay dos backends distintos.

> Para consultar el **mapa completo de arquitectura, flujos de audio/búsqueda/almacenamiento, endpoints `/api/*`, guía "dónde tocar cada cosa" y glosario técnico**, revisa el [README principal del repositorio](../README.md).

## Comandos rápidos

```powershell
# 1. Instalar dependencias
npm install

# 2. Worker local de salas y links (otra terminal, http://127.0.0.1:8787)
npm run dev:api

# 3. Desarrollo con recarga en caliente (http://localhost:5173)
npm run dev

# 4. Verificación estática (svelte-check + tsc)
npm run check

# 5. Suite de pruebas unitarias
node --test tests/*.test.ts

# 6. Compilación de producción + Service Worker y preview local (http://localhost:4173)
npm run build
npm run preview
```
