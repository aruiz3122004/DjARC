<script lang="ts">
  import { onDestroy, onMount, untrack } from 'svelte';
  import BlackoutOverlay from './components/BlackoutOverlay.svelte';
  import BottomPlayerBar from './components/BottomPlayerBar.svelte';
  import ConfirmModal from './components/ConfirmModal.svelte';
  import CrossfadeControl from './components/CrossfadeControl.svelte';
  import FaqView from './components/FaqView.svelte';
  import FavoritesView from './components/FavoritesView.svelte';
  import MonitoringView from './components/MonitoringView.svelte';
  import PlayerDeck from './components/PlayerDeck.svelte';
  import PlaylistManager from './components/PlaylistManager.svelte';
  import RoomView from './components/RoomView.svelte';
  import SearchResultsView from './components/SearchResultsView.svelte';
  import SidebarNav from './components/SidebarNav.svelte';
  import {
    downloadAudiusTrackAsFile,
    fetchAudiusTrending,
    searchAudiusTracks,
  } from './lib/api/audius';
  import { apiUrl, apiWsUrl } from './lib/api/base';
  import { GradMixAudioEngine } from './lib/audio/audioEngine';
  import { WakeLockManager } from './lib/audio/wakeLock';
  import { IsolatedSearchEngine } from './lib/search/searchEngine';
  import {
    createDefaultPlaylists,
    DEFAULT_PLAYLIST_ID,
    DEFAULT_SETTINGS,
    loadPlaylists,
    loadSettings,
    loadTracks,
    savePlaylists,
    saveSettings,
    saveTracks,
  } from './lib/storage/db';
  import {
    buildSafeOpfsKey,
    clearAllAudioFiles,
    deleteAudioFile,
    getDeviceDirectoryHandle,
    getStorageUsage,
    isDeviceDirectoryPickerSupported,
    pickDeviceStorageDirectory,
    readAudioArrayBuffer,
    readAudioBlob,
    requestPersistentStorage,
    saveAudioFile,
    type StorageUsageInfo,
  } from './lib/storage/opfsStorage';
  import type {
    AppModule,
    AppSettings,
    AudioEngineSnapshot,
    AudiusCatalogTrack,
    PartyBlock,
    Playlist,
    RepeatMode,
    RoomPermissions,
    RoomPublicState,
    SortOrder,
    Track,
  } from './lib/types';
  import { extractAudioTags } from './lib/utils/audioTags';
  import {
    buildPlaylistZipBlob,
    extractBundleIdFromInput,
    parseGradmixBundleFile,
    type BundleTrackManifest,
  } from './lib/utils/bundle';
  import {
    cleanDisplayArtist,
    cleanDisplayTitle,
    generateTrackId,
    inferAudioMimeType,
    isSupportedAudioFile,
    parseTrackFilename,
  } from './lib/utils/format';
  import { createRequestId, IdempotentController } from './lib/utils/idempotency';
  import { sortTrackIds } from './lib/utils/queue';
  import { buildWhatsAppShareUrl } from './lib/utils/whatsapp';
  import { parsePlaylistZipFile } from './lib/utils/zip';
  import { BpmAnalyzerQueue } from './lib/workers/bpmAnalyzer';

  let tracks = $state<Track[]>([]);
  let playlists = $state<Playlist[]>(createDefaultPlaylists());
  let settings = $state<AppSettings>({ ...DEFAULT_SETTINGS });
  let ready = $state(false);

  let activeModule = $state<AppModule>('player');
  let mobileMenuOpen = $state(false);
  let blackoutActive = $state(false);
  let wakeLockActive = $state(false);

  let storageInfo = $state<StorageUsageInfo>({
    supportedOpfs: true,
    usageBytes: 0,
    quotaBytes: 0,
    persisted: false,
  });

  let importing = $state(false);
  let importProgress = $state<{ done: number; total: number } | null>(null);
  let bundleBusy = $state(false);
  let bundleStatusText = $state<string | null>(null);
  let lastExportedLink = $state<string | null>(null);
  let storageWarningDismissed = $state(false);
  let lastStorageAlertShown = false;
  let playerPlaylistExpanded = $state(false);
  let confirmClosePlaylistOpen = $state(false);
  let confirmLeaveRoomOpen = $state(false);
  let roomEvictionAlert = $state<string | null>(null);
  let storagePromptMode = $state<'recommend' | 'mandatory' | null>(null);
  let pendingAddTrackToPlaylist = $state<Track | null>(null);
  let globalSearchQuery = $state('');
  let searchDropdownOpen = $state(false);
  let audiusResults = $state<AudiusCatalogTrack[]>([]);
  let audiusLoading = $state(false);
  let audiusError = $state<string | null>(null);
  let downloadingAudiusId = $state<string | null>(null);
  let audiusDebounceTimer: number | null = null;
  let audiusRequestSeq = 0;
  let toastMessage = $state<string | null>(null);
  let toastTimer: number | null = null;

  // Estado de Sala Colaborativa (WebSocket en tiempo real + respaldo)
  let room = $state<RoomPublicState | null>(null);
  let roomParticipantId = $state<string | null>(null);
  let roomError = $state<string | null>(null);
  let uploadingToRoom = $state(false);
  let pendingRoomInvite = $state<{ code: string; token: string } | null>(null);
  let ephemeralTracks = $state<Track[]>([]);
  let busyFlags = $state<string[]>([]);
  const actionController = new IdempotentController((keys) => {
    busyFlags = keys;
  });
  let roomActionBusy = $derived(busyFlags.some((k) => k.startsWith('room:')));
  let playlistActionBusy = $derived(busyFlags.some((k) => k.startsWith('pl:')));
  let searchActionBusy = $derived(busyFlags.some((k) => k.startsWith('search:')));
  let playerActionBusy = $derived(busyFlags.some((k) => k.startsWith('player:')));
  let roomSocket: WebSocket | null = null;
  let roomEventSource: EventSource | null = null;
  let roomReconnectTimer: number | null = null;
  let roomPollTimer: number | null = null;
  let roomHeartbeatTimer: number | null = null;
  let activeRoomSession: { code: string; participantId: string } | null = null;
  const roomTrackToLocalId = new Map<string, string>();
  let lastRoomSyncKey = '';
  let lastUploadedNowAudioKey = '';
  let guestMuted = $state(false);
  let guestAudioBlocked = $state(false);
  let guestAudioEl: HTMLAudioElement | null = null;
  let guestAudioLoadedKey = '';
  let lastGuestAudioHeartbeatMs = 0;
  let roomBackGuardPushed = false;

  function sendGuestAudioHeartbeatNow() {
    if (!activeRoomSession) return;
    const now = Date.now();
    if (now - lastGuestAudioHeartbeatMs < 2800) return;
    lastGuestAudioHeartbeatMs = now;
    const { code, participantId } = activeRoomSession;
    if (roomSocket && roomSocket.readyState === WebSocket.OPEN) {
      try {
        roomSocket.send(
          JSON.stringify({ type: 'audio-heartbeat', receivingAudio: true, muted: guestMuted })
        );
        return;
      } catch {
        // Fallback a HTTP
      }
    }
    void fetch(apiUrl(`/api/rooms/${encodeURIComponent(code)}/heartbeat`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ participantId }),
    }).catch(() => {});
  }

  function getOrCreateDeviceId(): string {
    try {
      const existing = localStorage.getItem('gradmix_device_id');
      if (existing) return existing;
      const fresh = `dev-${generateTrackId()}`;
      localStorage.setItem('gradmix_device_id', fresh);
      return fresh;
    } catch {
      return `dev-${generateTrackId()}`;
    }
  }

  const searchEngine = new IsolatedSearchEngine();

  const engine = new GradMixAudioEngine((playedTrackId) => {
    incrementPlayCount(playedTrackId);
  });

  let engineSnapshot = $state<AudioEngineSnapshot>(engine.getSnapshot());

  const wakeLock = new WakeLockManager((active) => {
    wakeLockActive = active;
  });

  const bpmAnalyzer = new BpmAnalyzerQueue((trackId, bpm, detectedDuration) => {
    let changed = false;
    tracks = tracks.map((t) => {
      if (t.id !== trackId) return t;
      changed = true;
      return {
        ...t,
        bpm,
        bpmStatus: bpm ? 'done' : 'error',
        duration: t.duration > 0 ? t.duration : (detectedDuration ?? 0),
      };
    });
    if (changed) {
      void saveTracks($state.snapshot(tracks));
    }
  });

  let tracksById = $derived(new Map(tracks.map((t) => [t.id, t])));
  let ephemeralById = $derived(new Map(ephemeralTracks.map((t) => [t.id, t])));

  function resolveKnownTrack(id: string): Track | null {
    return tracksById.get(id) ?? ephemeralById.get(id) ?? null;
  }

  function registerEphemeralTrack(tempTrack: Track) {
    const filtered = ephemeralTracks.filter((t) => t.id !== tempTrack.id);
    ephemeralTracks = [...filtered.slice(-23), tempTrack];
  }

  let activePlaylist = $derived(
    playlists.find((p) => p.id === settings.activePlaylistId) ?? playlists[0]
  );

  let favoriteTracks = $derived(tracks.filter((t) => Boolean(t.favorite)));

  let currentTrack = $derived(
    engineSnapshot.currentTrackId ? resolveKnownTrack(engineSnapshot.currentTrackId) : null
  );

  let nextTrack = $derived(
    engineSnapshot.nextTrackId ? resolveKnownTrack(engineSnapshot.nextTrackId) : null
  );

  let upNextTracks = $derived(
    engineSnapshot.upNextTrackIds
      .map((id) => resolveKnownTrack(id))
      .filter((t): t is Track => t !== null)
  );

  let storagePercent = $derived(
    storageInfo.quotaBytes > 0
      ? Math.min(100, (storageInfo.usageBytes / storageInfo.quotaBytes) * 100)
      : 0
  );

  let activePlaylistTracks = $derived.by(() => {
    if (!activePlaylist) return [] as Track[];
    const list: Track[] = [];
    for (const id of activePlaylist.trackIds) {
      const trk = tracksById.get(id);
      if (trk) list.push(trk);
    }
    return list;
  });

  let activePlaylistDuration = $derived(
    activePlaylistTracks.reduce((sum, t) => sum + (t.duration || 0), 0)
  );

  let hasPlaylistInPlayback = $derived(
    Boolean(engineSnapshot.currentTrackId) &&
      Boolean(activePlaylist) &&
      activePlaylistTracks.length > 0 &&
      activePlaylist!.trackIds.includes(engineSnapshot.currentTrackId!)
  );

  let showBottomPlaylistBar = $derived(
    currentTrack !== null &&
      (activeModule !== 'player' || hasPlaylistInPlayback || upNextTracks.length > 0)
  );

  let localSearchMatches = $derived(
    ready ? searchEngine.searchLocal(globalSearchQuery, 30) : []
  );

  let cachedAudiusMatches = $derived(
    globalSearchQuery.trim() ? searchEngine.searchCachedAudius(globalSearchQuery, 5) : []
  );

  // Sincroniza únicamente referencias en memoria RAM (cero lecturas a IndexedDB/OPFS al buscar)
  $effect(() => {
    searchEngine.syncMemoryIndex(tracks, playlists);
  });

  function showToast(msg: string) {
    toastMessage = msg;
    if (toastTimer !== null) window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => {
      toastMessage = null;
    }, 3000);
  }

  function incrementPlayCount(trackId: string) {
    tracks = tracks.map((t) =>
      t.id === trackId ? { ...t, playCount: (t.playCount ?? 0) + 1 } : t
    );
    void saveTracks($state.snapshot(tracks));
  }

  // Aplicar tema Claro / Oscuro OLED al documento
  $effect(() => {
    const html = document.documentElement;
    if (settings.theme === 'light') {
      html.classList.remove('dark');
      html.classList.add('light');
    } else {
      html.classList.remove('light');
      html.classList.add('dark');
    }
    const metaTheme = document.querySelector('meta[name="theme-color"]');
    if (metaTheme) {
      metaTheme.setAttribute('content', settings.theme === 'light' ? '#f6f7f9' : '#000000');
    }
  });

  // Sincronizar biblioteca y playlist activa (o pista independiente) con el motor de audio
  $effect(() => {
    if (!ready) return;
    const combinedTracks = ephemeralTracks.length > 0 ? [...tracks, ...ephemeralTracks] : tracks;
    const activePlTrackIds = activePlaylist ? activePlaylist.trackIds : [];

    untrack(() => {
      const currentId = engineSnapshot.currentTrackId;
      const isStandalonePlaying = Boolean(currentId) && ephemeralById.has(currentId!);
      const plTrackIds = isStandalonePlaying ? [currentId!] : activePlTrackIds;
      engine.syncLibrary(combinedTracks, plTrackIds);
    });
  });

  // Wake Lock automático mientras suena la fiesta o en Ahorro de batería
  $effect(() => {
    if (blackoutActive || engineSnapshot.status === 'playing') {
      void wakeLock.enable();
    } else {
      void wakeLock.disable();
    }
  });

  async function publishHostNowAudio(code: string, hostId: string, trk: Track) {
    try {
      const mem = engine.getMemoryBlob(trk.id);
      const blob =
        mem ??
        (await readAudioBlob(trk.opfsKey, inferAudioMimeType(trk.fileName, trk.mimeType)).catch(
          () => null
        ));
      if (!blob || blob.size === 0 || blob.size > 35 * 1024 * 1024) return;
      await fetch(apiUrl(`/api/rooms/${encodeURIComponent(code)}/now-audio`), {
        method: 'POST',
        headers: {
          'Content-Type': inferAudioMimeType(trk.fileName, blob.type || trk.mimeType),
          'x-host-id': hostId,
          'x-track-key': trk.id,
        },
        body: blob,
      });
    } catch {
      // Ignorar fallo puntual al subir pista activa a la sala
    }
  }

  function teardownGuestRoomAudio() {
    if (guestAudioEl) {
      try {
        guestAudioEl.pause();
        guestAudioEl.removeAttribute('src');
        guestAudioEl.load();
      } catch {
        // Ignorar
      }
      guestAudioEl = null;
    }
    guestAudioLoadedKey = '';
    guestAudioBlocked = false;
  }

  function syncGuestRoomPlayback(activeRoom: RoomPublicState, pid: string) {
    if (!activeRoom.hasLiveAudio || !activeRoom.nowPlayingTrackKey) {
      if (guestAudioEl) guestAudioEl.pause();
      return;
    }

    if (!guestAudioEl) {
      guestAudioEl = new Audio();
      guestAudioEl.preload = 'auto';
      guestAudioEl.setAttribute('playsinline', 'true');
      guestAudioEl.ontimeupdate = () => {
        sendGuestAudioHeartbeatNow();
      };
    }
    guestAudioEl.muted = guestMuted;

    const desiredKey = activeRoom.nowPlayingTrackKey;
    if (guestAudioLoadedKey !== desiredKey) {
      guestAudioLoadedKey = desiredKey;
      guestAudioEl.src = apiUrl(
        `/api/rooms/${encodeURIComponent(activeRoom.code)}/now-audio?participantId=${encodeURIComponent(pid)}&trackKey=${encodeURIComponent(desiredKey)}`
      );
      guestAudioEl.load();
    }

    const basePos = activeRoom.basePositionSec ?? 0;
    const syncedAt = activeRoom.playbackSyncedAtMs ?? Date.now();
    const estimatedSec = basePos + (activeRoom.isPlaying ? Math.max(0, (Date.now() - syncedAt) / 1000) : 0);

    if (activeRoom.isPlaying) {
      const seekAndPlay = () => {
        if (!guestAudioEl) return;
        if (
          Number.isFinite(guestAudioEl.duration) &&
          guestAudioEl.duration > 0 &&
          Math.abs(guestAudioEl.currentTime - estimatedSec) > 2.5
        ) {
          try {
            guestAudioEl.currentTime = Math.min(guestAudioEl.duration - 0.5, estimatedSec);
          } catch {
            // Ignorar si aún está bufferizando
          }
        }
        void guestAudioEl
          .play()
          .then(() => {
            guestAudioBlocked = false;
          })
          .catch(() => {
            guestAudioBlocked = true;
          });
      };

      if (guestAudioEl.readyState >= 1) {
        seekAndPlay();
      } else {
        guestAudioEl.onloadedmetadata = () => seekAndPlay();
      }
    } else {
      guestAudioEl.pause();
    }
  }

  function handleToggleGuestMute() {
    guestMuted = !guestMuted;
    if (guestAudioEl) {
      guestAudioEl.muted = guestMuted;
      if (!guestMuted && room && room.isPlaying && room.hasLiveAudio) {
        void guestAudioEl
          .play()
          .then(() => {
            guestAudioBlocked = false;
          })
          .catch(() => {
            guestAudioBlocked = true;
          });
      }
    }
  }

  // Si el usuario es Host de una sala, sincronizamos título actual, audio en vivo, estado y cola real hacia invitados
  $effect(() => {
    if (!room || !roomParticipantId || room.hostId !== roomParticipantId) return;
    const nowTitle = currentTrack ? (cleanDisplayTitle(currentTrack.title) || currentTrack.title) : null;
    const nowArtist = currentTrack ? (cleanDisplayArtist(currentTrack.artist) || currentTrack.artist) : null;
    const playing = engineSnapshot.status === 'playing';
    const curTrackKey = currentTrack?.id ?? null;

    const upcomingQueue: Track[] = [...upNextTracks];
    if (hasPlaylistInPlayback && activePlaylistTracks.length > 0 && currentTrack) {
      const curIdx = activePlaylistTracks.findIndex((t) => t.id === currentTrack.id);
      const after = curIdx >= 0 ? activePlaylistTracks.slice(curIdx + 1) : activePlaylistTracks;
      for (const t of after) {
        if (!upcomingQueue.some((q) => q.id === t.id)) {
          upcomingQueue.push(t);
        }
      }
    }

    const playbackQueue = upcomingQueue.slice(0, 5).map((t) => ({
      id: t.id,
      title: cleanDisplayTitle(t.title) || t.title,
      artist: cleanDisplayArtist(t.artist) || t.artist,
      duration: t.duration || 0,
    }));

    const queueSig = playbackQueue.map((q) => q.id).join(',');
    const syncKey = `${room.code}|${curTrackKey ?? ''}|${nowTitle ?? ''}|${playing}|${queueSig}`;
    if (syncKey !== lastRoomSyncKey) {
      lastRoomSyncKey = syncKey;
      const roomCode = room.code;
      const hostId = roomParticipantId;
      const basePositionSec = untrack(() => engineSnapshot.elapsed) || 0;

      void fetch(apiUrl(`/api/rooms/${encodeURIComponent(roomCode)}/state`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          hostId,
          nowPlayingTitle: nowTitle,
          nowPlayingArtist: nowArtist,
          nowPlayingTrackKey: curTrackKey,
          basePositionSec,
          isPlaying: playing,
          playbackQueue,
        }),
      }).catch(() => {});
    }

    if (currentTrack && curTrackKey && curTrackKey !== lastUploadedNowAudioKey) {
      lastUploadedNowAudioKey = curTrackKey;
      void publishHostNowAudio(room.code, roomParticipantId, currentTrack);
    }
  });

  // Invitados en la sala: reproducen automáticamente el audio en vivo (con Mute local en su dispositivo)
  $effect(() => {
    const activeRoom = room;
    const pid = roomParticipantId;
    if (!activeRoom || !pid || activeRoom.hostId === pid) {
      teardownGuestRoomAudio();
      return;
    }
    syncGuestRoomPlayback(activeRoom, pid);
  });

  async function refreshStorageInfo() {
    storageInfo = await getStorageUsage();
    const pct =
      storageInfo.quotaBytes > 0 ? (storageInfo.usageBytes / storageInfo.quotaBytes) * 100 : 0;

    if (settings.storageMode !== 'device') {
      if (pct >= 99) {
        storagePromptMode = 'mandatory';
      } else if (pct >= 90 && !settings.storage90Declined) {
        storagePromptMode = 'recommend';
      }
    }

    if (pct >= 80 && settings.storageMode !== 'device') {
      if (!lastStorageAlertShown) {
        lastStorageAlertShown = true;
        storageWarningDismissed = false;
        showToast(
          `Almacenamiento cerca del límite (${pct.toFixed(1)}%). Cambia a almacenamiento interno o vacía canciones.`
        );
      }
    } else {
      lastStorageAlertShown = false;
    }
  }

  async function handleSwitchToDeviceStorage() {
    try {
      if (!isDeviceDirectoryPickerSupported()) {
        showToast(
          'Tu navegador móvil no expone selector de carpetas; abre en Chrome de escritorio o compila la APK.'
        );
        return;
      }
      const { name } = await pickDeviceStorageDirectory();
      persistSettings({
        storageMode: 'device',
        deviceStorageName: name,
        storage90Declined: false,
      });
      storagePromptMode = null;
      showToast(`Almacenamiento interno activo (${name}). Las nuevas canciones irán allí.`);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      showToast(err instanceof Error ? err.message : 'No se pudo cambiar de almacenamiento.');
    }
  }

  function handleDecline90StorageSwitch() {
    persistSettings({ storage90Declined: true });
    storagePromptMode = null;
  }

  async function ensureCanDownloadToStorage(): Promise<boolean> {
    await refreshStorageInfo();
    if (settings.storageMode === 'device') {
      const handle = await getDeviceDirectoryHandle('readwrite');
      if (!handle) {
        await handleSwitchToDeviceStorage();
        const after = await getDeviceDirectoryHandle('readwrite');
        return Boolean(after);
      }
      return true;
    }

    const pct =
      storageInfo.quotaBytes > 0 ? (storageInfo.usageBytes / storageInfo.quotaBytes) * 100 : 0;
    if (pct >= 99) {
      storagePromptMode = 'mandatory';
      showToast(
        'Almacenamiento del navegador al 99%. Es obligatorio cambiar al almacenamiento interno para seguir descargando.'
      );
      return false;
    }
    if (pct >= 90 && !settings.storage90Declined) {
      storagePromptMode = 'recommend';
    }
    return true;
  }

  async function handleClearLocalDatabase() {
    for (const t of tracks) {
      bpmAnalyzer.removeFromQueue(t.id);
    }
    engine.stopAndClearAll();
    playerPlaylistExpanded = false;
    await clearAllAudioFiles();

    const defaults = createDefaultPlaylists();
    tracks = [];
    playlists = defaults;
    await Promise.all([saveTracks([]), savePlaylists($state.snapshot(defaults))]);
    persistSettings({ activePlaylistId: DEFAULT_PLAYLIST_ID });
    lastStorageAlertShown = false;
    storageWarningDismissed = true;
    await refreshStorageInfo();
    showToast('Base de datos local vaciada.');
  }

  function confirmCloseActivePlaylist() {
    confirmClosePlaylistOpen = false;
    playerPlaylistExpanded = false;
    engine.stopAndClearAll();
    showToast('Playlist cerrada en el reproductor.');
  }

  async function runAudiusCatalogLookup(rawQuery: string) {
    const trimmed = rawQuery.trim();
    const seq = ++audiusRequestSeq;
    audiusError = null;

    if (!trimmed) {
      audiusLoading = true;
      try {
        const list = await fetchAudiusTrending(16);
        if (seq !== audiusRequestSeq) return;
        audiusResults = list;
        searchEngine.cacheAudiusResults('', list);
      } catch (err) {
        if (seq !== audiusRequestSeq) return;
        audiusError = err instanceof Error ? err.message : 'No se pudo cargar el catálogo.';
      } finally {
        if (seq === audiusRequestSeq) audiusLoading = false;
      }
      return;
    }

    const exactCached = searchEngine.hasExactAudiusCache(trimmed);
    if (exactCached) {
      audiusResults = exactCached;
      audiusLoading = false;
      return;
    }

    audiusLoading = true;
    try {
      const list = await searchAudiusTracks(trimmed, 24);
      if (seq !== audiusRequestSeq) return;
      searchEngine.cacheAudiusResults(trimmed, list);
      audiusResults = list;
    } catch (err) {
      if (seq !== audiusRequestSeq) return;
      audiusError = err instanceof Error ? err.message : 'Error consultando el catálogo.';
    } finally {
      if (seq === audiusRequestSeq) audiusLoading = false;
    }
  }

  function handleSearchInputChange(nextQuery: string, immediate = false) {
    globalSearchQuery = nextQuery;
    if (audiusDebounceTimer !== null) {
      window.clearTimeout(audiusDebounceTimer);
      audiusDebounceTimer = null;
    }

    if (immediate) {
      void runAudiusCatalogLookup(nextQuery);
      return;
    }

    if (nextQuery.trim().length >= 2 || activeModule === 'search') {
      audiusDebounceTimer = window.setTimeout(() => {
        void runAudiusCatalogLookup(nextQuery);
      }, 140);
    }
  }

  function openSearchResultsPage(ev?: Event) {
    ev?.preventDefault();
    searchDropdownOpen = false;
    activeModule = 'search';
    void runAudiusCatalogLookup(globalSearchQuery);
  }

  async function playLibraryTrack(trackId: string, playlistIndex?: number) {
    await actionController.run(
      `player:play:${trackId}`,
      async () => {
        if (activePlaylist) {
          const combinedTracks =
            ephemeralTracks.length > 0 ? [...tracks, ...ephemeralTracks] : tracks;
          engine.syncLibrary(combinedTracks, activePlaylist.trackIds);
        }
        await engine.playTrack(trackId, {
          crossfade: engineSnapshot.status === 'playing',
          crossfadeDuration: Math.min(3, settings.crossfadeSeconds),
          playlistIndex,
        });
      },
      { minLockMs: 60 }
    );
  }

  async function handleQueueNextLocalTrack(trackId: string) {
    const trk = resolveKnownTrack(trackId);
    if (!trk) return;
    await actionController.run(
      `player:queue:${trackId}`,
      async () => {
        await engine.unlock();
        const combined = ephemeralTracks.length > 0 ? [...tracks, ...ephemeralTracks] : tracks;
        const isStandaloneCur =
          Boolean(engineSnapshot.currentTrackId) &&
          ephemeralById.has(engineSnapshot.currentTrackId!);
        const plOrder = isStandaloneCur
          ? [engineSnapshot.currentTrackId!]
          : activePlaylist
            ? activePlaylist.trackIds
            : [];
        engine.syncLibrary(combined, plOrder);
        const outcome = await engine.enqueueNext(trackId);
        const displayName = cleanDisplayTitle(trk.title) || trk.title;
        if (outcome === 'played') {
          showToast(`Reproduciendo "${displayName}".`);
        } else if (outcome === 'queued') {
          showToast(`"${displayName}" añadida a la cola (reproducirá siguiente).`);
        }
      },
      { minLockMs: 60 }
    );
  }

  async function ensureCatalogTrackPrepared(item: AudiusCatalogTrack): Promise<{
    trackId: string;
    existingLocal: Track | undefined;
  }> {
    const existing = tracks.find(
      (t) =>
        t.title.toLowerCase() === item.title.toLowerCase() &&
        t.artist.toLowerCase() === item.artist.toLowerCase()
    );
    const extId = `ext-${item.id}`;

    if (existing) {
      if (!engine.getMemoryBlob(extId)) {
        const mem = engine.getMemoryBlob(existing.id);
        const blob =
          mem ??
          (await readAudioBlob(
            existing.opfsKey,
            inferAudioMimeType(existing.fileName, existing.mimeType)
          ));
        engine.registerMemoryBlob(extId, blob);
      }
      const tempCopy: Track = { ...existing, id: extId, block: 'Fiesta Principal' };
      registerEphemeralTrack(tempCopy);
      return { trackId: extId, existingLocal: existing };
    }

    let fileBlob = engine.getMemoryBlob(extId);
    if (!fileBlob) {
      showToast(`Cargando "${item.title}"...`);
      fileBlob = await downloadAudiusTrackAsFile(item);
      engine.registerMemoryBlob(extId, fileBlob);
    }

    const fileName = fileBlob instanceof File ? fileBlob.name : `${item.title}.m4a`;
    const tempTrack: Track = {
      id: extId,
      fileName,
      opfsKey: extId,
      title: item.title,
      artist: item.artist,
      duration: item.duration || 0,
      sizeBytes: fileBlob.size,
      mimeType: inferAudioMimeType(fileName, fileBlob.type),
      bpm: null,
      bpmStatus: 'done',
      block: 'Fiesta Principal',
      playCount: 0,
      favorite: false,
      addedAt: Date.now(),
    };
    registerEphemeralTrack(tempTrack);
    return { trackId: extId, existingLocal: undefined };
  }

  async function handleSelectAudiusTrack(
    item: AudiusCatalogTrack,
    mode: 'play' | 'add' | 'queue',
    targetPlaylistIdOverride?: string
  ) {
    if (downloadingAudiusId) return;
    await actionController.run(
      `search:catalog:${item.id}`,
      async () => {
        downloadingAudiusId = item.id;
        try {
          await engine.unlock();

          if (mode === 'play') {
            const { trackId } = await ensureCatalogTrackPrepared(item);
            engine.syncLibrary([...tracks, ...ephemeralTracks], [trackId]);
            await engine.playTrack(trackId, {
              crossfade: engineSnapshot.status === 'playing',
              crossfadeDuration: Math.min(3, settings.crossfadeSeconds),
            });
            showToast(`Reproduciendo "${item.title}".`);
            return;
          }

          if (mode === 'queue') {
            const { trackId, existingLocal } = await ensureCatalogTrackPrepared(item);
            const targetId = existingLocal ? existingLocal.id : trackId;
            const combined = [...tracks, ...ephemeralTracks];
            const isStandaloneCur =
              Boolean(engineSnapshot.currentTrackId) &&
              ephemeralById.has(engineSnapshot.currentTrackId!);
            const plOrder = isStandaloneCur
              ? [engineSnapshot.currentTrackId!]
              : activePlaylist
                ? activePlaylist.trackIds
                : [];
            engine.syncLibrary(combined, plOrder);
            const outcome = await engine.enqueueNext(targetId);
            if (outcome === 'played') {
              showToast(`Reproduciendo "${item.title}".`);
            } else if (outcome === 'queued') {
              showToast(`"${item.title}" añadida a la cola (reproducirá siguiente).`);
            }
            return;
          }

          const existing = tracks.find(
            (t) =>
              t.title.toLowerCase() === item.title.toLowerCase() &&
              t.artist.toLowerCase() === item.artist.toLowerCase()
          );
          const extId = `ext-${item.id}`;

          await requestPersistentStorage();
          if (!(await ensureCanDownloadToStorage())) {
            return;
          }
          const targetPlaylistId =
            targetPlaylistIdOverride ?? activePlaylist?.id ?? playlists[0]?.id ?? DEFAULT_PLAYLIST_ID;
          const targetPlaylistObj = playlists.find((p) => p.id === targetPlaylistId) ?? activePlaylist;
          const targetBlock: PartyBlock = targetPlaylistObj?.block ?? 'Fiesta Principal';

          if (!existing) {
            const cachedMem = engine.getMemoryBlob(extId);
            let file: File;
            if (cachedMem instanceof File) {
              file = cachedMem;
            } else if (cachedMem) {
              file = new File([cachedMem], `${item.title}.m4a`, { type: cachedMem.type || 'audio/mp4' });
            } else {
              showToast(`Guardando "${item.title}" en ${targetPlaylistObj?.name ?? 'Playlist'}...`);
              file = await downloadAudiusTrackAsFile(item);
            }

            const id = generateTrackId();
            const opfsKey = buildSafeOpfsKey(id, file.name, settings.storageMode ?? 'browser');
            await saveAudioFile(opfsKey, file);

            const newTrack: Track = {
              id,
              fileName: file.name,
              opfsKey,
              title: item.title,
              artist: item.artist,
              duration: item.duration || 0,
              sizeBytes: file.size,
              mimeType: inferAudioMimeType(file.name, file.type),
              bpm: null,
              bpmStatus: 'analyzing',
              block: targetBlock,
              playCount: 0,
              favorite: false,
              addedAt: Date.now(),
            };

            tracks = [...tracks, newTrack];
            playlists = playlists.map((pl) =>
              pl.id === targetPlaylistId
                ? { ...pl, trackIds: [...pl.trackIds, id], updatedAt: Date.now() }
                : pl
            );

            await Promise.all([
              saveTracks($state.snapshot(tracks)),
              savePlaylists($state.snapshot(playlists)),
            ]);
            bpmAnalyzer.enqueue(id, opfsKey);
            await refreshStorageInfo();
          } else if (targetPlaylistObj && !targetPlaylistObj.trackIds.includes(existing.id)) {
            playlists = playlists.map((pl) =>
              pl.id === targetPlaylistId
                ? { ...pl, trackIds: [...pl.trackIds, existing.id], updatedAt: Date.now() }
                : pl
            );
            await savePlaylists($state.snapshot(playlists));
          }

          showToast(`"${item.title}" guardada en ${targetPlaylistObj?.name ?? 'Playlist'}.`);
        } catch (err) {
          showToast(err instanceof Error ? err.message : 'Error descargando pista.');
        } finally {
          downloadingAudiusId = null;
        }
      },
      { minLockMs: 60, maxLockMs: 45_000 }
    );
  }

  async function handleAddTrackToChosenPlaylist(track: Track, targetPlaylistId: string) {
    pendingAddTrackToPlaylist = null;
    await actionController.run(
      `pl:add-current:${track.id}`,
      async () => {
        const targetPl = playlists.find((p) => p.id === targetPlaylistId) ?? playlists[0];
        if (!targetPl) return;
        const cleanTitle = cleanDisplayTitle(track.title) || track.title;

        // Pista ya guardada en biblioteca local
        if (tracksById.has(track.id)) {
          if (targetPl.trackIds.includes(track.id)) {
            showToast(`"${cleanTitle}" ya está en ${targetPl.name}.`);
            return;
          }
          playlists = playlists.map((pl) =>
            pl.id === targetPl.id
              ? { ...pl, trackIds: [...pl.trackIds, track.id], updatedAt: Date.now() }
              : pl
          );
          await savePlaylists($state.snapshot(playlists));
          showToast(`"${cleanTitle}" añadida a ${targetPl.name}.`);
          return;
        }

        // Pista externa/efímera reproducida fuera de playlist: buscar equivalente local o persistir desde memoria
        const existingLocal = tracks.find(
          (t) =>
            t.title.toLowerCase() === track.title.toLowerCase() &&
            t.artist.toLowerCase() === track.artist.toLowerCase()
        );
        if (existingLocal) {
          if (targetPl.trackIds.includes(existingLocal.id)) {
            showToast(`"${cleanTitle}" ya está en ${targetPl.name}.`);
            return;
          }
          playlists = playlists.map((pl) =>
            pl.id === targetPl.id
              ? { ...pl, trackIds: [...pl.trackIds, existingLocal.id], updatedAt: Date.now() }
              : pl
          );
          await savePlaylists($state.snapshot(playlists));
          showToast(`"${cleanTitle}" añadida a ${targetPl.name}.`);
          return;
        }

        const memBlob = engine.getMemoryBlob(track.id);
        const blob =
          memBlob ??
          (await readAudioBlob(track.opfsKey, inferAudioMimeType(track.fileName, track.mimeType)).catch(
            () => null
          ));
        if (!blob) {
          showToast(`No se encontró el audio en memoria para "${cleanTitle}".`);
          return;
        }

        await requestPersistentStorage();
        if (!(await ensureCanDownloadToStorage())) {
          return;
        }
        const file =
          blob instanceof File
            ? blob
            : new File([blob], track.fileName || `${cleanTitle}.m4a`, {
                type: inferAudioMimeType(track.fileName, blob.type || track.mimeType),
              });
        const id = generateTrackId();
        const opfsKey = buildSafeOpfsKey(id, file.name, settings.storageMode ?? 'browser');
        await saveAudioFile(opfsKey, file);

        const newTrack: Track = {
          id,
          fileName: file.name,
          opfsKey,
          title: track.title,
          artist: track.artist,
          duration: track.duration || 0,
          sizeBytes: file.size,
          mimeType: inferAudioMimeType(file.name, file.type),
          bpm: null,
          bpmStatus: 'analyzing',
          block: targetPl.block,
          playCount: 0,
          favorite: track.favorite,
          addedAt: Date.now(),
        };

        tracks = [...tracks, newTrack];
        playlists = playlists.map((pl) =>
          pl.id === targetPl.id
            ? { ...pl, trackIds: [...pl.trackIds, id], updatedAt: Date.now() }
            : pl
        );

        await Promise.all([
          saveTracks($state.snapshot(tracks)),
          savePlaylists($state.snapshot(playlists)),
        ]);
        bpmAnalyzer.enqueue(id, opfsKey);
        await refreshStorageInfo();
        showToast(`"${cleanTitle}" guardada en ${targetPl.name}.`);
      },
      { minLockMs: 60 }
    );
  }

  onMount(() => {
    const unsub = engine.subscribe((snap) => {
      engineSnapshot = snap;
    });

    const handleSwMessage = (event: MessageEvent) => {
      const data = event.data as { type?: string; action?: string } | undefined;
      if (data?.type !== 'gradmix-media-action') return;
      if (data.action === 'prev') {
        void engine.previous();
      } else if (data.action === 'next') {
        void engine.skipNext();
      } else if (data.action === 'toggle') {
        void engine.togglePlayPause();
      }
    };
    navigator.serviceWorker?.addEventListener('message', handleSwMessage);

    const handleFirstGesture = () => {
      void engine.unlock();
      window.removeEventListener('pointerdown', handleFirstGesture);
      window.removeEventListener('keydown', handleFirstGesture);
    };
    window.addEventListener('pointerdown', handleFirstGesture, { passive: true });
    window.addEventListener('keydown', handleFirstGesture, { passive: true });

    const handleRoomBackPopstate = () => {
      if (room && roomParticipantId) {
        window.history.pushState({ gradmixRoomGuard: true, code: room.code }, '');
        confirmLeaveRoomOpen = true;
      }
    };
    const handleRoomBeforeUnload = (ev: BeforeUnloadEvent) => {
      if (room && roomParticipantId) {
        ev.preventDefault();
        ev.returnValue = '';
      }
    };
    const handleRoomVisibilityCheck = () => {
      if (document.visibilityState === 'visible' && activeRoomSession) {
        void refreshRoomSnapshot(activeRoomSession.code, activeRoomSession.participantId);
      }
    };
    window.addEventListener('popstate', handleRoomBackPopstate);
    window.addEventListener('beforeunload', handleRoomBeforeUnload);
    document.addEventListener('visibilitychange', handleRoomVisibilityCheck);

    void (async () => {
      const [loadedTracks, loadedPlaylists, loadedSettings] = await Promise.all([
        loadTracks(),
        loadPlaylists(),
        loadSettings(),
      ]);

      tracks = loadedTracks;
      playlists = loadedPlaylists;
      settings = loadedSettings;

      engine.setCrossfadeSeconds(settings.crossfadeSeconds);
      engine.setAutoDjEnabled(settings.autoDjEnabled);
      engine.setShuffle(settings.shuffle);
      engine.setRepeatMode(settings.repeatMode);
      engine.setMasterVolume(settings.masterVolume);

      ready = true;
      await refreshStorageInfo();

      for (const t of loadedTracks) {
        if (t.bpmStatus === 'pending' || t.bpmStatus === 'analyzing') {
          bpmAnalyzer.enqueue(t.id, t.opfsKey);
        }
      }

      // Enriquecer en segundo plano artista/título ID3/MP4 si alguna pista cargada no lo tenía
      void enrichMissingTrackTags(loadedTracks);

      const urlParams = new URLSearchParams(window.location.search);
      const importParam = urlParams.get('import');
      const roomInviteParam = urlParams.get('roomInvite');
      if (importParam) {
        window.history.replaceState({}, '', window.location.pathname);
        activeModule = 'playlists';
        void handleImportFromLink(importParam);
      } else if (roomInviteParam) {
        window.history.replaceState({}, '', window.location.pathname);
        const dotIdx = roomInviteParam.indexOf('.');
        if (dotIdx > 0) {
          const code = roomInviteParam.slice(0, dotIdx).trim().toUpperCase();
          const token = roomInviteParam.slice(dotIdx + 1).trim();
          if (code && token) {
            pendingRoomInvite = { code, token };
            activeModule = 'room';
          }
        }
      }
    })();

    return () => {
      unsub();
      navigator.serviceWorker?.removeEventListener('message', handleSwMessage);
      window.removeEventListener('pointerdown', handleFirstGesture);
      window.removeEventListener('keydown', handleFirstGesture);
      window.removeEventListener('popstate', handleRoomBackPopstate);
      window.removeEventListener('beforeunload', handleRoomBeforeUnload);
      document.removeEventListener('visibilitychange', handleRoomVisibilityCheck);
      teardownGuestRoomAudio();
    };
  });

  onDestroy(() => {
    disconnectRoomRealtime();
    bpmAnalyzer.dispose();
    void wakeLock.disable();
    engine.dispose();
  });

  async function enrichMissingTrackTags(initialTracks: Track[]) {
    const candidates = initialTracks.filter((t) => !cleanDisplayArtist(t.artist));
    if (candidates.length === 0) return;

    const updates = new Map<string, { title?: string; artist?: string }>();
    for (const trk of candidates.slice(0, 60)) {
      try {
        const blob = await readAudioBlob(trk.opfsKey, inferAudioMimeType(trk.fileName, trk.mimeType));
        const tags = await extractAudioTags(blob);
        const cleanArtist = tags.artist ? cleanDisplayArtist(tags.artist) : '';
        const cleanTitle = tags.title ? cleanDisplayTitle(tags.title) : '';
        if (cleanArtist || cleanTitle) {
          updates.set(trk.id, {
            artist: cleanArtist || undefined,
            title: cleanTitle || undefined,
          });
        }
      } catch {
        // Ignorar archivos aún no disponibles
      }
    }

    if (updates.size === 0) return;
    tracks = tracks.map((t) => {
      const patch = updates.get(t.id);
      if (!patch) return t;
      return {
        ...t,
        artist: patch.artist || t.artist,
        title: patch.title || t.title,
      };
    });
    void saveTracks($state.snapshot(tracks));
  }

  function persistSettings(patch: Partial<AppSettings>) {
    settings = { ...settings, ...patch };
    void saveSettings($state.snapshot(settings));
  }

  function handleToggleTheme() {
    const nextTheme = settings.theme === 'dark' ? 'light' : 'dark';
    persistSettings({ theme: nextTheme });
  }

  /**
   * Carga masiva asíncrona en bloques (lotes de 5 archivos en paralelo).
   * Muestra inmediatamente cada bloque de canciones conforme se guarda en OPFS
   * sin congelar la interfaz ni esperar a terminar toda la carpeta.
   */
  async function handleUploadFiles(fileList: FileList | File[], targetPlaylistIdOverride?: string) {
    const audioFiles = Array.from(fileList).filter(isSupportedAudioFile);
    if (audioFiles.length === 0) {
      showToast('No se detectaron archivos de audio compatibles.');
      return;
    }

    await engine.unlock();
    await requestPersistentStorage();
    if (!(await ensureCanDownloadToStorage())) {
      return;
    }

    importing = true;
    importProgress = { done: 0, total: audioFiles.length };

    const targetPlaylistId = targetPlaylistIdOverride ?? activePlaylist?.id ?? DEFAULT_PLAYLIST_ID;
    const targetPlaylistObj = playlists.find((p) => p.id === targetPlaylistId) ?? activePlaylist;
    const targetBlock: PartyBlock = targetPlaylistObj?.block ?? 'Fiesta Principal';
    const BATCH_SIZE = 5;
    let totalAdded = 0;

    for (let start = 0; start < audioFiles.length; start += BATCH_SIZE) {
      const batch = audioFiles.slice(start, start + BATCH_SIZE);

      const results = await Promise.allSettled(
        batch.map(async (file, offset): Promise<Track> => {
          const id = generateTrackId();
          const opfsKey = buildSafeOpfsKey(id, file.name, settings.storageMode ?? 'browser');
          const parsed = parseTrackFilename(file.name);
          const tags = await extractAudioTags(file);
          const title = cleanDisplayTitle(tags.title || parsed.title) || parsed.title;
          const artist = cleanDisplayArtist(tags.artist || parsed.artist);
          const mimeType = inferAudioMimeType(file.name, file.type);

          await saveAudioFile(opfsKey, file);

          return {
            id,
            fileName: file.name,
            opfsKey,
            title,
            artist,
            duration: 0,
            sizeBytes: file.size,
            mimeType,
            bpm: null,
            bpmStatus: 'analyzing',
            block: targetBlock,
            playCount: 0,
            favorite: false,
            addedAt: Date.now() + start + offset,
          };
        })
      );

      const batchAdded: Track[] = [];
      for (const r of results) {
        if (r.status === 'fulfilled') {
          batchAdded.push(r.value);
        }
      }

      if (batchAdded.length > 0) {
        totalAdded += batchAdded.length;
        tracks = [...tracks, ...batchAdded];
        playlists = playlists.map((pl) =>
          pl.id === targetPlaylistId
            ? {
                ...pl,
                trackIds: [...pl.trackIds, ...batchAdded.map((t) => t.id)],
                updatedAt: Date.now(),
              }
            : pl
        );

        await Promise.all([
          saveTracks($state.snapshot(tracks)),
          savePlaylists($state.snapshot(playlists)),
        ]);

        for (const trk of batchAdded) {
          bpmAnalyzer.enqueue(trk.id, trk.opfsKey);
        }
      }

      importProgress = {
        done: Math.min(start + batch.length, audioFiles.length),
        total: audioFiles.length,
      };

      // Ceder el hilo principal para que Svelte pinte cada bloque progresivamente
      await new Promise((r) => setTimeout(r, 16));
    }

    importing = false;
    importProgress = null;
    if (totalAdded > 0) {
      showToast(`${totalAdded} canciones guardadas offline.`);
      await refreshStorageInfo();
    }
  }

  function handleSelectPlaylist(id: string) {
    persistSettings({ activePlaylistId: id });
  }

  async function handlePlayPlaylist(playlistId: string) {
    const targetPl = playlists.find((p) => p.id === playlistId);
    if (!targetPl || targetPl.trackIds.length === 0) return;

    await actionController.run(
      `pl:play:${playlistId}`,
      async () => {
        persistSettings({ activePlaylistId: targetPl.id });
        const combinedTracks =
          ephemeralTracks.length > 0 ? [...tracks, ...ephemeralTracks] : tracks;
        engine.syncLibrary(combinedTracks, targetPl.trackIds);
        await engine.playTrack(targetPl.trackIds[0], {
          crossfade: engineSnapshot.status === 'playing',
          crossfadeDuration: Math.min(3, settings.crossfadeSeconds),
          playlistIndex: 0,
        });
      },
      { minLockMs: 60 }
    );
  }

  function handleCreatePlaylist(name: string) {
    void actionController.run('pl:create', () => {
      const newPl: Playlist = {
        id: `pl-${generateTrackId().slice(0, 8)}`,
        name,
        block: 'Fiesta Principal',
        trackIds: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      playlists = [...playlists, newPl];
      void savePlaylists($state.snapshot(playlists));
      persistSettings({ activePlaylistId: newPl.id });
      showToast(`Playlist "${name}" creada.`);
    });
  }

  function handleRenamePlaylist(id: string, name: string) {
    const trimmed = name.trim();
    if (!trimmed) return;
    void actionController.run(`pl:rename:${id}`, () => {
      playlists = playlists.map((p) =>
        p.id === id ? { ...p, name: trimmed, updatedAt: Date.now() } : p
      );
      void savePlaylists($state.snapshot(playlists));
      showToast(`Playlist renombrada a "${trimmed}".`);
    });
  }

  function handleDeletePlaylist(id: string) {
    if (playlists.length <= 1 || id === DEFAULT_PLAYLIST_ID) return;
    void actionController.run(`pl:delete:${id}`, () => {
      playlists = playlists.filter((p) => p.id !== id);
      void savePlaylists($state.snapshot(playlists));
      if (settings.activePlaylistId === id) {
        persistSettings({ activePlaylistId: playlists[0].id });
      }
    });
  }

  function handleSortPlaylist(order: SortOrder) {
    if (!activePlaylist) return;
    void actionController.run(`pl:sort:${order}`, () => {
      const sorted = sortTrackIds(activePlaylist.trackIds, tracksById, order);
      playlists = playlists.map((p) =>
        p.id === activePlaylist.id ? { ...p, trackIds: sorted, updatedAt: Date.now() } : p
      );
      void savePlaylists($state.snapshot(playlists));
    });
  }

  function handleMoveTrack(index: number, direction: -1 | 1) {
    if (!activePlaylist) return;
    const nextIdx = index + direction;
    if (nextIdx < 0 || nextIdx >= activePlaylist.trackIds.length) return;
    void actionController.run(
      'pl:move-track',
      () => {
        const copy = [...activePlaylist.trackIds];
        [copy[index], copy[nextIdx]] = [copy[nextIdx], copy[index]];
        playlists = playlists.map((p) =>
          p.id === activePlaylist.id ? { ...p, trackIds: copy, updatedAt: Date.now() } : p
        );
        void savePlaylists($state.snapshot(playlists));
      },
      { minLockMs: 180 }
    );
  }

  function handleTransferTrackToPlaylist(
    sourcePlaylistId: string,
    indexInSource: number,
    trackId: string,
    targetPlaylistId: string,
    transferMode: 'move' | 'copy'
  ) {
    if (sourcePlaylistId === targetPlaylistId) return;
    void actionController.run(`pl:transfer:${trackId}`, async () => {
      const destPl = playlists.find((p) => p.id === targetPlaylistId);
      if (!destPl) return;
      playlists = playlists.map((p) => {
        if (p.id === targetPlaylistId) {
          const nextIds = p.trackIds.includes(trackId) ? p.trackIds : [...p.trackIds, trackId];
          return { ...p, trackIds: nextIds, updatedAt: Date.now() };
        }
        if (transferMode === 'move' && p.id === sourcePlaylistId) {
          const copy = [...p.trackIds];
          if (copy[indexInSource] === trackId) {
            copy.splice(indexInSource, 1);
          } else {
            const foundIdx = copy.indexOf(trackId);
            if (foundIdx >= 0) copy.splice(foundIdx, 1);
          }
          return { ...p, trackIds: copy, updatedAt: Date.now() };
        }
        return p;
      });
      await savePlaylists($state.snapshot(playlists));
      showToast(
        transferMode === 'move'
          ? `Canción movida a "${destPl.name}".`
          : `Canción copiada a "${destPl.name}".`
      );
    });
  }

  function handleDuplicateTrackInPlaylist(trackId: string) {
    if (!activePlaylist) return;
    void actionController.run(`pl:dup:${trackId}`, () => {
      playlists = playlists.map((p) =>
        p.id === activePlaylist.id
          ? { ...p, trackIds: [...p.trackIds, trackId], updatedAt: Date.now() }
          : p
      );
      void savePlaylists($state.snapshot(playlists));
      showToast('Añadida a la cola.');
    });
  }

  function handleRemoveFromPlaylist(index: number) {
    if (!activePlaylist) return;
    void actionController.run('pl:remove-from-pl', () => {
      const copy = [...activePlaylist.trackIds];
      copy.splice(index, 1);
      playlists = playlists.map((p) =>
        p.id === activePlaylist.id ? { ...p, trackIds: copy, updatedAt: Date.now() } : p
      );
      void savePlaylists($state.snapshot(playlists));
    });
  }

  async function handleDeleteTrackCompletely(trackId: string) {
    const target = tracksById.get(trackId);
    if (!target) return;
    await actionController.run(`pl:delete-track:${trackId}`, async () => {
      bpmAnalyzer.removeFromQueue(trackId);
      if (engineSnapshot.currentTrackId === trackId) {
        engine.stopAndClearAll();
      }

      await deleteAudioFile(target.opfsKey);

      tracks = tracks.filter((t) => t.id !== trackId);
      playlists = playlists.map((p) => ({
        ...p,
        trackIds: p.trackIds.filter((id) => id !== trackId),
      }));

      await Promise.all([
        saveTracks($state.snapshot(tracks)),
        savePlaylists($state.snapshot(playlists)),
      ]);
      await refreshStorageInfo();
    });
  }

  function handleToggleFavorite(trackId: string) {
    tracks = tracks.map((t) => (t.id === trackId ? { ...t, favorite: !t.favorite } : t));
    void saveTracks($state.snapshot(tracks));
  }

  function handlePlayAllFavorites() {
    if (favoriteTracks.length === 0) return;
    const first = favoriteTracks[0];
    void playLibraryTrack(first.id);
    activeModule = 'player';
  }

  function handleToggleShuffle() {
    const next = !settings.shuffle;
    engine.setShuffle(next);
    persistSettings({ shuffle: next });
  }

  function handleCycleRepeat() {
    const order: RepeatMode[] = ['all', 'one', 'off'];
    const next = order[(order.indexOf(settings.repeatMode) + 1) % order.length];
    engine.setRepeatMode(next);
    persistSettings({ repeatMode: next });
  }

  function handleChangeCrossfade(sec: number) {
    engine.setCrossfadeSeconds(sec);
    persistSettings({ crossfadeSeconds: sec });
  }

  function handleToggleAutoDj(enabled: boolean) {
    engine.setAutoDjEnabled(enabled);
    persistSettings({ autoDjEnabled: enabled });
  }

  function handleMasterVolume(vol: number) {
    engine.setMasterVolume(vol);
    persistSettings({ masterVolume: vol });
  }

  function handleShareWhatsApp(targetPlaylist?: Playlist) {
    const pl = targetPlaylist ?? activePlaylist;
    if (!pl) return;
    const listTracks: Track[] = [];
    for (const id of pl.trackIds) {
      const trk = tracksById.get(id);
      if (trk) listTracks.push(trk);
    }
    const { url } = buildWhatsAppShareUrl(pl, listTracks, settings.crossfadeSeconds);
    window.open(url, '_blank', 'noopener,noreferrer');
  }

  function getOrderedTracksForPlaylist(pl: Playlist): Track[] {
    const listTracks: Track[] = [];
    for (const id of pl.trackIds) {
      const trk = tracksById.get(id);
      if (trk) listTracks.push(trk);
    }
    return listTracks;
  }

  async function importBundleEntriesIntoNewPlaylist(
    playlistName: string,
    block: PartyBlock,
    entries: BundleTrackManifest[],
    resolveBlob: (index: number, item: BundleTrackManifest) => Promise<Blob>
  ) {
    await engine.unlock();
    await requestPersistentStorage();

    const newPlaylistId = `pl-${generateTrackId().slice(0, 8)}`;
    const newPlaylist: Playlist = {
      id: newPlaylistId,
      name: playlistName || 'Playlist importada',
      block: block || 'Fiesta Principal',
      trackIds: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    playlists = [...playlists, newPlaylist];
    persistSettings({ activePlaylistId: newPlaylistId });
    await savePlaylists($state.snapshot(playlists));

    importProgress = { done: 0, total: entries.length };
    let importedCount = 0;

    for (let i = 0; i < entries.length; i += 1) {
      const item = entries[i];
      bundleStatusText = `Descargando al búfer (${i + 1}/${entries.length}): ${item.title}`;
      try {
        const blob = await resolveBlob(i, item);
        const file = new File([blob], item.fileName || `track-${i + 1}.mp3`, {
          type: item.mimeType || 'audio/mpeg',
        });
        const id = generateTrackId();
        const opfsKey = buildSafeOpfsKey(id, file.name, settings.storageMode ?? 'browser');
        await saveAudioFile(opfsKey, file);

        const trk: Track = {
          id,
          fileName: file.name,
          opfsKey,
          title: item.title,
          artist: item.artist,
          duration: item.duration || 0,
          sizeBytes: file.size,
          mimeType: file.type || 'audio/mpeg',
          bpm: item.bpm ?? null,
          bpmStatus: item.bpm ? 'done' : 'analyzing',
          block: item.block || newPlaylist.block,
          playCount: 0,
          favorite: false,
          addedAt: Date.now() + i,
        };

        tracks = [...tracks, trk];
        playlists = playlists.map((p) =>
          p.id === newPlaylistId
            ? { ...p, trackIds: [...p.trackIds, trk.id], updatedAt: Date.now() }
            : p
        );

        await Promise.all([
          saveTracks($state.snapshot(tracks)),
          savePlaylists($state.snapshot(playlists)),
        ]);

        if (!item.bpm) {
          bpmAnalyzer.enqueue(trk.id, trk.opfsKey);
        }
        importedCount += 1;
      } catch {
        // Continuar con el resto si una pista falla
      }

      importProgress = { done: i + 1, total: entries.length };
    }

    await refreshStorageInfo();
    return importedCount;
  }

  async function handleExportBundleLink(pl: Playlist) {
    const listTracks = getOrderedTracksForPlaylist(pl);
    if (listTracks.length === 0 || bundleBusy) return;

    bundleBusy = true;
    lastExportedLink = null;
    importProgress = { done: 0, total: listTracks.length };
    bundleStatusText = `Empaquetando "${pl.name}" para link...`;

    try {
      const manifestTracks: BundleTrackManifest[] = listTracks.map((t) => ({
        title: t.title,
        artist: t.artist,
        fileName: t.fileName,
        duration: t.duration,
        bpm: t.bpm,
        block: t.block,
        mimeType: t.mimeType,
        byteLength: t.sizeBytes,
      }));

      const createRes = await fetch(apiUrl('/api/bundles'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': createRequestId(),
        },
        body: JSON.stringify({
          playlistName: pl.name,
          block: pl.block,
          tracks: manifestTracks,
        }),
      });
      const createData = (await createRes.json()) as { id?: string; error?: string };
      if (!createRes.ok || !createData.id) {
        throw new Error(createData.error || 'No se pudo crear el paquete en el servidor.');
      }

      for (let i = 0; i < listTracks.length; i += 1) {
        const t = listTracks[i];
        bundleStatusText = `Subiendo audio (${i + 1}/${listTracks.length}): ${t.title}`;
        const buf = await readAudioArrayBuffer(t.opfsKey);
        const upRes = await fetch(
          apiUrl(`/api/bundles/${encodeURIComponent(createData.id)}/tracks/${i}`),
          {
            method: 'POST',
            headers: { 'Content-Type': t.mimeType || 'application/octet-stream' },
            body: buf,
          }
        );
        if (!upRes.ok) {
          throw new Error(`Fallo al subir "${t.title}".`);
        }
        importProgress = { done: i + 1, total: listTracks.length };
      }

      const shareUrl = `${window.location.origin}/?import=${encodeURIComponent(createData.id)}`;
      lastExportedLink = shareUrl;
      try {
        await navigator.clipboard.writeText(shareUrl);
        showToast('Link de playlist con canciones copiado al portapapeles.');
      } catch {
        showToast('Link de playlist generado.');
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Error al generar link de playlist.');
    } finally {
      bundleBusy = false;
      bundleStatusText = null;
      importProgress = null;
    }
  }

  async function handleExportBundleFile(pl: Playlist) {
    const listTracks = getOrderedTracksForPlaylist(pl);
    if (listTracks.length === 0 || bundleBusy) return;

    bundleBusy = true;
    importProgress = { done: 0, total: listTracks.length };
    bundleStatusText = `Comprimiendo canciones en .zip...`;

    try {
      const blob = await buildPlaylistZipBlob(listTracks, (done, total) => {
        importProgress = { done, total };
      });
      const safeName = pl.name.replace(/[^\w\-]+/g, '_').replace(/^_+|_+$/g, '') || 'playlist';
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${safeName}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      showToast(`Carpeta ${safeName}.zip guardada (${listTracks.length} canciones).`);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'No se pudo exportar archivo .zip.');
    } finally {
      bundleBusy = false;
      bundleStatusText = null;
      importProgress = null;
    }
  }

  async function handleImportFromLink(rawInput: string) {
    if (bundleBusy) return;
    if (!(await ensureCanDownloadToStorage())) return;
    const bundleId = extractBundleIdFromInput(rawInput);
    if (!bundleId) {
      showToast('Link o código de playlist inválido.');
      return;
    }

    bundleBusy = true;
    bundleStatusText = 'Consultando playlist compartida...';
    try {
      const metaRes = await fetch(apiUrl(`/api/bundles/${encodeURIComponent(bundleId)}`));
      const meta = (await metaRes.json()) as {
        playlistName?: string;
        block?: PartyBlock;
        tracks?: BundleTrackManifest[];
        error?: string;
      };
      if (!metaRes.ok || !meta.tracks) {
        throw new Error(meta.error || 'Playlist compartida no encontrada o expirada.');
      }

      const importedCount = await importBundleEntriesIntoNewPlaylist(
        meta.playlistName || 'Playlist importada',
        meta.block || 'Fiesta Principal',
        meta.tracks,
        async (index) => {
          const trackRes = await fetch(
            apiUrl(`/api/bundles/${encodeURIComponent(bundleId)}/tracks/${index}`)
          );
          if (!trackRes.ok) {
            throw new Error(`No se pudo descargar pista ${index + 1}`);
          }
          return await trackRes.blob();
        }
      );

      showToast(`${importedCount} canciones descargadas en el búfer offline.`);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Error al importar playlist por link.');
    } finally {
      bundleBusy = false;
      bundleStatusText = null;
      importProgress = null;
    }
  }

  async function handleImportFromFile(file: File) {
    if (bundleBusy) return;
    if (!(await ensureCanDownloadToStorage())) return;
    bundleBusy = true;
    bundleStatusText = `Leyendo ${file.name}...`;

    try {
      const lower = file.name.toLowerCase();
      if (lower.endsWith('.zip') || file.type.includes('zip')) {
        const zipEntries = await parsePlaylistZipFile(file);
        const rawPlName =
          file.name.replace(/\.zip$/i, '').replace(/[_]+/g, ' ').trim() || 'Playlist .zip';
        const entries: BundleTrackManifest[] = [];
        for (const item of zipEntries) {
          const parsed = parseTrackFilename(item.fileName);
          const tags = await extractAudioTags(item.blob);
          entries.push({
            title: cleanDisplayTitle(tags.title || parsed.title) || parsed.title,
            artist: cleanDisplayArtist(tags.artist || parsed.artist),
            fileName: item.fileName,
            duration: 0,
            bpm: null,
            block: 'Fiesta Principal',
            mimeType: item.mimeType,
            byteLength: item.blob.size,
          });
        }
        const importedCount = await importBundleEntriesIntoNewPlaylist(
          rawPlName,
          'Fiesta Principal',
          entries,
          async (index) => zipEntries[index].blob
        );
        showToast(`Playlist "${rawPlName}" importada (${importedCount} pistas).`);
        return;
      }

      const { manifest, slices } = await parseGradmixBundleFile(file);
      const importedCount = await importBundleEntriesIntoNewPlaylist(
        manifest.playlistName,
        (manifest.block as PartyBlock) || 'Fiesta Principal',
        manifest.tracks,
        async (index) => slices[index]
      );
      showToast(`Playlist "${manifest.playlistName}" importada (${importedCount} pistas).`);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Archivo .zip/.gradmix inválido.');
    } finally {
      bundleBusy = false;
      bundleStatusText = null;
      importProgress = null;
    }
  }

  async function enterBatterySaver() {
    await engine.unlock();
    blackoutActive = true;
  }

  // ==================== SALA COLABORATIVA ====================

  function ensureRoomBackGuard(code: string) {
    if (roomBackGuardPushed || typeof window === 'undefined') return;
    roomBackGuardPushed = true;
    window.history.pushState({ gradmixRoomGuard: true, code }, '');
  }

  function disconnectRoomRealtime() {
    activeRoomSession = null;
    lastUploadedNowAudioKey = '';
    lastRoomSyncKey = '';
    roomBackGuardPushed = false;
    teardownGuestRoomAudio();
    if (roomReconnectTimer !== null) {
      window.clearTimeout(roomReconnectTimer);
      roomReconnectTimer = null;
    }
    if (roomPollTimer !== null) {
      window.clearInterval(roomPollTimer);
      roomPollTimer = null;
    }
    if (roomHeartbeatTimer !== null) {
      window.clearInterval(roomHeartbeatTimer);
      roomHeartbeatTimer = null;
    }
    if (roomSocket) {
      try {
        roomSocket.onclose = null;
        roomSocket.close();
      } catch {
        // Ignorar
      }
      roomSocket = null;
    }
    if (roomEventSource) {
      roomEventSource.close();
      roomEventSource = null;
    }
  }

  function handleRoomEventPayload(code: string, participantId: string, event: string, data: unknown) {
    if (event === 'room-state') {
      room = data as RoomPublicState;
      return;
    }
    if (event === 'room-kicked') {
      const payload = (data ?? {}) as { reason?: string };
      const reason =
        payload.reason ||
        'Fuiste expulsado de la sala por inactividad (10 s sin recibir datos de audio).';
      disconnectRoomRealtime();
      room = null;
      roomParticipantId = null;
      confirmLeaveRoomOpen = false;
      roomEvictionAlert = reason;
      return;
    }
    if (event === 'new-room-track') {
      const info = data as {
        trackId: string;
        title: string;
        artist: string;
        duration: number;
        fileName: string;
        mimeType: string;
        addedByName: string;
      };
      void ingestIncomingRoomTrack(code, participantId, info);
      return;
    }
    if (event === 'room-command') {
      const cmd = data as {
        action: 'toggle-play' | 'skip-next' | 'previous' | 'remove-track';
        trackId?: string;
        byName?: string;
      };
      if (cmd.action === 'toggle-play') {
        void engine.togglePlayPause();
      } else if (cmd.action === 'skip-next') {
        void engine.skipNext();
      } else if (cmd.action === 'previous') {
        void engine.previous();
      } else if (cmd.action === 'remove-track' && cmd.trackId) {
        const localId = roomTrackToLocalId.get(cmd.trackId);
        if (localId) {
          void handleDeleteTrackCompletely(localId);
          roomTrackToLocalId.delete(cmd.trackId);
        }
      }
      return;
    }
    if (event === 'room-closed') {
      const payload = (data ?? {}) as { reason?: string };
      const hadActiveRoom = Boolean(room && roomParticipantId);
      disconnectRoomRealtime();
      room = null;
      roomParticipantId = null;
      confirmLeaveRoomOpen = false;
      if (hadActiveRoom) {
        roomEvictionAlert = payload.reason || 'La sala se cerró.';
      }
    }
  }

  async function refreshRoomSnapshot(code: string, participantId: string) {
    try {
      const resp = await fetch(
        apiUrl(
          `/api/rooms/${encodeURIComponent(code)}?participantId=${encodeURIComponent(participantId)}`
        )
      );
      if (resp.status === 403 || resp.status === 404 || resp.status === 410) {
        const hadGuestRoom = Boolean(room && roomParticipantId && room.hostId !== participantId);
        let serverError = '';
        try {
          const errJson = (await resp.json()) as { error?: string };
          if (errJson.error) serverError = errJson.error;
        } catch {
          // Ignorar cuerpo vacío o no JSON
        }
        disconnectRoomRealtime();
        room = null;
        roomParticipantId = null;
        confirmLeaveRoomOpen = false;
        if (resp.status === 403) {
          roomEvictionAlert =
            serverError ||
            'Fuiste expulsado de la sala por inactividad (10 s sin recibir datos de audio).';
        } else if (hadGuestRoom) {
          roomEvictionAlert = serverError || 'La sala se cerró o expiró por inactividad.';
        }
        return;
      }
      if (!resp.ok) return;
      const payload = (await resp.json()) as { room?: RoomPublicState };
      if (payload.room) {
        room = payload.room;
      }
    } catch {
      // Ignorar fallos transitorios de red
    }
  }

  function openRoomWebSocket(code: string, participantId: string) {
    if (roomSocket) {
      try {
        roomSocket.onclose = null;
        roomSocket.close();
      } catch {
        // Ignorar
      }
      roomSocket = null;
    }

    const wsUrl = apiWsUrl(
      `/api/rooms/${encodeURIComponent(code)}/ws?participantId=${encodeURIComponent(participantId)}`
    );

    try {
      const ws = new WebSocket(wsUrl);
      roomSocket = ws;

      ws.onopen = () => {
        try {
          ws.send(JSON.stringify({ type: 'sync' }));
        } catch {
          // Ignorar
        }
      };

      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(String(ev.data)) as { event?: string; data?: unknown };
          if (msg.event) {
            handleRoomEventPayload(code, participantId, msg.event, msg.data);
          }
        } catch {
          // Ignorar
        }
      };

      ws.onclose = () => {
        if (roomSocket === ws) {
          roomSocket = null;
        }
        if (activeRoomSession?.code === code && activeRoomSession?.participantId === participantId) {
          if (roomReconnectTimer !== null) window.clearTimeout(roomReconnectTimer);
          roomReconnectTimer = window.setTimeout(() => {
            if (
              activeRoomSession?.code === code &&
              activeRoomSession?.participantId === participantId
            ) {
              openRoomWebSocket(code, participantId);
              void refreshRoomSnapshot(code, participantId);
            }
          }, 1500);
        }
      };
    } catch {
      // SSE y polling mantienen sincronización si WebSocket falla en un proxy estricto
    }
  }

  function connectRoomRealtime(code: string, participantId: string) {
    disconnectRoomRealtime();
    activeRoomSession = { code, participantId };

    // Canal primario: WebSocket dedicado para participantes, privilegios, cola y comandos
    openRoomWebSocket(code, participantId);

    // Respaldo SSE + comprobación periódica si WebSocket aún está reconectando
    const es = new EventSource(
      apiUrl(
        `/api/rooms/${encodeURIComponent(code)}/events?participantId=${encodeURIComponent(participantId)}`
      )
    );
    roomEventSource = es;

    for (const evtName of ['room-state', 'new-room-track', 'room-command', 'room-closed', 'room-kicked'] as const) {
      es.addEventListener(evtName, (ev) => {
        try {
          handleRoomEventPayload(code, participantId, evtName, JSON.parse((ev as MessageEvent).data));
        } catch {
          // Ignorar
        }
      });
    }

    roomPollTimer = window.setInterval(() => {
      if (!activeRoomSession) return;
      if (roomSocket && roomSocket.readyState === WebSocket.OPEN) {
        return;
      }
      void refreshRoomSnapshot(code, participantId);
    }, 4000);

    roomHeartbeatTimer = window.setInterval(() => {
      sendGuestAudioHeartbeatNow();
    }, 3000);
  }

  async function ingestIncomingRoomTrack(
    code: string,
    hostParticipantId: string,
    info: {
      trackId: string;
      title: string;
      artist: string;
      duration: number;
      fileName: string;
      mimeType: string;
      addedByName: string;
    }
  ) {
    try {
      const resp = await fetch(
        apiUrl(
          `/api/rooms/${encodeURIComponent(code)}/tracks/${encodeURIComponent(info.trackId)}/audio?participantId=${encodeURIComponent(hostParticipantId)}`
        )
      );
      if (!resp.ok) return;

      const blob = await resp.blob();
      const file = new File([blob], info.fileName || `${info.title}.mp3`, {
        type: info.mimeType || 'audio/mpeg',
      });

      const localId = generateTrackId();
      const opfsKey = buildSafeOpfsKey(localId, file.name);
      await saveAudioFile(opfsKey, file);

      const newTrack: Track = {
        id: localId,
        fileName: file.name,
        opfsKey,
        title: info.title,
        artist: info.artist || info.addedByName,
        duration: info.duration || 0,
        sizeBytes: file.size,
        mimeType: file.type,
        bpm: null,
        bpmStatus: 'analyzing',
        block: activePlaylist?.block ?? 'Fiesta Principal',
        playCount: 0,
        favorite: false,
        addedAt: Date.now(),
      };

      roomTrackToLocalId.set(info.trackId, localId);
      const targetPlaylistId = activePlaylist?.id ?? DEFAULT_PLAYLIST_ID;

      tracks = [...tracks, newTrack];
      playlists = playlists.map((pl) =>
        pl.id === targetPlaylistId
          ? { ...pl, trackIds: [...pl.trackIds, localId], updatedAt: Date.now() }
          : pl
      );

      await Promise.all([
        saveTracks($state.snapshot(tracks)),
        savePlaylists($state.snapshot(playlists)),
      ]);
      bpmAnalyzer.enqueue(localId, opfsKey);
      showToast(`"${info.title}" añadida por ${info.addedByName}.`);
    } catch {
      // Ignorar fallo puntual de red
    }
  }

  async function handleCreateRoom(params: {
    hostName: string;
    password: string;
    durationHours: number;
    customCode: string;
  }): Promise<RoomPublicState | null> {
    const res = await actionController.run('room:create', async () => {
      roomError = null;
      try {
        const resp = await fetch(apiUrl('/api/rooms'), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': createRequestId(),
          },
          body: JSON.stringify({
            ...params,
            deviceId: getOrCreateDeviceId(),
          }),
        });
        const data = (await resp.json()) as {
          participantId?: string;
          room?: RoomPublicState;
          error?: string;
        };
        if (!resp.ok || !data.room || !data.participantId) {
          roomError = data.error || 'No se pudo crear la sala.';
          return null;
        }
        room = data.room;
        roomParticipantId = data.participantId;
        pendingRoomInvite = null;
        ensureRoomBackGuard(data.room.code);
        connectRoomRealtime(data.room.code, data.participantId);
        showToast(`Sala ${data.room.code} creada.`);
        return data.room;
      } catch {
        roomError = 'Servidor de sala no disponible (requiere conexión al host).';
        return null;
      }
    });
    return res.value ?? null;
  }

  function buildRoomInviteWhatsAppUrl(targetRoom: RoomPublicState): { shareUrl: string; waUrl: string } {
    const inviteParam = targetRoom.inviteToken
      ? `${targetRoom.code}.${targetRoom.inviteToken}`
      : targetRoom.code;
    const shareUrl = `${window.location.origin}/?roomInvite=${encodeURIComponent(inviteParam)}`;
    const text = `Únete directo a la sala "${targetRoom.code}" en GradMix (solo escribe tu nombre):\n${shareUrl}`;
    return {
      shareUrl,
      waUrl: `https://wa.me/?text=${encodeURIComponent(text)}`,
    };
  }

  async function handleShareRoomWhatsApp(
    targetRoom?: RoomPublicState,
    quickCreateParams?: { hostName: string; password: string; durationHours: number; customCode: string }
  ) {
    if (targetRoom) {
      await actionController.run('room:share-wa', async () => {
        const { shareUrl, waUrl } = buildRoomInviteWhatsAppUrl(targetRoom);
        try {
          await navigator.clipboard.writeText(shareUrl);
        } catch {
          // Ignorar bloqueo de portapapeles
        }
        window.open(waUrl, '_blank', 'noopener,noreferrer');
        showToast('Enlace de invitación directo copiado y abierto en WhatsApp.');
      });
      return;
    }

    if (!quickCreateParams) return;
    const created = await handleCreateRoom(quickCreateParams);
    if (!created) return;
    const { shareUrl, waUrl } = buildRoomInviteWhatsAppUrl(created);
    try {
      await navigator.clipboard.writeText(shareUrl);
    } catch {
      // Ignorar bloqueo de portapapeles
    }
    const popup = window.open(waUrl, '_blank', 'noopener,noreferrer');
    showToast(
      popup
        ? `Sala ${created.code} creada y compartida por WhatsApp.`
        : `Sala ${created.code} creada y enlace directo copiado al portapapeles.`
    );
  }

  async function handleJoinRoom(params: {
    code: string;
    password: string;
    userName: string;
    inviteToken?: string;
  }) {
    await actionController.run('room:join', async () => {
      roomError = null;
      try {
        const resp = await fetch(apiUrl(`/api/rooms/${encodeURIComponent(params.code)}/join`), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': createRequestId(),
          },
          body: JSON.stringify({
            password: params.password,
            inviteToken: params.inviteToken,
            userName: params.userName,
            deviceId: getOrCreateDeviceId(),
          }),
        });
        const data = (await resp.json()) as {
          participantId?: string;
          room?: RoomPublicState;
          error?: string;
        };
        if (!resp.ok || !data.room || !data.participantId) {
          roomError = data.error || 'No se pudo unir a la sala.';
          return;
        }
        room = data.room;
        roomParticipantId = data.participantId;
        pendingRoomInvite = null;
        ensureRoomBackGuard(data.room.code);
        connectRoomRealtime(data.room.code, data.participantId);
        showToast(`Conectado a sala ${data.room.code}.`);
      } catch {
        roomError = 'No se pudo conectar con la sala.';
      }
    });
  }

  function requestLeaveOrCloseRoom() {
    if (!room || !roomParticipantId) return;
    confirmLeaveRoomOpen = true;
  }

  async function handleLeaveOrCloseRoom() {
    confirmLeaveRoomOpen = false;
    if (!room || !roomParticipantId) return;
    await actionController.run('room:leave', async () => {
      if (!room || !roomParticipantId) return;
      const isHost = room.hostId === roomParticipantId;
      const code = room.code;
      const pid = roomParticipantId;

      disconnectRoomRealtime();
      room = null;
      roomParticipantId = null;

      if (isHost) {
        await fetch(apiUrl(`/api/rooms/${encodeURIComponent(code)}`), {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ hostId: pid }),
        }).catch(() => {});
      } else {
        await fetch(apiUrl(`/api/rooms/${encodeURIComponent(code)}/leave`), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ participantId: pid }),
        }).catch(() => {});
      }
    });
  }

  async function handleRemoveParticipant(targetParticipantId: string) {
    if (!room || !roomParticipantId) return;
    await actionController.run(`room:kick:${targetParticipantId}`, async () => {
      if (!room || !roomParticipantId) return;
      try {
        const resp = await fetch(
          apiUrl(
            `/api/rooms/${encodeURIComponent(room.code)}/participants/${encodeURIComponent(targetParticipantId)}`
          ),
          {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ hostId: roomParticipantId }),
          }
        );
        const data = (await resp.json()) as { room?: RoomPublicState; error?: string };
        if (!resp.ok) {
          roomError = data.error || 'No se pudo eliminar al participante.';
          return;
        }
        if (data.room) room = data.room;
        showToast('Participante eliminado de la sala.');
      } catch {
        roomError = 'Error al eliminar participante.';
      }
    });
  }

  async function handleUpdateRoomPermissions(
    targetParticipantId: string,
    permissions: RoomPermissions
  ) {
    if (!room || !roomParticipantId) return;
    await actionController.run(`room:perm:${targetParticipantId}`, async () => {
      if (!room || !roomParticipantId) return;
      try {
        const resp = await fetch(
          apiUrl(`/api/rooms/${encodeURIComponent(room.code)}/permissions`),
          {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            hostId: roomParticipantId,
            targetParticipantId,
            permissions,
          }),
        });
        const data = (await resp.json()) as { room?: RoomPublicState; error?: string };
        if (!resp.ok) {
          roomError = data.error || 'No se pudieron actualizar permisos.';
          return;
        }
        if (data.room) room = data.room;
      } catch {
        roomError = 'Error al actualizar permisos.';
      }
    });
  }

  async function handleUploadRoomFiles(fileList: FileList | File[]) {
    if (!room || !roomParticipantId) return;
    const files = Array.from(fileList).filter(isSupportedAudioFile);
    if (files.length === 0) return;

    await actionController.run(
      'room:upload',
      async () => {
        if (!room || !roomParticipantId) return;
        uploadingToRoom = true;
        roomError = null;
        try {
          for (const file of files) {
            const parsed = parseTrackFilename(file.name);
            const tags = await extractAudioTags(file);
            const title = cleanDisplayTitle(tags.title || parsed.title) || parsed.title;
            const artist = cleanDisplayArtist(tags.artist || parsed.artist);
            const resp = await fetch(
              apiUrl(`/api/rooms/${encodeURIComponent(room.code)}/tracks`),
              {
                method: 'POST',
                headers: {
                  'Content-Type': inferAudioMimeType(file.name, file.type),
                  'Idempotency-Key': createRequestId(),
                  'x-participant-id': roomParticipantId,
                  'x-track-filename': encodeURIComponent(file.name),
                  'x-track-title': encodeURIComponent(title),
                  'x-track-artist': encodeURIComponent(artist),
                },
                body: file,
              }
            );
            const data = (await resp.json()) as { room?: RoomPublicState; error?: string };
            if (!resp.ok) {
              roomError = data.error || 'No se pudo subir la canción a la sala.';
              break;
            }
            if (data.room) room = data.room;
          }
        } catch {
          roomError = 'Error de red al subir canción.';
        } finally {
          uploadingToRoom = false;
        }
      },
      { maxLockMs: 60_000 }
    );
  }

  async function handleDeleteRoomTrack(trackId: string) {
    if (!room || !roomParticipantId) return;
    await actionController.run(`room:delete:${trackId}`, async () => {
      if (!room || !roomParticipantId) return;
      try {
        const resp = await fetch(
          apiUrl(
            `/api/rooms/${encodeURIComponent(room.code)}/tracks/${encodeURIComponent(trackId)}`
          ),
          {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ participantId: roomParticipantId }),
          }
        );
        const data = (await resp.json()) as { room?: RoomPublicState; error?: string };
        if (!resp.ok) {
          roomError = data.error || 'Sin permiso para eliminar.';
          return;
        }
        if (data.room) room = data.room;
      } catch {
        roomError = 'Error al eliminar canción de la sala.';
      }
    });
  }

  async function handleRemoteRoomCommand(action: 'toggle-play' | 'skip-next' | 'previous') {
    if (!room || !roomParticipantId) return;
    await actionController.run(`room:cmd:${action}`, async () => {
      if (!room || !roomParticipantId) return;
      try {
        const resp = await fetch(
          apiUrl(`/api/rooms/${encodeURIComponent(room.code)}/command`),
          {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ participantId: roomParticipantId, action }),
        });
        if (!resp.ok) {
          const data = (await resp.json()) as { error?: string };
          roomError = data.error || 'No tienes permiso para controlar la reproducción.';
        }
      } catch {
        roomError = 'Error al enviar comando a la sala.';
      }
    });
  }
