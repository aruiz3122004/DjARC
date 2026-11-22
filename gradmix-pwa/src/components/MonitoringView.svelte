<script lang="ts">
  import AccordionList from './AccordionList.svelte';
  import ConfirmModal from './ConfirmModal.svelte';
  import type { DeviceStorageInfo, StorageUsageInfo } from '../lib/storage/opfsStorage';
  import type { AccordionItem, AudioEngineSnapshot } from '../lib/types';
  import { formatBytes } from '../lib/utils/format';

  interface Props {
    snapshot: AudioEngineSnapshot;
    storageInfo: StorageUsageInfo;
    deviceStorageInfo?: DeviceStorageInfo | null;
    storageMode?: 'browser' | 'device';
    deviceStorageName?: string;
    tracksCount: number;
    deviceTracksCount?: number;
    playlistsCount: number;
    onRefresh: () => void;
    onSwitchStorage?: () => Promise<void> | void;
    onRevokeDeviceStorage?: () => Promise<void> | void;
    onClearDatabase: () => Promise<void> | void;
  }

  let {
    snapshot,
    storageInfo,
    deviceStorageInfo = null,
    storageMode = 'browser',
    deviceStorageName = '',
    tracksCount,
    deviceTracksCount = 0,
    playlistsCount,
    onRefresh,
    onSwitchStorage,
    onRevokeDeviceStorage,
    onClearDatabase,
  }: Props = $props();

  let confirmClearOpen = $state(false);
  let clearing = $state(false);

  const STORAGE_GUIDE_ITEMS: readonly AccordionItem[] = [
    {
      id: 'pc',
      category: 'ALMACENAMIENTO INTERNO · PC (WINDOWS / MAC / LINUX)',
      question: '¿Cómo selecciono una carpeta de mi disco local y cómo se reproduce?',
      answer:
        'En Chrome o Edge, pulsa "Usar almacenamiento interno", entra a tu disco (por ejemplo C:\\Música) y crea o elige una carpeta dedicada (ej. GradMix) aceptando "Permitir editar archivos". Por seguridad web el navegador muestra el nombre de la carpeta en lugar de la letra de unidad, pero aparecerá arriba su propio apartado con el espacio usado y disponible. Las canciones descargadas allí muestran un ícono de carpeta y se reproducen directamente dentro de GradMix sin usar otro reproductor.',
    },
    {
      id: 'android',
      category: 'ALMACENAMIENTO INTERNO · ANDROID (CHROME / PWA)',
      question: '¿Qué carpeta debo elegir en Android y qué hacer si la bloquea?',
      answer:
        'Si se abre el selector de archivos, entra a Música o Documentos y crea una subcarpeta nueva (ej. GradMix); Android bloquea la raíz del dispositivo y Descargas por seguridad. Una vez autorizada, verás el apartado dedicado arriba y tus canciones llevarán el ícono de carpeta para reproducirse directo en la app. Si tu navegador móvil no soporta el selector, libera pistas antiguas o usa la PWA instalada.',
    },
    {
      id: 'ios',
      category: 'ALMACENAMIENTO INTERNO · IPHONE / IPAD (IOS)',
      question: '¿Cómo funciona el almacenamiento interno en iPhone o iPad?',
      answer:
        'Safari e iOS no permiten acceso directo a carpetas del sistema desde la web. Para conservar tu biblioteca sin pérdidas, instala GradMix en tu Pantalla de inicio (Compartir → Añadir a inicio) y mantén tus descargas dentro de la cuota persistente del navegador (10 GB).',
    },
  ];

  async function confirmWipe() {
    confirmClearOpen = false;
    clearing = true;
    try {
      await onClearDatabase();
      onRefresh();
    } finally {
      clearing = false;
    }
  }

  interface PerformanceMemory {
    usedJSHeapSize: number;
    totalJSHeapSize: number;
    jsHeapSizeLimit: number;
  }

  let jsHeap = $state<PerformanceMemory | null>(null);

  function readMemory() {
    const perf = performance as unknown as { memory?: PerformanceMemory };
    jsHeap = perf.memory ? { ...perf.memory } : null;
  }

  $effect(() => {
    readMemory();
    const id = window.setInterval(readMemory, 2000);
    return () => window.clearInterval(id);
  });

  let storagePercent = $derived(
    storageInfo.quotaBytes > 0
      ? Math.min(100, (storageInfo.usageBytes / storageInfo.quotaBytes) * 100)
      : 0
  );

  let jsHeapPercent = $derived(
    jsHeap && jsHeap.jsHeapSizeLimit > 0
      ? Math.min(100, (jsHeap.usedJSHeapSize / jsHeap.jsHeapSizeLimit) * 100)
      : 0
  );
