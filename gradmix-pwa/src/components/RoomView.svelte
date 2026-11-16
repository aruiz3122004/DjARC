<script lang="ts">
  import whatsappDark from '../assets/whatsapp-dark.png';
  import whatsappLight from '../assets/whatsapp-light.png';
  import ConfirmModal from './ConfirmModal.svelte';
  import type { RoomParticipant, RoomPermissions, RoomPublicState, ThemeMode } from '../lib/types';
  import { AUDIO_ACCEPT_ATTR, formatTime } from '../lib/utils/format';

  const PERM_COLUMNS: Array<{ key: keyof RoomPermissions; label: string }> = [
    { key: 'canSkip', label: 'Saltar' },
    { key: 'canPause', label: 'Pausar' },
    { key: 'canAdd', label: 'Añadir' },
    { key: 'canRemove', label: 'Eliminar' },
  ];

  interface Props {
    room: RoomPublicState | null;
    participantId: string | null;
    roomError: string | null;
    uploadingToRoom: boolean;
    roomActionBusy?: boolean;
    theme: ThemeMode;
    pendingInvite?: { code: string; token: string } | null;
    guestMuted?: boolean;
    guestAudioBlocked?: boolean;
    onCreateRoom: (params: {
      hostName: string;
      password: string;
      durationHours: number;
      customCode: string;
    }) => void;
    onJoinRoom: (params: { code: string; password: string; userName: string; inviteToken?: string }) => void;
    onClearInvite?: () => void;
    onShareRoomWhatsApp: (
      targetRoom?: RoomPublicState,
      quickCreateParams?: { hostName: string; password: string; durationHours: number; customCode: string }
    ) => void;
    onLeaveOrCloseRoom: () => void;
    onUpdatePermissions: (targetParticipantId: string, permissions: RoomPermissions) => void;
    onRemoveParticipant?: (targetParticipantId: string) => void;
    onToggleGuestMute?: () => void;
    onUploadRoomFiles: (files: FileList | File[]) => void;
    onDeleteRoomTrack: (trackId: string) => void;
    onRemoteCommand: (action: 'toggle-play' | 'skip-next' | 'previous') => void;
  }

  let {
    room,
    participantId,
    roomError,
    uploadingToRoom,
    roomActionBusy = false,
    theme,
    pendingInvite = null,
    guestMuted = false,
    guestAudioBlocked = false,
    onCreateRoom,
    onJoinRoom,
    onClearInvite,
    onShareRoomWhatsApp,
    onLeaveOrCloseRoom,
    onUpdatePermissions,
    onRemoveParticipant,
    onToggleGuestMute,
    onUploadRoomFiles,
    onDeleteRoomTrack,
    onRemoteCommand,
  }: Props = $props();

  let pendingKickUser = $state<RoomParticipant | null>(null);

  let mode = $state<'join' | 'create'>('join');

  // Formulario Crear Sala
  let hostName = $state('Host DJ');
  let createCode = $state('');
  let createPassword = $state('');
  let showCreatePassword = $state(false);
  let durationHours = $state(10);

  // Formulario Unirse a Sala
  let joinCode = $state('');
  let joinPassword = $state('');
  let showJoinPassword = $state(false);
  let joinUserName = $state('');

  let nowMs = $state(Date.now());
  let roomFileInput: HTMLInputElement | undefined = $state();

  $effect(() => {
    if (!room) return;
    nowMs = Date.now();
    const id = window.setInterval(() => {
      nowMs = Date.now();
    }, 1000);
    return () => window.clearInterval(id);
  });

  let me = $derived(
    room && participantId
      ? (room.participants.find((p) => p.id === participantId) ?? null)
      : null
  );

  let isHost = $derived(Boolean(room && participantId && room.hostId === participantId));
  let canSkip = $derived(Boolean(isHost || me?.permissions.canSkip));
  let canPause = $derived(Boolean(isHost || me?.permissions.canPause));
  let canAdd = $derived(Boolean(isHost || me?.permissions.canAdd));
  let canRemove = $derived(Boolean(isHost || me?.permissions.canRemove));
  let hostQueue = $derived((room?.playbackQueue ?? []).slice(0, 5));

  let remainingSeconds = $derived(
    room ? Math.max(0, Math.floor((room.expiresAt - nowMs) / 1000)) : 0
  );

  function submitCreate(ev: Event) {
    ev.preventDefault();
    if (roomActionBusy) return;
    onCreateRoom({
      hostName: hostName.trim() || 'Host DJ',
      password: createPassword,
      durationHours: Math.min(10, Math.max(1, Number(durationHours) || 10)),
      customCode: createCode.trim(),
    });
  }

  function submitJoin(ev: Event) {
    ev.preventDefault();
    if (roomActionBusy) return;
    if (pendingInvite) {
      onJoinRoom({
        code: pendingInvite.code,
        password: '',
        inviteToken: pendingInvite.token,
        userName: joinUserName.trim() || 'Invitado',
      });
      return;
    }
    if (!joinCode.trim()) return;
    onJoinRoom({
      code: joinCode.trim().toUpperCase(),
      password: joinPassword,
      userName: joinUserName.trim() || 'Invitado',
    });
  }

  function handleRoomFileChange(ev: Event) {
    const input = ev.currentTarget as HTMLInputElement;
    if (input.files && input.files.length > 0) {
      onUploadRoomFiles(input.files);
      input.value = '';
    }
  }
