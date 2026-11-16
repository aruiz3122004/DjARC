<script lang="ts">
  import whatsappDark from '../assets/whatsapp-dark.png';
  import whatsappLight from '../assets/whatsapp-light.png';
  import ConfirmModal from './ConfirmModal.svelte';
  import type { Playlist, SortOrder, ThemeMode, Track } from '../lib/types';
  import { extractBundleIdFromInput } from '../lib/utils/bundle';
  import {
    AUDIO_ACCEPT_ATTR,
    cleanDisplayArtist,
    cleanDisplayTitle,
    formatDurationTotal,
    formatTime,
  } from '../lib/utils/format';
  import { normalizeSearchText, scoreSearchMatch } from '../lib/search/searchEngine';

  interface Props {
    playlists: Playlist[];
    activePlaylist: Playlist;
    tracksById: Map<string, Track>;
    allTracks: Track[];
    theme: ThemeMode;
    currentTrackId: string | null;
    isPlaying: boolean;
    importing: boolean;
    importProgress: { done: number; total: number } | null;
    bundleBusy: boolean;
    actionBusy?: boolean;
    bundleStatusText: string | null;
    lastExportedLink: string | null;
    onSelectPlaylist: (id: string) => void;
    onCreatePlaylist: (name: string) => void;
    onRenamePlaylist: (id: string, name: string) => void;
    onDeletePlaylist: (id: string) => void;
    onUploadFiles: (files: FileList | File[], playlistId: string) => void;
    onPlayTrack: (trackId: string, playlistIndex: number) => void;
    onSortPlaylist: (order: SortOrder) => void;
    onMoveTrack: (index: number, direction: -1 | 1) => void;
    onTransferTrackToPlaylist: (
      sourcePlaylistId: string,
      indexInSource: number,
      trackId: string,
      targetPlaylistId: string,
      mode: 'move' | 'copy'
    ) => void;
    onDuplicateTrackInPlaylist: (trackId: string) => void;
    onRemoveFromPlaylist: (index: number) => void;
    onDeleteTrackCompletely: (trackId: string) => void;
    onToggleFavorite: (trackId: string) => void;
    onShareWhatsApp: (playlist: Playlist) => void;
    onExportBundleLink: (playlist: Playlist) => void;
    onExportBundleFile: (playlist: Playlist) => void;
    onImportFromLink: (linkOrCode: string) => void;
    onImportFromFile: (file: File) => void;
    onQueueNextTrack?: (trackId: string) => void;
    onPlayPlaylist?: (playlistId: string) => void;
  }

  let {
    playlists,
    activePlaylist,
    tracksById,
    allTracks,
    theme,
    currentTrackId,
    isPlaying,
    importing,
    importProgress,
    bundleBusy,
    actionBusy = false,
    bundleStatusText,
    lastExportedLink,
    onSelectPlaylist,
    onCreatePlaylist,
    onRenamePlaylist,
    onDeletePlaylist,
    onUploadFiles,
    onPlayTrack,
    onSortPlaylist,
    onMoveTrack,
    onTransferTrackToPlaylist,
    onDuplicateTrackInPlaylist,
    onRemoveFromPlaylist,
    onDeleteTrackCompletely,
    onToggleFavorite,
    onShareWhatsApp,
    onExportBundleLink,
    onExportBundleFile,
    onImportFromLink,
    onImportFromFile,
    onQueueNextTrack,
    onPlayPlaylist,
  }: Props = $props();

  let searchQuery = $state('');
  let showNewPlaylistForm = $state(false);
  let newPlaylistName = $state('');
  let showImportPanel = $state(false);
  let importLinkInput = $state('');
  let exportMenuPlaylistId = $state<string | null>(null);
  let copiedExportLink = $state(false);
  let showLibraryPicker = $state(false);
  let expandedPlaylistId = $state<string | null>(null);
  let uploadTargetPlaylistId = $state<string | null>(null);
  let editingPlaylistId = $state<string | null>(null);
  let editingPlaylistName = $state('');

  function startRenamePlaylist(pl: Playlist) {
    editingPlaylistId = pl.id;
    editingPlaylistName = pl.name;
  }

  function submitRenamePlaylist(ev: Event, plId: string) {
    ev.preventDefault();
    const trimmed = editingPlaylistName.trim();
    if (trimmed) {
      onRenamePlaylist(plId, trimmed);
    }
    editingPlaylistId = null;
    editingPlaylistName = '';
  }

  type PendingConfirm =
    | { kind: 'remove-from-playlist'; index: number; title: string }
    | { kind: 'delete-track'; trackId: string; title: string }
    | { kind: 'delete-playlist'; playlistId: string; name: string };
  let pendingConfirm = $state<PendingConfirm | null>(null);

  type PendingTransfer = {
    sourcePlaylistId: string;
    index: number;
    trackId: string;
    title: string;
  };
  let pendingTransfer = $state<PendingTransfer | null>(null);
  let keepCopyOnTransfer = $state(false);

  function executeTransfer(targetPlaylistId: string) {
    if (!pendingTransfer || actionBusy) return;
    const t = pendingTransfer;
    pendingTransfer = null;
    onTransferTrackToPlaylist(
      t.sourcePlaylistId,
      t.index,
      t.trackId,
      targetPlaylistId,
      keepCopyOnTransfer ? 'copy' : 'move'
    );
  }

  function executePendingConfirm() {
    const p = pendingConfirm;
    pendingConfirm = null;
    if (!p) return;
    if (p.kind === 'remove-from-playlist') {
      onRemoveFromPlaylist(p.index);
    } else if (p.kind === 'delete-track') {
      onDeleteTrackCompletely(p.trackId);
    } else if (p.kind === 'delete-playlist') {
      onDeletePlaylist(p.playlistId);
    }
  }

  $effect(() => {
    expandedPlaylistId = activePlaylist?.id ?? null;
  });

  let fileInputRef: HTMLInputElement | undefined = $state();
  let folderInputRef: HTMLInputElement | undefined = $state();
  let bundleInputRef: HTMLInputElement | undefined = $state();

  function getTracksForPlaylist(pl: Playlist): Track[] {
    const out: Track[] = [];
    for (const id of pl.trackIds) {
      const trk = tracksById.get(id);
      if (trk) out.push(trk);
    }
    return out;
  }

  let activeTracks = $derived(activePlaylist ? getTracksForPlaylist(activePlaylist) : []);

  let filteredActiveTracks = $derived.by(() => {
    const q = searchQuery.trim();
    return activeTracks
      .map((track, idx) => ({ track, idx }))
      .filter(({ track }) => {
        if (!q) return true;
        const norm = normalizeSearchText(`${track.title} ${track.artist} ${track.bpm ?? ''}`);
        return scoreSearchMatch(q, norm.spaced, norm.compact) > 0;
      });
  });

  function triggerFileUpload(playlistId: string) {
    uploadTargetPlaylistId = playlistId;
    fileInputRef?.click();
  }

  function triggerFolderUpload(playlistId: string) {
    uploadTargetPlaylistId = playlistId;
    folderInputRef?.click();
  }

  function handleFileChange(ev: Event) {
    const input = ev.currentTarget as HTMLInputElement;
    if (input.files && input.files.length > 0) {
      const targetId = uploadTargetPlaylistId ?? activePlaylist?.id ?? playlists[0]?.id;
      if (targetId) {
        onUploadFiles(input.files, targetId);
      }
      input.value = '';
    }
  }

  function submitNewPlaylist(ev: Event) {
    ev.preventDefault();
    const trimmed = newPlaylistName.trim();
    if (!trimmed) return;
    onCreatePlaylist(trimmed);
    newPlaylistName = '';
    showNewPlaylistForm = false;
  }

  function toggleExpand(plId: string) {
    if (expandedPlaylistId === plId) {
      expandedPlaylistId = null;
    } else {
      onSelectPlaylist(plId);
      expandedPlaylistId = plId;
    }
  }

  function handleBundleFileChange(ev: Event) {
    const input = ev.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (file) {
      onImportFromFile(file);
      showImportPanel = false;
      input.value = '';
    }
  }

  function submitImportLink(ev: Event) {
    ev.preventDefault();
    const raw = importLinkInput.trim();
    if (!raw) return;
    onImportFromLink(raw);
    importLinkInput = '';
    showImportPanel = false;
  }

  function handleImportLinkPaste(ev: ClipboardEvent) {
    const pasted = ev.clipboardData?.getData('text')?.trim() ?? '';
    if (!pasted) return;
    if (extractBundleIdFromInput(pasted)) {
      ev.preventDefault();
      importLinkInput = pasted;
      onImportFromLink(pasted);
      importLinkInput = '';
      showImportPanel = false;
    }
  }

  async function copyLastLink() {
    if (!lastExportedLink) return;
    try {
      await navigator.clipboard.writeText(lastExportedLink);
      copiedExportLink = true;
      setTimeout(() => {
        copiedExportLink = false;
      }, 1800);
    } catch {
      // Fallback silencioso
    }
  }
