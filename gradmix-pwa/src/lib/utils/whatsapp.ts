import type { AppSettings, Playlist, SessionExportPayload, Track } from '../types';
import { formatDurationTotal, formatTime } from './format';

/**
 * Construye el texto y enlace `https://wa.me/?text=...` para compartir
 * el setlist completo de la fiesta por WhatsApp.
 */
export function buildWhatsAppShareUrl(
  playlist: Playlist,
  tracks: Track[],
  crossfadeSeconds: number
): { url: string; message: string } {
  const totalSec = tracks.reduce((sum, t) => sum + (t.duration || 0), 0);
  const header = [
    `🎧 *GradMix Auto-DJ* — *${playlist.name}*`,
    `📦 Bloque: ${playlist.block} | 🎵 ${tracks.length} canciones (${formatDurationTotal(totalSec)})`,
    `🎚️ Crossfade Equal-Power: ${crossfadeSeconds}s`,
    '',
    '*Tracklist:*',
  ];

  const maxLines = 40;
  const lines = tracks.slice(0, maxLines).map((track, idx) => {
    const bpmTag = track.bpm ? ` · ${track.bpm} BPM` : '';
    return `${idx + 1}. ${track.title} — ${track.artist} (${formatTime(track.duration)}${bpmTag})`;
  });

  if (tracks.length > maxLines) {
    lines.push(`... y ${tracks.length - maxLines} canciones más.`);
  }

  lines.push('', '🚀 Reproducido 100% offline con GradMix PWA');

  const message = [...header, ...lines].join('\n');
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