</script>

<div class="flex min-h-dvh bg-[#f6f7f9] text-zinc-900 dark:bg-black dark:text-zinc-100">
  <!-- Barra lateral (Desktop) / Menú Hamburguesa (Móvil) -->
  <SidebarNav
    {activeModule}
    mobileOpen={mobileMenuOpen}
    theme={settings.theme}
    favoritesCount={favoriteTracks.length}
    roomActive={room !== null}
    onSelectModule={(mod) => {
      activeModule = mod;
      if (mod === 'search' && audiusResults.length === 0 && !audiusLoading) {
        void runAudiusCatalogLookup(globalSearchQuery);
      }
    }}
    onCloseMobile={() => (mobileMenuOpen = false)}
    onToggleTheme={handleToggleTheme}
  />

  <div class="flex min-w-0 flex-1 flex-col">
    <!-- Cabecera Minimalista con Buscador General y Controles de Notificación -->
    <header class="sticky top-0 z-30 border-b border-zinc-200 bg-white/95 dark:border-zinc-900 dark:bg-black/95">
      <div class="mx-auto flex max-w-3xl flex-wrap items-center justify-between gap-2 px-4 py-2.5 sm:flex-nowrap">
        <div class="flex items-center gap-2.5 shrink-0">
          <!-- Botón Hamburguesa (Móvil) -->
          <button
            type="button"
            onclick={() => (mobileMenuOpen = true)}
            aria-label="Abrir menú"
            class="flex h-9 w-9 items-center justify-center border border-zinc-200 bg-zinc-50 text-zinc-700 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-200 lg:hidden"
          >
            <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M3 6h18M3 12h18M3 18h18" stroke-linecap="round" />
            </svg>
          </button>

          <img src="/favicon.svg" alt="GradMix" class="h-7 w-7 lg:hidden" />
          <h1 class="text-sm font-semibold tracking-tight text-zinc-900 dark:text-white">
            GradMix
          </h1>
        </div>

        <!-- Barra de búsqueda general en Navbar -->
        <div class="relative order-last w-full sm:order-none sm:flex-1 sm:max-w-xs">
          <form onsubmit={openSearchResultsPage} class="flex items-center">
            <input
              type="search"
              value={globalSearchQuery}
              oninput={(e) => {
                searchDropdownOpen = true;
                handleSearchInputChange((e.currentTarget as HTMLInputElement).value);
              }}
              onfocus={() => (searchDropdownOpen = true)}
              placeholder="Buscar canciones o artistas..."
              aria-label="Buscar canciones o artistas"
              class="h-9 w-full border border-zinc-200 bg-zinc-50 px-3 pr-9 text-xs text-zinc-900 placeholder-zinc-400 focus:border-cyan-500 focus:outline-none dark:border-zinc-800 dark:bg-zinc-950 dark:text-white"
            />
            <button
              type="submit"
              title="Ver coincidencias"
              aria-label="Buscar coincidencias"
              class="absolute right-0 top-0 flex h-9 w-9 items-center justify-center text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-white"
            >
              <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="11" cy="11" r="7" />
                <path d="M20 20l-3.5-3.5" stroke-linecap="round" />
              </svg>
            </button>
          </form>

          {#if searchDropdownOpen && globalSearchQuery.trim()}
            <div class="fixed inset-0 z-30" onclick={() => (searchDropdownOpen = false)} aria-hidden="true"></div>
            <div class="absolute left-0 right-0 top-full z-40 mt-1 max-h-80 overflow-y-auto border border-zinc-300 bg-white shadow-xl dark:border-zinc-800 dark:bg-zinc-950">
              {#if localSearchMatches.length > 0}
                {#each localSearchMatches.slice(0, 5) as m (m.track.id)}
                  <button
                    type="button"
                    onclick={() => {
                      searchDropdownOpen = false;
                      void playLibraryTrack(m.track.id);
                    }}
                    class="flex w-full items-center justify-between gap-2 border-b border-zinc-100 px-3 py-2 text-left text-xs hover:bg-zinc-100 dark:border-zinc-900 dark:hover:bg-zinc-900"
                  >
                    <div class="min-w-0 flex-1">
                      <p class="truncate font-medium text-zinc-900 dark:text-white">
                        {cleanDisplayTitle(m.track.title) || m.track.title}
                      </p>
                      {#if cleanDisplayArtist(m.track.artist)}
                        <p class="truncate text-[10px] text-zinc-500">{cleanDisplayArtist(m.track.artist)}</p>
                      {/if}
                    </div>
                    <span class="shrink-0 text-[10px] text-cyan-600 dark:text-cyan-400">▶</span>
                  </button>
                {/each}
              {/if}

              {#each (cachedAudiusMatches.length > 0 ? cachedAudiusMatches.map((h) => h.item) : audiusResults).slice(0, 5) as hit (hit.id)}
                <button
                  type="button"
                  onclick={() => {
                    searchDropdownOpen = false;
                    void handleSelectAudiusTrack(hit, 'play');
                  }}
                  class="flex w-full items-center justify-between gap-2 border-b border-zinc-100 px-3 py-2 text-left text-xs hover:bg-zinc-100 dark:border-zinc-900 dark:hover:bg-zinc-900"
                >
                  <div class="min-w-0 flex-1">
                    <p class="truncate font-medium text-zinc-900 dark:text-white">{hit.title}</p>
                    {#if hit.artist}
                      <p class="truncate text-[10px] text-zinc-500">{hit.artist}</p>
                    {/if}
                  </div>
                  <span class="shrink-0 text-[10px] text-cyan-600 dark:text-cyan-400">▶</span>
                </button>
              {/each}

              <button
                type="button"
                onclick={() => openSearchResultsPage()}
                class="flex w-full items-center justify-between bg-zinc-900 px-3 py-2 text-left text-xs font-medium text-white dark:bg-white dark:text-black"
              >
                <span>Ver todas las coincidencias</span>
                <span>→</span>
              </button>
            </div>
          {/if}
        </div>

        <div class="flex shrink-0 items-center gap-1.5">
          <!-- Botón Tema Claro / Oscuro (ícono negro en claro, blanco en oscuro) -->
          <button
            type="button"
            onclick={handleToggleTheme}
            title={settings.theme === 'dark' ? 'Cambiar a modo claro' : 'Cambiar a modo oscuro'}
            aria-label="Cambiar tema"
            class="flex h-9 w-9 items-center justify-center border border-zinc-200 bg-zinc-50 text-zinc-900 transition hover:bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-950 dark:text-white dark:hover:bg-zinc-900"
          >
            {#if settings.theme === 'dark'}
              <svg class="h-4 w-4 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="4" />
                <path d="M12 2v2m0 16v2M4.93 4.93l1.41 1.41m11.32 11.32l1.41 1.41M2 12h2m16 0h2M4.93 19.07l1.41-1.41m11.32-11.32l1.41-1.41" stroke-linecap="round" />
              </svg>
            {:else}
              <svg class="h-4 w-4 text-zinc-900" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            {/if}
          </button>

          <!-- Botón Ahorro de batería (ícono negro en claro, blanco en oscuro) -->
          <button
            type="button"
            onclick={enterBatterySaver}
            title="Ahorro de batería"
            aria-label="Ahorro de batería"
            class="inline-flex h-9 items-center gap-1.5 border border-zinc-200 bg-zinc-50 px-2.5 text-xs font-medium text-zinc-900 transition hover:bg-zinc-100 active:scale-95 dark:border-zinc-800 dark:bg-zinc-950 dark:text-white dark:hover:bg-zinc-900"
          >
            <svg class="h-4 w-4 text-zinc-900 dark:text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="2" y="7" width="16" height="10" />
              <path d="M22 11v2" stroke-linecap="round" />
            </svg>
            <span class="hidden sm:inline">Ahorro de batería</span>
            <span class="sm:hidden">Ahorro</span>
          </button>
        </div>
      </div>
    </header>

    <main
      class="mx-auto w-full max-w-3xl flex-1 space-y-4 px-4 py-4 {showBottomPlaylistBar
        ? 'pb-24'
        : 'pb-16'}"
    >
      {#if storagePercent >= 80 && !storageWarningDismissed}
        <div
          class="flex items-center justify-between gap-2 border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-300"
        >
          <span>
            Almacenamiento casi lleno ({storagePercent.toFixed(1)}%). Borra canciones o vacía la base local.
          </span>
          <div class="flex shrink-0 items-center gap-1.5">
            <button
              type="button"
              onclick={() => (activeModule = 'monitoring')}
              class="border border-amber-500/50 bg-amber-500/20 px-2 py-1 text-[11px] font-semibold"
            >
              Monitoreo
            </button>
            <button
              type="button"
              onclick={() => (storageWarningDismissed = true)}
              title="Cerrar aviso"
              aria-label="Cerrar aviso"
              class="p-1 text-amber-700 hover:text-amber-900 dark:text-amber-300 dark:hover:text-white"
            >
              <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M18 6L6 18M6 6l12 12" stroke-linecap="round" />
              </svg>
            </button>
          </div>
        </div>
      {/if}

      {#if !engineSnapshot.unlocked && tracks.length > 0 && engineSnapshot.status === 'idle'}
        <button
          type="button"
          onclick={() => engine.unlock()}
          class="flex w-full items-center justify-between border border-cyan-500/40 bg-cyan-500/10 px-4 py-2.5 text-left text-xs text-cyan-800 dark:text-cyan-200"
        >
          <span>Toca para activar el motor de audio.</span>
          <span class="bg-cyan-500 px-2.5 py-1 font-semibold text-black">Activar</span>
        </button>
      {/if}

      {#if engineSnapshot.lastError}
        <div class="border border-red-500/40 bg-red-500/10 px-4 py-2.5 text-xs text-red-600 dark:text-red-300">
          {engineSnapshot.lastError}
        </div>
      {/if}

      <!-- Vista Principal Minimalista: Únicamente Canción + Decks + Crossfade -->
      {#if activeModule === 'player'}
        <PlayerDeck
          snapshot={engineSnapshot}
          {currentTrack}
          {nextTrack}
          actionBusy={playerActionBusy}
          onTogglePlay={() =>
            void actionController.run('player:transport', () => engine.togglePlayPause(), {
              minLockMs: 60,
            })}
          onNext={() =>
            void actionController.run('player:transport', () => engine.skipNext(), {
              minLockMs: 60,
            })}
          onPrevious={() =>
            void actionController.run('player:transport', () => engine.previous(), {
              minLockMs: 60,
            })}
          onSeek={(sec) => engine.seekTo(sec)}
          onToggleShuffle={handleToggleShuffle}
          onCycleRepeat={handleCycleRepeat}
          onMasterVolume={handleMasterVolume}
          onTriggerCrossfade={() =>
            void actionController.run('player:transport', () => engine.triggerManualCrossfade(), {
              minLockMs: 60,
            })}
          onToggleFavorite={handleToggleFavorite}
          onRequestAddToPlaylist={(trk) => (pendingAddTrackToPlaylist = trk)}
          onOpenPlaylists={() => (activeModule = 'playlists')}
        />

        <CrossfadeControl
          crossfadeSeconds={settings.crossfadeSeconds}
          autoDjEnabled={settings.autoDjEnabled}
          crossfading={engineSnapshot.crossfading}
          crossfadeProgress={engineSnapshot.crossfadeProgress}
          onChangeCrossfade={handleChangeCrossfade}
          onToggleAutoDj={handleToggleAutoDj}
        />
      {:else if activeModule === 'playlists'}
        {#if activePlaylist}
          <PlaylistManager
            {playlists}
            {activePlaylist}
            {tracksById}
            allTracks={tracks}
            theme={settings.theme}
            currentTrackId={engineSnapshot.currentTrackId}
            isPlaying={engineSnapshot.status === 'playing'}
            {importing}
            {importProgress}
            {bundleBusy}
            actionBusy={playlistActionBusy || playerActionBusy}
            {bundleStatusText}
            {lastExportedLink}
            onSelectPlaylist={handleSelectPlaylist}
            onPlayPlaylist={(plId) => void handlePlayPlaylist(plId)}
            onCreatePlaylist={handleCreatePlaylist}
            onRenamePlaylist={handleRenamePlaylist}
            onDeletePlaylist={handleDeletePlaylist}
            onUploadFiles={(files, plId) => handleUploadFiles(files, plId)}
            onPlayTrack={(trackId, playlistIndex) => void playLibraryTrack(trackId, playlistIndex)}
            onSortPlaylist={handleSortPlaylist}
            onMoveTrack={handleMoveTrack}
            onTransferTrackToPlaylist={handleTransferTrackToPlaylist}
            onDuplicateTrackInPlaylist={handleDuplicateTrackInPlaylist}
            onRemoveFromPlaylist={handleRemoveFromPlaylist}
            onDeleteTrackCompletely={handleDeleteTrackCompletely}
            onToggleFavorite={handleToggleFavorite}
            onShareWhatsApp={(pl) => handleShareWhatsApp(pl)}
            onExportBundleLink={(pl) => void handleExportBundleLink(pl)}
            onExportBundleFile={(pl) => void handleExportBundleFile(pl)}
            onImportFromLink={(raw) => void handleImportFromLink(raw)}
            onImportFromFile={(file) => void handleImportFromFile(file)}
            onQueueNextTrack={(trackId) => void handleQueueNextLocalTrack(trackId)}
          />
        {/if}
      {:else if activeModule === 'search'}
        <SearchResultsView
          query={globalSearchQuery}
          localMatches={localSearchMatches}
          {audiusResults}
          {audiusLoading}
          {audiusError}
          downloadingTrackId={downloadingAudiusId}
          actionBusy={searchActionBusy || playerActionBusy}
          currentTrackId={engineSnapshot.currentTrackId}
          isPlaying={engineSnapshot.status === 'playing'}
          {playlists}
          activePlaylistId={activePlaylist?.id ?? DEFAULT_PLAYLIST_ID}
          onSearchQuery={(q) => handleSearchInputChange(q)}
          onPlayLocalTrack={(trackId) => void playLibraryTrack(trackId)}
          onQueueNextLocalTrack={(trackId) => void handleQueueNextLocalTrack(trackId)}
          onPlayAudiusTrack={(item) => void handleSelectAudiusTrack(item, 'play')}
          onQueueNextAudiusTrack={(item) => void handleSelectAudiusTrack(item, 'queue')}
          onAddAudiusToPlaylist={(item, playlistId) => void handleSelectAudiusTrack(item, 'add', playlistId)}
        />
      {:else if activeModule === 'favorites'}
        <FavoritesView
          {favoriteTracks}
          currentTrackId={engineSnapshot.currentTrackId}
          isPlaying={engineSnapshot.status === 'playing'}
          onPlayTrack={(trackId) => playLibraryTrack(trackId)}
          onToggleFavorite={handleToggleFavorite}
          onPlayAllFavorites={handlePlayAllFavorites}
        />
      {:else if activeModule === 'monitoring'}
        <MonitoringView
          snapshot={engineSnapshot}
          {storageInfo}
          storageMode={settings.storageMode ?? 'browser'}
          deviceStorageName={settings.deviceStorageName ?? ''}
          tracksCount={tracks.length}
          playlistsCount={playlists.length}
          onRefresh={refreshStorageInfo}
          onSwitchStorage={handleSwitchToDeviceStorage}
          onClearDatabase={handleClearLocalDatabase}
        />
      {:else if activeModule === 'room'}
        <RoomView
          {room}
          participantId={roomParticipantId}
          {roomError}
          {uploadingToRoom}
          {roomActionBusy}
          theme={settings.theme}
          pendingInvite={pendingRoomInvite}
          {guestMuted}
          {guestAudioBlocked}
          onClearInvite={() => (pendingRoomInvite = null)}
          onCreateRoom={handleCreateRoom}
          onJoinRoom={handleJoinRoom}
          onShareRoomWhatsApp={handleShareRoomWhatsApp}
          onLeaveOrCloseRoom={requestLeaveOrCloseRoom}
          onUpdatePermissions={handleUpdateRoomPermissions}
          onRemoveParticipant={handleRemoveParticipant}
          onToggleGuestMute={handleToggleGuestMute}
          onUploadRoomFiles={handleUploadRoomFiles}
          onDeleteRoomTrack={handleDeleteRoomTrack}
          onRemoteCommand={handleRemoteRoomCommand}
        />
      {:else if activeModule === 'faq'}
        <FaqView />
      {/if}
    </main>
  </div>

  <BottomPlayerBar
    inPlayerView={activeModule === 'player'}
    snapshot={engineSnapshot}
    {currentTrack}
    {nextTrack}
    {upNextTracks}
    activePlaylist={activePlaylist ?? null}
    {activePlaylistTracks}
    {activePlaylistDuration}
    {hasPlaylistInPlayback}
    expanded={playerPlaylistExpanded}
    actionBusy={playerActionBusy}
    onToggleExpand={() => (playerPlaylistExpanded = !playerPlaylistExpanded)}
    onCollapse={() => (playerPlaylistExpanded = false)}
    onTogglePlay={() =>
      void actionController.run('player:transport', () => engine.togglePlayPause(), {
        minLockMs: 60,
      })}
    onNext={() =>
      void actionController.run('player:transport', () => engine.skipNext(), {
        minLockMs: 60,
      })}
    onPrevious={() =>
      void actionController.run('player:transport', () => engine.previous(), {
        minLockMs: 60,
      })}
    onSeek={(sec) => engine.seekTo(sec)}
    onOpenFullPlayer={() => (activeModule = 'player')}
    onPlayTrack={(trackId, playlistIndex) => void playLibraryTrack(trackId, playlistIndex)}
    onRequestClosePlaylist={() => (confirmClosePlaylistOpen = true)}
    onRequestAddToPlaylist={(trk) => (pendingAddTrackToPlaylist = trk)}
  />

  {#if pendingAddTrackToPlaylist}
    <div
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
    >
      <div class="w-full max-w-sm border border-zinc-300 bg-white p-5 shadow-2xl dark:border-zinc-800 dark:bg-zinc-950">
        <div class="flex items-start justify-between gap-2">
          <div class="min-w-0">
            <h3 class="text-sm font-semibold text-zinc-900 dark:text-white">
              Elegir playlist destino
            </h3>
            <p class="mt-0.5 truncate text-xs text-zinc-500 dark:text-zinc-400">
              {cleanDisplayTitle(pendingAddTrackToPlaylist.title) || pendingAddTrackToPlaylist.title}
            </p>
          </div>
          <button
            type="button"
            onclick={() => (pendingAddTrackToPlaylist = null)}
            title="Cerrar"
            aria-label="Cerrar"
            class="p-1 text-zinc-400 hover:text-zinc-900 dark:hover:text-white"
          >
            <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M18 6L6 18M6 6l12 12" stroke-linecap="round" />
            </svg>
          </button>
        </div>

        <div class="mt-3 max-h-60 space-y-1.5 overflow-y-auto">
          {#each playlists as pl (pl.id)}
            <button
              type="button"
              onclick={() => pendingAddTrackToPlaylist && void handleAddTrackToChosenPlaylist(pendingAddTrackToPlaylist, pl.id)}
              class="flex w-full items-center justify-between gap-2 border px-3 py-2.5 text-left text-xs transition {pl.id ===
              (activePlaylist?.id ?? '')
                ? 'border-cyan-500/60 bg-cyan-500/10 text-zinc-900 dark:text-white'
                : 'border-zinc-200 bg-zinc-50 text-zinc-800 hover:border-zinc-400 dark:border-zinc-800 dark:bg-black dark:text-zinc-200 dark:hover:border-zinc-600'}"
            >
              <div class="min-w-0 flex-1">
                <p class="truncate font-semibold">{pl.name}</p>
                <p class="text-[11px] text-zinc-500 dark:text-zinc-400">
                  {pl.trackIds.length} canciones
                </p>
              </div>
              {#if pl.id === activePlaylist?.id}
                <span class="shrink-0 bg-cyan-500 px-1.5 py-0.5 text-[10px] font-semibold text-black">
                  Activa
                </span>
              {/if}
            </button>
          {/each}
        </div>

        <div class="mt-4 flex justify-end">
          <button
            type="button"
            onclick={() => (pendingAddTrackToPlaylist = null)}
            class="border border-zinc-200 bg-zinc-50 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300"
          >
            Cancelar
          </button>
        </div>
      </div>
    </div>
  {/if}

  <ConfirmModal
    open={confirmClosePlaylistOpen}
    title="Cerrar playlist"
    message={`¿Seguro que deseas cerrar la playlist "${activePlaylist?.name ?? ''}" y detener su reproducción actual?`}
    confirmLabel="Cerrar playlist"
    danger={true}
    onConfirm={confirmCloseActivePlaylist}
    onCancel={() => (confirmClosePlaylistOpen = false)}
  />

  {#if confirmLeaveRoomOpen && room}
    <div
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
    >
      <div class="w-full max-w-sm border border-zinc-300 bg-white p-5 shadow-2xl dark:border-zinc-800 dark:bg-zinc-950">
        <h3 class="text-sm font-bold tracking-tight text-zinc-900 dark:text-white">
          ¡Estás dentro de una sala!
        </h3>
        <p class="mt-2 text-xs leading-relaxed text-zinc-600 dark:text-zinc-300">
          ¿Seguro que quieres salir de la sala <strong>{room.code}</strong>?
          {room.hostId === roomParticipantId ? ' Si sales como Host, la sala se cerrará para todos.' : ''}
        </p>

        <div class="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onclick={() => void handleLeaveOrCloseRoom()}
            class="border border-zinc-300 bg-zinc-100 px-3.5 py-2 text-xs font-medium text-zinc-800 transition hover:bg-zinc-200 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
          >
            Sí, salir
          </button>
          <button
            type="button"
            onclick={() => (confirmLeaveRoomOpen = false)}
            class="border border-red-800 bg-red-600 px-4 py-2 text-xs font-semibold text-white transition hover:bg-red-700"
          >
            No
          </button>
        </div>
      </div>
    </div>
  {/if}

  {#if roomEvictionAlert}
    <div
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="room-eviction-title"
    >
      <div class="relative w-full max-w-md border border-red-700/60 bg-white p-5 shadow-2xl dark:border-red-900/70 dark:bg-zinc-950">
        <button
          type="button"
          onclick={() => {
            roomEvictionAlert = null;
            activeModule = 'player';
          }}
          class="absolute top-3 right-3 flex h-8 w-8 items-center justify-center border border-zinc-300 bg-zinc-100 text-zinc-700 transition hover:bg-zinc-200 hover:text-zinc-950 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800 dark:hover:text-white"
          aria-label="Cerrar alerta y volver al reproductor"
          title="Cerrar y volver al reproductor"
        >
          <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>

        <div class="pr-10">
          <div class="mb-2 flex items-center gap-2 text-red-700 dark:text-red-400">
            <svg class="h-5 w-5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="9" />
              <path d="M12 8v5M12 16h.01" />
            </svg>
            <h3 id="room-eviction-title" class="text-sm font-semibold">
              Expulsado de la sala
            </h3>
          </div>
          <p class="text-xs leading-relaxed text-zinc-700 dark:text-zinc-300">
            {roomEvictionAlert}
          </p>
          <p class="mt-2 text-[11px] text-zinc-500 dark:text-zinc-400">
            Pulsa la <strong class="text-zinc-800 dark:text-zinc-200">X</strong> arriba a la derecha para volver al reproductor principal.
          </p>
        </div>
      </div>
    </div>
  {/if}

  {#if storagePromptMode}
    <div
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
    >
      <div class="w-full max-w-sm border border-zinc-300 bg-white p-5 shadow-2xl dark:border-zinc-800 dark:bg-zinc-950">
        <h3 class="text-sm font-bold tracking-tight text-zinc-900 dark:text-white">
          {storagePromptMode === 'mandatory'
            ? 'Almacenamiento del navegador lleno (99%)'
            : 'Almacenamiento del navegador casi lleno (90%)'}
        </h3>
        <p class="mt-2 text-xs leading-relaxed text-zinc-600 dark:text-zinc-300">
          {#if storagePromptMode === 'mandatory'}
            Alcanzaste el 99% del almacenamiento del navegador. Es obligatorio cambiar al almacenamiento interno de tu dispositivo para seguir descargando o guardando canciones. Las canciones anteriores permanecerán en el navegador sin migrar y las nuevas irán al dispositivo.
          {:else}
            Superaste el 90% del almacenamiento del navegador. Para poder seguir descargando canciones recomendamos que utilices el almacenamiento interno de tu dispositivo (sin migrar lo anterior; las nuevas descargas irán allí).
          {/if}
        </p>

        <div class="mt-5 flex flex-wrap justify-end gap-2">
          {#if storagePromptMode === 'recommend'}
            <button
              type="button"
              onclick={handleDecline90StorageSwitch}
              class="border border-zinc-300 bg-zinc-100 px-3 py-2 text-xs font-medium text-zinc-700 hover:bg-zinc-200 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300"
            >
              No aceptar
            </button>
          {:else}
            <button
              type="button"
              onclick={() => (storagePromptMode = null)}
              class="border border-zinc-300 bg-zinc-100 px-3 py-2 text-xs font-medium text-zinc-700 hover:bg-zinc-200 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300"
            >
              Cerrar (sin descargar)
            </button>
          {/if}
          <button
            type="button"
            onclick={() => void handleSwitchToDeviceStorage()}
            class="bg-zinc-900 px-3.5 py-2 text-xs font-semibold text-white hover:bg-zinc-800 dark:bg-white dark:text-black dark:hover:bg-zinc-200"
          >
            Cambiar almacenamiento
          </button>
        </div>
      </div>
    </div>
  {/if}

  {#if toastMessage}
    <div
      class="fixed bottom-5 left-1/2 z-40 -translate-x-1/2 border border-zinc-200 bg-white px-4 py-2 text-xs font-medium text-zinc-900 shadow-lg dark:border-zinc-800 dark:bg-zinc-900 dark:text-white"
    >
      {toastMessage}
    </div>
  {/if}

  <BlackoutOverlay
    active={blackoutActive}
    {wakeLockActive}
    snapshot={engineSnapshot}
    {currentTrack}
    {nextTrack}
    onExit={() => (blackoutActive = false)}
    onTogglePlay={() => engine.togglePlayPause()}
    onNext={() => engine.skipNext()}
  />
</div>
