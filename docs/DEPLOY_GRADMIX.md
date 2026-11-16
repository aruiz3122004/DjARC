# Despliegue de GradMix (Vercel + Cloudflare)

Estado: **desplegado y verificado el 16 de noviembre de 2026**.

- Sitio: <https://gradmix.arc03.online> (Vercel, proyecto `gradmix`).
- API de salas y links de playlist: <https://api.gradmix.arc03.online>
  (Worker `gradmix-api` + Durable Objects + R2 `gradmix-audio`).

---

## 1. Arquitectura

```
Navegador (PWA Svelte 5)
├── /api/catalog/*        → Vercel (funciones serverless, mismo origen)
│                            trending, search, stream (SoundCloud/Audius)
├── /api/rooms/*          → Worker gradmix-api   (Durable Object por sala)
└── /api/bundles/*        → Worker gradmix-api   (Durable Object por paquete)
                             └── audio en R2 (bucket gradmix-audio)
```

- El catálogo remoto se queda en Vercel porque descarga audio de terceros y
  necesita hasta 60 s por petición (`maxDuration`).
- Salas y paquetes van al Worker porque necesitan WebSocket, SSE y estado
  compartido: Durable Objects con almacenamiento SQLite y R2 para el audio.
- Sitio y API son orígenes distintos. El Worker solo acepta los orígenes listados
  en `ALLOWED_ORIGINS` (`wrangler.jsonc`) y los previews de Vercel del proyecto.

### Código

| Ruta | Contenido |
| --- | --- |
| `gradmix-pwa/server/catalog.ts` | Lógica del catálogo (compartida por plugin de Vite y Vercel). |
| `gradmix-pwa/server/api/catalog/*.ts` | Entradas de las funciones serverless. |
| `gradmix-pwa/scripts/build-api.mjs` | Empaqueta cada función en `api/<ruta>.js` autocontenido (generado, en `.gitignore`). |
| `gradmix-pwa/vite-catalog-plugin.ts` | Servidor de desarrollo de `/api/catalog/*` (Vite proxea salas y bundles al Worker local). |
| `gradmix-pwa/src/lib/api/base.ts` | `apiUrl()` / `apiWsUrl()` con `VITE_API_BASE`. |
| `gradmix-api/src/index.ts` | Router del Worker, CORS y creación de códigos. |
| `gradmix-api/src/room.ts` | `RoomDurableObject`: estado, join, SSE, WS, audio, permisos, comandos, alarma. |
| `gradmix-api/src/bundle.ts` | `BundleDurableObject`: manifiesto + audio, TTL 24 h. |
| `gradmix-api/src/shared.ts` | Tipos, JSON, códigos, PBKDF2, CORS. |
| `gradmix-api/scripts/smoke.mjs` | 36 comprobaciones end-to-end del API. |
| `gradmix-api/wrangler.jsonc` | Bindings, migración `v1` y ruta `api.gradmix.arc03.online`. |

### Reglas de negocio implementadas

- Código de sala de 6 caracteres (personalizable), clave opcional y `inviteToken`.
- Sala con duración máxima configurable (0,25 h a 10 h); al expirar se autodestruye
  y borra su audio de R2 (Durable Object alarm).
- Audio de una canción de sala: sube a R2, el host lo descarga **una sola vez**
  (`hasAudioRelay` pasa a `false`) y se borra al cerrar/expirar la sala.
- Link de playlist (bundle): manifiesto + hasta 300 pistas de 35 MB, TTL 24 h.
- Permisos por invitado: `canSkip`, `canPause`, `canAdd`, `canRemove`.
- Contraseñas: PBKDF2-SHA256, 12 000 iteraciones (límite de CPU del plan gratuito).

---

## 2. Infraestructura creada

