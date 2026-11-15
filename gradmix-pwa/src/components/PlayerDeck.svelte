<script lang="ts">
  import type { AudioEngineSnapshot, RepeatMode, Track } from '../lib/types';
  import { cleanDisplayArtist, cleanDisplayTitle, formatTime } from '../lib/utils/format';

  interface Props {
    snapshot: AudioEngineSnapshot;
    currentTrack: Track | null;
    nextTrack: Track | null;
    actionBusy?: boolean;
    onTogglePlay: () => void;
    onNext: () => void;
    onPrevious: () => void;
    onSeek: (seconds: number) => void;
    onToggleShuffle: () => void;
    onCycleRepeat: () => void;
    onMasterVolume: (vol: number) => void;
    onTriggerCrossfade: () => void;
    onToggleFavorite: (trackId: string) => void;
    onRequestAddToPlaylist?: (track: Track) => void;
    onOpenPlaylists: () => void;
  }

  let {
    snapshot,
    currentTrack,
    nextTrack,
    actionBusy = false,
    onTogglePlay,
    onNext,
    onPrevious,
    onSeek,
    onToggleShuffle,
    onCycleRepeat,
    onMasterVolume,
    onTriggerCrossfade,
    onToggleFavorite,
    onRequestAddToPlaylist,
    onOpenPlaylists,
  }: Props = $props();

  let scrubbing = $state(false);
  let scrubPreview = $state(0);

  let displayElapsed = $derived(scrubbing ? scrubPreview : snapshot.elapsed);
  let duration = $derived(snapshot.duration || currentTrack?.duration || 0);
  let remaining = $derived(Math.max(0, duration - displayElapsed));
  let progressPct = $derived(duration > 0 ? Math.min(100, (displayElapsed / duration) * 100) : 0);

  function repeatLabel(mode: RepeatMode): string {
    if (mode === 'one') return 'Repetir canción';
    if (mode === 'all') return 'Repetir lista';
    return 'Sin repetición';
  }

  function handleSeekInput(ev: Event) {
    const target = ev.currentTarget as HTMLInputElement;
    scrubbing = true;
    scrubPreview = Number(target.value);
  }

  function handleSeekCommit(ev: Event) {
    const target = ev.currentTarget as HTMLInputElement;
    const val = Number(target.value);
    scrubbing = false;
    onSeek(val);
  }
</script>

<section
  class="border border-zinc-200 bg-white p-4 sm:p-5 dark:border-zinc-900 dark:bg-zinc-950"
