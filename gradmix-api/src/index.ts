import { BundleDurableObject } from './bundle.ts';
import { RoomDurableObject } from './room.ts';
import { generateCode, json, normalizeCode, resolveCors, type Env } from './shared.ts';

export { BundleDurableObject, RoomDurableObject };

const ROOM_CREATE_ATTEMPTS = 6;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const cors = resolveCors(request, env.ALLOWED_ORIGINS);

    if (request.method.toUpperCase() === 'OPTIONS') {
      return new Response(null, {
        status: cors ? 204 : 403,
        headers: cors ?? { Vary: 'Origin' },
      });
    }

    const response = await route(request, env);
    return withCors(response, cors);
  },
} satisfies ExportedHandler<Env>;

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  const path = url.pathname;

  if (path === '/api/health') {
    return json({ ok: true, service: 'gradmix-api' });
  }

  if (path === '/api/rooms') {
    if (method !== 'POST') return json({ error: 'Método no permitido.' }, 405);
    return createRoom(request, env);
  }

  const roomMatch = path.match(/^\/api\/rooms\/([^/]+)(?:\/.*)?$/);
  if (roomMatch) {
    const code = normalizeCode(decodeURIComponent(roomMatch[1]));
    if (!code) return json({ error: 'Código de sala inválido.' }, 400);
    const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
    return stub.fetch(request);
  }

  if (path === '/api/bundles') {
    if (method !== 'POST') return json({ error: 'Método no permitido.' }, 405);
    return createBundle(request, env);
  }

  const bundleMatch = path.match(/^\/api\/bundles\/([^/]+)(?:\/.*)?$/);
  if (bundleMatch) {
    const id = normalizeCode(decodeURIComponent(bundleMatch[1]));
    if (!id) return json({ error: 'Identificador inválido.' }, 400);
    const stub = env.BUNDLES.get(env.BUNDLES.idFromName(id));
    return stub.fetch(request);
  }

  return json({ error: 'Ruta no encontrada.' }, 404);
}

async function createRoom(request: Request, env: Env): Promise<Response> {
  const raw = await request.text();
  let requested = '';
  try {
    const parsed = JSON.parse(raw || '{}') as { customCode?: string };
    requested = normalizeCode(parsed.customCode ?? '');
  } catch {
    return json({ error: 'JSON inválido.' }, 400);
  }

  let candidate = requested || generateCode();
  let lastResponse: Response | null = null;

  for (let attempt = 0; attempt < ROOM_CREATE_ATTEMPTS; attempt += 1) {
    const stub = env.ROOMS.get(env.ROOMS.idFromName(candidate));
    const headers = new Headers(request.headers);
    headers.set('x-room-code', candidate);
    headers.set('content-type', 'application/json');

    const response = await stub.fetch(
      new Request(request.url, { method: 'POST', headers, body: raw })
    );

    if (response.status !== 409) return response;

    lastResponse = response;
    if (requested && attempt === 0) {
      candidate = generateCode();
      continue;
    }
    candidate = generateCode();
  }

  return (
    lastResponse ?? json({ error: 'No se pudo asignar un código de sala disponible.' }, 503)
  );
}

async function createBundle(request: Request, env: Env): Promise<Response> {
  const raw = await request.text();
  if (!raw) return json({ error: 'Paquete vacío.' }, 400);

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const id = generateCode(8);
    const stub = env.BUNDLES.get(env.BUNDLES.idFromName(id));
    const headers = new Headers(request.headers);
    headers.set('x-bundle-id', id);
    headers.set('content-type', 'application/json');

    const response = await stub.fetch(
      new Request(request.url, { method: 'POST', headers, body: raw })
    );
    if (response.status !== 409) return response;
  }

  return json({ error: 'No se pudo crear el paquete.' }, 503);
}

function withCors(response: Response, cors: HeadersInit | null): Response {
  if (response.status === 101) return response;

  const headers = new Headers(response.headers);
  headers.set('Vary', 'Origin');
  if (cors) {
    for (const [key, value] of new Headers(cors)) {
      headers.set(key, value);
    }
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