| Recurso | Valor |
| --- | --- |
| Cuenta Cloudflare | `103e5976599c90859dca585c08ee33a9` (rcollante03122004@gmail.com) |
| Zona | `arc03.online` (`eccf789512d130324ac174938e803525`) |
| Worker | `gradmix-api` |
| Bucket R2 | `gradmix-audio` |
| Durable Objects | `RoomDurableObject` (ROOMS), `BundleDurableObject` (BUNDLES) |
| DNS del sitio | `A gradmix` → `76.76.21.21`, proxy **DNS only** |
| DNS del API | `api.gradmix` → lo crea el custom domain del Worker |
| Vercel env | `VITE_API_BASE=https://api.gradmix.arc03.online` (Production) |

Vercel: proyecto `gradmix` (team `aruiz3122004s-projects`), dominio
`gradmix.arc03.online` verificado.

### Verificación

```powershell
cd gradmix-api
node scripts/smoke.mjs https://api.gradmix.arc03.online
# 36 comprobaciones OK. Todo correcto.
```

---

## 3. Cómo desplegar cambios

### Rama de trabajo

Los cambios del asistente se hacen en la rama `opencode`, nunca directamente en `main`:

```powershell
git switch opencode
git pull origin opencode
# ... cambios ...
git commit -m "tipo(area): descripcion"
git push origin opencode
```

`main` solo se actualiza cuando se mergea `opencode` a propósito, así ningún cambio
llega a producción sin revisión. Desplegar (sección siguiente) toma lo que haya en
el directorio de trabajo, así que hay que desplegar desde `opencode` o hacer el merge
primero.

### API (salas y bundles)

```powershell
cd gradmix-api
npm run deploy
node scripts/smoke.mjs https://api.gradmix.arc03.online
```

> `npm run deploy` invoca `wrangler@3.114.15` a propósito. La 4.162 (la que usa
> `npm run dev`) falla en este proyecto: sube el script pero aborta al leer metadata
> de la API beta (`/workers/workers/...` → 404 "This Worker does not exist on your
> account"), así que el despliegue no se activa. No cambiar el script sin probarlo
> antes en un preview.

### Sitio (Vercel)

No hay auto-deploy por Git (el proyecto está vinculado en `gradmix-pwa`, no en la
raíz del repo). Desplegar manualmente:

```powershell
cd gradmix-pwa
npm run build
npx vercel deploy --prod --yes
```

Cambiar `VITE_API_BASE` exige rebuild (se incrusta en el bundle). Para definirla
sin saltos de línea:

```powershell
npx vercel env add VITE_API_BASE production --value "https://api.gradmix.arc03.online" --yes
```

---

## 4. Desarrollo local

```powershell
cd gradmix-api
npm run dev          # Worker en http://127.0.0.1:8787

cd ../gradmix-pwa
npm run dev          # app en http://localhost:5173
```

`vite.config.ts` proxea `/api/rooms` y `/api/bundles` a `127.0.0.1:8787` (con WebSocket
incluido), así que en desarrollo se usa **el mismo código** que en producción. El
catálogo (`/api/catalog/*`) sí lo sirve el plugin de Vite.

También se puede apuntar el frontend a un Worker remoto con un `.env.local`:

```
VITE_API_BASE=https://api.gradmix.arc03.online
```

---

## 5. Notas y límites

- Límite por pista: 35 MB (`MAX_UPLOAD_BYTES`). El Worker exige `Content-Length`
  (411 si falta) porque R2 necesita streams de longitud conocida.
- Si se agrega un dominio nuevo, sumarlo a `ALLOWED_ORIGINS` en
  `gradmix-api/wrangler.jsonc` y volver a desplegar.
- El audio de salas se borra al expirar; el de bundles a las 24 h.
- Revertir el frontend: `npx vercel rollback`. Revertir el Worker:
  `npx wrangler rollback`.
- Las credenciales de Cloudflare del equipo son un OAuth token de `wrangler`
  (guardado en `%APPDATA%\xdg.config\.wrangler\config\default.toml`) que **no**
  incluye permisos de DNS: los registros DNS se gestionan en el panel o con un
  token con `Zone → DNS → Edit`.
