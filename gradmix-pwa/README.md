# `gradmix-pwa` — Módulo Frontend & Servidor Vite

Este directorio contiene la aplicación web progresiva (**Svelte 5 + TypeScript + Vite + Tailwind CSS v4**) y el middleware de servidor ([vite-room-plugin.ts](vite-room-plugin.ts)) de **GradMix**.

> Para consultar el **mapa completo de arquitectura, flujos de audio/búsqueda/almacenamiento, endpoints `/api/*`, guía "dónde tocar cada cosa" y glosario técnico**, revisa el [README principal del repositorio](../README.md).

## Comandos rápidos

```powershell
# 1. Instalar dependencias
npm install

# 2. Desarrollo con recarga en caliente (http://localhost:5173)
npm run dev

# 3. Verificación estática (svelte-check + tsc)
npm run check

# 4. Suite de pruebas unitarias
node --test tests/*.test.ts

# 5. Compilación de producción + Service Worker y preview local (http://localhost:4173)
npm run build
npm run preview
```
