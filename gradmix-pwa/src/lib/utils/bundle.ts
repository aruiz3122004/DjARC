import type { PartyBlock, Playlist, Track } from '../types';
import { inspectAudioContainer, remuxFragmentedMp4ToStandardM4a } from '../audio/audioContainer';
import { readAudioArrayBuffer } from '../storage/opfsStorage';
import { cleanDisplayArtist, cleanDisplayTitle } from './format';
import { buildZipBlobFromEntries, sanitizeZipEntryFileName } from './zip';

const MAGIC = 'GMXB';
const VERSION = 1;

export interface BundleTrackManifest {
  title: string;
  artist: string;
  fileName: string;
  duration: number;
  bpm: number | null;
  block: PartyBlock;
  mimeType: string;
  byteLength: number;
}

export interface BundleManifest {
  app: 'GradMix';
  version: number;
  playlistName: string;
  block: PartyBlock;
  createdAt: number;
  tracks: BundleTrackManifest[];
}

/**
 * Empaqueta una playlist completa (metadatos + archivos de audio binarios desde OPFS)
 * en un único Blob binario `.gradmix` para guardar en el almacenamiento interno.
 */
export async function buildGradmixBundleBlob(
  playlist: Playlist,
  tracks: Track[],
  onProgress?: (done: number, total: number) => void
): Promise<Blob> {
  const manifestTracks: BundleTrackManifest[] = [];
  const binaryParts: Blob[] = [];

  for (let i = 0; i < tracks.length; i++) {
    const t = tracks[i];
    const buf = await readAudioArrayBuffer(t.opfsKey);
    const blob = new Blob([buf], { type: t.mimeType || 'audio/mpeg' });
    binaryParts.push(blob);
    manifestTracks.push({
      title: t.title,
      artist: t.artist,
      fileName: t.fileName,
      duration: t.duration,
      bpm: t.bpm,
      block: t.block,
      mimeType: t.mimeType || 'audio/mpeg',
      byteLength: blob.size,
    });
    onProgress?.(i + 1, tracks.length);
  }

  const manifest: BundleManifest = {
    app: 'GradMix',
    version: VERSION,
    playlistName: playlist.name,
    block: playlist.block,
    createdAt: Date.now(),
    tracks: manifestTracks,
  };

  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
  const header = new ArrayBuffer(9);
  const view = new DataView(header);
  for (let i = 0; i < 4; i++) {
    view.setUint8(i, MAGIC.charCodeAt(i));
  }
  view.setUint8(4, VERSION);
  view.setUint32(5, manifestBytes.byteLength, false);

  return new Blob([header, manifestBytes, ...binaryParts], {
    type: 'application/octet-stream',
  });
}

/**
 * Empaqueta cada canción de la playlist como archivo independiente dentro de un `.zip` estándar,
 * normalizando contenedores fMP4 a `.m4a` estándar para preservar la duración real en reproductores externos.
 */
export async function buildPlaylistZipBlob(
  tracks: Track[],
  onProgress?: (done: number, total: number) => void
): Promise<Blob> {
  const usedNames = new Set<string>();
  const entries: Array<{ fileName: string; bytes: Uint8Array; modifiedAt?: number }> = [];

  for (let i = 0; i < tracks.length; i++) {
    const t = tracks[i];
    const buf = await readAudioArrayBuffer(t.opfsKey);
    let audioBytes = new Uint8Array(buf);
    const info = inspectAudioContainer(audioBytes);
    if (info.fragmentedMp4 && !info.encrypted) {
      const remuxed = remuxFragmentedMp4ToStandardM4a(audioBytes);
      if (remuxed) {
        audioBytes = new Uint8Array(remuxed);
      }
    }

    let sourceNameForExt = t.fileName;
    if (info.kind === 'mp4') sourceNameForExt = 'track.m4a';
    else if (info.kind === 'mp3') sourceNameForExt = 'track.mp3';
    else if (info.kind === 'aac') sourceNameForExt = 'track.aac';
    else if (info.kind === 'ogg') sourceNameForExt = 'track.ogg';
    else if (info.kind === 'flac') sourceNameForExt = 'track.flac';
    else if (info.kind === 'wav') sourceNameForExt = 'track.wav';
    else if (info.kind === 'webm') sourceNameForExt = 'track.webm';

    const title = cleanDisplayTitle(t.title) || t.title || 'Pista';
    const artist = cleanDisplayArtist(t.artist);
    entries.push({
      fileName: sanitizeZipEntryFileName(title, artist, sourceNameForExt, usedNames),
      bytes: audioBytes,
      modifiedAt: t.addedAt,
    });
    onProgress?.(i + 1, tracks.length);
  }

  return await buildZipBlobFromEntries(entries);
}

/**
 * Lee un archivo `.gradmix` desde el almacenamiento interno usando `Blob.slice()`
 * para evitar duplicar todo el archivo en RAM durante la importación.
 */
export async function parseGradmixBundleFile(
  file: File
): Promise<{ manifest: BundleManifest; slices: Blob[] }> {
  if (file.size < 9) {
    throw new Error('Archivo .gradmix inválido o corrupto.');
  }

  const headerBuf = await file.slice(0, 9).arrayBuffer();
  const view = new DataView(headerBuf);
  const magic = String.fromCharCode(
    view.getUint8(0),
    view.getUint8(1),
    view.getUint8(2),
    view.getUint8(3)
  );
  if (magic !== MAGIC) {
    throw new Error('Formato no reconocido. Se esperaba un archivo .gradmix.');
  }

  const version = view.getUint8(4);
  if (version !== VERSION) {
    throw new Error(`Versión de paquete no soportada (${version}).`);
  }

  const manifestLen = view.getUint32(5, false);
  if (9 + manifestLen > file.size) {
    throw new Error('El manifiesto del paquete está incompleto.');
  }

  const manifestText = await file.slice(9, 9 + manifestLen).text();
  const manifest = JSON.parse(manifestText) as BundleManifest;
  if (manifest.app !== 'GradMix' || !Array.isArray(manifest.tracks)) {
    throw new Error('Contenido de paquete .gradmix inválido.');
  }

  const slices: Blob[] = [];
  let cursor = 9 + manifestLen;
  for (const item of manifest.tracks) {
    if (cursor + item.byteLength > file.size) {
      throw new Error(`Pista "${item.title}" truncada dentro del paquete.`);
    }
    slices.push(file.slice(cursor, cursor + item.byteLength, item.mimeType || 'audio/mpeg'));
    cursor += item.byteLength;
  }

  return { manifest, slices };
}

/**
 * Extrae el ID del bundle desde un link completo (`https://.../?import=ABC123`) o un código directo.
 */
export function extractBundleIdFromInput(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  try {
    const url = new URL(trimmed);
    const param = url.searchParams.get('import');
    if (param) {
      return param.trim().toUpperCase();
    }
  } catch {
    // No es URL completa, puede ser parámetro o código directo
  }

  const match = trimmed.match(/[?&]import=([A-Za-z0-9_-]+)/);
  if (match) {
    return match[1].toUpperCase();
  }

  if (/^[A-Za-z0-9_-]{4,24}$/.test(trimmed)) {
    return trimmed.toUpperCase();
  }

  return null;
}
