<script lang="ts">
  import type { AppModule, ThemeMode } from '../lib/types';

  interface Props {
    activeModule: AppModule;
    mobileOpen: boolean;
    theme: ThemeMode;
    favoritesCount: number;
    roomActive: boolean;
    onSelectModule: (mod: AppModule) => void;
    onCloseMobile: () => void;
    onToggleTheme: () => void;
  }

  let {
    activeModule,
    mobileOpen,
    theme,
    favoritesCount,
    roomActive,
    onSelectModule,
    onCloseMobile,
    onToggleTheme,
  }: Props = $props();

  const items: Array<{ id: AppModule; label: string }> = [
    { id: 'player', label: 'Reproductor' },
    { id: 'search', label: 'Buscar' },
    { id: 'playlists', label: 'Playlists' },
    { id: 'favorites', label: 'Favoritos' },
    { id: 'monitoring', label: 'Monitoreo' },
    { id: 'room', label: 'Sala' },
  ];

  function select(id: AppModule) {
    onSelectModule(id);
    onCloseMobile();
  }
</script>

<!-- Backdrop móvil -->
{#if mobileOpen}
  <button
    type="button"
    aria-label="Cerrar menú"
    onclick={onCloseMobile}
    class="fixed inset-0 z-40 bg-black/60 lg:hidden"
  ></button>
{/if}

<aside
  class="fixed inset-y-0 left-0 z-50 flex w-60 flex-col border-r border-zinc-200 bg-white px-3 py-4 transition-transform duration-200 dark:border-zinc-900 dark:bg-black lg:static lg:z-auto lg:translate-x-0 {mobileOpen
    ? 'translate-x-0'
    : '-translate-x-full'}"
  aria-label="Navegación de módulos"
>
  <div class="mb-6 flex items-center justify-between px-2">
    <div class="flex items-center gap-2.5">
      <img src="/favicon.svg" alt="GradMix" class="h-7 w-7 " />
      <span class="text-sm font-semibold tracking-tight text-zinc-900 dark:text-white">
        GradMix
      </span>
    </div>
    <button
      type="button"
      onclick={onCloseMobile}
      aria-label="Cerrar menú"
      class="p-1.5 text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-900 lg:hidden"
    >
      <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M18 6L6 18M6 6l12 12" stroke-linecap="round" />
      </svg>
    </button>
  </div>

  <nav class="flex-1 space-y-1">
    {#each items as item (item.id)}
      {@const isActive = activeModule === item.id}
      <button
        type="button"
        onclick={() => select(item.id)}
        class="flex w-full items-center justify-between px-3 py-2.5 text-xs font-medium transition {isActive
          ? 'bg-zinc-900 text-white dark:bg-zinc-900 dark:text-cyan-300'
          : 'text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-950 dark:hover:text-zinc-100'}"
      >
        <span class="flex items-center gap-3">
          {#if item.id === 'player'}
            <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="9" />
              <circle cx="12" cy="12" r="2.5" />
            </svg>
          {:else if item.id === 'search'}
            <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="11" cy="11" r="7" />
              <path d="M20 20l-3.5-3.5" stroke-linecap="round" />
            </svg>
          {:else if item.id === 'playlists'}
            <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M9 18V5l12-2v13M9 9l12-2" stroke-linecap="round" stroke-linejoin="round" />
              <circle cx="6" cy="18" r="3" />
              <circle cx="18" cy="16" r="3" />
            </svg>
          {:else if item.id === 'favorites'}
            <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path
                d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          {:else if item.id === 'monitoring'}
            <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M3 12h4l3-7 4 14 3-7h4" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          {:else}
            <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" stroke-linecap="round" />
              <circle cx="9" cy="7" r="4" />
              <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" stroke-linecap="round" />
            </svg>
          {/if}
          <span>{item.label}</span>
        </span>

        {#if item.id === 'favorites' && favoritesCount > 0}
          <span class="tabular-nums text-[10px] opacity-70">{favoritesCount}</span>
        {:else if item.id === 'room' && roomActive}
          <span class="h-2 w-2 bg-emerald-400"></span>
        {/if}
      </button>
    {/each}
  </nav>

  <!-- Cambio de tema Claro / Oscuro OLED -->
  <div class="border-t border-zinc-200 pt-3 dark:border-zinc-900">
    <button
      type="button"
      onclick={onToggleTheme}
      class="flex w-full items-center justify-between px-3 py-2 text-xs font-medium text-zinc-600 transition hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-950"
    >
      <span class="flex items-center gap-2.5">
        {#if theme === 'dark'}
          <svg class="h-4 w-4 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2v2m0 16v2M4.93 4.93l1.41 1.41m11.32 11.32l1.41 1.41M2 12h2m16 0h2M4.93 19.07l1.41-1.41m11.32-11.32l1.41-1.41" stroke-linecap="round" />
          </svg>
          <span>Modo Claro</span>
        {:else}
          <svg class="h-4 w-4 text-zinc-900" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
          <span>Modo Oscuro</span>
        {/if}
      </span>
    </button>
  </div>
</aside>
