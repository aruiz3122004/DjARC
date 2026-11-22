# Wiki del Repositorio — GradMix (`DjARC`)

Bienvenido al índice central de la Wiki técnica de **GradMix** (enfoque *Docs-as-Code* versionado dentro de `docs/`). Todo cambio de arquitectura o API se documenta aquí junto al código fuente.

---

## Mapa de Páginas de la Wiki

| Página | Tema | Cuándo consultarla |
| :--- | :--- | :--- |
| [**README Principal**](../README.md) | Visión general, Quick Start, límites, acordeones rápidos y glosario | Punto de entrada para entender y levantar el proyecto en local |
| [**Arquitectura General (`ARQUITECTURA-OV`)**](ARQUITECTURA-OV.md) | Topología Client ↔ Vercel ↔ Cloudflare DO/R2, dev vs prod y catálogo | Antes de tocar rutas `/api/*`, proxy de Vite o infraestructura |
| [**Módulos UI y Audio Engine (`MODULOS-UI-OV`)**](MODULOS-UI-OV.md) | Svelte 5 en `App.svelte`, 14 componentes, Decks A/B, colas y PWA | Al modificar vistas, crossfade, `PlaybackQueue` o `MediaSession` |
| [**Salas y Compartición E2EE (`SALAS-Y-COMPARTICION-OV`)**](SALAS-Y-COMPARTICION-OV.md) | `RoomDurableObject`, latidos `seen:`, `now-audio` y WhatsApp E2EE | Al cambiar permisos de sala, WebSockets o links `?share=` / `?import=#k=` |
| [**Almacenamiento y Seguridad (`ALMACENAMIENTO-Y-SEGURIDAD-OV`)**](ALMACENAMIENTO-Y-SEGURIDAD-OV.md) | `IndexedDB`, `OPFS`, `devfs::`, remux `.m4a`, `.zip` y amenazas | Al tocar cuotas, File System Access API, cifrado o validaciones |
| [**Guía de Despliegue (`DEPLOY_GRADMIX`)**](DEPLOY_GRADMIX.md) | Vercel (`main`), Cloudflare Worker (`wrangler`), DNS y smoke tests | Al desplegar cambios en `gradmix-api` o configurar dominios/R2 |

---

## Archivos Históricos / Contexto Inicial

- [`context.md`](context.md): notas de motivación inicial del proyecto (evento de 10 horas, gestión de RAM, Blackout AMOLED).
- [`security.md`](security.md): análisis inicial del sandbox PWA en cliente.

---

## Sincronización Opcional con la Pestaña GitHub Wiki

La Wiki principal vive versionada en esta carpeta (`docs/`) para revisarse en *Pull Requests*. Si además deseas reflejar estas páginas en la pestaña **Wiki** de GitHub (`https://github.com/aruiz3122004/DjARC/wiki`), primero activa la Wiki en **Settings → Features → Wikis** del repositorio y clona `DjARC.wiki.git` para copiar `docs/WIKI.md` como `Home.md` junto a los archivos `*-OV.md` y `DEPLOY_GRADMIX.md`.
