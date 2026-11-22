<script lang="ts">
  import type { AudioEngineSnapshot, Playlist, Track } from '../lib/types';
  import { cleanDisplayArtist, cleanDisplayTitle, formatDurationTotal, formatTime } from '../lib/utils/format';
  import { normalizeSearchText, scoreSearchMatch } from '../lib/search/searchEngine';

  interface Props {
    inPlayerView: boolean;
    snapshot: AudioEngineSnapshot;
    currentTrack: Track | null;
    nextTrack?: Track | null;
    upNextTracks: Track[];
    activePlaylist: Playlist | null;
    activePlaylistTracks: Track[];
    activePlaylistDuration: number;
    hasPlaylistInPlayback: boolean;
    expanded: boolean;
    actionBusy?: boolean;
    onToggleExpand: () => void;
    onCollapse: () => void;
    onTogglePlay: () => void;
    onNext: () => void;
    onPrevious?: () => void;
    onSeek?: (seconds: number) => void;
    onOpenFullPlayer: () => void;
    onPlayTrack: (trackId: string, playlistIndex?: number) => void;
    onRequestClosePlaylist: () => void;
    onRequestAddToPlaylist?: (track: Track) => void;
  }

  let {
    inPlayerView,
    snapshot,
    currentTrack,
    nextTrack = null,
    upNextTracks,
    activePlaylist,
    activePlaylistTracks,
    activePlaylistDuration,
    hasPlaylistInPlayback,
    expanded,
    actionBusy = false,
    onToggleExpand,
    onCollapse,
    onTogglePlay,
    onNext,
    onPrevious: _onPrevious,
    onSeek,
    onOpenFullPlayer,
    onPlayTrack,
    onRequestClosePlaylist,
    onRequestAddToPlaylist,
  }: Props = $props();

  let searchQuery = $state('');
  let scrubbing = $state(false);
  let scrubPreview = $state(0);

  let showBar = $derived(
    currentTrack !== null &&
      (!inPlayerView || hasPlaylistInPlayback || upNextTracks.length > 0)
  );

  let duration = $derived(snapshot.duration || currentTrack?.duration || 0);
  let displayElapsed = $derived(scrubbing ? scrubPreview : snapshot.elapsed);
  let remaining = $derived(Math.max(0, duration - displayElapsed));
  let progressPct = $derived(
    duration > 0 ? Math.min(100, Math.max(0, (displayElapsed / duration) * 100)) : 0
  );

  function handleSeekInput(ev: Event) {
    const target = ev.currentTarget as HTMLInputElement;
    scrubbing = true;
    scrubPreview = Number(target.value);
  }

  function handleSeekCommit(ev: Event) {
    const target = ev.currentTarget as HTMLInputElement;
    const val = Number(target.value);
    scrubbing = false;
    onSeek?.(val);
  }

  let filteredPlaylistTracks = $derived.by(() => {
    const raw = searchQuery.trim();
    return activePlaylistTracks
      .map((plTrk, idx) => ({ plTrk, idx }))
      .filter(({ plTrk }) => {
        if (!raw) return true;
        const norm = normalizeSearchText(`${plTrk.title} ${plTrk.artist}`);
        return scoreSearchMatch(raw, norm.spaced, norm.compact) > 0;
      });
  });

  let isPlaying = $derived(snapshot.status === 'playing');
  let isLoading = $derived(snapshot.status === 'loading');
</script>

