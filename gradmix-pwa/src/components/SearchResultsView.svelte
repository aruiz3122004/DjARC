<script lang="ts">
  import type { AudiusCatalogTrack, Playlist } from '../lib/types';
  import type { LocalSearchMatch } from '../lib/search/searchEngine';
  import { cleanDisplayArtist, cleanDisplayTitle, formatTime } from '../lib/utils/format';

  interface Props {
    query: string;
    localMatches: LocalSearchMatch[];
    audiusResults: AudiusCatalogTrack[];
    audiusLoading: boolean;
    audiusError: string | null;
    downloadingTrackId: string | null;
    actionBusy?: boolean;
    currentTrackId: string | null;
    isPlaying: boolean;
    playlists: Playlist[];
    activePlaylistId: string;
    onSearchQuery: (q: string) => void;
    onPlayLocalTrack: (trackId: string) => void;
    onQueueNextLocalTrack: (trackId: string) => void;
    onPlayAudiusTrack: (item: AudiusCatalogTrack) => void;
    onQueueNextAudiusTrack: (item: AudiusCatalogTrack) => void;
    onAddAudiusToPlaylist: (item: AudiusCatalogTrack, targetPlaylistId: string) => void;
  }

  let {
    query,
    localMatches,
    audiusResults,
    audiusLoading,
    audiusError,
    downloadingTrackId,
    actionBusy = false,
    currentTrackId,
    isPlaying,
    playlists,
    activePlaylistId,
    onSearchQuery,
    onPlayLocalTrack,
    onQueueNextLocalTrack,
    onPlayAudiusTrack,
    onQueueNextAudiusTrack,
    onAddAudiusToPlaylist,
  }: Props = $props();

  let pageInput = $state('');
  let pendingAddItem = $state<AudiusCatalogTrack | null>(null);

  $effect(() => {
    pageInput = query;
  });

  function submitSearch(ev: Event) {
    ev.preventDefault();
    onSearchQuery(pageInput);
  }

  function handleRequestAdd(item: AudiusCatalogTrack) {
    if (playlists.length <= 1) {
      onAddAudiusToPlaylist(item, playlists[0]?.id ?? activePlaylistId);
      return;
    }
    pendingAddItem = item;
  }

  function confirmAddToPlaylist(targetId: string) {
    if (!pendingAddItem) return;
    const item = pendingAddItem;
    pendingAddItem = null;
    onAddAudiusToPlaylist(item, targetId);
  }
</script>

