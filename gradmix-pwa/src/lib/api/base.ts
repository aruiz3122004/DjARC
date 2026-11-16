/**
 * Base del API de salas colaborativas y links de playlist.
 *
 * - En desarrollo (`npm run dev`) queda vacío y las peticiones van al plugin de
 *   Vite, que sirve salas y paquetes en el mismo origen.
 * - En producción se define `VITE_API_BASE` (por ejemplo
 *   `https://api.gradmix.arc03.online`) apuntando al Worker de Cloudflare.
 *
 * El catálogo remoto (SoundCloud/Audius) NO usa esta base: vive en las
 * funciones serverless del propio sitio (`/api/catalog/*`).
 */
const rawBase = (import.meta.env.VITE_API_BASE ?? '').trim().replace(/\/+$/, '');

export const API_BASE = rawBase;

/** Construye una URL absoluta (o relativa) contra el API de salas/paquetes. */
export function apiUrl(path: string): string {
  const normalized = path.startsWith('/') ? path : `/${path}`;
  return `${rawBase}${normalized}`;
}

/** Igual que `apiUrl`, pero con esquema `ws:`/`wss:` para WebSockets. */
export function apiWsUrl(path: string): string {
  const url = apiUrl(path);
  if (/^wss?:\/\//i.test(url)) return url;
  if (/^https?:\/\//i.test(url)) return url.replace(/^http/i, 'ws');
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}${url}`;
}
