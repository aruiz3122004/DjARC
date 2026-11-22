export type DeckId = 'A' | 'B';

export type RepeatMode = 'off' | 'all' | 'one';

export type PlaybackStatus = 'idle' | 'loading' | 'playing' | 'paused';

export type SortOrder = 'manual' | 'bpm-asc' | 'bpm-desc' | 'title-asc' | 'recent';

export type ThemeMode = 'dark' | 'light';

export type AppModule =
  | 'player'
  | 'playlists'
  | 'favorites'
  | 'monitoring'
  | 'room'
  | 'faq'
  | 'search';

export interface AccordionItem {
  id: string;
  category: string;
  question: string;
  answer: string;
}

export interface AudiusCatalogTrack {
  id: string;
  title: string;
  artist: string;
  duration: number;
  genre: string;
  artworkUrl: string | null;
  host: string;
}

export type PartyBlock =
  | 'Calentamiento'
  | 'Cóctel'
  | 'Cena'
  | 'Fiesta Principal'
  | 'Hora Loca'
  | 'Cierre';

export interface Track {
  id: string;
  fileName: string;
  opfsKey: string;
  title: string;
  artist: string;
  duration: number;
  sizeBytes: number;
  mimeType: string;
  bpm: number | null;
  bpmStatus: 'pending' | 'analyzing' | 'done' | 'error';
  block: PartyBlock;
  playCount: number;
  favorite?: boolean;
  addedAt: number;
  /** ID en catálogo público remoto (si proviene de SoundCloud/Audius) para compartir sin servidor. */
  catalogId?: string;
}

export interface SharedPlaylistTrack {
  index: number;
  trackId: string;
  title: string;
  artist: string;
  duration: number;
  mimeType: string;
  fileName: string;
  catalogId?: string;
}

export interface SharedPlaylistPreview {
  title: string;
  block: PartyBlock;
  sourceKind: 'catalog-share' | 'bundle';
  isEncrypted: boolean;
  isZeroServer: boolean;
  tracks: SharedPlaylistTrack[];
  loadingTrackIndex: number | null;
  downloading: boolean;
}

export interface Playlist {
  id: string;
  name: string;
  block: PartyBlock;
  trackIds: string[];
  createdAt: number;
  updatedAt: number;
}

export interface DeckSnapshot {
  id: DeckId;
  trackId: string | null;
  title: string;
  artist: string;
  bpm: number | null;
  duration: number;
  elapsed: number;
  gain: number;
  state: 'empty' | 'preloading' | 'ready' | 'playing' | 'paused' | 'fading-out';
  hasBufferInRam: boolean;
}

export interface AudioEngineSnapshot {
  status: PlaybackStatus;
  activeDeck: DeckId;
  deckA: DeckSnapshot;
  deckB: DeckSnapshot;
  currentTrackId: string | null;
  nextTrackId: string | null;
  upNextTrackIds: string[];
  elapsed: number;
  duration: number;
  crossfading: boolean;
  crossfadeProgress: number;
  crossfadeSeconds: number;
  autoDjEnabled: boolean;
  shuffle: boolean;
  repeatMode: RepeatMode;
  masterVolume: number;
  ramBuffersCount: number;
  ramBufferBytes: number;
  audioContextState: AudioContextState | 'uninitialized';
  unlocked: boolean;
  lastError: string | null;
}

export interface AppSettings {
  crossfadeSeconds: number;
  autoDjEnabled: boolean;
  shuffle: boolean;
  repeatMode: RepeatMode;
  masterVolume: number;
  activePlaylistId: string;
  theme: ThemeMode;
  storageMode?: 'browser' | 'device';
  storage90Declined?: boolean;
  deviceStorageName?: string;
}

export interface RoomPermissions {
  canSkip: boolean;
  canPause: boolean;
  canAdd: boolean;
  canRemove: boolean;
}

export interface RoomParticipant {
  id: string;
  name: string;
  isHost: boolean;
  joinedAt: number;
  lastSeenAt?: number;
  deviceId?: string;
  permissions: RoomPermissions;
}

export interface RoomTrackItem {
  id: string;
  title: string;
  artist: string;
  duration: number;
  addedById: string;
  addedByName: string;
  addedAt: number;
  hasAudioRelay: boolean;
}

export interface RoomQueuePreviewItem {
  id: string;
  title: string;
  artist: string;
  duration: number;
}

export interface RoomPublicState {
  code: string;
  hostId: string;
  inviteToken?: string;
  createdAt: number;
  expiresAt: number;
  maxDurationHours: number;
  participants: RoomParticipant[];
  tracks: RoomTrackItem[];
  playbackQueue?: RoomQueuePreviewItem[];
  nowPlayingTitle: string | null;
  nowPlayingArtist?: string | null;
  nowPlayingTrackKey?: string | null;
  hasLiveAudio?: boolean;
  basePositionSec?: number;
  playbackSyncedAtMs?: number;
  isPlaying: boolean;
}

export interface SessionExportPayload {
  app: 'GradMix';
  version: 1;
  exportedAt: string;
  settings: Pick<AppSettings, 'crossfadeSeconds' | 'shuffle' | 'repeatMode' | 'autoDjEnabled'>;
  playlistName: string;
  tracks: Array<{
    title: string;
    artist: string;
    fileName: string;
    duration: number;
    bpm: number | null;
    block: PartyBlock;
  }>;
}
