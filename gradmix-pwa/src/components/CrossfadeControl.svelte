<script lang="ts">
  interface Props {
    crossfadeSeconds: number;
    autoDjEnabled: boolean;
    crossfading: boolean;
    crossfadeProgress: number;
    onChangeCrossfade: (seconds: number) => void;
    onToggleAutoDj: (enabled: boolean) => void;
  }

  let {
    crossfadeSeconds,
    autoDjEnabled,
    crossfading,
    crossfadeProgress,
    onChangeCrossfade,
    onToggleAutoDj,
  }: Props = $props();

  const presets = [4, 8, 12];
</script>

<section class="border border-zinc-200 bg-white p-4 dark:border-zinc-900 dark:bg-zinc-950">
  <div class="flex items-center justify-between gap-2">
    <div class="flex items-center gap-2">
      <svg class="h-4 w-4 text-cyan-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M4 17l6-6 4 4 6-6" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
      <h3 class="text-xs font-semibold uppercase tracking-wider text-zinc-800 dark:text-zinc-200">
        Crossfade
      </h3>
      <span class="tabular-nums text-xs font-semibold text-cyan-600 dark:text-cyan-400">
        {crossfadeSeconds}s
      </span>
    </div>

    <label
      class="inline-flex cursor-pointer select-none items-center gap-2 text-[11px] font-medium text-zinc-700 dark:text-zinc-300"
      title="Activar o desactivar Crossfade / Auto-DJ"
    >
      <span>Auto-DJ</span>
      <span class="relative inline-flex h-5 w-10 items-center">
        <input
          type="checkbox"
          role="switch"
          checked={autoDjEnabled}
          onchange={(ev) => onToggleAutoDj((ev.currentTarget as HTMLInputElement).checked)}
          aria-label="Activar Crossfade Auto-DJ"
          class="peer sr-only"
        />
        <span
          class="h-5 w-10 border border-zinc-300 bg-zinc-200 transition-colors peer-checked:border-blue-700 peer-checked:bg-blue-600 dark:border-zinc-700 dark:bg-zinc-900 dark:peer-checked:border-blue-500 dark:peer-checked:bg-blue-500"
        ></span>
        <span
          class="pointer-events-none absolute left-0.5 h-3.5 w-3.5 bg-white shadow-sm transition-transform peer-checked:translate-x-5 dark:bg-zinc-200 peer-checked:dark:bg-black"
        ></span>
      </span>
    </label>
  </div>

  <div class="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center">
    <div class="flex-1">
      <input
        type="range"
        min="2"
        max="15"
        step="1"
        value={crossfadeSeconds}
        oninput={(e) => onChangeCrossfade(Number((e.currentTarget as HTMLInputElement).value))}
        aria-label="Duración de crossfade en segundos"
        class="gradmix-slider w-full"
      />
    </div>

    <div class="flex items-center gap-1.5">
      {#each presets as sec}
        <button
          type="button"
          onclick={() => onChangeCrossfade(sec)}
          class="border px-2.5 py-1 tabular-nums text-xs transition {crossfadeSeconds ===
          sec
            ? 'border-cyan-500/60 bg-cyan-500/15 font-semibold text-cyan-700 dark:text-cyan-300'
            : 'border-zinc-200 bg-zinc-50 text-zinc-500 dark:border-zinc-800 dark:bg-black dark:text-zinc-400'}"
        >
          {sec}s
        </button>
      {/each}
    </div>
  </div>

  {#if crossfading}
    <div class="mt-3 h-1 w-full overflow-hidden bg-zinc-200 dark:bg-zinc-900">
      <div
        class="h-full bg-cyan-500 transition-all duration-150"
        style="width: {Math.round(crossfadeProgress * 100)}%"
      ></div>
    </div>
  {/if}
</section>
