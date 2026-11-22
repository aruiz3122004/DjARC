import type { AppSettings, Playlist, SessionExportPayload, Track } from '../types';
import { formatDurationTotal, formatTime } from './format';

/**
 * Construye el mensaje corto y enlace `https://wa.me/?text=...` con el link cifrado
 * para que el receptor abra la playlist, la escuche al instante o la descargue.
 */
export function buildWhatsAppShareUrl(
  playlist: Playlist,
  tracks: Track[],
  shareUrl: string
): { url: string; message: string } {
  const totalSec = tracks.reduce((sum, t) => sum + (t.duration || 0), 0);
  const message = [
    `🎧 *GradMix — ${playlist.name}*`,
    `🎵 ${tracks.length} canciones (${formatDurationTotal(totalSec)})`,
    `🔒 Enlace cifrado — abre para reproducir al instante sin descargar o guardar la playlist:`,
    shareUrl,
  ].join('\n');

  const url = `https://wa.me/?text=${encodeURIComponent(message)}`;
  return { url, message };
}

/**
 * Exporta un archivo .json ligero con la configuración de sesión y el orden de pistas
 * (sin archivos de audio pesados) para compartir o respaldar la estructura del evento.
 */
export function exportPlaylistSessionJson(
  playlist: Playlist,
  tracks: Track[],
  settings: Pick<AppSettings, 'crossfadeSeconds' | 'shuffle' | 'repeatMode' | 'autoDjEnabled'>
): void {
  const payload: SessionExportPayload = {
    app: 'GradMix',
    version: 1,
    exportedAt: new Date().toISOString(),
    settings: {
      crossfadeSeconds: settings.crossfadeSeconds,
      shuffle: settings.shuffle,
      repeatMode: settings.repeatMode,
      autoDjEnabled: settings.autoDjEnabled,
    },
    playlistName: playlist.name,
    tracks: tracks.map((t) => ({
      title: t.title,
      artist: t.artist,
      fileName: t.fileName,
      duration: t.duration,
      bpm: t.bpm,
      block: t.block,
    })),
  };

  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const safeName = playlist.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  a.href = url;
  a.download = `gradmix-${safeName || 'session'}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
