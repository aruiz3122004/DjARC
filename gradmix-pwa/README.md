# `gradmix-pwa` — Módulo Frontend, Motor de Audio & Catálogo

Este directorio contiene la aplicación web progresiva (**Svelte 5 + TypeScript + Vite 8 + Tailwind CSS v4**) y el catálogo proxy ([`server/catalog.ts`](server/catalog.ts) + [`vite-catalog-plugin.ts`](vite-catalog-plugin.ts)) de **GradMix**.

> Las salas colaborativas y los enlaces E2EE de playlist viven en el Worker de Cloudflare [`../gradmix-api`](../gradmix-api). En desarrollo corre en local (`npm run dev:api`) y Vite proxea `/api/rooms` y `/api/bundles` hacia él.

## Documentación de Referencia

- [README principal del repositorio](../README.md) — visión general, guía completa de comandos y endpoints.
- [`docs/ARQUITECTURA-OV.md`](../docs/ARQUITECTURA-OV.md) — topología PWA ↔ Vercel ↔ Cloudflare Workers.
- [`docs/MODULOS-UI-OV.md`](../docs/MODULOS-UI-OV.md) — `App.svelte`, los 14 componentes UI y `GradMixAudioEngine`.
- [`docs/SALAS-Y-COMPARTICION-OV.md`](../docs/SALAS-Y-COMPARTICION-OV.md) — salas colaborativas y compartición AES-256-GCM.
- [`docs/ALMACENAMIENTO-Y-SEGURIDAD-OV.md`](../docs/ALMACENAMIENTO-Y-SEGURIDAD-OV.md) — OPFS, carpeta local `devfs::`, remux `.m4a` y seguridad.

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

# 5. Suite de pruebas unitarias (6 archivos *.test.ts)
node --test tests/*.test.ts

# 6. Compilación de producción + Service Worker + funciones Vercel y preview (http://localhost:4173)
npm run build
npm run preview
```