{#if showBar && currentTrack}
  {#if expanded}
    <div
      class="fixed inset-0 z-20 bg-black/55 backdrop-blur-[1px]"
      onclick={onCollapse}
      aria-hidden="true"
    ></div>
  {/if}

  <div
    class="fixed inset-x-0 bottom-0 z-30 bg-white dark:bg-black {expanded
      ? 'border-t-2 border-cyan-500 shadow-[0_-14px_34px_rgba(0,0,0,0.32)] dark:shadow-[0_-14px_38px_rgba(0,0,0,0.9)]'
      : 'border-t border-zinc-300 dark:border-zinc-800'}"
  >
    {#if !inPlayerView}
      <div class="h-[2px] w-full bg-zinc-200 dark:bg-zinc-900">
        <div
          class="h-full bg-cyan-500 transition-[width] duration-150"
          style={`width: ${progressPct.toFixed(2)}%`}
        ></div>
      </div>
    {/if}

    <div class="mx-auto w-full max-w-3xl">
      {#if expanded}
        <div class="flex items-center justify-between border-b border-zinc-800 bg-zinc-900 px-4 py-2 text-[11px] font-semibold uppercase tracking-wider text-white">
          <div class="flex items-center gap-2 min-w-0">
            <span class="h-1.5 w-5 shrink-0 bg-cyan-400"></span>
            <span class="truncate">
              {upNextTracks.length > 0
                ? `En cola (${upNextTracks.length})${hasPlaylistInPlayback && activePlaylist ? ` · ${activePlaylist.name}` : ''}`
                : hasPlaylistInPlayback && activePlaylist
                  ? `Playlist · ${activePlaylist.name}`
                  : 'Reproduciendo ahora'}
            </span>
          </div>

          <div class="flex shrink-0 items-center gap-2.5 whitespace-nowrap">
            {#if onRequestAddToPlaylist}
              <button
                type="button"
                onclick={() => onRequestAddToPlaylist(currentTrack)}
                title="Añadir a una playlist"
                aria-label="Añadir canción actual a una playlist"
                class="inline-flex h-6 w-6 items-center justify-center border border-zinc-700 bg-zinc-800 text-zinc-200 transition hover:border-cyan-400 hover:text-white active:scale-95"
              >
                <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M3 6h12M3 12h12M3 18h8" stroke-linecap="round" />
                  <path d="M18 14v6M15 17h6" stroke-linecap="round" />
                </svg>
              </button>
            {/if}
            {#if !inPlayerView}
              <button
                type="button"
                onclick={() => {
                  onCollapse();
                  onOpenFullPlayer();
                }}
                class="text-[10px] font-medium text-cyan-400 hover:text-cyan-300"
              >
                Abrir reproductor
              </button>
            {/if}
            <button
              type="button"
              onclick={onCollapse}
              class="text-[10px] font-medium text-zinc-300 hover:text-white"
            >
              Ocultar
            </button>
          </div>
        </div>

        {#if !inPlayerView}
          <div class="border-b border-zinc-200 bg-zinc-50 px-4 py-2.5 dark:border-zinc-800 dark:bg-zinc-950">
            <div class="flex items-start justify-between gap-2">
              <div class="min-w-0 flex-1">
                <p class="truncate text-xs font-semibold text-zinc-900 dark:text-white">
                  {cleanDisplayTitle(currentTrack.title) || currentTrack.title}
                </p>
                <p class="truncate text-[11px] text-zinc-500 dark:text-zinc-400">
                  {cleanDisplayArtist(currentTrack.artist) || 'Artista desconocido'}
                </p>
              </div>
              {#if nextTrack}
                <p class="max-w-[46%] shrink-0 truncate text-right text-[10px] text-cyan-700 dark:text-cyan-400">
                  Sig: {cleanDisplayTitle(nextTrack.title) || nextTrack.title}
                </p>
              {/if}
            </div>

            <!-- Barra de progreso interactiva desde la vista previa -->
            <div class="mt-2">
              <div class="relative flex items-center">
                <div class="pointer-events-none absolute inset-x-0 h-[3px] bg-zinc-200 dark:bg-zinc-800">
                  <div
                    class="h-full bg-cyan-500 transition-all duration-100"
                    style="width: {progressPct}%"
                  ></div>
                </div>
                <input
                  type="range"
                  min="0"
                  max={Math.max(1, duration)}
                  step="0.25"
                  value={displayElapsed}
                  disabled={duration <= 0 || !onSeek}
                  oninput={handleSeekInput}
                  onchange={handleSeekCommit}
                  aria-label="Posición de reproducción en barra previa"
                  class="gradmix-slider relative z-10 w-full disabled:opacity-40"
                />
              </div>
              <div class="mt-1 flex justify-between text-[10px] tabular-nums text-zinc-500 dark:text-zinc-400">
                <span>{formatTime(displayElapsed)}</span>
                <span>-{formatTime(remaining)} / {formatTime(duration)}</span>
              </div>
            </div>
          </div>
        {/if}

        {#if upNextTracks.length > 0}
          <div class="border-b border-zinc-200 bg-zinc-100/80 dark:border-zinc-800 dark:bg-zinc-950">
            <div class="px-4 py-2 text-[10px] font-semibold uppercase tracking-wider text-cyan-700 dark:text-cyan-400">
              Siguientes en cola ({upNextTracks.length})
            </div>
            <div class="{hasPlaylistInPlayback ? 'max-h-[30dvh]' : 'max-h-[58dvh]'} overflow-y-auto">
              {#each upNextTracks as qTrk, qIdx (`q-${qIdx}-${qTrk.id}`)}
                <button
                  type="button"
                  onclick={() => onPlayTrack(qTrk.id)}
                  class="flex w-full items-center gap-2.5 border-t border-zinc-200/70 px-4 py-2.5 text-left hover:bg-zinc-200/60 dark:border-zinc-900 dark:hover:bg-zinc-900"
                >
                  <span class="w-4 shrink-0 text-[10px] font-semibold tabular-nums text-cyan-600 dark:text-cyan-400">
                    {qIdx + 1}
                  </span>
                  <div class="min-w-0 flex-1">
                    <p class="truncate text-xs font-medium text-zinc-900 dark:text-white">
                      {cleanDisplayTitle(qTrk.title) || qTrk.title}
                    </p>
                    <p class="truncate text-[10px] text-zinc-500 dark:text-zinc-400">
                      {cleanDisplayArtist(qTrk.artist) || 'Artista desconocido'}
                    </p>
                  </div>
                  <span class="shrink-0 text-[11px] tabular-nums text-zinc-400">
                    {formatTime(qTrk.duration)}
                  </span>
                </button>
              {/each}
            </div>
          </div>
        {/if}

        {#if hasPlaylistInPlayback && activePlaylist}
          <div class="border-b border-zinc-200 bg-zinc-100 px-3 py-2 dark:border-zinc-800 dark:bg-zinc-950">
            <input
              type="search"
              bind:value={searchQuery}
              placeholder="Buscar en esta playlist..."
              aria-label="Buscar dentro de la playlist en reproducción"
              class="w-full border border-zinc-300 bg-white px-3 py-1.5 text-xs text-zinc-900 placeholder-zinc-400 focus:border-cyan-500 focus:outline-none dark:border-zinc-800 dark:bg-black dark:text-white"
            />
          </div>
          <div class="max-h-[56dvh] overflow-y-auto border-b border-zinc-300 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950">
            {#if filteredPlaylistTracks.length === 0}
              <p class="py-6 text-center text-xs text-zinc-400">
                Sin coincidencias en esta playlist.
              </p>
            {:else}
              {#each filteredPlaylistTracks as { plTrk, idx } (`${idx}-${plTrk.id}`)}
                {@const isPlayingItem = snapshot.currentTrackId === plTrk.id}
                {@const isNextItem = Boolean(nextTrack && nextTrack.id === plTrk.id && !isPlayingItem)}
                <button
                  type="button"
                  onclick={() => onPlayTrack(plTrk.id, idx)}
                  class="flex w-full items-center gap-2.5 border-b border-zinc-200/70 px-4 py-2.5 text-left transition last:border-b-0 dark:border-zinc-900 {isPlayingItem
                    ? 'bg-cyan-500/15 text-cyan-800 dark:text-cyan-300'
                    : isNextItem
                      ? 'bg-zinc-100/90 dark:bg-zinc-900/70'
                      : 'hover:bg-zinc-100 dark:hover:bg-zinc-900'}"
                >
                  <span class="w-5 shrink-0 tabular-nums text-[11px] font-semibold text-zinc-400">
                    {idx + 1}
                  </span>
                  <div class="min-w-0 flex-1">
                    <p class="truncate text-xs font-medium text-zinc-900 dark:text-white">
                      {cleanDisplayTitle(plTrk.title) || plTrk.title}
                    </p>
                    <p class="truncate text-[10px] text-zinc-500 dark:text-zinc-400">
                      {cleanDisplayArtist(plTrk.artist) || 'Artista desconocido'}
                    </p>
                  </div>
                  {#if isNextItem}
                    <span class="shrink-0 text-[10px] font-semibold uppercase tracking-wider text-cyan-700 dark:text-cyan-400">
                      Siguiente
                    </span>
                  {/if}
                  <span class="shrink-0 tabular-nums text-[11px] text-zinc-400">
                    {formatTime(plTrk.duration)}
                  </span>
                </button>
              {/each}
            {/if}
          </div>
        {/if}
      {/if}

      <!-- Barra inferior colapsada -->
      {#if !inPlayerView}
        <div class="flex items-center justify-between gap-2 px-3 py-2 sm:px-4">
          <button
            type="button"
            onclick={onToggleExpand}
            title={expanded ? 'Contraer barra de reproducción' : 'Desplegar barra de reproducción'}
            aria-label={expanded ? 'Contraer barra' : 'Desplegar barra'}
            class="flex min-w-0 flex-1 items-center gap-2.5 text-left"
          >
            <svg
              class="h-4 w-4 shrink-0 text-zinc-500 dark:text-zinc-400"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
            >
              {#if expanded}
                <path d="M6 9l6 6 6-6" stroke-linecap="round" stroke-linejoin="round" />
              {:else}
                <path d="M18 15l-6-6-6 6" stroke-linecap="round" stroke-linejoin="round" />
              {/if}
            </svg>
            <div class="min-w-0 flex-1">
              <p class="truncate text-xs font-semibold text-zinc-900 dark:text-white">
                {cleanDisplayTitle(currentTrack.title) || currentTrack.title}
              </p>
              <p class="truncate text-[10px] text-zinc-500 dark:text-zinc-400">
                {cleanDisplayArtist(currentTrack.artist) || 'Artista desconocido'}
                {#if upNextTracks.length > 0}
                  · {upNextTracks.length} en cola
                {/if}
                {#if nextTrack}
                  <span class="text-cyan-700 dark:text-cyan-400">
                    · Sig: {cleanDisplayTitle(nextTrack.title) || nextTrack.title}
                  </span>
                {/if}
              </p>
            </div>
          </button>

          <div class="flex shrink-0 items-center gap-1.5">
            <button
              type="button"
              onclick={onTogglePlay}
              disabled={actionBusy}
              title={isPlaying ? 'Pausar' : 'Reproducir'}
              aria-label={isPlaying ? 'Pausar' : 'Reproducir'}
              class="flex h-9 w-9 items-center justify-center bg-zinc-900 text-white transition hover:bg-zinc-800 active:scale-95 disabled:opacity-40 dark:bg-white dark:text-black dark:hover:bg-zinc-200"
            >
              {#if isLoading}
                <svg class="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M21 12a9 9 0 1 1-6.22-8.56" stroke-linecap="round" />
                </svg>
              {:else if isPlaying}
                <svg class="h-4 w-4" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M6 5h4v14H6zM14 5h4v14h-4z" />
                </svg>
              {:else}
                <svg class="h-4 w-4" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M8 5v14l11-7z" />
                </svg>
              {/if}
            </button>

            <button
              type="button"
              onclick={onNext}
              disabled={actionBusy}
              title="Reproducir siguiente"
              aria-label="Siguiente canción"
              class="flex h-9 w-9 items-center justify-center border border-zinc-300 bg-zinc-50 text-zinc-900 transition hover:bg-zinc-100 active:scale-95 disabled:opacity-40 dark:border-zinc-800 dark:bg-zinc-950 dark:text-white dark:hover:bg-zinc-900"
            >
              <svg class="h-4 w-4" viewBox="0 0 24 24" fill="currentColor">
                <path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z" />
              </svg>
            </button>
          </div>
        </div>
      {:else}
        <div class="flex items-center justify-between gap-2 px-4 py-2.5">
          <button
            type="button"
            onclick={onToggleExpand}
            title={expanded ? 'Contraer cola' : 'Desplegar canciones en cola'}
            aria-label={expanded ? 'Contraer cola' : 'Desplegar cola'}
            class="flex min-w-0 flex-1 items-center gap-2 text-left"
          >
            <svg
              class="h-4 w-4 shrink-0 text-zinc-500 transition-transform dark:text-zinc-400"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
            >
              {#if expanded}
                <path d="M6 9l6 6 6-6" stroke-linecap="round" stroke-linejoin="round" />
              {:else}
                <path d="M18 15l-6-6-6 6" stroke-linecap="round" stroke-linejoin="round" />
              {/if}
            </svg>
            <span class="truncate text-xs font-semibold text-zinc-900 dark:text-white">
              {hasPlaylistInPlayback && activePlaylist ? activePlaylist.name : 'Cola de reproducción'}
            </span>
            <span class="shrink-0 tabular-nums text-[11px] text-zinc-500 dark:text-zinc-400">
              {#if hasPlaylistInPlayback}
                {activePlaylistTracks.length} · {formatDurationTotal(activePlaylistDuration)}
              {/if}
              {#if upNextTracks.length > 0}
                {hasPlaylistInPlayback ? ` · +${upNextTracks.length} sig.` : `${upNextTracks.length} siguientes`}
              {:else if nextTrack}
                · Sig: {cleanDisplayTitle(nextTrack.title) || nextTrack.title}
              {/if}
            </span>
          </button>

          {#if hasPlaylistInPlayback}
            <button
              type="button"
              onclick={onRequestClosePlaylist}
              title="Cerrar playlist"
              aria-label="Cerrar playlist"
              class="p-1 text-zinc-500 transition hover:text-red-500 dark:text-zinc-400"
            >
              <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M18 6L6 18M6 6l12 12" stroke-linecap="round" />
              </svg>
            </button>
          {/if}
        </div>
      {/if}
    </div>
  </div>
{/if}
