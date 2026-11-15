<script lang="ts">
  import type { Track } from '../lib/types';
  import { formatTime } from '../lib/utils/format';

  interface Props {
    favoriteTracks: Track[];
    currentTrackId: string | null;
    isPlaying: boolean;
    onPlayTrack: (trackId: string) => void;
    onToggleFavorite: (trackId: string) => void;
    onPlayAllFavorites: () => void;
  }

  let {
    favoriteTracks,
    currentTrackId,
    isPlaying,
    onPlayTrack,
    onToggleFavorite,
    onPlayAllFavorites,
  }: Props = $props();
</script>

<section class="border border-zinc-200 bg-white p-4 sm:p-5 dark:border-zinc-900 dark:bg-zinc-950">
  <div class="mb-4 flex items-center justify-between gap-2">
    <div>
      <h2 class="text-base font-semibold tracking-tight text-zinc-900 dark:text-white">
        Favoritos
      </h2>
      <p class="text-[11px] text-zinc-500 dark:text-zinc-400">
        {favoriteTracks.length} canciones marcadas
      </p>
    </div>

    {#if favoriteTracks.length > 0}
      <button
        type="button"
        onclick={onPlayAllFavorites}
        title="Reproducir favoritos"
        class="inline-flex items-center gap-1.5 bg-zinc-900 px-3 py-2 text-xs font-medium text-white transition hover:bg-zinc-800 active:scale-95 dark:bg-cyan-400 dark:text-black"
      >
        <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="currentColor">
          <path d="M8 5v14l11-7-11-7z" />
        </svg>
        <span class="hidden sm:inline">Reproducir</span>
      </button>
    {/if}
  </div>

  {#if favoriteTracks.length === 0}
    <div class="border border-dashed border-zinc-200 p-8 text-center text-xs text-zinc-400 dark:border-zinc-800">
      Toca el corazón en cualquier canción para guardarla aquí.
    </div>
  {:else}
    <div class="space-y-1.5">
      {#each favoriteTracks as track (track.id)}
        {@const isCurrent = currentTrackId === track.id}
        <div
          class="flex items-center gap-2 border p-2.5 transition {isCurrent
            ? 'border-cyan-500/50 bg-cyan-50/70 dark:bg-cyan-950/20'
            : 'border-zinc-200 bg-zinc-50/50 dark:border-zinc-900 dark:bg-black'}"
        >
          <button
            type="button"
            onclick={() => onPlayTrack(track.id)}
            aria-label={`Reproducir ${track.title}`}
            class="flex h-8 w-8 shrink-0 items-center justify-center {isCurrent
              ? 'bg-cyan-500 text-black'
              : 'bg-zinc-200/80 text-zinc-700 dark:bg-zinc-900 dark:text-zinc-300'}"
          >
            {#if isCurrent && isPlaying}
              <span class="h-2 w-2 bg-black animate-ping"></span>
            {:else}
              <svg class="h-3.5 w-3.5 translate-x-0.5" viewBox="0 0 24 24" fill="currentColor">
                <path d="M8 5v14l11-7-11-7z" />
              </svg>
            {/if}
          </button>

          <button
            type="button"
            onclick={() => onPlayTrack(track.id)}
            class="min-w-0 flex-1 text-left"
          >
            <p class="truncate text-xs font-medium text-zinc-900 dark:text-zinc-100">
              {track.title}
            </p>
            <p class="truncate text-[11px] text-zinc-500 dark:text-zinc-400">
              {track.artist}
            </p>
          </button>

          <span class="tabular-nums text-[11px] text-zinc-400">
            {formatTime(track.duration)}
          </span>

          <button
            type="button"
            onclick={() => onToggleFavorite(track.id)}
            aria-label="Quitar de favoritos"
            class="p-1.5 text-rose-500 hover:bg-rose-500/10"
          >
            <svg class="h-4 w-4" viewBox="0 0 24 24" fill="currentColor">
              <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
            </svg>
          </button>
        </div>
      {/each}
    </div>
  {/if}
</section>
