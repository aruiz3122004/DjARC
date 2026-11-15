/**
 * Motor de Audio Doble Canal (Deck A / Deck B) para GradMix Auto-DJ.
 *
 * Arquitectura anti-crash de 10 horas:
 * 1. Un ÚNICO AudioContext continuo (latencyHint: 'playback') para evitar suspensiones en iOS/Android.
 * 2. Ventana deslizante estricta de 2 búferes en RAM: solo la pista actual y la siguiente pre-cargada.
 * 3. Cada instancia de reproducción crea su AudioBufferSourceNode y GainNode y los desconecta
 *    explícitamente (.stop(), .disconnect()) y libera buffer = null al terminar el crossfade.
 * 4. Curva Equal-Power Crossfade (cos/sin) + DynamicsCompressorNode maestro.
 * 5. Control completo: Play, Pause, Seek, Siguiente (salto), Anterior, Repetir (off/all/one), Aleatorio y Crossfade manual.
 */

import { readAudioArrayBuffer, readAudioBlob } from '../storage/opfsStorage';
import type {
  AudioEngineSnapshot,
  DeckId,
  DeckSnapshot,
  PlaybackStatus,
  RepeatMode,
  Track,
} from '../types';
import { inferAudioMimeType } from '../utils/format';
import { PlaybackQueue } from '../utils/queue';
import {
  describeUnsupportedAudioReason,
  extractAdtsFromFragmentedMp4,
  inspectAudioContainer,
} from './audioContainer';
import {
  closePlaybackNotification,
  registerMediaSessionHandlers,
  syncPlaybackNotification,
  updateMediaSessionMetadata,
} from './mediaSession';

interface DeckRuntime {
  id: DeckId;
  trackId: string | null;
  buffer: AudioBuffer | null;
  source: AudioBufferSourceNode | null;
  gainNode: GainNode | null;
  audioEl: HTMLAudioElement | null;
  objectUrl: string | null;
  elSourceNode: MediaElementAudioSourceNode | null;
  elDuration: number;
  state: DeckSnapshot['state'];
  startedAtCtxTime: number;
  offsetAtStart: number;
  pausedOffset: number;
  currentGain: number;
  preloadingToken: number;
}

const CURVE_SAMPLES = 64;

function createEqualPowerCurves(): { fadeOut: Float32Array; fadeIn: Float32Array } {
  const fadeOut = new Float32Array(CURVE_SAMPLES);
  const fadeIn = new Float32Array(CURVE_SAMPLES);
  for (let i = 0; i < CURVE_SAMPLES; i++) {
    const t = i / (CURVE_SAMPLES - 1);
    fadeOut[i] = Math.cos(t * Math.PI * 0.5);
    fadeIn[i] = Math.sin(t * Math.PI * 0.5);
  }
  return { fadeOut, fadeIn };
}

const { fadeOut: EQUAL_POWER_OUT, fadeIn: EQUAL_POWER_IN } = createEqualPowerCurves();

export class GradMixAudioEngine {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private compressor: DynamicsCompressorNode | null = null;
  private unlocked = false;

  private tracksById = new Map<string, Track>();
  private queue = new PlaybackQueue();

  private decks: Record<DeckId, DeckRuntime> = {
    A: this.createEmptyDeck('A'),
    B: this.createEmptyDeck('B'),
  };

  private activeDeckId: DeckId = 'A';
  private status: PlaybackStatus = 'idle';
  private crossfadeSeconds = 8;
  private autoDjEnabled = true;
  private shuffle = false;
  private repeatMode: RepeatMode = 'all';
  private masterVolume = 0.92;
  private lastError: string | null = null;

  private crossfading = false;
  private crossfadeStartCtxTime = 0;
  private crossfadeDurationActive = 0;
  private crossfadeOutgoingDeck: DeckId | null = null;
  private crossfadeTimerId: number | null = null;

  private schedulerId: number | null = null;
  private decodeSequence = 0;
  private lastMediaSessionUpdate = 0;
  private lastNotificationSyncKey = '';
  private anchorAudio: HTMLAudioElement | null = null;
  private anchorUrl: string | null = null;
  private memoryBlobs = new Map<string, Blob>();
  private transitionLocked = false;

  private listeners = new Set<(snapshot: AudioEngineSnapshot) => void>();
  private onTrackPlayCallback: ((trackId: string) => void) | null = null;

  constructor(onTrackPlay?: (trackId: string) => void) {
    this.onTrackPlayCallback = onTrackPlay ?? null;
    this.setupMediaSession();
  }

  private createEmptyDeck(id: DeckId): DeckRuntime {
    return {
      id,
      trackId: null,
      buffer: null,
      source: null,
      gainNode: null,
      audioEl: null,
      objectUrl: null,
      elSourceNode: null,
      elDuration: 0,
      state: 'empty',
      startedAtCtxTime: 0,
      offsetAtStart: 0,
      pausedOffset: 0,
      currentGain: 0,
      preloadingToken: 0,
    };
  }

  private setupMediaSession(): void {
    registerMediaSessionHandlers({
      onPlay: () => {
        void this.play();
      },
      onPause: () => {
        this.pause();
      },
      onNext: () => {
        void this.skipNext();
      },
      onPrevious: () => {
        void this.previous();
      },
      onSeekTo: (sec) => {
        void this.seekTo(sec);
      },
      onSeekBy: (delta) => {
        const cur = this.getDeckElapsed(this.decks[this.activeDeckId]);
        void this.seekTo(cur + delta);
      },
    });
  }