</script>

<section class="space-y-4">
  <div class="border border-zinc-200 bg-white p-4 sm:p-5 dark:border-zinc-900 dark:bg-zinc-950">
    <div class="mb-4 flex items-center justify-between">
      <div>
        <h2 class="text-base font-semibold tracking-tight text-zinc-900 dark:text-white">
          Monitoreo de Recursos
        </h2>
        <p class="text-[11px] text-zinc-500 dark:text-zinc-400">
          Consumo en tiempo real del navegador y almacenamiento local
        </p>
      </div>

      <button
        type="button"
        onclick={() => {
          readMemory();
          onRefresh();
        }}
        title="Actualizar métricas"
        aria-label="Actualizar métricas"
        class="border border-zinc-200 bg-zinc-50 p-2 text-zinc-600 transition hover:bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300"
      >
        <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M23 4v6h-6M1 20v-6h6" stroke-linecap="round" stroke-linejoin="round" />
          <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>
    </div>

    <!-- Memoria RAM del Navegador -->
    <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <div class="border border-zinc-200 bg-zinc-50/60 p-3.5 dark:border-zinc-900 dark:bg-black">
        <p class="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
          Búferes de Audio en RAM
        </p>
        <p class="mt-1 tabular-nums text-xl font-semibold text-zinc-900 dark:text-white">
          {snapshot.ramBuffersCount} / 2 pistas
        </p>
        <p class="mt-0.5 tabular-nums text-xs text-zinc-500 dark:text-zinc-400">
          PCM decodificado: {formatBytes(snapshot.ramBufferBytes)}
        </p>
        <p class="mt-2 text-[11px] text-zinc-400">
          AudioContext: <span class="font-medium">{snapshot.audioContextState}</span>
        </p>
      </div>

      <div class="border border-zinc-200 bg-zinc-50/60 p-3.5 dark:border-zinc-900 dark:bg-black">
        <p class="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
          Heap JS del Navegador
        </p>
        {#if jsHeap}
          <p class="mt-1 tabular-nums text-xl font-semibold text-zinc-900 dark:text-white">
            {formatBytes(jsHeap.usedJSHeapSize)}
          </p>
          <p class="mt-0.5 tabular-nums text-xs text-zinc-500 dark:text-zinc-400">
            Límite: {formatBytes(jsHeap.jsHeapSizeLimit)} ({jsHeapPercent.toFixed(1)}%)
          </p>
          <div class="mt-2 h-1.5 w-full overflow-hidden bg-zinc-200 dark:bg-zinc-900">
            <div class="h-full bg-cyan-500" style="width: {jsHeapPercent}%"></div>
          </div>
        {:else}
          <p class="mt-1 text-sm font-medium text-zinc-700 dark:text-zinc-300">
            No expuesto por este navegador
          </p>
          <p class="mt-1 text-[11px] text-zinc-400">
            Safari/Firefox ocultan <code>performance.memory</code> por privacidad; los búferes de audio siguen limitados a 2 pistas.
          </p>
        {/if}
      </div>
    </div>

    <!-- Base de Datos Local (OPFS + IndexedDB) -->
    <div class="mt-3 border border-zinc-200 bg-zinc-50/60 p-3.5 dark:border-zinc-900 dark:bg-black">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p class="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
            Base de Datos Local (OPFS + IndexedDB)
          </p>
          <p class="mt-1 tabular-nums text-lg font-semibold text-zinc-900 dark:text-white">
            {formatBytes(storageInfo.usageBytes)}
            {#if storageInfo.quotaBytes > 0}
              <span class="text-xs font-normal text-zinc-500">
                / {formatBytes(storageInfo.quotaBytes)} ({storagePercent.toFixed(2)}%)
              </span>
            {/if}
          </p>
        </div>

        <div class="flex flex-wrap gap-1.5 text-[11px]">
          <span class="border border-zinc-200 bg-white px-2 py-1 dark:border-zinc-800 dark:bg-zinc-950">
            Destino: {storageMode === 'device' ? `Dispositivo (${deviceStorageName || 'Carpeta'})` : storageInfo.supportedOpfs ? 'Navegador (OPFS)' : 'Navegador (IDB)'}
          </span>
          <span class="border border-zinc-200 bg-white px-2 py-1 dark:border-zinc-800 dark:bg-zinc-950">
            Persistente: {storageInfo.persisted ? 'Sí' : 'Estándar'}
          </span>
        </div>
      </div>

      <div class="mt-2.5 h-1.5 w-full overflow-hidden bg-zinc-200 dark:bg-zinc-900">
        <div
          class="h-full transition-all {storagePercent >= 90
            ? 'bg-red-500'
            : storagePercent >= 80
              ? 'bg-amber-500'
              : 'bg-emerald-500'}"
          style="width: {Math.max(1, storagePercent)}%"
        ></div>
      </div>

      {#if storagePercent >= 80}
        <div class="mt-3 border border-amber-500/50 bg-amber-500/10 p-2.5 text-xs text-amber-800 dark:text-amber-300">
          Almacenamiento del navegador al {storagePercent.toFixed(1)}%. Puedes cambiar al almacenamiento interno de tu dispositivo o vaciar canciones locales.
        </div>
      {/if}

      <div class="mt-3 flex flex-wrap items-center justify-between gap-2">
        <div class="flex gap-4 tabular-nums text-xs text-zinc-500 dark:text-zinc-400">
          <span>Canciones guardadas: <strong class="text-zinc-800 dark:text-zinc-200">{tracksCount}</strong></span>
          <span>Playlists: <strong class="text-zinc-800 dark:text-zinc-200">{playlistsCount}</strong></span>
        </div>

        <div class="flex flex-wrap items-center gap-2">
          {#if onSwitchStorage}
            <button
              type="button"
              onclick={() => onSwitchStorage()}
              class="inline-flex items-center gap-1.5 border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-900 transition hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:text-white dark:hover:bg-zinc-800"
            >
              {storageMode === 'device' ? 'Cambiar carpeta interna' : 'Usar almacenamiento interno'}
            </button>
          {/if}

          <button
            type="button"
            onclick={() => (confirmClearOpen = true)}
            disabled={clearing}
            class="inline-flex items-center gap-1.5 border border-red-800 bg-red-700 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-red-800 disabled:opacity-40"
          >
            <svg class="h-4 w-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M9 3h6l1 2h4v2H4V5h4l1-2zm-3 6h12l-1 11a2 2 0 0 1-2 1.8H9a2 2 0 0 1-2-1.8L6 9zm4 2v7h1.5v-7H10zm2.5 0v7H14v-7h-1.5z" />
            </svg>
            <span>{clearing ? 'Borrando...' : 'Borrar datos'}</span>
          </button>
        </div>
      </div>
    </div>

    {#if storageMode === 'device' || deviceStorageInfo !== null}
      {@const permGranted = deviceStorageInfo?.permissionState === 'granted'}
      <div class="mt-3 border border-cyan-500/40 bg-cyan-50/30 p-3.5 dark:border-cyan-900/60 dark:bg-zinc-950">
        <div class="flex items-center gap-2">
          <svg class="h-4 w-4 text-cyan-600 dark:text-cyan-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path
              d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
          <div>
            <p class="text-[11px] font-semibold uppercase tracking-wider text-cyan-700 dark:text-cyan-400">
              Almacenamiento Interno del Dispositivo
            </p>
            <p class="mt-0.5 tabular-nums text-sm font-semibold text-zinc-900 dark:text-white">
              {permGranted && deviceStorageInfo
                ? `${formatBytes(deviceStorageInfo.usedBytes)} usados en la carpeta`
                : 'Carpeta autorizada (toca para verificar permiso)'}
            </p>
          </div>
        </div>

        <p class="mt-2 text-[11px] leading-relaxed text-zinc-600 dark:text-zinc-300">
          Las pistas descargadas en esta carpeta quedan en tu disco fuera de los 10 GB del navegador, se identifican con el
          <strong class="text-cyan-700 dark:text-cyan-400">ícono de carpeta</strong> en tus playlists y se reproducen directamente dentro de GradMix.
          {#if storageInfo.quotaBytes > storageInfo.usageBytes}
            Espacio libre estimado en cuota del navegador: <strong>{formatBytes(storageInfo.quotaBytes - storageInfo.usageBytes)}</strong> (la carpeta local usa el almacenamiento libre de tu dispositivo).
          {/if}
        </p>

        <div class="mt-3 flex flex-wrap items-center justify-between gap-2">
          <div class="tabular-nums text-xs text-zinc-500 dark:text-zinc-400">
            <span>
              Pistas en almacenamiento interno:
              <strong class="text-zinc-800 dark:text-zinc-200">{deviceTracksCount}</strong>
            </span>
          </div>

          <div class="flex flex-wrap items-center gap-2">
            {#if onSwitchStorage}
              <button
                type="button"
                onclick={() => onSwitchStorage()}
                class="border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-900 transition hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:text-white dark:hover:bg-zinc-800"
              >
                {permGranted ? 'Cambiar carpeta' : 'Autorizar / Reabrir carpeta'}
              </button>
            {/if}
            {#if onRevokeDeviceStorage}
              <button
                type="button"
                onclick={() => onRevokeDeviceStorage()}
                class="border border-red-800 bg-red-700 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-red-800"
              >
                Eliminar acceso
              </button>
            {/if}
          </div>
        </div>
      </div>
    {/if}

    <!-- Guía desplegable de Almacenamiento Interno por dispositivo (PC / Android / iOS) -->
    <div class="mt-4 border border-zinc-200 bg-white dark:border-zinc-900 dark:bg-black">
      <div class="border-b border-zinc-200 px-3.5 py-3 dark:border-zinc-900">
        <p class="text-[11px] font-semibold uppercase tracking-wider text-zinc-700 dark:text-zinc-200">
          ¿Cómo usar el almacenamiento interno según tu dispositivo?
        </p>
        <p class="mt-0.5 text-[11px] text-zinc-500 dark:text-zinc-400">
          Por defecto tus canciones se guardan en el navegador (OPFS). Despliega tu plataforma para ver qué seleccionar:
        </p>
      </div>

      <AccordionList items={STORAGE_GUIDE_ITEMS} />
    </div>
  </div>
</section>

<ConfirmModal
  open={confirmClearOpen}
  title="Borrar datos"
  message="¿Seguro que deseas borrar todas las canciones de OPFS y reiniciar tus playlists locales? Esta acción liberará el espacio del navegador y no se puede deshacer."
  confirmLabel="Sí, borrar datos"
  danger={true}
  onConfirm={confirmWipe}
  onCancel={() => (confirmClearOpen = false)}
/>
