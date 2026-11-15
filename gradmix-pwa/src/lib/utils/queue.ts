import type { RepeatMode, SortOrder, Track } from '../types';

/**
 * Baraja un arreglo con Fisher-Yates evitando, si es posible,
 * que el primer elemento coincida con `avoidFirst`.
 */
export function shuffleItems<T>(items: T[], avoidFirst?: T | null): T[] {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  if (avoidFirst !== undefined && avoidFirst !== null && arr.length > 1 && arr[0] === avoidFirst) {
    const swapIdx = 1 + Math.floor(Math.random() * (arr.length - 1));
    [arr[0], arr[swapIdx]] = [arr[swapIdx], arr[0]];
  }
  return arr;
}

/**
 * Ordena una lista de IDs de canciones según el criterio elegido.
 */
export function sortTrackIds(
  trackIds: string[],
  tracksById: Map<string, Track>,
  order: SortOrder
): string[] {
  if (order === 'manual') return [...trackIds];

  return [...trackIds].sort((aId, bId) => {
    const a = tracksById.get(aId);
    const b = tracksById.get(bId);
    if (!a || !b) return 0;

    switch (order) {
      case 'bpm-asc': {
        const bpmA = a.bpm ?? Number.MAX_SAFE_INTEGER;
        const bpmB = b.bpm ?? Number.MAX_SAFE_INTEGER;
        if (bpmA !== bpmB) return bpmA - bpmB;
        return a.title.localeCompare(b.title);
      }
      case 'bpm-desc': {
        const bpmA = a.bpm ?? -1;
        const bpmB = b.bpm ?? -1;
        if (bpmA !== bpmB) return bpmB - bpmA;
        return a.title.localeCompare(b.title);
      }
      case 'title-asc':
        return a.title.localeCompare(b.title);
      case 'recent':
        return b.addedAt - a.addedAt;
      default:
        return 0;
    }
  });
}

interface HistoryEntry {
  id: string;
  pos: number;
}

/**
 * Gestor de cola de reproducción con soporte para:
 * - Orden secuencial (incluso si una canción aparece repetida varias veces en la playlist)
 * - Modo aleatorio (Shuffle) sin repetir prematuramente hasta completar ciclo
 * - Repetición: 'off' | 'all' | 'one'
 * - Historial real para retroceder con "Anterior" incluso en aleatorio
 */
export class PlaybackQueue {
  private order: string[] = [];
  private shuffledOrder: string[] = [];
  private upNextQueue: string[] = [];
  private history: HistoryEntry[] = [];
  private currentId: string | null = null;
  private currentPos = -1;
  private resumePlaylistPos = -1;
  private shuffle = false;
  private repeatMode: RepeatMode = 'all';

  setPlaylistOrder(trackIds: string[], validKnownIds?: Set<string>): void {
    this.order = [...trackIds];
    const validSet = new Set(this.order);
    const retainSet = validKnownIds ?? validSet;
    this.history = this.history.filter((h) => retainSet.has(h.id));
    this.upNextQueue = this.upNextQueue.filter((id) => retainSet.has(id));
    if (this.resumePlaylistPos >= this.order.length) {
      this.resumePlaylistPos = -1;
    }

    if (this.currentId && !retainSet.has(this.currentId)) {
      this.currentId = null;
      this.currentPos = -1;
      this.resumePlaylistPos = -1;
    }

    if (this.shuffle) {
      this.rebuildShuffle(this.currentId);
    } else if (this.currentId) {
      if (this.currentPos < 0 || this.order[this.currentPos] !== this.currentId) {
        this.currentPos = this.order.indexOf(this.currentId);
      }
      if (this.currentPos >= 0) {
        this.resumePlaylistPos = this.currentPos;
      }
    }
  }

  /**
   * Añade una pista para reproducirse inmediatamente después de la actual (en orden FIFO).
   */
  enqueueNext(trackId: string): void {
    if (this.upNextQueue[this.upNextQueue.length - 1] === trackId) return;
    this.upNextQueue.push(trackId);
  }

  getUpNextIds(): string[] {
    return [...this.upNextQueue];
  }

  clearUpNext(): void {
    this.upNextQueue = [];
  }

  setShuffle(enabled: boolean): void {
    if (this.shuffle === enabled) return;
    this.shuffle = enabled;
    if (enabled) {
      this.rebuildShuffle(this.currentId);
    } else {
      this.shuffledOrder = [];
      if (this.currentId) {
        this.currentPos = this.order.indexOf(this.currentId);
      }
    }
  }

  setRepeatMode(mode: RepeatMode): void {
    this.repeatMode = mode;
  }

  getCurrentId(): string | null {
    return this.currentId;
  }

  setCurrentTrack(trackId: string | null, pushToHistory = true, explicitPos?: number): void {
    if (pushToHistory && this.currentId && (this.currentId !== trackId || explicitPos !== this.currentPos)) {
      this.history.push({ id: this.currentId, pos: this.currentPos });
      if (this.history.length > 200) {
        this.history.shift();
      }
    }

    this.currentId = trackId;
    if (!trackId) {
      this.currentPos = -1;
      this.resumePlaylistPos = -1;
      return;
    }

    const active = this.getActiveOrder();
    if (
      typeof explicitPos === 'number' &&
      explicitPos >= 0 &&
      explicitPos < active.length &&
      active[explicitPos] === trackId
    ) {
      this.currentPos = explicitPos;
    } else if (this.shuffle) {
      this.rebuildShuffle(trackId);
    } else {
      this.currentPos = this.order.indexOf(trackId);
    }
    if (this.currentPos >= 0) {
      this.resumePlaylistPos = this.currentPos;
    }
  }

  private getActiveOrder(): string[] {
    return this.shuffle ? this.shuffledOrder : this.order;
  }

