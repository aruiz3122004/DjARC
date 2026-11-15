/**
 * Integración con navigator.mediaSession API.
 * Permite mostrar título, artista y barra de progreso en pantalla bloqueada,
 * centro de control y relojes inteligentes, y responder a Play/Pause/Siguiente/Anterior.
 */

import type { PlaybackStatus, Track } from '../types';
import { cleanDisplayArtist, cleanDisplayTitle } from '../utils/format';

export interface MediaSessionHandlers {
  onPlay: () => void;
  onPause: () => void;
  onNext: () => void;
  onPrevious: () => void;
  onSeekTo: (seconds: number) => void;
  onSeekBy: (deltaSeconds: number) => void;
}

let savedHandlers: MediaSessionHandlers | null = null;

function applyActionHandlers(handlers: MediaSessionHandlers): void {
  if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;

  const ms = navigator.mediaSession;
  const safeSet = (action: MediaSessionAction, fn: MediaSessionActionHandler | null) => {
    try {
      ms.setActionHandler(action, fn);
    } catch {
      // Algunas acciones no son soportadas en todos los navegadores
    }
  };

  safeSet('play', () => handlers.onPlay());
  safeSet('pause', () => handlers.onPause());
  safeSet('previoustrack', () => handlers.onPrevious());
  safeSet('nexttrack', () => handlers.onNext());
  safeSet('seekto', (details) => {
    if (typeof details.seekTime === 'number') {
      handlers.onSeekTo(details.seekTime);
    }
  });
  safeSet('seekbackward', (details) => {
    handlers.onSeekBy(-(details.seekOffset ?? 10));
  });
  safeSet('seekforward', (details) => {
    handlers.onSeekBy(details.seekOffset ?? 10);
  });
}

export function registerMediaSessionHandlers(handlers: MediaSessionHandlers): void {
  savedHandlers = handlers;
  applyActionHandlers(handlers);
}

export function updateMediaSessionMetadata(
  track: Track | null,
  status: PlaybackStatus,
  elapsed: number,
  duration: number
): void {
  if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;

  const ms = navigator.mediaSession;
  if (savedHandlers) {
    applyActionHandlers(savedHandlers);
  }

  ms.playbackState =
    status === 'playing' ? 'playing' : status === 'paused' ? 'paused' : 'none';

  if (track && typeof MediaMetadata !== 'undefined') {
    ms.metadata = new MediaMetadata({
      title: cleanDisplayTitle(track.title) || track.title,
      artist: cleanDisplayArtist(track.artist),
      album: '',
      artwork: [
        { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
      ],
    });
  } else if (!track) {
    ms.metadata = null;
  }

  if (typeof ms.setPositionState === 'function' && duration > 0 && Number.isFinite(duration)) {
    try {
      ms.setPositionState({
        duration,
        playbackRate: 1,
        position: Math.min(Math.max(0, elapsed), duration),
      });
    } catch {
      // Ignorar si la posición excede duración durante transiciones
    }
  }
}

const PLAYBACK_NOTIFICATION_TAG = 'gradmix-playback-controls';

export function getNotificationPermissionState(): NotificationPermission | 'unsupported' {
  if (typeof window === 'undefined' || !('Notification' in window)) {
    return 'unsupported';
  }
  return Notification.permission;
}

export async function requestNotificationControlsPermission(): Promise<
  NotificationPermission | 'unsupported'
> {
  if (typeof window === 'undefined' || !('Notification' in window)) {
    return 'unsupported';
  }
  if (Notification.permission === 'granted') {
    return 'granted';
  }
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

/**
 * Muestra/actualiza una notificación local en la barra de notificaciones
 * con botones Anterior / Play-Pausa / Siguiente usando el Service Worker local (sin VAPID).
 */
export async function syncPlaybackNotification(
  _track: Track | null,
  _status: PlaybackStatus
): Promise<void> {
  // Aseguramos cerrar cualquier notificación de texto antigua para que Android/iOS
  // muestre exclusivamente el reproductor nativo de MediaSession (íconos grandes |◄ ⏸ ►|
  // que incluyen Siguiente y NO cierran ni comprimen la barra de notificaciones al tocarlos).
  await closePlaybackNotification();
}

export async function closePlaybackNotification(): Promise<void> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg) return;
    const existing = await reg.getNotifications({ tag: PLAYBACK_NOTIFICATION_TAG });
    for (const n of existing) n.close();
  } catch {
    // Ignorar
  }
}
