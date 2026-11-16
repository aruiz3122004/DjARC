import { createStore, get, set } from 'idb-keyval';
import type { AppSettings, Playlist, Track } from '../types';

const metaStore = createStore('gradmix-meta-db', 'gradmix-meta-store');

const KEYS = {
  TRACKS: 'tracks_v1',
  PLAYLISTS: 'playlists_v1',
  SETTINGS: 'settings_v1',
} as const;

export const DEFAULT_PLAYLIST_ID = 'pl-main-party';

export const DEFAULT_SETTINGS: AppSettings = {
  crossfadeSeconds: 8,
  autoDjEnabled: true,
  shuffle: false,
  repeatMode: 'all',
  masterVolume: 0.92,
  activePlaylistId: DEFAULT_PLAYLIST_ID,
  theme: 'dark',
  storageMode: 'browser',
  storage90Declined: false,
  deviceStorageName: '',
};

export function createDefaultPlaylists(): Playlist[] {
  const now = Date.now();
  return [
    {
      id: DEFAULT_PLAYLIST_ID,
      name: 'Playlist Principal',
      block: 'Fiesta Principal',
      trackIds: [],
      createdAt: now,
      updatedAt: now,
    },
  ];
}

export async function loadTracks(): Promise<Track[]> {
  const saved = await get<Track[]>(KEYS.TRACKS, metaStore);
  return Array.isArray(saved) ? saved : [];
}

export async function saveTracks(tracks: Track[]): Promise<void> {
  await set(KEYS.TRACKS, tracks, metaStore);
}

export async function loadPlaylists(): Promise<Playlist[]> {
  const saved = await get<Playlist[]>(KEYS.PLAYLISTS, metaStore);
  if (Array.isArray(saved) && saved.length > 0) {
    // Limpiar playlists vacías antiguas heredadas de versiones iniciales
    const cleaned = saved.filter(
      (p) =>
        p.id === DEFAULT_PLAYLIST_ID ||
        p.trackIds.length > 0 ||
        (p.id !== 'pl-warmup' && p.id !== 'pl-horaloca')
    );
    if (cleaned.length > 0) {
      if (cleaned.length !== saved.length) {
        await savePlaylists(cleaned);
      }
      return cleaned;
    }
  }
  const defaults = createDefaultPlaylists();
  await savePlaylists(defaults);
  return defaults;
}

export async function savePlaylists(playlists: Playlist[]): Promise<void> {
  await set(KEYS.PLAYLISTS, playlists, metaStore);
}

export async function loadSettings(): Promise<AppSettings> {
  const saved = await get<Partial<AppSettings>>(KEYS.SETTINGS, metaStore);
  return {
    ...DEFAULT_SETTINGS,
    ...(saved ?? {}),
  };
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  await set(KEYS.SETTINGS, settings, metaStore);
}
