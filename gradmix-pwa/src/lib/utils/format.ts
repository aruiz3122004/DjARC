/**
 * Utilidades de formateo de tiempo, tamaño y extracción limpia de metadatos desde nombre de archivo.
 */

export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const total = Math.floor(seconds);
  const hrs = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hrs > 0) {
    return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

export function formatDurationTotal(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0 min';
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.round((seconds % 3600) / 60);
  if (hrs === 0) return `${mins} min`;
  return `${hrs}h ${String(mins).padStart(2, '0')}m`;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const exp = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, exp);
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[exp]}`;
}

export function cleanDisplayTitle(raw: string): string {
  return raw
    .replace(/\(\s*(?:m4a|mp3|wav|flac|ogg|aac|opus)\s*\d*\s*k?(?:bps)?\s*\)/gi, '')
    .replace(/\[\s*(?:m4a|mp3|wav|flac|ogg|aac|opus)\s*\d*\s*k?(?:bps)?\s*\]/gi, '')
    .replace(/\(\s*official\s+(?:music\s+)?video\s*\)/gi, '')
    .replace(/\[\s*official\s+(?:music\s+)?video\s*\]/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function cleanDisplayArtist(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.toLowerCase() === 'biblioteca local') {
    return '';
  }
  return trimmed;
}

export function parseTrackFilename(fileName: string): { title: string; artist: string } {
  const withoutExt = fileName.replace(/\.[^.]+$/, '').trim();
  const cleaned = cleanDisplayTitle(
    withoutExt
      .replace(/^\d{1,3}[\s._-]+/, '')
      .replace(/_/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  );

  const separators = [' - ', ' – ', ' — '];
  for (const sep of separators) {
    const idx = cleaned.indexOf(sep);
    if (idx > 0 && idx < cleaned.length - sep.length) {
      const artist = cleanDisplayArtist(cleaned.slice(0, idx));
      const title = cleanDisplayTitle(cleaned.slice(idx + sep.length));
      if (title) {
        return { title, artist };
      }
    }
  }

  return {
    title: cleaned || fileName,
    artist: '',
  };
}

export function generateTrackId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `trk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

export const SUPPORTED_AUDIO_EXT =
  /\.(mp3|wav|wave|m4a|m4b|m4p|m4r|mp4|aac|ogg|oga|opus|flac|webm|weba|3gp|3gpp|amr|aif|aiff|aifc|caf|wma|alac|ac3|mka)$/i;

export const AUDIO_ACCEPT_ATTR =
  'audio/*,.mp3,.wav,.wave,.m4a,.m4b,.mp4,.aac,.ogg,.oga,.opus,.flac,.webm,.weba,.3gp,.amr,.aif,.aiff,.caf,.wma,.mka';

const MIME_BY_EXT: Record<string, string> = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  wave: 'audio/wav',
  m4a: 'audio/mp4',
  m4b: 'audio/mp4',
  m4p: 'audio/mp4',
  m4r: 'audio/mp4',
  mp4: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/opus',
  flac: 'audio/flac',
  webm: 'audio/webm',
  weba: 'audio/webm',
  '3gp': 'audio/3gpp',
  '3gpp': 'audio/3gpp',
  amr: 'audio/amr',
  aif: 'audio/aiff',
  aiff: 'audio/aiff',
  aifc: 'audio/aiff',
  caf: 'audio/x-caf',
  wma: 'audio/x-ms-wma',
  alac: 'audio/mp4',
  ac3: 'audio/ac3',
  mka: 'audio/x-matroska',
};

export function inferAudioMimeType(fileName: string, explicitMime?: string): string {
  if (explicitMime && (explicitMime.startsWith('audio/') || explicitMime === 'application/ogg')) {
    return explicitMime;
  }
  const match = fileName.toLowerCase().match(/\.([a-z0-9]+)$/);
  if (match && MIME_BY_EXT[match[1]]) {
    return MIME_BY_EXT[match[1]];
  }
  return 'audio/mpeg';
}

export function isSupportedAudioFile(file: File): boolean {
  if (file.type) {
    if (file.type.startsWith('audio/') || file.type === 'application/ogg') return true;
    if (
      (file.type === 'video/mp4' || file.type === 'video/webm' || file.type === 'video/3gpp') &&
      SUPPORTED_AUDIO_EXT.test(file.name)
    ) {
      return true;
    }
  }
  return SUPPORTED_AUDIO_EXT.test(file.name);
}
