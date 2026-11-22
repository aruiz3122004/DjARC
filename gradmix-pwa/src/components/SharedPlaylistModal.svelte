<script lang="ts">
  import type { SharedPlaylistPreview } from '../lib/types';
  import { formatDurationTotal, formatTime } from '../lib/utils/format';

  interface Props {
    shared: SharedPlaylistPreview | null;
    currentTrackId: string | null;
    isPlaying: boolean;
    onPlayAll: () => void;
    onPlayTrack: (index: number) => void;
    onDownloadPlaylist: () => void;
    onClose: () => void;
  }

  let {
    shared,
    currentTrackId,
    isPlaying,
    onPlayAll,
    onPlayTrack,
    onDownloadPlaylist,
    onClose,
  }: Props = $props();

  let totalSeconds = $derived(
    shared ? shared.tracks.reduce((sum, t) => sum + (t.duration || 0), 0) : 0
  );
</script>

{#if shared}
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm"
    role="dialog"
    aria-modal="true"
    aria-labelledby="shared-playlist-title"
  >
    <div class="relative flex max-h-[88dvh] w-full max-w-lg flex-col border border-zinc-300 bg-white shadow-2xl dark:border-zinc-800 dark:bg-zinc-950">
      <div class="flex items-start justify-between gap-3 border-b border-zinc-200 p-4 dark:border-zinc-900">
        <div class="min-w-0">
          <div class="mb-1.5 flex flex-wrap items-center gap-1.5">
            <span class="border border-cyan-500/40 bg-cyan-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-cyan-700 dark:text-cyan-400">
              {shared.isEncrypted ? 'Playlist compartida · Enlace cifrado' : 'Playlist compartida'}
            </span>
            {#if shared.isZeroServer}
              <span class="border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-400">
                Sin servidor
              </span>
            {/if}
          </div>

          <h3 id="shared-playlist-title" class="truncate text-base font-semibold text-zinc-900 dark:text-white">
            {shared.title}
          </h3>
          <p class="mt-0.5 text-[11px] text-zinc-500 dark:text-zinc-400">
            {shared.block} · {shared.tracks.length} canciones · {formatDurationTotal(totalSeconds)}
          </p>
        </div>

        <button
          type="button"
          onclick={onClose}
          aria-label="Cerrar vista de playlist"
          title="Cerrar"
          class="flex h-8 w-8 shrink-0 items-center justify-center border border-zinc-200 bg-zinc-50 text-zinc-600 transition hover:bg-zinc-200 hover:text-zinc-950 dark:border-zinc-800 dark:bg-black dark:text-zinc-400 dark:hover:bg-zinc-900 dark:hover:text-white"
        >
          <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      <div class="border-b border-zinc-200 bg-zinc-50/70 px-4 py-3 dark:border-zinc-900 dark:bg-black">
        <div class="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onclick={onPlayAll}
            disabled={shared.tracks.length === 0 || shared.loadingTrackIndex !== null}
            class="inline-flex flex-1 items-center justify-center gap-2 bg-zinc-900 px-3.5 py-2 text-xs font-semibold text-white transition hover:bg-zinc-800 disabled:opacity-50 dark:bg-cyan-400 dark:text-black dark:hover:bg-cyan-300"
          >
            <svg class="h-4 w-4" viewBox="0 0 24 24" fill="currentColor">
              <path d="M8 5v14l11-7-11-7z" />
            </svg>
            <span>Reproducir sin descargar</span>
          </button>

          <button
            type="button"
            onclick={onDownloadPlaylist}
            disabled={shared.downloading || shared.tracks.length === 0}
            class="inline-flex items-center justify-center gap-1.5 border border-zinc-300 bg-white px-3.5 py-2 text-xs font-semibold text-zinc-900 transition hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-white dark:hover:bg-zinc-800"
          >
            <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M12 3v12m0 0l-4-4m4 4l4-4M4 17v3h16v-3" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
            <span>{shared.downloading ? 'Descargando...' : 'Descargar Playlist'}</span>
          </button>
        </div>

        <p class="mt-2 text-[11px] leading-relaxed text-zinc-500 dark:text-zinc-400">
          Toca cualquier canción para reproducirla al instante sin guardar archivos en tu dispositivo, o usa <strong>Descargar Playlist</strong> para tenerla offline.
        </p>
      </div>

      <div class="flex-1 space-y-1.5 overflow-y-auto p-3.5">
        {#each shared.tracks as item, idx (`${idx}-${item.trackId}`)}
          {@const active = currentTrackId === item.trackId}
          {@const loading = shared.loadingTrackIndex === idx}
          <button
            type="button"
            onclick={() => onPlayTrack(idx)}
            class="flex w-full items-center gap-2.5 border p-2.5 text-left transition {active
              ? 'border-cyan-500/60 bg-cyan-50/70 dark:bg-cyan-950/20'
              : 'border-zinc-200 bg-white hover:border-zinc-400 dark:border-zinc-900 dark:bg-black dark:hover:border-zinc-700'}"
          >
            <span
              class="flex h-7 w-7 shrink-0 items-center justify-center text-[11px] font-semibold {active
                ? 'bg-cyan-500 text-black'
                : 'bg-zinc-100 text-zinc-600 dark:bg-zinc-900 dark:text-zinc-300'}"
            >
              {#if loading}
                <span class="h-2.5 w-2.5 animate-spin rounded-full border-2 border-current border-t-transparent"></span>
              {:else if active && isPlaying}
                <span class="h-2 w-2 animate-ping bg-black"></span>
              {:else}
                {idx + 1}
              {/if}
            </span>

            <div class="min-w-0 flex-1">
              <p class="truncate text-xs font-medium text-zinc-900 dark:text-zinc-100">
                {item.title}
              </p>
              <p class="truncate text-[11px] text-zinc-500 dark:text-zinc-400">
                {item.artist || 'Artista desconocido'}
              </p>
            </div>

            <span class="shrink-0 tabular-nums text-[11px] text-zinc-400">
              {loading ? 'Cargando...' : formatTime(item.duration)}
            </span>
          </button>
        {/each}
      </div>
    </div>
  </div>
{/if}