<section class="space-y-4">
  <div class="border border-zinc-200 bg-white p-4 sm:p-5 dark:border-zinc-900 dark:bg-zinc-950">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <div>
        <h2 class="text-base font-semibold tracking-tight text-zinc-900 dark:text-white">
          Coincidencias
        </h2>
        <p class="text-[11px] text-zinc-500 dark:text-zinc-400">
          {query.trim()
            ? `${localMatches.length + audiusResults.length} resultados para "${query.trim()}"`
            : 'Canciones conocidas listas para reproducir o añadir a tu playlist'}
        </p>
      </div>
    </div>

    <form onsubmit={submitSearch} class="mt-3 flex gap-2">
      <input
        type="search"
        bind:value={pageInput}
        oninput={() => onSearchQuery(pageInput)}
        placeholder="Buscar canción o artista..."
        class="flex-1 border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs text-zinc-900 placeholder-zinc-400 focus:border-cyan-500 focus:outline-none dark:border-zinc-800 dark:bg-black dark:text-white"
      />
      <button
        type="submit"
        class="bg-zinc-900 px-3.5 py-2 text-xs font-medium text-white dark:bg-white dark:text-black"
      >
        Buscar
      </button>
    </form>
  </div>

  <!-- Coincidencias Locales -->
  {#if query.trim() && localMatches.length > 0}
    <div class="border border-zinc-200 bg-white p-4 sm:p-5 dark:border-zinc-900 dark:bg-zinc-950">
      <div class="mb-3 flex items-center justify-between">
        <h3 class="text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
          En tus Playlists ({localMatches.length})
        </h3>
      </div>

      <div class="space-y-1.5">
        {#each localMatches as match (match.track.id)}
          {@const isCurrent = currentTrackId === match.track.id}
          <div
            class="flex items-center gap-2.5 border p-2.5 {isCurrent
              ? 'border-cyan-500/60 bg-cyan-500/10'
              : 'border-zinc-200 bg-zinc-50/50 dark:border-zinc-900 dark:bg-black'}"
          >
            <button
              type="button"
              onclick={() => onPlayLocalTrack(match.track.id)}
              disabled={actionBusy || downloadingTrackId !== null}
              title="Reproducir"
              aria-label={`Reproducir ${match.track.title}`}
              class="flex h-8 w-8 shrink-0 items-center justify-center bg-zinc-900 text-white disabled:opacity-40 dark:bg-white dark:text-black"
            >
              {#if isCurrent && isPlaying}
                <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M6 5h4v14H6zM14 5h4v14h-4z" />
                </svg>
              {:else}
                <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M8 5v14l11-7z" />
                </svg>
              {/if}
            </button>

              <div class="min-w-0 flex-1">
                <p class="truncate text-xs font-semibold text-zinc-900 dark:text-white">
                  {cleanDisplayTitle(match.track.title) || match.track.title}
                </p>
                <p class="truncate text-[11px] text-zinc-500 dark:text-zinc-400">
                  {[cleanDisplayArtist(match.track.artist) || 'Artista desconocido', match.playlistNames.join(', ')]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
              </div>

            <div class="flex shrink-0 items-center gap-2 tabular-nums text-[11px] text-zinc-400">
              <span>{formatTime(match.track.duration)}</span>
              <button
                type="button"
                onclick={() => onQueueNextLocalTrack(match.track.id)}
                disabled={actionBusy}
                title="Añadir a la cola (reproducir siguiente)"
                aria-label={`Añadir ${match.track.title} a la cola`}
                class="flex h-8 w-8 items-center justify-center border border-zinc-300 bg-white text-zinc-900 transition hover:bg-zinc-100 disabled:opacity-40 dark:border-zinc-800 dark:bg-zinc-950 dark:text-white dark:hover:bg-zinc-900"
              >
                <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M3 6h12M3 12h8M3 18h8" stroke-linecap="round" />
                  <path d="M16 11l5 3.5-5 3.5V11z" fill="currentColor" stroke="none" />
                </svg>
              </button>
            </div>
          </div>
        {/each}
      </div>
    </div>
  {/if}

  <!-- Resultados del Catálogo -->
  <div class="border border-zinc-200 bg-white p-4 sm:p-5 dark:border-zinc-900 dark:bg-zinc-950">
    <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
      <h3 class="text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
        {query.trim() ? `Canciones (${audiusResults.length})` : 'Populares'}
      </h3>
    </div>

    {#if audiusLoading}
      <div class="border border-zinc-200 bg-zinc-50 p-4 text-center text-xs text-zinc-500 dark:border-zinc-900 dark:bg-black dark:text-zinc-400">
        Buscando canciones...
      </div>
    {:else if audiusError}
      <div class="border border-red-500/40 bg-red-500/10 p-3 text-xs text-red-600 dark:text-red-300">
        {audiusError}
      </div>
    {:else if audiusResults.length === 0}
      <p class="py-4 text-center text-xs text-zinc-400">
        {query.trim()
          ? `Sin coincidencias para "${query.trim()}".`
          : 'Escribe en el buscador para encontrar canciones.'}
      </p>
    {:else}
      <div class="space-y-2">
        {#each audiusResults as item (item.id)}
          {@const isDownloading = downloadingTrackId === item.id}
          <div class="flex items-center gap-3 border border-zinc-200 bg-zinc-50/50 p-2.5 dark:border-zinc-900 dark:bg-black">
            {#if item.artworkUrl}
              <img
                src={item.artworkUrl}
                alt={item.title}
                loading="lazy"
                class="h-10 w-10 shrink-0 border border-zinc-200 object-cover dark:border-zinc-800"
              />
            {:else}
              <div class="flex h-10 w-10 shrink-0 items-center justify-center border border-zinc-200 bg-zinc-100 text-zinc-400 dark:border-zinc-800 dark:bg-zinc-900">
                <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M9 18V5l12-2v13" stroke-linecap="round" stroke-linejoin="round" />
                  <circle cx="6" cy="18" r="3" />
                  <circle cx="18" cy="16" r="3" />
                </svg>
              </div>
            {/if}

            <div class="min-w-0 flex-1">
              <p class="truncate text-xs font-semibold text-zinc-900 dark:text-white">
                {item.title}
              </p>
              <p class="truncate text-[11px] text-zinc-500 dark:text-zinc-400">
                {item.artist}
                {#if item.genre}
                  · {item.genre}
                {/if}
                · {formatTime(item.duration)}
              </p>
            </div>

            <div class="flex shrink-0 items-center gap-1.5">
              <button
                type="button"
                onclick={() => onPlayAudiusTrack(item)}
                disabled={actionBusy || downloadingTrackId !== null}
                title="Reproducir canción independiente (fuera de playlists)"
                aria-label={`Reproducir ${item.title}`}
                class="inline-flex h-8 items-center gap-1 bg-zinc-900 px-2.5 text-[11px] font-medium text-white transition hover:bg-zinc-800 disabled:opacity-40 dark:bg-white dark:text-black dark:hover:bg-zinc-200"
              >
                <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M8 5v14l11-7z" />
                </svg>
                <span class="hidden sm:inline">{isDownloading ? 'Cargando...' : 'Reproducir'}</span>
              </button>

              <button
                type="button"
                onclick={() => onQueueNextAudiusTrack(item)}
                disabled={actionBusy || downloadingTrackId !== null}
                title="Añadir a la cola (reproducir siguiente)"
                aria-label={`Añadir ${item.title} a la cola`}
                class="inline-flex h-8 w-8 items-center justify-center border border-zinc-300 bg-white text-zinc-900 transition hover:bg-zinc-100 disabled:opacity-40 dark:border-zinc-800 dark:bg-zinc-950 dark:text-white dark:hover:bg-zinc-900"
              >
                <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M3 6h12M3 12h8M3 18h8" stroke-linecap="round" />
                  <path d="M16 11l5 3.5-5 3.5V11z" fill="currentColor" stroke="none" />
                </svg>
              </button>

              <button
                type="button"
                onclick={() => handleRequestAdd(item)}
                disabled={actionBusy || downloadingTrackId !== null}
                title="Descargar en una playlist"
                aria-label={`Añadir ${item.title} a una playlist`}
                class="inline-flex h-8 w-8 items-center justify-center border border-zinc-300 bg-white text-zinc-900 transition hover:bg-zinc-100 disabled:opacity-40 dark:border-zinc-800 dark:bg-zinc-950 dark:text-white dark:hover:bg-zinc-900"
              >
                <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
                  <path d="M12 5v14M5 12h14" stroke-linecap="round" />
                </svg>
              </button>
            </div>
          </div>
        {/each}
      </div>
    {/if}
  </div>
</section>

{#if pendingAddItem}
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
            {pendingAddItem.title}
          </p>
        </div>
        <button
          type="button"
          onclick={() => (pendingAddItem = null)}
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
            onclick={() => confirmAddToPlaylist(pl.id)}
            class="flex w-full items-center justify-between gap-2 border px-3 py-2.5 text-left text-xs transition {pl.id ===
            activePlaylistId
              ? 'border-cyan-500/60 bg-cyan-500/10 text-zinc-900 dark:text-white'
              : 'border-zinc-200 bg-zinc-50 text-zinc-800 hover:border-zinc-400 dark:border-zinc-800 dark:bg-black dark:text-zinc-200 dark:hover:border-zinc-600'}"
          >
            <div class="min-w-0 flex-1">
              <p class="truncate font-semibold">{pl.name}</p>
              <p class="text-[11px] text-zinc-500 dark:text-zinc-400">
                {pl.trackIds.length} canciones
              </p>
            </div>
            {#if pl.id === activePlaylistId}
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
          onclick={() => (pendingAddItem = null)}
          class="border border-zinc-200 bg-zinc-50 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300"
        >
          Cancelar
        </button>
      </div>
    </div>
  </div>
{/if}
