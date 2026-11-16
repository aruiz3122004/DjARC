# Despliegue de GradMix (Vercel + Cloudflare)

Estado al **15 de noviembre de 2026**. Todo el código está construido y probado en
local; solo falta ejecutar los despliegues que requieren las credenciales de
Cloudflare.

- Sitio: `https://gradmix.arc03.online` (Vercel, proyecto `gradmix`).
- API de salas y links de playlist: `https://api.gradmix.arc03.online` (Worker
  `gradmix-api` + Durable Objects + R2).

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

### Código

| Ruta | Contenido |
| --- | --- |
| `gradmix-pwa/server/catalog.ts` | Lógica del catálogo (compartida por plugin de Vite y Vercel). |
| `gradmix-pwa/server/api/catalog/*.ts` | Entradas de las funciones serverless. |
| `gradmix-pwa/scripts/build-api.mjs` | Empaqueta cada función en `api/<ruta>.js` autocontenido (generado, en `.gitignore`). |
| `gradmix-pwa/vite-room-plugin.ts` | Servidor de desarrollo: salas, SSE, WS y bundles en `localhost`. |
| `gradmix-pwa/src/lib/api/base.ts` | `apiUrl()` / `apiWsUrl()` con `VITE_API_BASE`. |
| `gradmix-api/src/index.ts` | Router del Worker, CORS y creación de códigos. |
| `gradmix-api/src/room.ts` | `RoomDurableObject`: estado, join, SSE, WS, audio, permisos, comandos, alarma. |
| `gradmix-api/src/bundle.ts` | `BundleDurableObject`: manifiesto + audio, TTL 24 h. |
| `gradmix-api/src/shared.ts` | Tipos, JSON, códigos, PBKDF2, CORS. |
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

## 2. Lo que ya está hecho

- [x] Proyecto Vercel `gradmix` creado y desplegado en `https://gradmix.vercel.app`.
- [x] `gradmix.arc03.online` agregado al proyecto (queda `misconfigured` hasta crear el CNAME).
- [x] Catálogo serverless funcionando en producción (`/api/catalog/trending`,
      `/api/catalog/search`, `/api/catalog/stream`), con `policy` de SoundCloud
      aceptando `ALLOW` y `MONETIZE`.
- [x] Node del proyecto fijado en `24.x`.
- [x] Worker completo en `gradmix-api/` con `npx tsc --noEmit` limpio.
- [x] Suite de pruebas del Worker aprobada (33 comprobaciones): creación de sala,
      códigos ocupados, claves, inviteToken, estado, WebSocket, SSE, subida y
      descarga única de audio, permisos, comandos, bundles, cierre.
- [x] Frontend desacoplado del origen: `apiUrl()` / `apiWsUrl()` en
      `src/lib/api/base.ts`; `npm run check` y `npm run build` limpios.
- [x] CORS del Worker verificado: preflight 204 para orígenes permitidos y 403
      para orígenes desconocidos.

---

## 3. Pendientes para mañana (en orden)

### Paso 1 — API Token de Cloudflare

Crear en <https://dash.cloudflare.com/profile/api-tokens> un token con:

- `Zone → DNS → Edit` sobre `arc03.online`.
- `Account → Workers Scripts → Edit`.
- `Account → Workers R2 Storage → Edit`.
- `Account → Durable Objects → Edit`.
- `Account → Account Settings → Read`.

Luego, en PowerShell:

```powershell
$env:CLOUDFLARE_API_TOKEN = "<token>"
cd C:\Users\caric\Downloads\proyectos_andres\DjARC\gradmix-api
npx wrangler whoami
```

### Paso 2 — Bucket R2

```powershell
npx wrangler r2 bucket create gradmix-audio
```

Sin este bucket `wrangler deploy` falla.

### Paso 3 — Desplegar el Worker

```powershell
cd C:\Users\caric\Downloads\proyectos_andres\DjARC\gradmix-api
npx wrangler deploy
```

`wrangler.jsonc` ya declara `routes: [{ pattern: "api.gradmix.arc03.online",
custom_domain: true }]`, así que el despliegue crea el DNS y el certificado del
subdominio automáticamente sobre la zona `arc03.online`.

Verificar:

```powershell
curl.exe https://api.gradmix.arc03.online/api/health
# {"ok":true,"service":"gradmix-api"}
```

### Paso 4 — CNAME del sitio

En el panel de Cloudflare (zona `arc03.online`) crear:

| Tipo | Nombre | Contenido | Proxy |
| --- | --- | --- | --- |
| CNAME | `gradmix` | `cname.vercel-dns.com` | **DNS only** (gris) |

Si el dominio sigue `misconfigured`, ejecutar `vercel domains inspect
gradmix.arc03.online` en `gradmix-pwa` y confirmar que el proyecto es `gradmix`.

### Paso 5 — Conectar el frontend con el Worker

```powershell
cd C:\Users\caric\Downloads\proyectos_andres\DjARC\gradmix-pwa
"https://api.gradmix.arc03.online" | vercel env add VITE_API_BASE production
```

Y volver a desplegar (no hay auto-deploy por Git: el proyecto está vinculado en
`gradmix-pwa`, no en la raíz del repo):

```powershell
npm run build
vercel deploy --prod --yes
```

### Paso 6 — Verificación end-to-end

Desde `https://gradmix.arc03.online`:

1. Crear sala con clave y compartirla por WhatsApp.
2. Unirse desde otro dispositivo con la clave y con el link de invitación.
3. Subir una canción como invitado y comprobar que el host la recibe y suena.
4. Cambiar permisos y enviar `pause`/`skip` desde el invitado.
5. Generar un link de playlist, abrirlo en una ventana privada e importar.
6. Reproducir una pista del catálogo (SoundCloud/Audius) para confirmar que
   `/api/catalog/*` sigue sirviendo desde Vercel.
7. Cerrar la sala como host y confirmar que el invitado ve "sala cerrada".

---

## 4. Desarrollo local

```powershell
cd gradmix-pwa
npm run dev     # plugin de Vite: /api/rooms, /api/bundles y /api/catalog
```

El Worker también se puede correr aparte:

```powershell
cd gradmix-api
npx wrangler dev --port 8787
```

Y apuntar el frontend con un `.env.local`:

```
VITE_API_BASE=http://127.0.0.1:8787
```

---

## 5. Notas y límites

- `VITE_API_BASE` se incrusta en el bundle al compilar: cambiarla exige rebuild.
- Límite por pista: 35 MB (`MAX_UPLOAD_BYTES`). El Worker exige `Content-Length`
  (411 si falta) porque R2 necesita streams de longitud conocida.
- Sitio y Worker son orígenes distintos: si se agrega un dominio nuevo, sumarlo
  a `ALLOWED_ORIGINS` en `gradmix-api/wrangler.jsonc` y volver a desplegar.
- El audio de salas se borra al expirar; el de bundles a las 24 h.
- Si hay que revertir el frontend: `vercel rollback` en `gradmix-pwa`. El Worker
  se revierte con `npx wrangler rollback`.
