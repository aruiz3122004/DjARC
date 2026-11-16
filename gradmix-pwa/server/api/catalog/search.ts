import type { IncomingMessage, ServerResponse } from 'node:http';
import { createCatalogHandler } from '../../catalog.ts';

const catalog = createCatalogHandler();

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `https://${req.headers.host ?? 'localhost'}`);
  try {
    await catalog.handle(res, '/api/catalog/search', url, (req.method ?? 'GET').toUpperCase());
  } catch (err) {
    if (!res.headersSent) {
      const message = err instanceof Error ? err.message : 'Error al consultar catálogo.';
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: message }));
    }
  }
}
