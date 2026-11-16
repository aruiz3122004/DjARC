# gradmix-api

Worker de Cloudflare que sirve las salas colaborativas y los links de playlist de
GradMix.

- `src/index.ts` — router, CORS y generación de códigos.
- `src/room.ts` — `RoomDurableObject` (estado, SSE, WebSocket, audio en R2).
- `src/bundle.ts` — `BundleDurableObject` (manifiesto + audio, TTL 24 h).
- `src/shared.ts` — tipos, utilidades y hashing de contraseñas.

```bash
npm install
npx wrangler dev --port 8787   # http://127.0.0.1:8787/api/health
node scripts/smoke.mjs         # 36 comprobaciones contra el dev local
npx wrangler deploy            # requiere CLOUDFLARE_API_TOKEN o wrangler login
node scripts/smoke.mjs https://api.gradmix.arc03.online
```

El despliegue completo (DNS, Vercel, verificación) está documentado en
[`../docs/DEPLOY_GRADMIX.md`](../docs/DEPLOY_GRADMIX.md).
