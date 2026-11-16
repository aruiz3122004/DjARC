import type { Connect, Plugin } from 'vite';
import { createCatalogHandler } from './server/catalog.ts';

/**
 * En desarrollo y en `vite preview` no existen las funciones serverless de Vercel,
 * así que este plugin monta `/api/catalog/*` en el propio servidor de Vite.
 *
 * Las salas (`/api/rooms`) y los links de playlist (`/api/bundles`) NO se sirven
 * aquí: vienen del Worker de Cloudflare. En local, Vite los proxea a
 * `http://127.0.0.1:8787` (ver `server.proxy` en `vite.config.ts`), así que el
 * frontend habla siempre con el mismo origen y con el mismo código que producción.
 */
export function gradmixCatalogPlugin(): Plugin {
  const catalog = createCatalogHandler();

  const middleware: Connect.NextHandleFunction = (req, res, next) => {
    const rawUrl = req.url ?? '';
    if (!rawUrl.startsWith('/api/catalog')) {
      next();
      return;
    }

    const url = new URL(rawUrl, 'http://localhost');
    const method = (req.method ?? 'GET').toUpperCase();

    void catalog.handle(res, url.pathname, url, method).catch((err: unknown) => {
      if (res.headersSent) return;
      const message = err instanceof Error ? err.message : 'Error al consultar catálogo.';
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify({ error: message }));
    });
  };

  return {
    name: 'gradmix-catalog',
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}