  subscribe(listener: (snapshot: AudioEngineSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    const snap = this.getSnapshot();
    for (const listener of this.listeners) {
      listener(snap);
    }

    const now = performance.now();
    if (now - this.lastMediaSessionUpdate > 800 || snap.status !== 'playing') {
      this.lastMediaSessionUpdate = now;
      const track = snap.currentTrackId ? this.tracksById.get(snap.currentTrackId) ?? null : null;
      updateMediaSessionMetadata(track, snap.status, snap.elapsed, snap.duration);

      const notifKey = `${snap.currentTrackId ?? ''}|${snap.status}`;
      if (notifKey !== this.lastNotificationSyncKey) {
        this.lastNotificationSyncKey = notifKey;
        void syncPlaybackNotification(track, snap.status);
      }
    }

    this.syncAnchorAudioPlayback(snap.status);
  }

  /**
   * Crea un <audio> silencioso de 15 s (Chromium exige >= 5 s de duración para activar
   * el reproductor nativo de MediaSession en Android con íconos grandes |◄ ⏸ ►| que no
   * comprimen la barra de notificaciones al tocarlos).
   */
  private ensureAnchorAudio(): void {
    if (typeof window === 'undefined' || typeof Audio === 'undefined' || this.anchorAudio) {
      return;
    }
    try {
      const sampleRate = 8000;
      const numSamples = sampleRate * 15; // 15 segundos (>= 5 s requerido por Android Chrome)
      const buffer = new ArrayBuffer(44 + numSamples * 2);
      const view = new DataView(buffer);
      const writeStr = (offset: number, s: string) => {
        for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
      };
      writeStr(0, 'RIFF');
      view.setUint32(4, 36 + numSamples * 2, true);
      writeStr(8, 'WAVE');
      writeStr(12, 'fmt ');
      view.setUint32(16, 16, true);
      view.setUint16(20, 1, true);
      view.setUint16(22, 1, true);
      view.setUint32(24, sampleRate, true);
      view.setUint32(28, sampleRate * 2, true);
      view.setUint16(32, 2, true);
      view.setUint16(34, 16, true);
      writeStr(36, 'data');
      view.setUint32(40, numSamples * 2, true);

      const blob = new Blob([buffer], { type: 'audio/wav' });
      this.anchorUrl = URL.createObjectURL(blob);
      const audio = new Audio(this.anchorUrl);
      audio.loop = true;
      audio.volume = 0.05;
      audio.setAttribute('playsinline', 'true');
      this.anchorAudio = audio;
    } catch {
      // Ignorar si el entorno no soporta HTMLAudioElement
    }
  }

  private syncAnchorAudioPlayback(status: PlaybackStatus): void {
    if (!this.anchorAudio) return;
    if (status === 'playing') {
      if (this.anchorAudio.paused) {
        void this.anchorAudio.play().catch(() => {});
      }
    } else if (!this.anchorAudio.paused) {
      this.anchorAudio.pause();
    }
  }

  /**
   * Crea e inicializa el AudioContext único + DynamicsCompressorNode maestro.
   */
  private ensureAudioContext(): AudioContext {
    if (!this.ctx) {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;

      this.ctx = new AudioCtx({ latencyHint: 'playback' });

      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.setValueAtTime(this.masterVolume, this.ctx.currentTime);

      // Compresor maestro para nivelar canciones con distinta sonoridad en la fiesta
      this.compressor = this.ctx.createDynamicsCompressor();
      this.compressor.threshold.setValueAtTime(-14, this.ctx.currentTime);
      this.compressor.knee.setValueAtTime(18, this.ctx.currentTime);
      this.compressor.ratio.setValueAtTime(4, this.ctx.currentTime);
      this.compressor.attack.setValueAtTime(0.005, this.ctx.currentTime);
      this.compressor.release.setValueAtTime(0.15, this.ctx.currentTime);

      this.masterGain.connect(this.compressor);
      this.compressor.connect(this.ctx.destination);

      this.ctx.addEventListener('statechange', () => {
        this.emit();
      });
    }

    return this.ctx;
  }

  /**
   * Desbloqueo explícito de AudioContext para iOS Safari / Android Chrome tras el primer toque.
   */
  async unlock(): Promise<boolean> {
    try {
      this.ensureAnchorAudio();
      const ctx = this.ensureAudioContext();
      if (ctx.state === 'suspended') {
        await ctx.resume();
      }
      if (!this.unlocked) {
        const silentBuffer = ctx.createBuffer(1, 1, 22050);
        const src = ctx.createBufferSource();
        src.buffer = silentBuffer;
        src.connect(ctx.destination);
        src.start(0);
        src.stop(0);
        src.disconnect();
        src.buffer = null;
        this.unlocked = true;
      }
      this.emit();
      return true;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : 'No se pudo desbloquear el audio.';
      this.emit();
      return false;
    }
  }

  private getStandbyDeckId(deckId: DeckId = this.activeDeckId): DeckId {
    return deckId === 'A' ? 'B' : 'A';
  }

  private hasDeckMedia(deck: DeckRuntime): boolean {
    return deck.buffer !== null || deck.audioEl !== null;
  }

  private getDeckDuration(deck: DeckRuntime): number {
    if (deck.buffer) return deck.buffer.duration;
    if (deck.audioEl) {
      if (deck.elDuration > 0) return deck.elDuration;
      if (Number.isFinite(deck.audioEl.duration) && deck.audioEl.duration > 0) {
        return deck.audioEl.duration;
      }
      if (deck.trackId) return this.tracksById.get(deck.trackId)?.duration ?? 0;
    }
    return 0;
  }

  private getDeckElapsed(deck: DeckRuntime): number {
    const duration = this.getDeckDuration(deck);
    if (deck.audioEl) {
      if (deck.state === 'playing' || deck.state === 'fading-out') {
        return Math.min(Math.max(0, deck.audioEl.currentTime || 0), duration || Infinity);
      }
      if (deck.state === 'paused') {
        return Math.min(Math.max(0, deck.pausedOffset), duration || Infinity);
      }
      return 0;
    }
    if (!deck.buffer) return 0;
    if (deck.state === 'playing' || deck.state === 'fading-out') {
      if (!this.ctx) return deck.pausedOffset;
      const elapsed = deck.offsetAtStart + (this.ctx.currentTime - deck.startedAtCtxTime);
      return Math.min(Math.max(0, elapsed), duration);
    }
    if (deck.state === 'paused') {
      return Math.min(Math.max(0, deck.pausedOffset), duration);
    }
    return 0;
  }

  /**
   * Detiene y desconecta explícitamente los nodos Web Audio / HTMLAudioElement de un deck,
   * y opcionalmente libera el AudioBuffer u ObjectURL de la RAM.
   */
  private cleanupDeckNodes(deck: DeckRuntime, releaseBuffer: boolean): void {
    if (deck.source) {
      deck.source.onended = null;
      try {
        deck.source.stop();
      } catch {
        // El nodo ya pudo haber terminado naturalmente
      }
      try {
        deck.source.disconnect();
      } catch {
        // Ignorar si ya estaba desconectado
      }
      deck.source.buffer = null;
      deck.source = null;
    }

    if (deck.audioEl) {
      try {
        deck.audioEl.pause();
      } catch {
        // Ignorar
      }
      if (releaseBuffer) {
        deck.audioEl.onended = null;
        try {
          deck.audioEl.removeAttribute('src');
          deck.audioEl.load();
        } catch {
          // Ignorar
        }
        if (deck.elSourceNode) {
          try {
            deck.elSourceNode.disconnect();
          } catch {
            // Ignorar
          }
          deck.elSourceNode = null;
        }
        deck.audioEl = null;
        deck.elDuration = 0;
      }
    }

    if (deck.gainNode) {
      try {
        deck.gainNode.gain.cancelScheduledValues(0);
        deck.gainNode.disconnect();
      } catch {
        // Ignorar
      }
      deck.gainNode = null;
    }

    if (releaseBuffer) {
      if (deck.objectUrl) {
        URL.revokeObjectURL(deck.objectUrl);
        deck.objectUrl = null;
      }
      deck.buffer = null;
      deck.trackId = null;
      deck.state = 'empty';
      deck.pausedOffset = 0;
      deck.offsetAtStart = 0;
      deck.currentGain = 0;
    }
  }

  private async probeAudioElementBlob(
    blob: Blob,
    track: Track,
    failureReason: string
  ): Promise<{ audioEl: HTMLAudioElement; objectUrl: string; duration: number }> {
    const objectUrl = URL.createObjectURL(blob);
    const audioEl = new Audio();
    audioEl.preload = 'auto';
    audioEl.setAttribute('playsinline', 'true');

    const duration = await new Promise<number>((resolve, reject) => {
      const cleanupEvents = () => {
        audioEl.onloadedmetadata = null;
        audioEl.onerror = null;
      };
      const timer = window.setTimeout(() => {
        cleanupEvents();
        if (Number.isFinite(audioEl.duration) && audioEl.duration > 0) {
          resolve(audioEl.duration);
        } else if (track.duration > 0) {
          resolve(track.duration);
        } else {
          reject(new Error(`Formato no compatible con este navegador (${track.fileName}).`));
        }
      }, 6000);

      audioEl.onloadedmetadata = () => {
        window.clearTimeout(timer);
        cleanupEvents();
        resolve(Number.isFinite(audioEl.duration) ? audioEl.duration : track.duration || 0);
      };

      audioEl.onerror = () => {
        window.clearTimeout(timer);
        cleanupEvents();
        reject(new Error(failureReason));
      };

      audioEl.src = objectUrl;
      audioEl.load();
    }).catch((err) => {
      URL.revokeObjectURL(objectUrl);
      throw err;
    });

    return { audioEl, objectUrl, duration };
  }

  private async loadFallbackAudioElement(
    track: Track
  ): Promise<
    | { kind: 'buffer'; buffer: AudioBuffer }
    | { kind: 'element'; audioEl: HTMLAudioElement; objectUrl: string; duration: number }
  > {
    const mime = inferAudioMimeType(track.fileName, track.mimeType);
    const cachedBlob = this.memoryBlobs.get(track.id);
    const rawBlob = cachedBlob ?? (await readAudioBlob(track.opfsKey, mime));
    const headBytes = new Uint8Array(await rawBlob.slice(0, 32 * 1024).arrayBuffer());
    const info = inspectAudioContainer(headBytes);
    const reason = describeUnsupportedAudioReason(track.fileName, headBytes, mime);

    if (info.encrypted || info.kind === 'invalid-text') {
      throw new Error(reason);
    }

    const typedBlob =
      info.mimeType && rawBlob.type !== info.mimeType
        ? new Blob([rawBlob], { type: info.mimeType })
        : rawBlob;

    try {
      const elMedia = await this.probeAudioElementBlob(typedBlob, track, reason);
      return { kind: 'element', ...elMedia };
    } catch (primaryErr) {
      // Último recurso para fMP4 AAC sin cifrar: extraer tramas AAC con cabecera ADTS
      if (info.fragmentedMp4 && info.codec === 'aac') {
        const fullBytes = new Uint8Array(await rawBlob.arrayBuffer());
        const adtsBytes = extractAdtsFromFragmentedMp4(fullBytes);
        if (adtsBytes) {
          try {
            const ctx = this.ensureAudioContext();
            const decoded = await ctx.decodeAudioData(adtsBytes.buffer.slice(0) as ArrayBuffer);
            return { kind: 'buffer', buffer: decoded };
          } catch {
            // Intentar como elemento <audio type="audio/aac">
          }
          const adtsBlob = new Blob([adtsBytes.buffer.slice(0) as ArrayBuffer], {
            type: 'audio/aac',
          });
          const adtsEl = await this.probeAudioElementBlob(adtsBlob, track, reason);
          return { kind: 'element', ...adtsEl };
        }
      }
      throw primaryErr;
    }
  }

  registerMemoryBlob(trackId: string, blob: Blob): void {
    this.memoryBlobs.delete(trackId);
    this.memoryBlobs.set(trackId, blob);
    while (this.memoryBlobs.size > 4) {
      const oldestKey = this.memoryBlobs.keys().next().value;
      if (!oldestKey) break;
      if (this.decks.A.trackId === oldestKey || this.decks.B.trackId === oldestKey) {
        // Mover al final para no desalojar el audio actualmente cargado
        const val = this.memoryBlobs.get(oldestKey)!;
        this.memoryBlobs.delete(oldestKey);
        this.memoryBlobs.set(oldestKey, val);
        if (this.memoryBlobs.size <= 4) break;
        const secondKey = Array.from(this.memoryBlobs.keys()).find(
          (k) => k !== this.decks.A.trackId && k !== this.decks.B.trackId
        );
        if (!secondKey) break;
        this.memoryBlobs.delete(secondKey);
      } else {
        this.memoryBlobs.delete(oldestKey);
      }
    }
  }

  getMemoryBlob(trackId: string): Blob | null {
    return this.memoryBlobs.get(trackId) ?? null;
  }

  /**
   * Prepara la pista bajo demanda; para archivos medianos/grandes (>1.5 MB) inicia directo con
   * HTMLAudioElement streaming (~20-40ms, cero decodificación PCM bloqueante) con respaldo decodeAudioData.
   */
  private async prepareDeckMedia(
    trackId: string
  ): Promise<
    | { kind: 'buffer'; buffer: AudioBuffer }
    | { kind: 'element'; audioEl: HTMLAudioElement; objectUrl: string; duration: number }
  > {
    const track = this.tracksById.get(trackId);
    if (!track) {
      throw new Error('La canción ya no existe en la biblioteca.');
    }

    const memBlob = this.memoryBlobs.get(trackId);
    const estSize = memBlob?.size ?? track.sizeBytes ?? 0;

    // Pistas completas (>1.5 MB): arranque casi instantáneo con HTMLAudioElement + MediaElementSource
    if (estSize > 1_500_000) {
      try {
        return await this.loadFallbackAudioElement(track);
      } catch (elErr) {
        const msg = elErr instanceof Error ? elErr.message : '';
        if (msg.includes('DRM/cifrado') || msg.includes('respuesta inválida')) {
          throw elErr;
        }
        const ctx = this.ensureAudioContext();
        const arrayBuffer = memBlob ? await memBlob.arrayBuffer() : await readAudioArrayBuffer(track.opfsKey);
        const buffer = await ctx.decodeAudioData(arrayBuffer);
        return { kind: 'buffer', buffer };
      }
    }

    const ctx = this.ensureAudioContext();
    try {
      const arrayBuffer = memBlob ? await memBlob.arrayBuffer() : await readAudioArrayBuffer(track.opfsKey);
      const buffer = await ctx.decodeAudioData(arrayBuffer);
      return { kind: 'buffer', buffer };
    } catch {
      return await this.loadFallbackAudioElement(track);
    }
  }

  /**
   * Inicia la reproducción física de un AudioBuffer o HTMLAudioElement ya cargado en `deck`.
   */
  private startDeckSource(
    deck: DeckRuntime,
    offsetSeconds: number,
    initialGain: number
  ): void {
    const ctx = this.ensureAudioContext();
    if (!this.hasDeckMedia(deck) || !this.masterGain) return;

    this.cleanupDeckNodes(deck, false);

    const dur = this.getDeckDuration(deck);
    const safeOffset = Math.min(Math.max(0, offsetSeconds), Math.max(0, dur - 0.05));
    const playingDeckId = deck.id;
    const playingTrackId = deck.trackId;

    if (deck.audioEl) {
      const audioEl = deck.audioEl;
      try {
        if (!deck.elSourceNode) {
          deck.elSourceNode = ctx.createMediaElementSource(audioEl);
        }
        const gainNode = ctx.createGain();
        gainNode.gain.setValueAtTime(initialGain, ctx.currentTime);
        deck.elSourceNode.connect(gainNode);
        gainNode.connect(this.masterGain);
        deck.gainNode = gainNode;
        audioEl.volume = 1;
      } catch {
        audioEl.volume = this.masterVolume * initialGain;
      }

      audioEl.onended = () => {
        if (deck.audioEl !== audioEl) return;
        if (this.status !== 'playing') return;
        if (this.activeDeckId !== playingDeckId) {
          this.cleanupDeckNodes(deck, true);
          this.emit();
          return;
        }
        if (!this.crossfading) {
          void this.handleNaturalTrackEnd(playingTrackId);
        }
      };

      if (Math.abs((audioEl.currentTime || 0) - safeOffset) > 0.25) {
        try {
          audioEl.currentTime = safeOffset;
        } catch {
          // Ignorar si aún está buffering
        }
      }
      deck.startedAtCtxTime = ctx.currentTime;
      deck.offsetAtStart = safeOffset;
      deck.pausedOffset = safeOffset;
      deck.currentGain = initialGain;
      deck.state = 'playing';
      void audioEl.play().catch((err) => {
        this.lastError = err instanceof Error ? err.message : 'Error al iniciar audio.';
        this.emit();
      });
      return;
    }

    if (!deck.buffer) return;
    const source = ctx.createBufferSource();
    source.buffer = deck.buffer;

    const gainNode = ctx.createGain();
    gainNode.gain.setValueAtTime(initialGain, ctx.currentTime);

    source.connect(gainNode);
    gainNode.connect(this.masterGain);

    deck.source = source;
    deck.gainNode = gainNode;
    deck.startedAtCtxTime = ctx.currentTime;
    deck.offsetAtStart = safeOffset;
    deck.pausedOffset = safeOffset;
    deck.currentGain = initialGain;
    deck.state = 'playing';

    source.onended = () => {
      if (deck.source !== source) return;
      if (this.status !== 'playing') return;
      if (this.activeDeckId !== playingDeckId) {
        this.cleanupDeckNodes(deck, true);
        this.emit();
        return;
      }
      if (!this.crossfading) {
        void this.handleNaturalTrackEnd(playingTrackId);
      }
    };

    source.start(0, safeOffset);
  }

  private async handleNaturalTrackEnd(endedTrackId: string | null): Promise<void> {
    const currentDeck = this.decks[this.activeDeckId];
    this.cleanupDeckNodes(currentDeck, true);

    const nextId = this.queue.advanceNext(false);
    if (!nextId) {
      this.status = 'idle';
      this.stopScheduler();
      this.emit();
      return;
    }

    // Si repeat === 'one' o el usuario solo tiene 1 pista en loop, reproducimos desde 0
    if (nextId === endedTrackId && this.decks[this.getStandbyDeckId()].trackId !== nextId) {
      await this.playTrack(nextId, { crossfade: false, pushHistory: false });
      return;
    }

    await this.playTrack(nextId, { crossfade: false, pushHistory: false });
  }

  /**
   * Sincroniza la biblioteca y la lista de reproducción activa desde Svelte.
   */
  syncLibrary(tracks: Track[], playlistTrackIds: string[]): void {
    this.tracksById = new Map(tracks.map((t) => [t.id, t]));
    const validKnownIds = new Set(this.tracksById.keys());
    this.queue.setPlaylistOrder(playlistTrackIds, validKnownIds);

    // Si la pista siguiente pre-cargada ya no coincide con el nuevo orden, la liberamos
    const standby = this.decks[this.getStandbyDeckId()];
    const expectedNext = this.queue.peekNextTrackId(false);
    if (!this.crossfading && this.hasDeckMedia(standby) && standby.trackId !== expectedNext) {
      this.cleanupDeckNodes(standby, true);
    }

    // Si la pista activa fue eliminada de la lista, detenemos limpiamente
    const active = this.decks[this.activeDeckId];
    if (active.trackId && !this.tracksById.has(active.trackId)) {
      this.stopAndClearAll();
    } else {
      this.emit();
    }
  }

  /**
   * Añade una canción a la cola para que se reproduzca inmediatamente después de la actual.
   * Si no hay ninguna canción cargada, la reproduce al instante.
   */
  async enqueueNext(trackId: string): Promise<'played' | 'queued' | 'missing'> {
    if (!this.tracksById.has(trackId)) return 'missing';

    const active = this.decks[this.activeDeckId];
    if (!active.trackId && !this.queue.getCurrentId()) {
      await this.playTrack(trackId, { crossfade: false });
      return 'played';
    }

    this.queue.enqueueNext(trackId);
    const standby = this.decks[this.getStandbyDeckId()];
    const expectedNext = this.queue.peekNextTrackId(false);
    if (!this.crossfading && expectedNext && standby.trackId !== expectedNext) {
      this.cleanupDeckNodes(standby, true);
      if (this.status === 'playing') {
        void this.ensureStandbyPreloaded();
      }
    }
    this.emit();
    return 'queued';
  }

  setCrossfadeSeconds(seconds: number): void {
    this.crossfadeSeconds = Math.min(15, Math.max(2, Math.round(seconds)));
    this.emit();
  }

  setAutoDjEnabled(enabled: boolean): void {
    this.autoDjEnabled = enabled;
    this.emit();
  }

  setShuffle(enabled: boolean): void {
    this.shuffle = enabled;
    this.queue.setShuffle(enabled);

    const standby = this.decks[this.getStandbyDeckId()];
    const expectedNext = this.queue.peekNextTrackId(false);
    if (!this.crossfading && standby.trackId !== expectedNext) {
      this.cleanupDeckNodes(standby, true);
    }

    this.emit();
  }

  setRepeatMode(mode: RepeatMode): void {
    this.repeatMode = mode;
    this.queue.setRepeatMode(mode);

    const standby = this.decks[this.getStandbyDeckId()];
    const expectedNext = this.queue.peekNextTrackId(false);
    if (!this.crossfading && standby.trackId !== expectedNext) {
      this.cleanupDeckNodes(standby, true);
    }

    this.emit();
  }

  setMasterVolume(volume: number): void {
    this.masterVolume = Math.min(1, Math.max(0, volume));
    if (this.ctx && this.masterGain) {
      this.masterGain.gain.setTargetAtTime(this.masterVolume, this.ctx.currentTime, 0.02);
    }
    this.emit();
  }

  /**
   * Reproduce una pista específica (al tocarla en la playlist o saltar a ella).
   * Mantiene la regla estricta de máximo 2 búferes en RAM.
   */
  async playTrack(
    trackId: string,
    options: {
      crossfade?: boolean;
      crossfadeDuration?: number;
      pushHistory?: boolean;
      playlistIndex?: number;
    } = {}
  ): Promise<void> {
    await this.unlock();
    this.lastError = null;

    const myToken = ++this.decodeSequence;
    const activeDeck = this.decks[this.activeDeckId];
    const standbyId = this.getStandbyDeckId();
    const standbyDeck = this.decks[standbyId];

    // Cancelar cualquier crossfade previo en curso
    this.cancelCrossfadeCleanupTimer();
    if (this.crossfading && this.crossfadeOutgoingDeck) {
      this.cleanupDeckNodes(this.decks[this.crossfadeOutgoingDeck], true);
      this.crossfading = false;
      this.crossfadeOutgoingDeck = null;
    }

    this.queue.setCurrentTrack(trackId, options.pushHistory ?? true, options.playlistIndex);

    const wantCrossfade =
      Boolean(options.crossfade) &&
      this.status === 'playing' &&
      this.hasDeckMedia(activeDeck) &&
      activeDeck.state === 'playing';

    if (wantCrossfade) {
      // Caso 1: La pista solicitada ya estaba lista en standbyDeck (instantáneo!)
      if (standbyDeck.trackId === trackId && this.hasDeckMedia(standbyDeck)) {
        this.beginCrossfade(
          this.activeDeckId,
          standbyId,
          options.crossfadeDuration ?? this.crossfadeSeconds
        );
        return;
      }

      // Caso 2: Necesitamos decodificar en standbyDeck (liberando antes cualquier otro media en standby)
      this.cleanupDeckNodes(standbyDeck, true);
      if (activeDeck.trackId === trackId && activeDeck.buffer) {
        standbyDeck.trackId = trackId;
        standbyDeck.buffer = activeDeck.buffer;
        standbyDeck.state = 'ready';
      } else {
        standbyDeck.trackId = trackId;
        standbyDeck.state = 'preloading';
        this.emit();
        try {
          const media = await this.prepareDeckMedia(trackId);
          if (myToken !== this.decodeSequence) {
            if (media.kind === 'element') URL.revokeObjectURL(media.objectUrl);
            return;
          }
          standbyDeck.trackId = trackId;
          if (media.kind === 'buffer') {
            standbyDeck.buffer = media.buffer;
          } else {
            standbyDeck.audioEl = media.audioEl;
            standbyDeck.objectUrl = media.objectUrl;
            standbyDeck.elDuration = media.duration;
          }
          standbyDeck.state = 'ready';
        } catch (err) {
          if (myToken !== this.decodeSequence) return;
          this.cleanupDeckNodes(standbyDeck, true);
          this.lastError = err instanceof Error ? err.message : 'Error al decodificar audio.';
          this.emit();
          return;
        }
      }

      // Verificamos que activeDeck siga reproduciendo mientras decodificábamos
      if (this.status === 'playing' && this.hasDeckMedia(activeDeck) && activeDeck.state === 'playing') {
        this.beginCrossfade(
          this.activeDeckId,
          standbyId,
          options.crossfadeDuration ?? this.crossfadeSeconds
        );
        return;
      }
    }

    // Reproducción directa sin crossfade (o desde pausa/idle)
    // Si ya la teníamos decodificada en standby, intercambiamos decks y limpiamos el anterior
    if (standbyDeck.trackId === trackId && this.hasDeckMedia(standbyDeck)) {
      this.cleanupDeckNodes(activeDeck, true);
      this.activeDeckId = standbyId;
      this.startDeckSource(standbyDeck, 0, 1);
      this.status = 'playing';
      this.startScheduler();
      this.onTrackPlayCallback?.(trackId);
      this.emit();
      return;
    }

    // Si es la misma pista que ya está en activeDeck, reiniciamos desde 0 sin re-decodificar
    if (activeDeck.trackId === trackId && this.hasDeckMedia(activeDeck)) {
      this.cleanupDeckNodes(standbyDeck, true);
      this.startDeckSource(activeDeck, 0, 1);
      this.status = 'playing';
      this.startScheduler();
      this.onTrackPlayCallback?.(trackId);
      this.emit();
      return;
    }

    // Liberamos el standby primero para respetar estrictamente máximo 2 búferes en RAM
    this.cleanupDeckNodes(standbyDeck, true);
    this.cleanupDeckNodes(activeDeck, true);

    this.status = 'loading';
    activeDeck.trackId = trackId;
    activeDeck.state = 'preloading';
    this.emit();

    try {
      const media = await this.prepareDeckMedia(trackId);
      if (myToken !== this.decodeSequence) {
        if (media.kind === 'element') URL.revokeObjectURL(media.objectUrl);
        return;
      }

      if (media.kind === 'buffer') {
        activeDeck.buffer = media.buffer;
      } else {
        activeDeck.audioEl = media.audioEl;
        activeDeck.objectUrl = media.objectUrl;
        activeDeck.elDuration = media.duration;
      }
      this.startDeckSource(activeDeck, 0, 1);
      this.status = 'playing';
      this.startScheduler();
      this.onTrackPlayCallback?.(trackId);
      this.emit();
    } catch (err) {
      if (myToken !== this.decodeSequence) return;
      this.cleanupDeckNodes(activeDeck, true);
      this.status = 'idle';
      this.lastError = err instanceof Error ? err.message : 'Error al reproducir pista.';
      this.emit();
    }
  }

  /**
   * Inicia o reanuda la reproducción. Si no hay pista cargada, arranca la primera de la cola.
   */
  async play(): Promise<void> {
    await this.unlock();
    const active = this.decks[this.activeDeckId];

    if (this.status === 'playing' && active.state === 'playing') {
      return;
    }

    if (this.status === 'paused' && this.hasDeckMedia(active) && active.trackId) {
      this.startDeckSource(active, active.pausedOffset, 1);
      this.status = 'playing';
      this.startScheduler();
      this.emit();
      return;
    }

    const targetId = this.queue.getCurrentId() ?? this.queue.advanceNext(false);
    if (targetId) {
      await this.playTrack(targetId, { crossfade: false, pushHistory: false });
    }
  }

  /**
   * Pausa la reproducción preservando la posición exacta y el búfer actual en RAM.
   */
  pause(): void {
    if (this.status !== 'playing') return;

    this.cancelCrossfadeCleanupTimer();

    // Si estaba a mitad de un crossfade, asentamos limpiamente en el deck entrante (activeDeckId)
    if (this.crossfading && this.crossfadeOutgoingDeck) {
      this.cleanupDeckNodes(this.decks[this.crossfadeOutgoingDeck], true);
      this.crossfading = false;
      this.crossfadeOutgoingDeck = null;
    }

    const active = this.decks[this.activeDeckId];
    const elapsed = this.getDeckElapsed(active);
    this.cleanupDeckNodes(active, false);
    active.pausedOffset = elapsed;
    active.currentGain = 1;
    active.state = this.hasDeckMedia(active) ? 'paused' : 'empty';

    this.status = 'paused';
    this.stopScheduler();
    this.emit();
  }

  async togglePlayPause(): Promise<void> {
    if (this.status === 'playing') {
      this.pause();
    } else {
      await this.play();
    }
  }

  /**
   * Salta a la siguiente canción (con un fade suave corto de 0.7s si está sonando, o directo si está en pausa).
   */
  async skipNext(): Promise<void> {
    if (this.transitionLocked) return;
    this.transitionLocked = true;
    try {
      const nextId = this.queue.advanceNext(true);
      if (!nextId) return;

      const shouldQuickFade =
        this.status === 'playing' &&
        this.hasDeckMedia(this.decks[this.activeDeckId]) &&
        !this.crossfading;

      await this.playTrack(nextId, {
        crossfade: shouldQuickFade,
        crossfadeDuration: 0.75,
        pushHistory: false,
      });
    } finally {
      this.transitionLocked = false;
    }
  }

  /**
   * Dispara manualmente el crossfade Equal-Power completo (de 2s a 15s) hacia la siguiente pista ahora mismo.
   */
  async triggerManualCrossfade(): Promise<void> {
    if (this.crossfading || this.transitionLocked) return;
    this.transitionLocked = true;
    try {
      const nextId = this.queue.advanceNext(true);
      if (!nextId) return;

      await this.playTrack(nextId, {
        crossfade: true,
        crossfadeDuration: this.crossfadeSeconds,
        pushHistory: false,
      });
    } finally {
      this.transitionLocked = false;
    }
  }

  /**
   * Retrocede: si la canción lleva > 3s, la reinicia al inicio; si no, vuelve a la canción anterior del historial.
   */
  async previous(): Promise<void> {
    if (this.transitionLocked) return;
    this.transitionLocked = true;
    try {
      const active = this.decks[this.activeDeckId];
      const elapsed = this.getDeckElapsed(active);

      if (this.hasDeckMedia(active) && elapsed > 3) {
        await this.seekTo(0);
        return;
      }

      const prevId = this.queue.stepPrevious();
      if (!prevId) return;

      await this.playTrack(prevId, { crossfade: false, pushHistory: false });
    } finally {
      this.transitionLocked = false;
    }
  }

  /**
   * Permite adelantar o retroceder dentro de la canción actual.
   */
  async seekTo(seconds: number): Promise<void> {
    const active = this.decks[this.activeDeckId];
    if (!this.hasDeckMedia(active)) return;

    const target = Math.min(Math.max(0, seconds), Math.max(0, this.getDeckDuration(active) - 0.1));

    // Si estaba en crossfade, lo cancelamos limpiamente
    if (this.crossfading && this.crossfadeOutgoingDeck) {
      this.cancelCrossfadeCleanupTimer();
      this.cleanupDeckNodes(this.decks[this.crossfadeOutgoingDeck], true);
      this.crossfading = false;
      this.crossfadeOutgoingDeck = null;
    }

    if (this.status === 'playing') {
      this.startDeckSource(active, target, 1);
      this.emit();
    } else {
      active.pausedOffset = target;
      this.emit();
    }
  }

  /**
   * Ejecuta la curva Equal-Power Crossfade entre outgoingId -> incomingId
   * y programa la limpieza crítica de memoria al finalizar.
   */
  private beginCrossfade(outgoingId: DeckId, incomingId: DeckId, requestedDuration: number): void {
    const ctx = this.ensureAudioContext();
    const outgoing = this.decks[outgoingId];
    const incoming = this.decks[incomingId];

    if (!this.hasDeckMedia(outgoing) || !this.hasDeckMedia(incoming)) {
      return;
    }

    const outDuration = this.getDeckDuration(outgoing);
    const inDuration = this.getDeckDuration(incoming) || requestedDuration * 3;
    const outRemaining = Math.max(0.2, outDuration - this.getDeckElapsed(outgoing));
    const maxAllowed = Math.min(outRemaining, inDuration * 0.45);
    const duration = Math.max(0.25, Math.min(requestedDuration, maxAllowed));

    // Arrancamos el canal entrante con ganancia 0
    this.startDeckSource(incoming, 0, 0);

    const now = ctx.currentTime;

    // Curva Equal-Power (coseno saliente, seno entrante) para evitar caídas de volumen
    if (outgoing.gainNode) {
      outgoing.gainNode.gain.cancelScheduledValues(now);
      outgoing.gainNode.gain.setValueAtTime(outgoing.currentGain || 1, now);
      outgoing.gainNode.gain.setValueCurveAtTime(EQUAL_POWER_OUT, now, duration);
    }
    outgoing.state = 'fading-out';

    if (incoming.gainNode) {
      incoming.gainNode.gain.cancelScheduledValues(now);
      incoming.gainNode.gain.setValueAtTime(0, now);
      incoming.gainNode.gain.setValueCurveAtTime(EQUAL_POWER_IN, now, duration);
    }

    this.activeDeckId = incomingId;
    this.crossfading = true;
    this.crossfadeStartCtxTime = now;
    this.crossfadeDurationActive = duration;
    this.crossfadeOutgoingDeck = outgoingId;
    this.status = 'playing';

    if (incoming.trackId) {
      this.onTrackPlayCallback?.(incoming.trackId);
    }

    this.cancelCrossfadeCleanupTimer();
    this.crossfadeTimerId = window.setTimeout(() => {
      this.finishCrossfadeCleanup(outgoingId);
    }, Math.ceil(duration * 1000) + 80);

    this.startScheduler();
    this.emit();
  }

  private cancelCrossfadeCleanupTimer(): void {
    if (this.crossfadeTimerId !== null) {
      window.clearTimeout(this.crossfadeTimerId);
      this.crossfadeTimerId = null;
    }
  }

  private finishCrossfadeCleanup(outgoingId: DeckId): void {
    this.crossfadeTimerId = null;
    const outgoing = this.decks[outgoingId];
    this.cleanupDeckNodes(outgoing, true);

    const incoming = this.decks[this.activeDeckId];
    incoming.currentGain = 1;
    if (incoming.gainNode && this.ctx) {
      try {
        incoming.gainNode.gain.cancelScheduledValues(this.ctx.currentTime);
        incoming.gainNode.gain.setValueAtTime(1, this.ctx.currentTime);
      } catch {
        // Ignorar
      }
    }

    this.crossfading = false;
    this.crossfadeOutgoingDeck = null;
    this.crossfadeDurationActive = 0;
    this.emit();
  }

  /**
   * Planificador cada 250ms (estable en segundo plano) para:
   * - Pre-cargar la pista siguiente en el deck libre ~25s antes de terminar
   * - Disparar el crossfade automático al llegar al punto de mezcla
   */
  private startScheduler(): void {
    if (this.schedulerId !== null) return;
    this.schedulerId = window.setInterval(() => {
      this.tick();
    }, 250);
  }

  private stopScheduler(): void {
    if (this.schedulerId !== null) {
      window.clearInterval(this.schedulerId);
      this.schedulerId = null;
    }
  }

  private tick(): void {
    if (this.status !== 'playing') return;

    const active = this.decks[this.activeDeckId];
    if (!this.hasDeckMedia(active)) return;

    const duration = this.getDeckDuration(active);
    const elapsed = this.getDeckElapsed(active);
    const remaining = Math.max(0, duration - elapsed);

    if (this.crossfading && this.ctx) {
      const cfElapsed = this.ctx.currentTime - this.crossfadeStartCtxTime;
      const t = Math.min(1, Math.max(0, cfElapsed / Math.max(0.1, this.crossfadeDurationActive)));
      active.currentGain = Math.sin(t * Math.PI * 0.5);
      if (!active.gainNode && active.audioEl) {
        active.audioEl.volume = this.masterVolume * active.currentGain;
      }
      if (this.crossfadeOutgoingDeck) {
        const outgoingDeck = this.decks[this.crossfadeOutgoingDeck];
        outgoingDeck.currentGain = Math.cos(t * Math.PI * 0.5);
        if (!outgoingDeck.gainNode && outgoingDeck.audioEl) {
          outgoingDeck.audioEl.volume = this.masterVolume * outgoingDeck.currentGain;
        }
      }
    } else {
      active.currentGain = 1;
    }

    // 1. Pre-carga bajo demanda de la siguiente canción en el deck libre
    if (!this.crossfading && this.autoDjEnabled) {
      const preloadThreshold = Math.max(this.crossfadeSeconds + 15, 25);
      if (remaining <= preloadThreshold || (duration > 0 && duration <= 30)) {
        void this.ensureStandbyPreloaded();
      }

      // 2. Disparo automático del crossfade Equal-Power
      const effectiveCrossfade = duration > 0 ? Math.min(this.crossfadeSeconds, duration * 0.4) : 0;
      const standby = this.decks[this.getStandbyDeckId()];
      if (
        duration > 0 &&
        remaining <= effectiveCrossfade &&
        remaining > 0.15 &&
        this.hasDeckMedia(standby) &&
        standby.state === 'ready'
      ) {
        const nextId = this.queue.advanceNext(false);
        if (nextId && standby.trackId === nextId) {
          this.beginCrossfade(this.activeDeckId, standby.id, effectiveCrossfade);
          return;
        }
      }
    }

    this.emit();
  }

  private async ensureStandbyPreloaded(): Promise<void> {
    const standbyId = this.getStandbyDeckId();
    const standby = this.decks[standbyId];
    const nextId = this.queue.peekNextTrackId(false);

    if (!nextId) return;
    if (standby.trackId === nextId && (this.hasDeckMedia(standby) || standby.state === 'preloading')) {
      return;
    }

    // Si es repeat === 'one' sobre la misma pista, reutilizamos la referencia del buffer activo
    const active = this.decks[this.activeDeckId];
    if (active.trackId === nextId && active.buffer) {
      this.cleanupDeckNodes(standby, true);
      standby.trackId = nextId;
      standby.buffer = active.buffer;
      standby.state = 'ready';
      this.emit();
      return;
    }

    this.cleanupDeckNodes(standby, true);
    const token = ++standby.preloadingToken;
    standby.trackId = nextId;
    standby.state = 'preloading';
    this.emit();

    try {
      const media = await this.prepareDeckMedia(nextId);
      if (standby.preloadingToken !== token || standby.trackId !== nextId) {
        if (media.kind === 'element') URL.revokeObjectURL(media.objectUrl);
        return;
      }
      if (media.kind === 'buffer') {
        standby.buffer = media.buffer;
      } else {
        standby.audioEl = media.audioEl;
        standby.objectUrl = media.objectUrl;
        standby.elDuration = media.duration;
      }
      standby.state = 'ready';
      this.emit();
    } catch {
      if (standby.preloadingToken === token) {
        this.cleanupDeckNodes(standby, true);
        this.emit();
      }
    }
  }

  stopAndClearAll(): void {
    this.decodeSequence++;
    this.cancelCrossfadeCleanupTimer();
    this.stopScheduler();
    this.crossfading = false;
    this.crossfadeOutgoingDeck = null;
    this.cleanupDeckNodes(this.decks.A, true);
    this.cleanupDeckNodes(this.decks.B, true);
    this.queue.setCurrentTrack(null, false);
    this.status = 'idle';
    this.emit();
  }

  dispose(): void {
    this.stopAndClearAll();
    if (this.masterGain) {
      try {
        this.masterGain.disconnect();
      } catch {
        // Ignorar
      }
    }
    if (this.compressor) {
      try {
        this.compressor.disconnect();
      } catch {
        // Ignorar
      }
    }
    if (this.anchorAudio) {
      this.anchorAudio.pause();
      this.anchorAudio.src = '';
      this.anchorAudio = null;
    }
    if (this.anchorUrl) {
      URL.revokeObjectURL(this.anchorUrl);
      this.anchorUrl = null;
    }
    void closePlaybackNotification();
    if (this.ctx && this.ctx.state !== 'closed') {
      void this.ctx.close();
    }
    this.ctx = null;
  }

  private buildDeckSnapshot(deck: DeckRuntime): DeckSnapshot {
    const track = deck.trackId ? this.tracksById.get(deck.trackId) : undefined;
    return {
      id: deck.id,
      trackId: deck.trackId,
      title: track?.title ?? (deck.trackId ? 'Cargando...' : 'Libre'),
      artist: track?.artist ?? '',
      bpm: track?.bpm ?? null,
      duration: this.getDeckDuration(deck) || track?.duration || 0,
      elapsed: this.getDeckElapsed(deck),
      gain: deck.currentGain,
      state: deck.state,
      hasBufferInRam: this.hasDeckMedia(deck),
    };
  }

  getSnapshot(): AudioEngineSnapshot {
    const active = this.decks[this.activeDeckId];
    const deckA = this.buildDeckSnapshot(this.decks.A);
    const deckB = this.buildDeckSnapshot(this.decks.B);
    const duration =
      this.getDeckDuration(active) ||
      (active.trackId ? this.tracksById.get(active.trackId)?.duration ?? 0 : 0);
    const elapsed = this.getDeckElapsed(active);

    let crossfadeProgress = 0;
    if (this.crossfading && this.ctx && this.crossfadeDurationActive > 0) {
      crossfadeProgress = Math.min(
        1,
        Math.max(0, (this.ctx.currentTime - this.crossfadeStartCtxTime) / this.crossfadeDurationActive)
      );
    }

    // Contar búferes únicos en RAM (máximo 2 siempre) y sus bytes PCM (Float32 = 4 bytes)
    const uniqueBuffers = new Set<AudioBuffer>();
    if (this.decks.A.buffer) uniqueBuffers.add(this.decks.A.buffer);
    if (this.decks.B.buffer) uniqueBuffers.add(this.decks.B.buffer);
    let ramBufferBytes = 0;
    for (const buf of uniqueBuffers) {
      ramBufferBytes += buf.length * buf.numberOfChannels * 4;
    }

    return {
      status: this.status,
      activeDeck: this.activeDeckId,
      deckA,
      deckB,
      currentTrackId: active.trackId,
      nextTrackId: this.queue.peekNextTrackId(false),
      upNextTrackIds: this.queue.getUpNextIds(),
      elapsed,
      duration,
      crossfading: this.crossfading,
      crossfadeProgress,
      crossfadeSeconds: this.crossfadeSeconds,
      autoDjEnabled: this.autoDjEnabled,
      shuffle: this.shuffle,
      repeatMode: this.repeatMode,
      masterVolume: this.masterVolume,
      ramBuffersCount: uniqueBuffers.size,
      ramBufferBytes,
      audioContextState: this.ctx ? this.ctx.state : 'uninitialized',
      unlocked: this.unlocked,
      lastError: this.lastError,
    };
  }
}
