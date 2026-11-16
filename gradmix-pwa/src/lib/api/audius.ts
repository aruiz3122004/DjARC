import { inspectAudioContainer, remuxFragmentedMp4ToStandardM4a } from '../audio/audioContainer';
import type { AudiusCatalogTrack } from '../types';

// El catálogo remoto lo sirve el propio sitio (funciones serverless de Vercel en
// producción y el plugin de Vite en local), así que siempre es mismo origen.

export async function searchAudiusTracks(
  query: string,
  limit = 24
): Promise<AudiusCatalogTrack[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const resp = await fetch(
    `/api/catalog/search?q=${encodeURIComponent(trimmed)}&limit=${encodeURIComponent(String(limit))}`
  );
  const data = (await resp.json()) as { tracks?: AudiusCatalogTrack[]; error?: string };
  if (!resp.ok) {
    throw new Error(data.error || 'Error al buscar en el catálogo.');
  }
  return Array.isArray(data.tracks) ? data.tracks : [];
}

export async function fetchAudiusTrending(limit = 16): Promise<AudiusCatalogTrack[]> {
  const resp = await fetch(`/api/catalog/trending?limit=${encodeURIComponent(String(limit))}`);
  const data = (await resp.json()) as { tracks?: AudiusCatalogTrack[]; error?: string };
  if (!resp.ok) {
    throw new Error(data.error || 'No se pudieron obtener recomendaciones del catálogo.');
  }
  return Array.isArray(data.tracks) ? data.tracks : [];
}

export async function downloadAudiusTrackAsFile(track: AudiusCatalogTrack): Promise<File> {
  const params = new URLSearchParams({
    trackId: track.id,
  });
  if (track.host) params.set('host', track.host);

  const resp = await fetch(`/api/catalog/stream?${params.toString()}`);
  if (!resp.ok) {
    let serverErr = '';
    try {
      const payload = (await resp.json()) as { error?: string };
      serverErr = payload.error ?? '';
    } catch {
      // Ignorar cuerpo no JSON
    }
    throw new Error(serverErr || `No se pudo descargar "${track.title}".`);
  }

  const rawBlob = await resp.blob();
  const headBytes = new Uint8Array(await rawBlob.slice(0, 32 * 1024).arrayBuffer());
  const containerInfo = inspectAudioContainer(headBytes);
  if (containerInfo.encrypted) {
    throw new Error(
      `"${track.title}" está protegida con DRM/cifrado y ningún navegador puede decodificarla.`
    );
  }
  if (containerInfo.kind === 'invalid-text') {
    throw new Error(`El catálogo devolvió una respuesta inválida para "${track.title}".`);
  }

  const safeBase =
    `${track.artist ? `${track.artist} - ` : ''}${track.title}`
      .replace(/[\\/:*?"<>|]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 100) || `track-${track.id}`;

  const rawMime = resp.headers.get('content-type') || rawBlob.type || 'audio/mpeg';
  const mime = containerInfo.mimeType ?? rawMime;
  let finalBlob: Blob =
    containerInfo.mimeType && rawBlob.type !== containerInfo.mimeType
      ? new Blob([rawBlob], { type: containerInfo.mimeType })
      : rawBlob;

  if (containerInfo.fragmentedMp4) {
    const fullBytes = new Uint8Array(await rawBlob.arrayBuffer());
    const remuxed = remuxFragmentedMp4ToStandardM4a(fullBytes);
    if (remuxed) {
      finalBlob = new Blob([new Uint8Array(remuxed)], { type: 'audio/mp4' });
    }
  }

  const ext =
    containerInfo.kind === 'ogg' || mime.includes('ogg')
      ? '.ogg'
      : mime.includes('opus')
        ? '.opus'
        : containerInfo.kind === 'flac' || mime.includes('flac')
          ? '.flac'
          : containerInfo.kind === 'wav' || mime.includes('wav')
            ? '.wav'
            : containerInfo.kind === 'aac'
              ? '.aac'
              : containerInfo.kind === 'mp4' || mime.includes('mp4') || mime.includes('m4a')
                ? '.m4a'
                : '.mp3';

  return new File([finalBlob], `${safeBase}${ext}`, { type: mime });
}