  private rebuildShuffle(anchorId: string | null): void {
    if (this.order.length === 0) {
      this.shuffledOrder = [];
      this.currentPos = -1;
      return;
    }
    if (anchorId && this.order.includes(anchorId)) {
      const anchorIdx = this.order.indexOf(anchorId);
      const remaining = this.order.filter((_, idx) => idx !== anchorIdx);
      this.shuffledOrder = [anchorId, ...shuffleItems(remaining)];
      this.currentPos = 0;
    } else {
      this.shuffledOrder = shuffleItems(this.order);
      this.currentPos = this.currentId ? this.shuffledOrder.indexOf(this.currentId) : -1;
    }
  }

  private resolveCurrentIndex(active: string[]): number {
    if (!this.currentId) return -1;
    if (
      this.currentPos >= 0 &&
      this.currentPos < active.length &&
      active[this.currentPos] === this.currentId
    ) {
      return this.currentPos;
    }
    return active.indexOf(this.currentId);
  }

  private getAnchorIndexForNext(active: string[]): number {
    const idx = this.resolveCurrentIndex(active);
    if (idx >= 0) return idx;
    if (this.resumePlaylistPos >= 0 && this.resumePlaylistPos < active.length) {
      return this.resumePlaylistPos;
    }
    return -1;
  }

  /**
   * Devuelve el ID de la siguiente canción sin mutar el estado (para pre-carga).
   * Si `manualSkip` es true, ignora `repeatMode === 'one'` para que el usuario
   * siempre pueda saltar de canción cuando presiona Siguiente.
   */
  peekNextTrackId(manualSkip = false): string | null {
    if (this.repeatMode === 'one' && !manualSkip) {
      return this.currentId ?? this.upNextQueue[0] ?? this.getActiveOrder()[0] ?? null;
    }

    if (this.upNextQueue.length > 0) {
      return this.upNextQueue[0];
    }

    const active = this.getActiveOrder();
    if (active.length === 0) return null;

    if (!this.currentId) {
      return active[0];
    }

    const idx = this.getAnchorIndexForNext(active);
    if (idx === -1) {
      return active[0];
    }

    if (idx + 1 < active.length) {
      return active[idx + 1];
    }

    if (this.repeatMode === 'all' || (this.repeatMode === 'one' && manualSkip)) {
      if (this.shuffle && active.length > 1) {
        return active[0] === this.currentId ? active[1] : active[0];
      }
      return active[0];
    }

    return null;
  }

  /**
   * Avanza a la siguiente canción actualizando historial y re-barajando si terminó el ciclo.
   */
  advanceNext(manualSkip = false): string | null {
    if (this.repeatMode === 'one' && !manualSkip && this.currentId) {
      return this.currentId;
    }

    if (this.upNextQueue.length > 0) {
      const queuedNext = this.upNextQueue.shift()!;
      const active = this.getActiveOrder();
      if (this.currentId) {
        const curIdx = this.resolveCurrentIndex(active);
        if (curIdx >= 0) {
          this.resumePlaylistPos = curIdx;
        }
        this.history.push({ id: this.currentId, pos: curIdx });
        if (this.history.length > 200) {
          this.history.shift();
        }
      }
      this.currentId = queuedNext;
      this.currentPos = active.indexOf(queuedNext);
      if (this.currentPos >= 0) {
        this.resumePlaylistPos = this.currentPos;
      }
      return queuedNext;
    }

    const active = this.getActiveOrder();
    if (active.length === 0) return null;

    if (!this.currentId) {
      this.currentId = active[0];
      this.currentPos = 0;
      this.resumePlaylistPos = 0;
      return this.currentId;
    }

    const idx = this.getAnchorIndexForNext(active);
    let nextId: string | null = null;
    let nextPos = -1;

    if (idx === -1) {
      nextId = active[0];
      nextPos = 0;
    } else if (idx + 1 < active.length) {
      nextPos = idx + 1;
      nextId = active[nextPos];
    } else if (this.repeatMode === 'all' || (this.repeatMode === 'one' && manualSkip)) {
      if (this.shuffle) {
        const lastPlayed = this.currentId;
        this.shuffledOrder = shuffleItems(this.order, lastPlayed);
        nextPos = 0;
        nextId = this.shuffledOrder[0] ?? null;
      } else {
        nextPos = 0;
        nextId = this.order[0] ?? null;
      }
    }

    if (nextId) {
      this.history.push({ id: this.currentId, pos: idx });
      if (this.history.length > 200) {
        this.history.shift();
      }
      this.currentId = nextId;
      this.currentPos = nextPos;
      this.resumePlaylistPos = nextPos;
    }

    return nextId;
  }

  /**
   * Retrocede a la canción anterior (desde historial o índice anterior).
   */
  stepPrevious(): string | null {
    const active = this.getActiveOrder();
    if (active.length === 0) return null;

    while (this.history.length > 0) {
      const prev = this.history.pop()!;
      if (active.includes(prev.id)) {
        this.currentId = prev.id;
        this.currentPos =
          prev.pos >= 0 && prev.pos < active.length && active[prev.pos] === prev.id
            ? prev.pos
            : active.indexOf(prev.id);
        return prev.id;
      }
    }

    if (!this.currentId) {
      this.currentId = active[0];
      this.currentPos = 0;
      return this.currentId;
    }

    const idx = this.resolveCurrentIndex(active);
    if (idx > 0) {
      this.currentPos = idx - 1;
      this.currentId = active[this.currentPos];
      return this.currentId;
    }

    if (this.repeatMode === 'all') {
      this.currentPos = active.length - 1;
      this.currentId = active[this.currentPos];
      return this.currentId;
    }

    return this.currentId;
  }
}