>
  <!-- Estado mínimo -->
  <div class="mb-3 flex items-center justify-between text-[11px]">
    <span
      class="inline-flex items-center gap-1.5 font-medium uppercase tracking-wider {snapshot.status ===
      'playing'
        ? 'text-emerald-600 dark:text-emerald-400'
        : snapshot.status === 'loading'
          ? 'text-amber-600 dark:text-amber-400'
          : 'text-zinc-500'}"
    >
      <span
        class="h-1.5 w-1.5 {snapshot.status === 'playing'
          ? 'bg-emerald-500'
          : snapshot.status === 'loading'
            ? 'bg-amber-400'
            : 'bg-zinc-400 dark:bg-zinc-600'}"
      ></span>
      {snapshot.status === 'playing'
        ? snapshot.crossfading
          ? 'Mezclando'
          : 'En vivo'
        : snapshot.status === 'paused'
          ? 'Pausado'
          : snapshot.status === 'loading'
            ? 'Cargando'
            : 'Listo'}
    </span>

    {#if currentTrack}
      <div class="flex items-center gap-1">
        {#if onRequestAddToPlaylist}
          <button
            type="button"
            onclick={() => onRequestAddToPlaylist(currentTrack)}
            aria-label="Añadir canción actual a una playlist"
            title="Añadir a una playlist"
            class="border border-zinc-200 bg-zinc-50 p-1.5 text-zinc-600 transition hover:border-zinc-400 hover:text-zinc-900 active:scale-95 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:border-zinc-600 dark:hover:text-white"
          >
            <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M3 6h12M3 12h12M3 18h8" stroke-linecap="round" />
              <path d="M18 14v6M15 17h6" stroke-linecap="round" />
            </svg>
          </button>
        {/if}

        <button
          type="button"
          onclick={() => onToggleFavorite(currentTrack.id)}
          aria-label={currentTrack.favorite ? 'Quitar de favoritos' : 'Añadir a favoritos'}
          title={currentTrack.favorite ? 'Quitar de favoritos' : 'Añadir a favoritos'}
          class="p-1.5 transition active:scale-95 {currentTrack.favorite
            ? 'text-rose-500'
            : 'text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200'}"
        >
          <svg
            class="h-4 w-4"
            viewBox="0 0 24 24"
            fill={currentTrack.favorite ? 'currentColor' : 'none'}
            stroke="currentColor"
            stroke-width="2"
          >
            <path
              d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </button>
      </div>
    {/if}
  </div>

  <!-- Pista Actual -->
  <div class="mb-4">
    {#if currentTrack}
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0 flex-1">
          <h2 class="truncate text-lg sm:text-xl font-semibold tracking-tight text-zinc-900 dark:text-white">
            {cleanDisplayTitle(currentTrack.title) || currentTrack.title}
          </h2>
          <p class="mt-0.5 truncate text-xs text-zinc-500 dark:text-zinc-400">
            {cleanDisplayArtist(currentTrack.artist) || 'Artista desconocido'}
          </p>
        </div>

        {#if snapshot.status === 'playing' && nextTrack}
          <button
            type="button"
            onclick={onTriggerCrossfade}
            disabled={snapshot.crossfading}
            title="Mezclar ahora"
            aria-label="Mezclar ahora"
            class="inline-flex shrink-0 items-center gap-1.5 border border-zinc-200 bg-zinc-50 px-2.5 py-2 text-xs font-medium text-zinc-800 transition hover:bg-zinc-100 active:scale-95 disabled:opacity-40 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
          >
            <svg class="h-3.5 w-3.5 text-cyan-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M16 3h5v5M4 20L21 3M21 16v5h-5" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
            <span class="hidden sm:inline">{snapshot.crossfading ? '...' : `${snapshot.crossfadeSeconds}s`}</span>
          </button>
        {/if}
      </div>
    {:else}
      <button
        type="button"
        onclick={onOpenPlaylists}
        class="flex w-full items-center justify-center gap-2 border border-dashed border-zinc-300 bg-zinc-50/70 p-4 text-xs font-medium text-zinc-600 transition hover:border-cyan-500/60 dark:border-zinc-800 dark:bg-black dark:text-zinc-400"
      >
        <svg class="h-4 w-4 text-cyan-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M12 5v14M5 12h14" stroke-linecap="round" />
        </svg>
        <span>Ir a Playlists para subir música</span>
      </button>
    {/if}
  </div>

  <!-- Barra de progreso / Seek -->
  <div class="mb-4">
    <div class="relative flex items-center">
      <div
        class="pointer-events-none absolute left-0 h-1.5 bg-cyan-500"
        style="width: {progressPct}%"
      ></div>
      <input
        type="range"
        min="0"
        max={Math.max(1, duration)}
        step="0.25"
        value={displayElapsed}
        disabled={!currentTrack || duration <= 0}
        oninput={handleSeekInput}
        onchange={handleSeekCommit}
        aria-label="Posición de reproducción"
        class="gradmix-slider relative z-10 w-full disabled:opacity-40"
      />
    </div>
    <div class="mt-1.5 flex justify-between tabular-nums text-[11px] text-zinc-500 dark:text-zinc-400">
      <span>{formatTime(displayElapsed)}</span>
      <span>-{formatTime(remaining)} / {formatTime(duration)}</span>
    </div>
  </div>

  <!-- Controles de Reproducción (Iconos claros) -->
  <div class="mb-5 flex items-center justify-between gap-2 sm:justify-center sm:gap-5">
    <button
      type="button"
      onclick={onToggleShuffle}
      aria-pressed={snapshot.shuffle}
      aria-label="Aleatorio"
      title={snapshot.shuffle ? 'Aleatorio activado' : 'Aleatorio'}
      class="relative flex h-10 w-10 items-center justify-center border transition active:scale-95 {snapshot.shuffle
        ? 'border-cyan-500/60 bg-cyan-500/10 text-cyan-600 dark:text-cyan-300'
        : 'border-zinc-200 bg-zinc-50 text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400'}"
    >
      <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M16 3h5v5M4 20L21 3M21 16v5h-5M15 15l6 6M4 4l5 5" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </button>

    <button
      type="button"
      onclick={onPrevious}
      disabled={!currentTrack || snapshot.status === 'loading' || actionBusy}
      aria-label="Anterior"
      title="Anterior"
      class="flex h-11 w-11 items-center justify-center border border-zinc-200 bg-zinc-50 text-zinc-800 transition hover:bg-zinc-100 active:scale-95 disabled:opacity-40 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800"
    >
      <svg class="h-5 w-5" viewBox="0 0 24 24" fill="currentColor">
        <path d="M6 5h2v14H6V5zm3.5 7 9.5 6V6l-9.5 6z" />
      </svg>
    </button>

    <button
      type="button"
      onclick={onTogglePlay}
      disabled={snapshot.status === 'loading' || actionBusy}
      aria-label={snapshot.status === 'playing' ? 'Pausar' : 'Reproducir'}
      title={snapshot.status === 'playing' ? 'Pausar' : 'Reproducir'}
      class="flex h-14 w-14 items-center justify-center bg-zinc-900 text-white transition hover:bg-zinc-800 active:scale-95 disabled:opacity-50 dark:bg-cyan-400 dark:text-black dark:hover:bg-cyan-300"
    >
      {#if snapshot.status === 'playing'}
        <svg class="h-6 w-6" viewBox="0 0 24 24" fill="currentColor">
          <path d="M6 5h4v14H6V5zm8 0h4v14h-4V5z" />
        </svg>
      {:else if snapshot.status === 'loading'}
        <svg class="h-6 w-6 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <circle cx="12" cy="12" r="9" class="opacity-25" />
          <path d="M21 12a9 9 0 0 0-9-9" stroke-linecap="round" />
        </svg>
      {:else}
        <svg class="h-6 w-6 translate-x-0.5" viewBox="0 0 24 24" fill="currentColor">
          <path d="M8 5v14l11-7-11-7z" />
        </svg>
      {/if}
    </button>

    <button
      type="button"
      onclick={onNext}
      disabled={(!currentTrack && !nextTrack) || snapshot.status === 'loading' || actionBusy}
      aria-label="Saltar canción"
      title="Saltar canción"
      class="flex h-11 w-11 items-center justify-center border border-zinc-200 bg-zinc-50 text-zinc-800 transition hover:bg-zinc-100 active:scale-95 disabled:opacity-40 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800"
    >
      <svg class="h-5 w-5" viewBox="0 0 24 24" fill="currentColor">
        <path d="M16 5h2v14h-2V5zM5 18l9.5-6L5 6v12z" />
      </svg>
    </button>

    <button
      type="button"
      onclick={onCycleRepeat}
      aria-label={repeatLabel(snapshot.repeatMode)}
      title={repeatLabel(snapshot.repeatMode)}
      class="relative flex h-10 w-10 items-center justify-center border transition active:scale-95 {snapshot.repeatMode !==
      'off'
        ? 'border-cyan-500/60 bg-cyan-500/10 text-cyan-600 dark:text-cyan-300'
        : 'border-zinc-200 bg-zinc-50 text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400'}"
    >
      <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path
          d="M17 2l4 4-4 4M3 11V9a4 4 0 0 1 4-4h14M7 22l-4-4 4-4M21 13v2a4 4 0 0 1-4 4H3"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
      {#if snapshot.repeatMode === 'one'}
        <span
          class="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center bg-cyan-500 text-[9px] font-bold text-black"
        >
          1
        </span>
      {/if}
    </button>
  </div>

  <!-- Decks A / B minimalistas -->
  <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
    {#each [snapshot.deckA, snapshot.deckB] as deck (deck.id)}
      {@const isActive = snapshot.activeDeck === deck.id && deck.trackId !== null}
      <div
        class="border px-3 py-2.5 transition {isActive
          ? 'border-cyan-500/50 bg-cyan-50/50 dark:border-cyan-500/40 dark:bg-cyan-950/15'
          : 'border-zinc-200 bg-zinc-50/60 dark:border-zinc-900 dark:bg-black'}"
      >
        <div class="flex items-center justify-between text-[10px] font-semibold tracking-widest uppercase">
          <span class={deck.id === 'A' ? 'text-cyan-600 dark:text-cyan-400' : 'text-zinc-500 dark:text-zinc-400'}>
            Deck {deck.id}
          </span>
          <span class="tabular-nums text-zinc-400 dark:text-zinc-500">
            {#if deck.state === 'playing'}
              {Math.round(deck.gain * 100)}%
            {:else if deck.state === 'fading-out'}
              {Math.round(deck.gain * 100)}%
            {:else if deck.state === 'ready'}
              Lista
            {:else if deck.state === 'preloading'}
              ...
            {:else if deck.state === 'paused'}
              Pausa
            {:else}
              —
            {/if}
          </span>
        </div>
        <p class="mt-1 truncate text-xs font-medium text-zinc-800 dark:text-zinc-200">
          {deck.trackId ? deck.title : 'Disponible'}
        </p>
        <div class="mt-2 h-1 w-full overflow-hidden bg-zinc-200 dark:bg-zinc-900">
          <div
            class="h-full transition-all duration-150 {deck.id === 'A'
              ? 'bg-cyan-500'
              : 'bg-zinc-500 dark:bg-zinc-400'}"
            style="width: {Math.round(deck.gain * 100)}%"
          ></div>
        </div>
      </div>
    {/each}
  </div>

  <!-- Volumen Maestro + Siguiente mínima -->
  <div class="mt-4 flex flex-col gap-3 border-t border-zinc-200 pt-3 dark:border-zinc-900 sm:flex-row sm:items-center sm:justify-between">
    {#if nextTrack}
      <p class="min-w-0 truncate text-xs text-zinc-500 dark:text-zinc-400">
        Siguiente: <span class="font-medium text-zinc-800 dark:text-zinc-200">{nextTrack.title}</span>
      </p>
    {:else}
      <span class="text-xs text-zinc-400"></span>
    {/if}

    <div class="flex items-center gap-2 sm:w-44">
      <svg class="h-4 w-4 shrink-0 text-zinc-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M11 5L6 9H2v6h4l5 4V5zM15.54 8.46a5 5 0 0 1 0 7.07" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
      <input
        type="range"
        min="0"
        max="1"
        step="0.02"
        value={snapshot.masterVolume}
        oninput={(e) => onMasterVolume(Number((e.currentTarget as HTMLInputElement).value))}
        aria-label="Volumen maestro"
        class="gradmix-slider w-full"
      />
      <span class="w-8 text-right tabular-nums text-[11px] text-zinc-500 dark:text-zinc-400">
        {Math.round(snapshot.masterVolume * 100)}%
      </span>
    </div>
  </div>
</section>
