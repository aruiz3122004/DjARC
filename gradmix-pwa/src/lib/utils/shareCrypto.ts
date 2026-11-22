import type { PartyBlock } from '../types';

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlToBytes(raw: string): Uint8Array<ArrayBuffer> {
  const padded = raw.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (raw.length % 4)) % 4);
  const bin = atob(padded);
  const buf = new ArrayBuffer(bin.length);
  const out = new Uint8Array(buf);
  for (let i = 0; i < bin.length; i += 1) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

export function generateShareKey(): { keyBytes: Uint8Array<ArrayBuffer>; keyToken: string } {
  const buf = new ArrayBuffer(32);
  const keyBytes = new Uint8Array(buf);
  crypto.getRandomValues(keyBytes);
  return { keyBytes, keyToken: bytesToBase64Url(keyBytes) };
}

export async function encryptShareBytes(
  plain: ArrayBuffer | Uint8Array,
  keyBytes: Uint8Array<ArrayBuffer>
): Promise<Uint8Array<ArrayBuffer>> {
  const ivBuf = new ArrayBuffer(12);
  const iv = new Uint8Array(ivBuf);
  crypto.getRandomValues(iv);

  const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt']);
  const plainView =
    plain instanceof Uint8Array
      ? new Uint8Array(plain).buffer
      : plain;
  const cipherBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plainView);
  const cipher = new Uint8Array(cipherBuf);

  const outBuf = new ArrayBuffer(12 + cipher.byteLength);
  const out = new Uint8Array(outBuf);
  out.set(iv, 0);
  out.set(cipher, 12);
  return out;
}

export async function decryptShareBytes(
  encrypted: ArrayBuffer | Uint8Array,
  keyBytes: Uint8Array<ArrayBuffer>
): Promise<ArrayBuffer> {
  const bytes = encrypted instanceof Uint8Array ? encrypted : new Uint8Array(encrypted);
  if (bytes.byteLength < 28) {
    throw new Error('Contenido cifrado incompleto o inválido.');
  }
  const ivBuf = new ArrayBuffer(12);
  const iv = new Uint8Array(ivBuf);
  iv.set(bytes.subarray(0, 12));

  const cipherCopy = new Uint8Array(new ArrayBuffer(bytes.byteLength - 12));
  cipherCopy.set(bytes.subarray(12));

  const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['decrypt']);
  return await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipherCopy);
}

export interface ZeroServerCatalogShareItem {
  catalogId: string;
  title: string;
  artist: string;
  duration: number;
}

export interface ZeroServerCatalogShareData {
  playlistName: string;
  block: PartyBlock;
  tracks: ZeroServerCatalogShareItem[];
}

/**
 * Codifica y cifra una playlist de catálogo público directamente en la URL (`?share=...`)
 * sin requerir almacenamiento ni subida de archivos al servidor.
 */
export async function encodeZeroServerPlaylistLink(
  origin: string,
  playlistName: string,
  block: PartyBlock,
  tracks: ZeroServerCatalogShareItem[]
): Promise<string> {
  const payload = {
    v: 1,
    n: playlistName,
    b: block,
    t: tracks.map((t) => [t.catalogId, t.title, t.artist, Math.round(t.duration || 0)]),
  };
  const keyBuf = new ArrayBuffer(16);
  const keyBytes = new Uint8Array(keyBuf);
  crypto.getRandomValues(keyBytes);

  const plainBytes = new TextEncoder().encode(JSON.stringify(payload));
  const encrypted = await encryptShareBytes(plainBytes, keyBytes);

  const combinedBuf = new ArrayBuffer(16 + encrypted.byteLength);
  const combined = new Uint8Array(combinedBuf);
  combined.set(keyBytes, 0);
  combined.set(encrypted, 16);

  return `${origin}/?share=${encodeURIComponent(bytesToBase64Url(combined))}`;
}

export async function decodeZeroServerPlaylistLink(
  token: string
): Promise<ZeroServerCatalogShareData> {
  const raw = base64UrlToBytes(token.trim());
  if (raw.byteLength < 44) {
    throw new Error('Enlace de playlist cifrado inválido.');
  }
  const keyBytes = new Uint8Array(new ArrayBuffer(16));
  keyBytes.set(raw.subarray(0, 16));
  const encrypted = raw.subarray(16);
  const plainBuf = await decryptShareBytes(encrypted, keyBytes);
  const parsed = JSON.parse(new TextDecoder().decode(plainBuf)) as {
    v?: number;
    n?: string;
    b?: PartyBlock;
    t?: Array<[string, string, string, number]>;
  };
  if (parsed.v !== 1 || !Array.isArray(parsed.t)) {
    throw new Error('Formato de playlist compartida no reconocido.');
  }
  return {
    playlistName: parsed.n || 'Playlist compartida',
    block: parsed.b || 'Fiesta Principal',
    tracks: parsed.t.map((row) => ({
      catalogId: String(row[0] ?? ''),
      title: String(row[1] ?? 'Sin título'),
      artist: String(row[2] ?? ''),
      duration: Number(row[3]) || 0,
    })),
  };
}

export type ParsedSharedLink =
  | { kind: 'catalog-share'; token: string }
  | { kind: 'bundle'; bundleId: string; keyToken: string | null };

export function parseSharedPlaylistInput(raw: string): ParsedSharedLink | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  try {
    const url = new URL(trimmed);
    const shareToken = url.searchParams.get('share');
    if (shareToken) {
      return { kind: 'catalog-share', token: shareToken.trim() };
    }
    const importId = url.searchParams.get('import');
    if (importId) {
      const hashParams = new URLSearchParams(url.hash.replace(/^#/, ''));
      const keyToken = hashParams.get('k')?.trim() || null;
      return { kind: 'bundle', bundleId: importId.trim().toUpperCase(), keyToken };
    }
  } catch {
    // No es URL completa: probar coincidencia directa de parámetros o código de paquete
  }

  const shareMatch = trimmed.match(/[?&]share=([A-Za-z0-9_-]+)/);
  if (shareMatch) {
    return { kind: 'catalog-share', token: shareMatch[1] };
  }

  const importMatch = trimmed.match(/[?&]import=([A-Za-z0-9_-]+)/);
  if (importMatch) {
    const keyMatch = trimmed.match(/[#&]k=([A-Za-z0-9_-]+)/);
    return {
      kind: 'bundle',
      bundleId: importMatch[1].toUpperCase(),
      keyToken: keyMatch ? keyMatch[1] : null,
    };
  }

  const cleanCode = trimmed.toUpperCase();
  if (/^[A-Z0-9]{6,12}$/.test(cleanCode)) {
    return { kind: 'bundle', bundleId: cleanCode, keyToken: null };
  }
  return null;
}
