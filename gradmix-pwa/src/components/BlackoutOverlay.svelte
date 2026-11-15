<script lang="ts">
  import type { AudioEngineSnapshot, Track } from '../lib/types';
  import { formatTime } from '../lib/utils/format';

  interface Props {
    active: boolean;
    wakeLockActive: boolean;
    snapshot: AudioEngineSnapshot;
    currentTrack: Track | null;
    nextTrack: Track | null;
    onExit: () => void;
    onTogglePlay: () => void;
    onNext: () => void;
  }

  let {
    active,
    wakeLockActive,
    snapshot,
    currentTrack,
    nextTrack,
    onExit,
    onTogglePlay,
    onNext,
  }: Props = $props();

  let now = $state(new Date());
  let batteryLevel = $state<number | null>(null);
  let batteryCharging = $state(false);

  $effect(() => {
    if (!active) return;

    const clockId = window.setInterval(() => {
      now = new Date();
    }, 1000);

    let batteryRef: {
      level: number;
      charging: boolean;
      addEventListener: (type: string, fn: () => void) => void;
      removeEventListener: (type: string, fn: () => void) => void;
    } | null = null;

    const updateBattery = () => {
      if (!batteryRef) return;
      batteryLevel = Math.round(batteryRef.level * 100);
      batteryCharging = batteryRef.charging;
    };

    const nav = navigator as unknown as {
      getBattery?: () => Promise<typeof batteryRef>;
    };

    if (typeof nav.getBattery === 'function') {
      nav
        .getBattery()
        .then((bat) => {
          if (!bat) return;
          batteryRef = bat;
          updateBattery();
          bat.addEventListener('levelchange', updateBattery);
          bat.addEventListener('chargingchange', updateBattery);
        })
        .catch(() => {});
    }

    return () => {
      window.clearInterval(clockId);
      if (batteryRef) {
        batteryRef.removeEventListener('levelchange', updateBattery);
        batteryRef.removeEventListener('chargingchange', updateBattery);
      }
    };
  });

  let formattedTime = $derived(
    now.toLocaleTimeString('es-ES', {
      hour: '2-digit',
      minute: '2-digit',
    })
  );

  let remaining = $derived(
    Math.max(0, (snapshot.duration || currentTrack?.duration || 0) - snapshot.elapsed)
  );
</script>

{#if active}
  <div
    class="fixed inset-0 z-50 flex flex-col items-center justify-between bg-[#000000] px-6 py-10 text-zinc-100 select-none"
    role="dialog"
    aria-label="Ahorro de batería"
  >
    <div class="flex w-full max-w-md items-center justify-between text-xs opacity-20">
      <span>{wakeLockActive ? 'AHORRO ACTIVO' : 'AHORRO DE BATERÍA'}</span>
      {#if batteryLevel !== null}
        <span class="tabular-nums">
          {batteryCharging ? '⚡' : ''}{batteryLevel}%
        </span>
      {/if}
    </div>

    <div class="flex max-w-md flex-col items-center text-center opacity-20">
      <div class="tabular-nums text-6xl sm:text-7xl font-thin tracking-tight text-white">
        {formattedTime}
      </div>

      {#if currentTrack}
        <p class="mt-8 text-base font-medium text-white line-clamp-2">
          {currentTrack.title}
        </p>
        <p class="mt-1 text-xs text-zinc-300 tabular-nums">
          {currentTrack.artist} · -{formatTime(remaining)}
        </p>
        {#if nextTrack}
          <p class="mt-4 text-[11px] text-zinc-400">
            Siguiente: {nextTrack.title}
          </p>
        {/if}
      {:else}
        <p class="mt-8 text-sm text-zinc-400">En espera</p>
      {/if}
    </div>

    <div class="flex w-full max-w-sm flex-col items-center gap-4 opacity-25 transition-opacity hover:opacity-80">
      <div class="flex items-center gap-4">
        <button
          type="button"
          onclick={onTogglePlay}
          class="border border-zinc-700 px-5 py-2.5 text-xs font-medium text-white"
        >
          {snapshot.status === 'playing' ? 'Pausar' : 'Reproducir'}
        </button>
        <button
          type="button"
          onclick={onNext}
          class="border border-zinc-700 px-5 py-2.5 text-xs font-medium text-white"
        >
          Saltar →
        </button>
      </div>

      <button
        type="button"
        onclick={onExit}
        class="mt-2 border border-zinc-800 px-6 py-2.5 text-xs tracking-wider uppercase text-zinc-300"
      >
        Salir
      </button>
    </div>
  </div>
{/if}