</script>

<section class="border border-zinc-200 bg-white p-4 sm:p-5 dark:border-zinc-900 dark:bg-zinc-950">
  <!-- Inputs ocultos compartidos para subir archivos/carpetas dentro de cualquier playlist -->
  <input
    bind:this={fileInputRef}
    type="file"
    multiple
    accept={AUDIO_ACCEPT_ATTR}
    onchange={handleFileChange}
    class="hidden"
  />
  <input
    bind:this={folderInputRef}
    type="file"
    multiple
    webkitdirectory
    accept={AUDIO_ACCEPT_ATTR}
    onchange={handleFileChange}
    class="hidden"
  />
  <input
    bind:this={bundleInputRef}
    type="file"
    accept=".zip,.gradmix,application/zip,application/x-zip-compressed,application/octet-stream"
    onchange={handleBundleFileChange}
    class="hidden"
  />

  <!-- Cabecera superior: título + botones Importar y Nueva -->
  <div class="flex items-center justify-between gap-2">
    <div>
      <h2 class="text-base font-semibold tracking-tight text-zinc-900 dark:text-white">
        Playlists
      </h2>
      <p class="text-[11px] text-zinc-500 dark:text-zinc-400">
        {allTracks.length} pistas locales
      </p>
    </div>

    <div class="flex items-center gap-1.5">
      <button
        type="button"
        onclick={() => {
          showImportPanel = !showImportPanel;
          if (showImportPanel) showNewPlaylistForm = false;
        }}
        title="Importar playlist (link o archivo .gradmix)"
        aria-label="Importar playlist"
        class="inline-flex h-9 items-center gap-1.5 border px-2.5 text-xs font-medium transition {showImportPanel
          ? 'border-zinc-900 bg-zinc-900 text-white dark:border-white dark:bg-white dark:text-black'
          : 'border-zinc-300 bg-zinc-50 text-zinc-900 hover:bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-900 dark:text-white dark:hover:bg-zinc-800'}"
      >
        <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M12 3v12m0 0l-4-4m4 4l4-4M4 17v3h16v-3" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        <span class="hidden sm:inline">Importar</span>
      </button>

      <button
        type="button"
        onclick={() => {
          showNewPlaylistForm = !showNewPlaylistForm;
          if (showNewPlaylistForm) showImportPanel = false;
        }}
        title="Crear playlist"
        aria-label="Crear playlist"
        class="inline-flex h-9 items-center gap-1.5 border border-zinc-300 bg-zinc-50 px-3 text-xs font-medium text-zinc-900 transition hover:bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-900 dark:text-white dark:hover:bg-zinc-800"
      >
        <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" stroke-linecap="round" />
        </svg>
        <span>Nueva</span>
      </button>
    </div>
  </div>

  <!-- Progreso de importación / empaquetado -->
  {#if bundleBusy && bundleStatusText}
    <div class="mt-3 border border-cyan-500/40 bg-cyan-500/5 p-3">
      <div class="flex items-center justify-between gap-2 text-xs font-medium text-cyan-700 dark:text-cyan-300">
        <span>{bundleStatusText}</span>
        {#if importProgress}
          <span class="tabular-nums">{importProgress.done} / {importProgress.total}</span>
        {/if}
      </div>
      {#if importProgress}
        <div class="mt-1.5 h-1.5 w-full overflow-hidden bg-zinc-200 dark:bg-zinc-900">
          <div
            class="h-full bg-cyan-500 transition-all"
            style="width: {Math.round((importProgress.done / Math.max(1, importProgress.total)) * 100)}%"
          ></div>
        </div>
      {/if}
    </div>
  {:else if importing && importProgress}
    <div class="mt-3 border border-cyan-500/30 bg-cyan-500/5 p-3">
      <div class="mb-1.5 flex justify-between text-xs text-cyan-700 dark:text-cyan-300">
        <span>Cargando en bloques...</span>
        <span class="tabular-nums font-medium">{importProgress.done} / {importProgress.total}</span>
      </div>
      <div class="h-1.5 w-full overflow-hidden bg-zinc-200 dark:bg-zinc-900">
        <div
          class="h-full bg-cyan-500 transition-all"
          style="width: {Math.round((importProgress.done / Math.max(1, importProgress.total)) * 100)}%"
        ></div>
      </div>
    </div>
  {/if}

  {#if showImportPanel}
    <div class="mt-3 space-y-2 border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-black">
      <p class="text-[11px] font-medium uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
        Importar playlist con canciones
      </p>
      <form onsubmit={submitImportLink} class="flex gap-2">
        <input
          type="text"
          bind:value={importLinkInput}
          onpaste={handleImportLinkPaste}
          placeholder="Pega aquí el link (?import=...) o código..."
          disabled={bundleBusy}
          class="flex-1 border border-zinc-200 bg-white px-3 py-1.5 text-xs text-zinc-900 placeholder-zinc-400 focus:border-cyan-500 focus:outline-none disabled:opacity-50 dark:border-zinc-800 dark:bg-zinc-950 dark:text-white"
        />
        <button
          type="submit"
          disabled={bundleBusy || !importLinkInput.trim()}
          title="Descargar playlist desde link"
          aria-label="Descargar playlist desde link"
          class="inline-flex items-center gap-1.5 bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40 dark:bg-white dark:text-black"
        >
          <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M12 3v12m0 0l-4-4m4 4l4-4M4 17v3h16v-3" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
          <span class="hidden sm:inline">Descargar</span>
        </button>
      </form>

      <div class="flex flex-wrap items-center justify-between gap-2 border-t border-zinc-200 pt-2 dark:border-zinc-900">
        <span class="text-[11px] text-zinc-500 dark:text-zinc-400">
          O desde almacenamiento interno (archivo .zip o .gradmix):
        </span>
        <button
          type="button"
          onclick={() => bundleInputRef?.click()}
          disabled={bundleBusy}
          class="inline-flex items-center gap-1.5 border border-zinc-300 bg-white px-2.5 py-1.5 text-xs font-medium text-zinc-900 transition hover:bg-zinc-100 disabled:opacity-40 dark:border-zinc-800 dark:bg-zinc-950 dark:text-white dark:hover:bg-zinc-900"
        >
          <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
          </svg>
          <span>Importar .zip</span>
        </button>
      </div>
    </div>
  {/if}

  {#if showNewPlaylistForm}
    <form
      onsubmit={submitNewPlaylist}
      class="mt-3 flex gap-2 border border-zinc-200 bg-zinc-50 p-2.5 dark:border-zinc-800 dark:bg-black"
    >
      <input
        type="text"
        bind:value={newPlaylistName}
        placeholder="Nombre de la playlist..."
        class="flex-1 border border-zinc-200 bg-white px-3 py-1.5 text-xs text-zinc-900 placeholder-zinc-400 focus:border-cyan-500 focus:outline-none dark:border-zinc-800 dark:bg-zinc-950 dark:text-white"
      />
      <button
        type="submit"
        disabled={actionBusy}
        class="bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40 dark:bg-cyan-400 dark:text-black"
      >
        Crear
      </button>
    </form>
  {/if}

  <!-- Acordeón desplegable de Playlists -->
  <div class="mt-4 space-y-2.5">
    {#each playlists as pl (pl.id)}
      {@const isExpanded = expandedPlaylistId === pl.id}
      {@const plTracks = isExpanded ? activeTracks : getTracksForPlaylist(pl)}
      {@const plDuration = plTracks.reduce((sum, t) => sum + (t.duration || 0), 0)}

      <div
        class="overflow-hidden border transition {isExpanded
          ? 'border-zinc-400 bg-zinc-50/40 dark:border-zinc-700 dark:bg-black'
          : 'border-zinc-200 bg-white dark:border-zinc-900 dark:bg-black'}"
      >
        <!-- Cabecera desplegable -->
        <div class="flex items-center justify-between gap-2 px-3 py-2.5">
          {#if editingPlaylistId === pl.id}
            <form
              onsubmit={(ev) => submitRenamePlaylist(ev, pl.id)}
              class="flex flex-1 items-center gap-1.5"
            >
              <input
                type="text"
                bind:value={editingPlaylistName}
                aria-label="Nuevo nombre de la playlist"
                class="min-w-0 flex-1 border border-zinc-300 bg-white px-2.5 py-1 text-xs text-zinc-900 focus:border-cyan-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-950 dark:text-white"
              />
              <button
                type="submit"
                title="Guardar nombre"
                aria-label="Guardar nombre"
                class="flex h-7 w-7 items-center justify-center bg-zinc-900 text-white dark:bg-white dark:text-black"
              >
                <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
                  <path d="M5 13l4 4L19 7" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
              </button>
              <button
                type="button"
                onclick={() => (editingPlaylistId = null)}
                title="Cancelar"
                aria-label="Cancelar"
                class="flex h-7 w-7 items-center justify-center border border-zinc-300 bg-white text-zinc-600 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-300"
              >
                <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M18 6L6 18M6 6l12 12" stroke-linecap="round" />
                </svg>
              </button>
            </form>
          {:else}
            <button
              type="button"
              onclick={() => toggleExpand(pl.id)}
              class="flex min-w-0 flex-1 items-center gap-2 text-left"
            >
              <svg
                class="h-4 w-4 shrink-0 text-zinc-400 transition-transform {isExpanded ? 'rotate-90 text-zinc-900 dark:text-white' : ''}"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
              >
                <path d="M9 18l6-6-6-6" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
              <span class="truncate text-xs font-semibold text-zinc-900 dark:text-zinc-100">
                {pl.name}
              </span>
              <span class="tabular-nums text-[11px] text-zinc-400">
                {pl.trackIds.length} · {formatDurationTotal(plDuration)}
              </span>
            </button>

            <div class="flex shrink-0 items-center gap-1">
              <button
                type="button"
                onclick={() => {
                  if (onPlayPlaylist) {
                    onPlayPlaylist(pl.id);
                  } else if (plTracks.length > 0) {
                    onSelectPlaylist(pl.id);
                    onPlayTrack(plTracks[0].id, 0);
                  }
                }}
                disabled={actionBusy || plTracks.length === 0}
                title="Reproducir playlist"
                aria-label="Reproducir playlist"
                class="flex h-7 w-7 items-center justify-center bg-zinc-900 text-white transition hover:bg-zinc-800 active:scale-95 disabled:opacity-35 dark:bg-white dark:text-black dark:hover:bg-zinc-200"
              >
                <svg class="h-3.5 w-3.5 translate-x-[0.5px]" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M8 5v14l11-7z" />
                </svg>
              </button>

              <button
                type="button"
                onclick={() => startRenamePlaylist(pl)}
                title="Cambiar nombre de la playlist"
                aria-label="Cambiar nombre de la playlist"
                class="p-1 text-zinc-400 transition hover:text-zinc-900 dark:hover:text-white"
              >
                <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M12 20h9" stroke-linecap="round" stroke-linejoin="round" />
                  <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
              </button>

              {#if playlists.length > 1 && pl.id !== 'pl-main-party'}
                <button
                  type="button"
                  onclick={() => (pendingConfirm = { kind: 'delete-playlist', playlistId: pl.id, name: pl.name })}
                  title="Eliminar playlist"
                  aria-label="Eliminar playlist"
                  class="p-1 text-zinc-400 hover:text-red-500"
                >
                  <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M18 6L6 18M6 6l12 12" stroke-linecap="round" />
                  </svg>
                </button>
              {/if}
            </div>
          {/if}
        </div>

        <!-- Contenido Lazy-Rendered al desplegar -->
        {#if isExpanded}
          <div class="border-t border-zinc-200 p-3 dark:border-zinc-900">
            <!-- Barra interna: Buscador + 3 botones solo íconos (+, Carpeta, WhatsApp) + Orden -->
            <div class="mb-3 flex flex-wrap items-center gap-2">
              <input
                type="search"
                bind:value={searchQuery}
                placeholder="Buscar..."
                class="min-w-[120px] flex-1 border border-zinc-200 bg-white px-2.5 py-1.5 text-xs text-zinc-900 placeholder-zinc-400 focus:border-cyan-500 focus:outline-none dark:border-zinc-800 dark:bg-zinc-950 dark:text-white"
              />

              <!-- Solo íconos para Subir Canciones (+), Subir Carpeta y WhatsApp -->
              <div class="flex items-center gap-1">
                <button
                  type="button"
                  onclick={() => triggerFileUpload(pl.id)}
                  disabled={importing || actionBusy}
                  title="Subir canciones"
                  aria-label="Subir canciones"
                  class="flex h-8 w-8 items-center justify-center bg-zinc-900 text-white transition hover:bg-zinc-800 active:scale-95 disabled:opacity-50 dark:bg-white dark:text-black dark:hover:bg-zinc-200"
                >
                  <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
                    <path d="M12 5v14M5 12h14" stroke-linecap="round" />
                  </svg>
                </button>

                <button
                  type="button"
                  onclick={() => triggerFolderUpload(pl.id)}
                  disabled={importing || actionBusy}
                  title="Subir carpeta"
                  aria-label="Subir carpeta"
                  class="flex h-8 w-8 items-center justify-center border border-zinc-200 bg-white text-zinc-900 transition hover:bg-zinc-100 active:scale-95 disabled:opacity-50 dark:border-zinc-800 dark:bg-zinc-950 dark:text-white dark:hover:bg-zinc-900"
                >
                  <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
                  </svg>
                </button>

                <button
                  type="button"
                  onclick={() => onShareWhatsApp(pl)}
                  disabled={plTracks.length === 0 || actionBusy}
                  title="Compartir lista por WhatsApp"
                  aria-label="Compartir lista por WhatsApp"
                  class="flex h-8 w-8 items-center justify-center border border-zinc-200 bg-white transition hover:bg-zinc-100 active:scale-95 disabled:opacity-40 dark:border-zinc-800 dark:bg-zinc-950 dark:hover:bg-zinc-900"
                >
                  <img
                    src={theme === 'dark' ? whatsappLight : whatsappDark}
                    alt="WhatsApp"
                    class="h-4 w-4 object-contain"
                  />
                </button>

                <button
                  type="button"
                  onclick={() => (exportMenuPlaylistId = exportMenuPlaylistId === pl.id ? null : pl.id)}
                  disabled={plTracks.length === 0 || bundleBusy}
                  title="Exportar playlist con canciones (Link o archivo .gradmix)"
                  aria-label="Exportar playlist con canciones"
                  class="flex h-8 w-8 items-center justify-center border transition active:scale-95 disabled:opacity-40 {exportMenuPlaylistId === pl.id
                    ? 'border-zinc-900 bg-zinc-900 text-white dark:border-white dark:bg-white dark:text-black'
                    : 'border-zinc-200 bg-white text-zinc-900 hover:bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-950 dark:text-white dark:hover:bg-zinc-900'}"
                >
                  <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M12 16V4m0 0l-4 4m4-4l4 4M4 17v3h16v-3" stroke-linecap="round" stroke-linejoin="round" />
                  </svg>
                </button>
              </div>

              <div class="flex items-center gap-1">
                <button
                  type="button"
                  onclick={() => onSortPlaylist('title-asc')}
                  disabled={actionBusy}
                  title="Ordenar A-Z"
                  class="border border-zinc-200 bg-white px-2 py-1 text-[11px] text-zinc-600 hover:border-zinc-400 disabled:opacity-40 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-300"
                >
                  A-Z
                </button>
                {#if allTracks.length > 0}
                  <button
                    type="button"
                    onclick={() => (showLibraryPicker = !showLibraryPicker)}
                    title="Añadir desde biblioteca"
                    aria-label="Añadir desde biblioteca"
                    class="border border-zinc-200 bg-white p-1.5 text-zinc-600 hover:border-zinc-400 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-300"
                  >
                    <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20M4 4.5A2.5 2.5 0 0 1 6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15z" />
                    </svg>
                  </button>
                {/if}
              </div>
            </div>

            {#if exportMenuPlaylistId === pl.id}
              <div class="mb-3 space-y-2 border border-zinc-200 bg-white p-2.5 dark:border-zinc-800 dark:bg-zinc-950">
                <div class="flex flex-wrap items-center justify-between gap-2">
                  <span class="text-[11px] font-medium text-zinc-600 dark:text-zinc-300">
                    Empaquetar canciones ({plTracks.length}):
                  </span>
                  <div class="flex items-center gap-1.5">
                    <button
                      type="button"
                      onclick={() => onExportBundleLink(pl)}
                      disabled={bundleBusy || plTracks.length === 0}
                      class="inline-flex items-center gap-1.5 bg-zinc-900 px-2.5 py-1.5 text-[11px] font-medium text-white disabled:opacity-40 dark:bg-white dark:text-black"
                    >
                      <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" stroke-linecap="round" />
                      </svg>
                      <span>Generar Link</span>
                    </button>

                    <button
                      type="button"
                      onclick={() => onExportBundleFile(pl)}
                      disabled={bundleBusy || plTracks.length === 0}
                      title="Descargar carpeta comprimida .zip con cada canción por separado"
                      class="inline-flex items-center gap-1.5 border border-zinc-300 bg-zinc-50 px-2.5 py-1.5 text-[11px] font-medium text-zinc-900 disabled:opacity-40 dark:border-zinc-800 dark:bg-black dark:text-white"
                    >
                      <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" stroke-linecap="round" stroke-linejoin="round" />
                      </svg>
                      <span>Guardar .zip</span>
                    </button>
                  </div>
                </div>

                {#if lastExportedLink}
                  <div class="flex items-center gap-1.5 border-t border-zinc-200 pt-2 dark:border-zinc-900">
                    <input
                      type="text"
                      readonly
                      value={lastExportedLink}
                      onclick={(e) => (e.currentTarget as HTMLInputElement).select()}
                      class="flex-1 border border-zinc-200 bg-zinc-50 px-2 py-1 text-[11px] font-mono text-zinc-800 focus:outline-none dark:border-zinc-800 dark:bg-black dark:text-zinc-200"
                    />
                    <button
                      type="button"
                      onclick={copyLastLink}
                      class="border border-zinc-300 bg-zinc-100 px-2.5 py-1 text-[11px] font-medium text-zinc-900 dark:border-zinc-800 dark:bg-zinc-900 dark:text-white"
                    >
                      {copiedExportLink ? 'Copiado' : 'Copiar'}
                    </button>
                  </div>
                {/if}
              </div>
            {/if}

            {#if showLibraryPicker && allTracks.length > 0}
              <div class="mb-3 max-h-40 overflow-y-auto border border-zinc-200 bg-white p-2 dark:border-zinc-800 dark:bg-zinc-950">
                {#each allTracks as libTrack (libTrack.id)}
                  <div class="flex items-center justify-between gap-2 px-2 py-1 text-xs hover:bg-zinc-100 dark:hover:bg-zinc-900">
                    <span class="truncate text-zinc-700 dark:text-zinc-300">{libTrack.title}</span>
                    <button
                      type="button"
                      onclick={() => onDuplicateTrackInPlaylist(libTrack.id)}
                      class="shrink-0 text-[11px] font-medium text-cyan-600 dark:text-cyan-400"
                    >
                      + Añadir
                    </button>
                  </div>
                {/each}
              </div>
            {/if}

            <!-- Lista de canciones -->
            <div class="max-h-[400px] space-y-1.5 overflow-y-auto">
              {#if filteredActiveTracks.length === 0}
                <p class="py-6 text-center text-xs text-zinc-400">
                  {activeTracks.length === 0
                    ? 'Playlist vacía. Sube canciones o una carpeta.'
                    : 'Sin coincidencias.'}
                </p>
              {:else}
                {#each filteredActiveTracks as { track, idx } (`${idx}-${track.id}`)}
                  {@const isCurrent = currentTrackId === track.id}
                  <div
                    class="flex items-center gap-2 border p-2 transition {isCurrent
                      ? 'border-cyan-500/60 bg-cyan-50/70 dark:bg-cyan-950/20'
                      : 'border-zinc-200 bg-white hover:border-zinc-300 dark:border-zinc-900 dark:bg-zinc-950 dark:hover:border-zinc-800'}"
                  >
                    <button
                      type="button"
                      onclick={() => onPlayTrack(track.id, idx)}
                      aria-label={`Reproducir ${track.title}`}
                      class="flex h-8 w-8 shrink-0 items-center justify-center tabular-nums text-xs font-semibold {isCurrent
                        ? 'bg-cyan-500 text-black'
                        : 'bg-zinc-100 text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400'}"
                    >
                      {#if isCurrent && isPlaying}
                        <span class="h-2 w-2 bg-black animate-ping"></span>
                      {:else}
                        {idx + 1}
                      {/if}
                    </button>

                    <button
                      type="button"
                      onclick={() => onPlayTrack(track.id, idx)}
                      class="min-w-0 flex-1 text-left"
                    >
                      <p class="truncate text-xs font-medium text-zinc-900 dark:text-zinc-100">
                        {cleanDisplayTitle(track.title) || track.title}
                      </p>
                      <p class="truncate text-[11px] text-zinc-500 dark:text-zinc-400">
                        {cleanDisplayArtist(track.artist) || 'Artista desconocido'}
                      </p>
                    </button>

                    <div class="flex shrink-0 items-center gap-1.5 tabular-nums text-[11px] text-zinc-400">
                      {#if track.bpm}
                        <span class="hidden sm:inline text-cyan-600 dark:text-cyan-400">{track.bpm}</span>
                      {/if}
                      <span>{formatTime(track.duration)}</span>
                    </div>

                    <div class="flex shrink-0 items-center gap-0.5">
                      {#if onQueueNextTrack}
                        <button
                          type="button"
                          onclick={() => onQueueNextTrack(track.id)}
                          disabled={actionBusy}
                          title="Añadir a la cola (reproducir siguiente)"
                          aria-label="Añadir a la cola"
                          class="p-1.5 text-zinc-400 hover:text-cyan-500 disabled:opacity-25"
                        >
                          <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M3 6h12M3 12h8M3 18h8" stroke-linecap="round" />
                            <path d="M16 11l5 3.5-5 3.5V11z" fill="currentColor" stroke="none" />
                          </svg>
                        </button>
                      {/if}

                      <button
                        type="button"
                        onclick={() => onToggleFavorite(track.id)}
                        title="Favorito"
                        aria-label="Favorito"
                        class="p-1.5 {track.favorite ? 'text-rose-500' : 'text-zinc-400 hover:text-rose-400'}"
                      >
                        <svg
                          class="h-3.5 w-3.5"
                          viewBox="0 0 24 24"
                          fill={track.favorite ? 'currentColor' : 'none'}
                          stroke="currentColor"
                          stroke-width="2"
                        >
                          <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
                        </svg>
                      </button>

                      <button
                        type="button"
                        onclick={() => onMoveTrack(idx, -1)}
                        disabled={idx === 0 || actionBusy}
                        title="Subir en la lista"
                        aria-label="Subir canción en la lista"
                        class="inline-flex h-7 w-7 items-center justify-center text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-900 disabled:opacity-25 dark:text-zinc-400 dark:hover:bg-zinc-900 dark:hover:text-white"
                      >
                        <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
                          <path d="M12 19V5m0 0l-5 5m5-5l5 5" stroke-linecap="round" stroke-linejoin="round" />
                        </svg>
                      </button>

                      <button
                        type="button"
                        onclick={() => onMoveTrack(idx, 1)}
                        disabled={idx === activeTracks.length - 1 || actionBusy}
                        title="Bajar en la lista"
                        aria-label="Bajar canción en la lista"
                        class="inline-flex h-7 w-7 items-center justify-center text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-900 disabled:opacity-25 dark:text-zinc-400 dark:hover:bg-zinc-900 dark:hover:text-white"
                      >
                        <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
                          <path d="M12 5v14m0 0l-5-5m5 5l5-5" stroke-linecap="round" stroke-linejoin="round" />
                        </svg>
                      </button>

                      {#if playlists.length > 1}
                        <button
                          type="button"
                          onclick={() => {
                            keepCopyOnTransfer = false;
                            pendingTransfer = {
                              sourcePlaylistId: pl.id,
                              index: idx,
                              trackId: track.id,
                              title: cleanDisplayTitle(track.title) || track.title,
                            };
                          }}
                          disabled={actionBusy}
                          title="Pasar a otra playlist"
                          aria-label="Pasar canción a otra playlist"
                          class="inline-flex h-7 w-7 items-center justify-center text-zinc-500 transition hover:bg-zinc-100 hover:text-cyan-600 disabled:opacity-25 dark:text-zinc-400 dark:hover:bg-zinc-900 dark:hover:text-cyan-400"
                        >
                          <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M15 3h6v6M10 14L21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" stroke-linecap="round" stroke-linejoin="round" />
                          </svg>
                        </button>
                      {/if}

                      <button
                        type="button"
                        onclick={() =>
                          (pendingConfirm = {
                            kind: 'remove-from-playlist',
                            index: idx,
                            title: track.title,
                          })}
                        title="Quitar de la playlist"
                        aria-label="Quitar de la playlist"
                        class="p-1.5 text-zinc-400 hover:text-amber-500"
                      >
                        <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                          <path d="M18 6L6 18M6 6l12 12" stroke-linecap="round" />
                        </svg>
                      </button>

                      <button
                        type="button"
                        onclick={() =>
                          (pendingConfirm = {
                            kind: 'delete-track',
                            trackId: track.id,
                            title: track.title,
                          })}
                        title="Eliminar archivo"
                        aria-label="Eliminar archivo"
                        class="p-1.5 text-zinc-400 hover:text-red-500"
                      >
                        <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                          <path d="M3 6h18M8 6V4h8v2m-1 0v14H9V6h6z" stroke-linecap="round" stroke-linejoin="round" />
                        </svg>
                      </button>
                    </div>
                  </div>
                {/each}
              {/if}
            </div>
          </div>
        {/if}
      </div>
    {/each}
  </div>
</section>

<ConfirmModal
  open={pendingConfirm !== null}
  title={pendingConfirm?.kind === 'delete-playlist'
    ? 'Eliminar playlist'
    : pendingConfirm?.kind === 'delete-track'
      ? 'Eliminar archivo de audio'
      : 'Quitar canción'}
  message={pendingConfirm?.kind === 'delete-playlist'
    ? `¿Seguro que quieres eliminar la playlist "${pendingConfirm.name}"?`
    : pendingConfirm?.kind === 'delete-track'
      ? `¿Seguro que quieres eliminar "${pendingConfirm.title}" de la biblioteca local? Esta acción no se puede deshacer.`
      : pendingConfirm?.kind === 'remove-from-playlist'
        ? `¿Seguro que quieres quitar "${pendingConfirm.title}" de esta playlist?`
        : ''}
  confirmLabel="Eliminar"
  danger={true}
  onConfirm={executePendingConfirm}
  onCancel={() => (pendingConfirm = null)}
/>

{#if pendingTransfer}
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
    role="dialog"
    aria-modal="true"
  >
    <div class="w-full max-w-sm border border-zinc-300 bg-white p-5 shadow-2xl dark:border-zinc-800 dark:bg-zinc-950">
      <div class="flex items-start justify-between gap-2">
        <div class="min-w-0">
          <h3 class="text-sm font-semibold text-zinc-900 dark:text-white">
            Pasar a otra playlist
          </h3>
          <p class="mt-0.5 truncate text-xs text-zinc-500 dark:text-zinc-400">
            {pendingTransfer.title}
          </p>
        </div>
        <button
          type="button"
          onclick={() => (pendingTransfer = null)}
          title="Cerrar"
          aria-label="Cerrar"
          class="p-1 text-zinc-400 hover:text-zinc-900 dark:hover:text-white"
        >
          <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M18 6L6 18M6 6l12 12" stroke-linecap="round" />
          </svg>
        </button>
      </div>

      <label class="mt-3 flex cursor-pointer items-center gap-2 border border-zinc-200 bg-zinc-50 px-3 py-2 text-[11px] text-zinc-700 dark:border-zinc-800 dark:bg-black dark:text-zinc-300">
        <input type="checkbox" bind:checked={keepCopyOnTransfer} class="accent-cyan-500" />
        <span>Mantener copia también en la playlist actual</span>
      </label>

      <div class="mt-3 max-h-60 space-y-1.5 overflow-y-auto">
        {#each playlists.filter((p) => p.id !== pendingTransfer?.sourcePlaylistId) as dest (dest.id)}
          <button
            type="button"
            onclick={() => executeTransfer(dest.id)}
            disabled={actionBusy}
            class="flex w-full items-center justify-between gap-2 border border-zinc-200 bg-zinc-50 px-3 py-2.5 text-left text-xs text-zinc-800 transition hover:border-cyan-500/60 hover:bg-cyan-500/10 disabled:opacity-40 dark:border-zinc-800 dark:bg-black dark:text-zinc-200"
          >
            <div class="min-w-0 flex-1">
              <p class="truncate font-semibold">{dest.name}</p>
              <p class="text-[11px] text-zinc-500 dark:text-zinc-400">
                {dest.trackIds.length} canciones
              </p>
            </div>
            <span class="shrink-0 bg-zinc-900 px-2 py-0.5 text-[10px] font-semibold text-white dark:bg-white dark:text-black">
              {keepCopyOnTransfer ? 'Copiar' : 'Mover'}
            </span>
          </button>
        {/each}
      </div>

      <div class="mt-4 flex justify-end">
        <button
          type="button"
          onclick={() => (pendingTransfer = null)}
          class="border border-zinc-200 bg-zinc-50 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300"
        >
          Cancelar
        </button>
      </div>
    </div>
  </div>
{/if}