</script>

<section class="space-y-4">
  {#if roomError}
    <div class="border border-red-500/40 bg-red-500/10 px-4 py-2.5 text-xs text-red-600 dark:text-red-300">
      {roomError}
    </div>
  {/if}

  {#if !room}
    <div class="border border-zinc-200 bg-white p-4 sm:p-5 dark:border-zinc-900 dark:bg-zinc-950">
      <div class="mb-4 flex items-center justify-between gap-2">
        <div>
          <h2 class="text-base font-semibold tracking-tight text-zinc-900 dark:text-white">
            Sala Colaborativa
          </h2>
          <p class="text-[11px] text-zinc-500 dark:text-zinc-400">
            Salas temporales (máx. 10h) para compartir canciones en vivo
          </p>
        </div>

        <div class="flex items-center gap-1.5">
          <button
            type="button"
            disabled={roomActionBusy}
            onclick={() =>
              onShareRoomWhatsApp(undefined, {
                hostName: hostName.trim() || 'Host DJ',
                password: createPassword,
                durationHours: Math.min(10, Math.max(1, Number(durationHours) || 10)),
                customCode: createCode.trim(),
              })}
            title="Crear y compartir invitación directa por WhatsApp (sin código)"
            aria-label="Compartir sala por WhatsApp"
            class="flex h-8 w-8 items-center justify-center border border-zinc-200 bg-zinc-50 transition hover:bg-zinc-100 active:scale-95 disabled:opacity-40 dark:border-zinc-800 dark:bg-black dark:hover:bg-zinc-900"
          >
            <img
              src={theme === 'dark' ? whatsappLight : whatsappDark}
              alt="WhatsApp"
              class="h-4 w-4 object-contain"
            />
          </button>

          <div class="flex border border-zinc-200 bg-zinc-50 p-1 text-xs dark:border-zinc-800 dark:bg-black">
            <button
              type="button"
              onclick={() => (mode = 'join')}
              class="px-3 py-1 font-medium transition {mode === 'join'
                ? 'bg-zinc-900 text-white dark:bg-white dark:text-black'
                : 'text-zinc-500'}"
            >
              Unirse
            </button>
            <button
              type="button"
              onclick={() => {
                onClearInvite?.();
                mode = 'create';
              }}
              class="px-3 py-1 font-medium transition {mode === 'create' && !pendingInvite
                ? 'bg-zinc-900 text-white dark:bg-white dark:text-black'
                : 'text-zinc-500'}"
            >
              Crear
            </button>
          </div>
        </div>
      </div>

      {#if mode === 'join' || pendingInvite}
        <form onsubmit={submitJoin} class="space-y-3">
          {#if pendingInvite}
            <div class="flex items-center justify-between gap-2 border border-cyan-500/40 bg-cyan-500/10 px-3 py-2 text-xs text-cyan-800 dark:text-cyan-200">
              <span>Invitación directa a sala <strong>{pendingInvite.code}</strong> · Solo ingresa tu nombre</span>
              {#if onClearInvite}
                <button
                  type="button"
                  onclick={onClearInvite}
                  class="shrink-0 text-[11px] font-medium underline opacity-80 hover:opacity-100"
                >
                  Cambiar
                </button>
              {/if}
            </div>
          {:else}
            <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label class="mb-1 block text-[11px] font-medium text-zinc-500" for="join-code">
                Nombre de la sala
              </label>
              <input
                id="join-code"
                type="text"
                required
                bind:value={joinCode}
                placeholder="Ej: GRAD26"
                class="w-full border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs uppercase tracking-wider text-zinc-900 focus:border-cyan-500 focus:outline-none dark:border-zinc-800 dark:bg-black dark:text-white"
              />
            </div>

            <div>
              <label class="mb-1 block text-[11px] font-medium text-zinc-500" for="join-pass">
                Clave
              </label>
              <div class="relative flex items-center">
                <input
                  id="join-pass"
                  type={showJoinPassword ? 'text' : 'password'}
                  bind:value={joinPassword}
                  placeholder="Números, texto o símbolos"
                  class="w-full border border-zinc-200 bg-zinc-50 py-2 pl-3 pr-9 text-xs text-zinc-900 focus:border-cyan-500 focus:outline-none dark:border-zinc-800 dark:bg-black dark:text-white"
                />
                <button
                  type="button"
                  onclick={() => (showJoinPassword = !showJoinPassword)}
                  aria-label={showJoinPassword ? 'Ocultar clave' : 'Ver clave'}
                  title={showJoinPassword ? 'Ocultar clave' : 'Ver clave'}
                  class="absolute right-2 p-1 text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-white"
                >
                  {#if showJoinPassword}
                    <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24M1 1l22 22" stroke-linecap="round" stroke-linejoin="round" />
                    </svg>
                  {:else}
                    <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                      <circle cx="12" cy="12" r="3" />
                    </svg>
                  {/if}
                </button>
              </div>
            </div>
            </div>
          {/if}

          <div>
            <label class="mb-1 block text-[11px] font-medium text-zinc-500" for="join-name">
              Tu nombre
            </label>
            <input
              id="join-name"
              type="text"
              required={Boolean(pendingInvite)}
              bind:value={joinUserName}
              placeholder="Ej: Andrés"
              class="w-full border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs text-zinc-900 focus:border-cyan-500 focus:outline-none dark:border-zinc-800 dark:bg-black dark:text-white"
            />
          </div>

          <button
            type="submit"
            disabled={roomActionBusy}
            class="w-full bg-zinc-900 py-2.5 text-xs font-semibold text-white transition hover:bg-zinc-800 disabled:opacity-40 dark:bg-white dark:text-black dark:hover:bg-zinc-200"
          >
            {roomActionBusy ? 'Entrando...' : 'Entrar a la Sala'}
          </button>
        </form>
      {:else}
        <form onsubmit={submitCreate} class="space-y-3">
          <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label class="mb-1 block text-[11px] font-medium text-zinc-500" for="host-name">
                Nombre del Host
              </label>
              <input
                id="host-name"
                type="text"
                bind:value={hostName}
                class="w-full border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs text-zinc-900 focus:border-cyan-500 focus:outline-none dark:border-zinc-800 dark:bg-black dark:text-white"
              />
            </div>

            <div>
              <label class="mb-1 block text-[11px] font-medium text-zinc-500" for="custom-code">
                Nombre de la sala (opcional)
              </label>
              <input
                id="custom-code"
                type="text"
                bind:value={createCode}
                placeholder="Auto si se deja vacío"
                class="w-full border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs uppercase tracking-wider text-zinc-900 focus:border-cyan-500 focus:outline-none dark:border-zinc-800 dark:bg-black dark:text-white"
              />
            </div>
          </div>

          <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label class="mb-1 block text-[11px] font-medium text-zinc-500" for="create-pass">
                Clave de la sala
              </label>
              <div class="relative flex items-center">
                <input
                  id="create-pass"
                  type={showCreatePassword ? 'text' : 'password'}
                  bind:value={createPassword}
                  placeholder="Números, texto o símbolos"
                  class="w-full border border-zinc-200 bg-zinc-50 py-2 pl-3 pr-9 text-xs text-zinc-900 focus:border-cyan-500 focus:outline-none dark:border-zinc-800 dark:bg-black dark:text-white"
                />
                <button
                  type="button"
                  onclick={() => (showCreatePassword = !showCreatePassword)}
                  aria-label={showCreatePassword ? 'Ocultar clave' : 'Ver clave'}
                  title={showCreatePassword ? 'Ocultar clave' : 'Ver clave'}
                  class="absolute right-2 p-1 text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-white"
                >
                  {#if showCreatePassword}
                    <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24M1 1l22 22" stroke-linecap="round" stroke-linejoin="round" />
                    </svg>
                  {:else}
                    <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                      <circle cx="12" cy="12" r="3" />
                    </svg>
                  {/if}
                </button>
              </div>
            </div>

            <div>
              <label class="mb-1 block text-[11px] font-medium text-zinc-500" for="room-hours">
                Duración (máx. 10 horas): <strong class="tabular-nums">{durationHours}h</strong>
              </label>
              <input
                id="room-hours"
                type="range"
                min="1"
                max="10"
                step="1"
                bind:value={durationHours}
                class="gradmix-slider mt-2 w-full"
              />
            </div>
          </div>

          <button
            type="submit"
            disabled={roomActionBusy}
            class="w-full bg-zinc-900 py-2.5 text-xs font-semibold text-white transition hover:bg-zinc-800 disabled:opacity-40 dark:bg-white dark:text-black dark:hover:bg-zinc-200"
          >
            {roomActionBusy ? 'Creando sala...' : 'Crear Sala Temporal'}
          </button>
        </form>
      {/if}
    </div>
  {:else}
    <!-- Sala Activa -->
    <div class="border border-zinc-200 bg-white p-4 sm:p-5 dark:border-zinc-900 dark:bg-zinc-950">
      <div class="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-200 pb-3 dark:border-zinc-900">
        <div>
          <div class="flex items-center gap-2">
            <span class="border border-zinc-300 bg-zinc-100 px-2.5 py-1 font-mono text-xs font-bold tracking-widest text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-white">
              {room.code}
            </span>
            <span class="text-xs font-medium text-zinc-600 dark:text-zinc-400">
              {isHost ? 'Host' : 'Invitado'}
            </span>
          </div>
          <p class="mt-1 tabular-nums text-[11px] text-zinc-500">
            Autodestrucción en {formatTime(remainingSeconds)}
          </p>
        </div>

        <div class="flex items-center gap-1.5">
          {#if room.inviteToken}
            <button
              type="button"
              disabled={roomActionBusy}
              onclick={() => onShareRoomWhatsApp(room ?? undefined)}
              title="Compartir enlace directo por WhatsApp (sin código)"
              aria-label="Compartir sala por WhatsApp"
              class="flex h-8 w-8 items-center justify-center border border-zinc-200 bg-zinc-50 transition hover:bg-zinc-100 active:scale-95 disabled:opacity-40 dark:border-zinc-800 dark:bg-black dark:hover:bg-zinc-900"
            >
              <img
                src={theme === 'dark' ? whatsappLight : whatsappDark}
                alt="WhatsApp"
                class="h-4 w-4 object-contain"
              />
            </button>
          {/if}

          <button
            type="button"
            disabled={roomActionBusy}
            onclick={onLeaveOrCloseRoom}
            class="border border-red-800 bg-red-700 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-red-800 disabled:opacity-40"
          >
            {isHost ? 'Cerrar sala' : 'Salir'}
          </button>
        </div>
      </div>

      <div class="mt-3 flex flex-wrap items-center justify-between gap-3 border border-zinc-200 bg-zinc-50/70 p-3 dark:border-zinc-900 dark:bg-black">
        <div class="min-w-0 flex-1">
          <p class="text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
            Sonando en la sala
          </p>
          <p class="truncate text-xs font-medium text-zinc-900 dark:text-zinc-100">
            {room.nowPlayingTitle ?? 'En espera'}
          </p>
          {#if room.nowPlayingArtist}
            <p class="truncate text-[11px] text-zinc-500">{room.nowPlayingArtist}</p>
          {/if}
          {#if !isHost && guestAudioBlocked}
            <p class="mt-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
              Toca el ícono de altavoz para activar el audio en este dispositivo.
            </p>
          {/if}
        </div>

        <div class="flex items-center gap-2">
          {#if !isHost && onToggleGuestMute}
            <button
              type="button"
              onclick={onToggleGuestMute}
              title={guestMuted ? 'Activar sonido (solo en tu dispositivo)' : 'Silenciar audio en este dispositivo'}
              aria-label={guestMuted ? 'Activar sonido' : 'Silenciar'}
              class="inline-flex h-8 w-8 cursor-pointer items-center justify-center bg-transparent transition hover:scale-110 active:scale-95 {guestMuted
                ? 'text-red-600 drop-shadow-sm dark:text-red-400'
                : 'text-zinc-900 drop-shadow-sm hover:text-cyan-600 dark:text-white dark:hover:text-cyan-400'}"
            >
              {#if guestMuted}
                <!-- Altavoz silenciado (con X) sin fondo -->
                <svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
                  <path d="M11 5L6 9H2v6h4l5 4V5z" stroke-linecap="round" stroke-linejoin="round" />
                  <path d="M22 9l-6 6M16 9l6 6" stroke-linecap="round" />
                </svg>
              {:else}
                <!-- Altavoz activo sin fondo -->
                <svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
                  <path d="M11 5L6 9H2v6h4l5 4V5z" stroke-linecap="round" stroke-linejoin="round" />
                  <path d="M15.54 8.46a5 5 0 0 1 0 7.07M19.07 4.93a10 10 0 0 1 0 14.14" stroke-linecap="round" />
                </svg>
              {/if}
            </button>
          {/if}

          <button
            type="button"
            disabled={!canSkip || roomActionBusy}
            onclick={() => onRemoteCommand('previous')}
            title="Anterior"
            aria-label="Anterior"
            class="flex h-9 w-9 items-center justify-center border border-zinc-200 bg-white text-zinc-700 disabled:opacity-30 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-200"
          >
            <svg class="h-4 w-4" viewBox="0 0 24 24" fill="currentColor">
              <path d="M6 5h2v14H6V5zm3.5 7 9.5 6V6l-9.5 6z" />
            </svg>
          </button>

          <button
            type="button"
            disabled={isHost || !canPause || roomActionBusy}
            onclick={() => onRemoteCommand('toggle-play')}
            title={isHost
              ? 'Indicador informativo para invitados (controla Play/Pausa desde el reproductor o barra inferior)'
              : room.isPlaying
                ? 'Pausar'
                : 'Reproducir'}
            aria-label={isHost ? 'Estado de reproducción' : room.isPlaying ? 'Pausar' : 'Reproducir'}
            class="flex h-9 w-9 items-center justify-center bg-zinc-900 text-white disabled:cursor-not-allowed disabled:opacity-45 dark:bg-white dark:text-black"
          >
            {#if room.isPlaying}
              <svg class="h-4 w-4" viewBox="0 0 24 24" fill="currentColor">
                <path d="M6 5h4v14H6V5zm8 0h4v14h-4V5z" />
              </svg>
            {:else}
              <svg class="h-4 w-4 translate-x-0.5" viewBox="0 0 24 24" fill="currentColor">
                <path d="M8 5v14l11-7-11-7z" />
              </svg>
            {/if}
          </button>

          <button
            type="button"
            disabled={!canSkip || roomActionBusy}
            onclick={() => onRemoteCommand('skip-next')}
            title="Saltar"
            aria-label="Saltar"
            class="flex h-9 w-9 items-center justify-center border border-zinc-200 bg-white text-zinc-700 disabled:opacity-30 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-200"
          >
            <svg class="h-4 w-4" viewBox="0 0 24 24" fill="currentColor">
              <path d="M16 5h2v14h-2V5zM5 18l9.5-6L5 6v12z" />
            </svg>
          </button>
        </div>
      </div>

      <!-- Cola de la sala (pistas subidas + cola real en reproducción del Host) -->
      <div class="mt-4 flex items-center justify-between gap-2">
        <h3 class="text-xs font-semibold uppercase tracking-wider text-zinc-500">
          Cola de la Sala ({room.tracks.length + hostQueue.length})
        </h3>

        {#if canAdd}
          <input
            bind:this={roomFileInput}
            type="file"
            multiple
            accept={AUDIO_ACCEPT_ATTR}
            onchange={handleRoomFileChange}
            class="hidden"
          />
          <button
            type="button"
            disabled={uploadingToRoom}
            onclick={() => roomFileInput?.click()}
            title="Subir canción"
            aria-label="Subir canción"
            class="inline-flex h-8 items-center gap-1.5 bg-zinc-900 px-3 text-xs font-medium text-white transition disabled:opacity-50 dark:bg-white dark:text-black"
          >
            <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
              <path d="M12 5v14M5 12h14" stroke-linecap="round" />
            </svg>
            <span>{uploadingToRoom ? 'Subiendo...' : 'Subir'}</span>
          </button>
        {:else}
          <span class="text-[11px] text-zinc-400">Solo lectura</span>
        {/if}
      </div>

      <div class="mt-2.5 max-h-56 space-y-1.5 overflow-y-auto">
        {#if room.tracks.length === 0 && hostQueue.length === 0}
          <p class="py-5 text-center text-xs text-zinc-400">
            Aún no hay canciones en la sala.
          </p>
        {:else}
          {#each room.tracks as trk (trk.id)}
            <div class="flex items-center justify-between gap-2 border border-zinc-200 bg-zinc-50/50 px-3 py-2 dark:border-zinc-900 dark:bg-black">
              <div class="min-w-0 flex-1">
                <p class="truncate text-xs font-medium text-zinc-900 dark:text-zinc-100">
                  {trk.title}
                </p>
                <p class="truncate text-[11px] text-zinc-500">
                  {trk.artist} · {trk.addedByName}
                </p>
              </div>
              {#if canRemove}
                <button
                  type="button"
                  disabled={roomActionBusy}
                  onclick={() => onDeleteRoomTrack(trk.id)}
                  title="Eliminar"
                  aria-label="Eliminar"
                  class="p-1 text-zinc-400 hover:text-red-500 disabled:opacity-30"
                >
                  <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M18 6L6 18M6 6l12 12" stroke-linecap="round" />
                  </svg>
                </button>
              {/if}
            </div>
          {/each}

          {#each hostQueue as qTrk, qIdx (`hq-${qIdx}-${qTrk.id}`)}
            <div class="flex items-center justify-between gap-2 border border-zinc-200 bg-zinc-50/50 px-3 py-2 dark:border-zinc-900 dark:bg-black">
              <span class="w-4 shrink-0 text-[11px] font-semibold tabular-nums text-zinc-400">
                {qIdx + 1}
              </span>
              <div class="min-w-0 flex-1">
                <p class="truncate text-xs font-medium text-zinc-900 dark:text-zinc-100">
                  {qTrk.title}
                </p>
                <p class="truncate text-[11px] text-zinc-500">
                  {qTrk.artist || 'Artista desconocido'}
                </p>
              </div>
              <span
                class="shrink-0 text-[11px] font-semibold {qIdx === 0
                  ? 'text-cyan-700 dark:text-cyan-400'
                  : 'text-zinc-400 dark:text-zinc-500'}"
              >
                {qIdx === 0 ? 'Siguiente' : 'En cola'}
              </span>
            </div>
          {/each}
        {/if}
      </div>

      <!-- Tabla de Usuarios y Privilegios (Switches Izquierda/Derecha) -->
      <div class="mt-5 border-t border-zinc-200 pt-4 dark:border-zinc-900">
        <h3 class="mb-2.5 text-xs font-semibold uppercase tracking-wider text-zinc-500">
          Participantes ({room.participants.length})
        </h3>
        <div class="overflow-x-auto border border-zinc-200 dark:border-zinc-900">
          <table class="w-full min-w-[460px] border-collapse text-left text-xs">
            <thead>
              <tr class="border-b border-zinc-200 bg-zinc-100 text-[10px] font-semibold uppercase tracking-wider text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300">
                <th class="px-3 py-2">Participante</th>
                {#each PERM_COLUMNS as col (col.key)}
                  <th class="px-2 py-2 text-center">{col.label}</th>
                {/each}
                {#if isHost && onRemoveParticipant}
                  <th class="px-2 py-2 text-center">Expulsar</th>
                {/if}
              </tr>
            </thead>
            <tbody class="divide-y divide-zinc-200 bg-zinc-50/40 dark:divide-zinc-900 dark:bg-black">
              {#each room.participants as user (user.id)}
                <tr>
                  <td class="px-3 py-2.5">
                    <div class="flex items-center gap-2">
                      <span class="truncate font-medium text-zinc-900 dark:text-zinc-100">
                        {user.name}
                      </span>
                      {#if user.isHost}
                        <span class="border border-zinc-300 px-1.5 py-0.5 text-[10px] font-semibold text-zinc-700 dark:border-zinc-700 dark:text-zinc-300">
                          Host
                        </span>
                      {/if}
                    </div>
                  </td>

                  {#each PERM_COLUMNS as col (col.key)}
                    <td class="px-2 py-2 text-center">
                      {#if user.isHost}
                        <span class="text-zinc-400">—</span>
                      {:else}
                        <label
                          class="inline-flex cursor-pointer items-center justify-center {isHost ? '' : 'cursor-not-allowed opacity-70'}"
                          title={`${col.label} (${user.name})`}
                        >
                          <span class="relative inline-flex h-5 w-9 items-center">
                            <input
                              type="checkbox"
                              role="switch"
                              checked={Boolean(user.permissions[col.key])}
                              disabled={!isHost || roomActionBusy}
                              onchange={(e) =>
                                onUpdatePermissions(user.id, {
                                  ...user.permissions,
                                  [col.key]: (e.currentTarget as HTMLInputElement).checked,
                                })}
                              aria-label={`${col.label} para ${user.name}`}
                              class="peer sr-only"
                            />
                            <span
                              class="h-5 w-9 border border-zinc-300 bg-zinc-200 transition-colors peer-checked:border-emerald-700 peer-checked:bg-emerald-600 dark:border-zinc-700 dark:bg-zinc-900 dark:peer-checked:border-emerald-500 dark:peer-checked:bg-emerald-500"
                            ></span>
                            <span
                              class="pointer-events-none absolute left-0.5 h-3.5 w-3.5 bg-white shadow-sm transition-transform peer-checked:translate-x-4 dark:bg-zinc-200 peer-checked:dark:bg-black"
                            ></span>
                          </span>
                        </label>
                      {/if}
                    </td>
                  {/each}

                  {#if isHost && onRemoveParticipant}
                    <td class="px-2 py-2 text-center">
                      {#if user.isHost}
                        <span class="text-zinc-400">—</span>
                      {:else}
                        <button
                          type="button"
                          disabled={roomActionBusy}
                          onclick={() => (pendingKickUser = user)}
                          title={`Eliminar a ${user.name} de la sala`}
                          aria-label={`Eliminar a ${user.name}`}
                          class="inline-flex h-8 w-8 cursor-pointer items-center justify-center bg-transparent text-red-600 drop-shadow-sm transition hover:scale-110 hover:text-red-700 active:scale-95 disabled:opacity-40 dark:text-red-400 dark:hover:text-red-300"
                        >
                          <svg class="h-[18px] w-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
                            <path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" stroke-linecap="round" stroke-linejoin="round" />
                            <circle cx="8.5" cy="7" r="4" />
                            <path d="M18 8l5 5M23 8l-5 5" stroke-linecap="round" />
                          </svg>
                        </button>
                      {/if}
                    </td>
                  {/if}
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  {/if}
</section>

<ConfirmModal
  open={pendingKickUser !== null}
  title="Eliminar participante"
  message={pendingKickUser ? `¿Seguro que quieres eliminar a "${pendingKickUser.name}" de la sala?` : ''}
  confirmLabel="Sí, eliminar"
  danger={true}
  onConfirm={() => {
    const target = pendingKickUser;
    pendingKickUser = null;
    if (target) onRemoveParticipant?.(target.id);
  }}
  onCancel={() => (pendingKickUser = null)}
/>
