/**
 * Motor de búsqueda aislado en memoria RAM.
 *
 * Características:
 * 1. Cero llamadas a la DB local (IndexedDB / OPFS): opera exclusivamente sobre el índice en memoria.
 * 2. Flexibilidad de caracteres: insensible a mayúsculas/minúsculas, tildes/diacríticos y
 *    puntuación (puntos, guiones, paréntesis, etc.). Ej: "Dr.Dre" == "dr dre" == "DR DRE".
 * 3. Lógica recursiva pura:
 *    - `recursiveMatchTokens`: verifica recursivamente cada token de búsqueda sobre el objetivo.
 *    - `recursiveSubsequenceScore`: emparejamiento recursivo carácter a carácter con memoización.
 *    - `recursiveScanEntries`: recorre y puntúa recursivamente las entradas indexadas.
 *    - `resolveCachedPrefixRecursive`: busca recursivamente prefijos ya cacheados en memoria
 *      para reutilizar resultados previos sin repetir consultas innecesarias.
 */

import type { AudiusCatalogTrack, Playlist, Track } from '../types';

export interface IndexedLocalTrackEntry {
  kind: 'local-track';
  track: Track;
  playlistIds: string[];
  playlistNames: string[];
  normalizedSpaced: string;
  normalizedCompact: string;
}

export interface LocalSearchMatch {
  track: Track;
  playlistNames: string[];
  score: number;
}

export interface CatalogSearchMatch {
  item: AudiusCatalogTrack;
  score: number;
}

/**
 * Normaliza texto eliminando tildes, convirtiendo a minúsculas y unificando
 * puntos, guiones, barras y signos en espacios (y versión compacta sin separadores).
 */
export function normalizeSearchText(input: string): { spaced: string; compact: string } {
  const ascii = input
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

  const spaced = ascii
    .replace(/[.,\-_/\\()[\]{}!?:;'"`~@#$%^&*+=<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const compact = spaced.replace(/\s+/g, '');
  return { spaced, compact };
}

/**
 * Recursión con memoización para puntuar coincidencia de subsecuencia carácter a carácter.
 * Permite encontrar coincidencias incluso cuando faltan puntos, espacios o letras intermedias.
 */
export function recursiveSubsequenceScore(
  queryCompact: string,
  targetCompact: string,
  qi = 0,
  ti = 0,
  consecutive = 0,
  memo = new Map<string, number>()
): number {
  if (qi >= queryCompact.length) return 10;
  if (ti >= targetCompact.length || queryCompact.length - qi > targetCompact.length - ti) {
    return -1;
  }

  const key = `${qi}:${ti}:${consecutive}`;
  const cached = memo.get(key);
  if (cached !== undefined) return cached;

  let best = recursiveSubsequenceScore(queryCompact, targetCompact, qi, ti + 1, 0, memo);
  if (queryCompact[qi] === targetCompact[ti]) {
    const take = recursiveSubsequenceScore(
      queryCompact,
      targetCompact,
      qi + 1,
      ti + 1,
      consecutive + 1,
      memo
    );
    if (take >= 0) {
      const bonus = 4 + consecutive * 3 + (ti === 0 ? 5 : 0);
      best = Math.max(best, bonus + take);
    }
  }

  memo.set(key, best);
  return best;
}

/**
 * Recorre recursivamente los tokens de búsqueda contra un texto normalizado.
 */
function recursiveMatchTokens(
  tokens: string[],
  spacedTarget: string,
  compactTarget: string,
  idx = 0,
  accScore = 0
): number {
  if (idx >= tokens.length) return accScore;

  const token = tokens[idx];
  let tokenScore = -1;

  const exactPos = spacedTarget.indexOf(token);
  if (exactPos >= 0) {
    const atWordStart = exactPos === 0 || spacedTarget[exactPos - 1] === ' ';
    tokenScore = (atWordStart ? 45 : 28) + token.length * 4;
  } else {
    const compactPos = compactTarget.indexOf(token);
    if (compactPos >= 0) {
      tokenScore = 24 + token.length * 3;
    } else if (token.length >= 2) {
      const subScore = recursiveSubsequenceScore(token, compactTarget);
      if (subScore > 0) {
        tokenScore = Math.min(22, subScore);
      }
    }
  }

  if (tokenScore < 0) return -1;
  return recursiveMatchTokens(tokens, spacedTarget, compactTarget, idx + 1, accScore + tokenScore);
}

/**
 * Calcula puntuación total combinando coincidencia exacta, compacta (sin puntos/espacios)
 * y tokens recursivos.
 */
export function scoreSearchMatch(
  rawQuery: string,
  spacedTarget: string,
  compactTarget: string
): number {
  const q = normalizeSearchText(rawQuery);
  if (!q.compact) return 0;

  // 1. Coincidencia exacta o de subcadena directa flexible a puntuación/mayúsculas
  if (spacedTarget === q.spaced || compactTarget === q.compact) {
    return 300;
  }
  if (spacedTarget.startsWith(q.spaced) || compactTarget.startsWith(q.compact)) {
    return 220 + q.compact.length * 2;
  }
  if (spacedTarget.includes(q.spaced) || compactTarget.includes(q.compact)) {
    return 160 + q.compact.length * 2;
  }

  // 2. Coincidencia recursiva por tokens separados
  const tokens = q.spaced.split(' ').filter(Boolean);
  if (tokens.length > 0) {
    const tokenScore = recursiveMatchTokens(tokens, spacedTarget, compactTarget);
    if (tokenScore > 0) {
      return 60 + tokenScore;
    }
  }

  // 3. Fallback recursivo por subsecuencia compacta (para consultas largas con saltos)
  if (q.compact.length >= 3 && q.compact.length <= 18 && compactTarget.length <= 120) {
    const sub = recursiveSubsequenceScore(q.compact, compactTarget);
    if (sub >= q.compact.length * 4) {
      return sub;
    }
  }

  return 0;
}

/**
 * Escanea recursivamente un arreglo de elementos en memoria acumular coincidencias ordenadas.
 */
function recursiveScanEntries<T>(
  items: T[],
  evaluate: (item: T) => number,
  index = 0,
  acc: Array<{ item: T; score: number }> = []
): Array<{ item: T; score: number }> {
  if (index >= items.length) return acc;

  const current = items[index];
  const score = evaluate(current);
  if (score > 0) {
    acc.push({ item: current, score });
  }
  return recursiveScanEntries(items, evaluate, index + 1, acc);
}

export class IsolatedSearchEngine {
  private localEntries: IndexedLocalTrackEntry[] = [];
  private audiusCache = new Map<string, AudiusCatalogTrack[]>();
  private allCachedAudiusById = new Map<
    string,
    { item: AudiusCatalogTrack; spaced: string; compact: string }
  >();

  /**
   * Sincroniza únicamente referencias en RAM (nunca consulta IndexedDB ni OPFS).
   */
  syncMemoryIndex(tracks: Track[], playlists: Playlist[]): void {
    const playlistsByTrack = new Map<string, { ids: string[]; names: string[] }>();
    for (const pl of playlists) {
      for (const tid of pl.trackIds) {
        let info = playlistsByTrack.get(tid);
        if (!info) {
          info = { ids: [], names: [] };
          playlistsByTrack.set(tid, info);
        }
        if (!info.ids.includes(pl.id)) {
          info.ids.push(pl.id);
          info.names.push(pl.name);
        }
      }
    }

    this.localEntries = tracks.map((track) => {
      const plInfo = playlistsByTrack.get(track.id);
      const playlistNames = plInfo?.names ?? [];
      const searchable = `${track.title} ${track.artist} ${track.fileName} ${playlistNames.join(' ')}`;
      const { spaced, compact } = normalizeSearchText(searchable);
      return {
        kind: 'local-track',
        track,
        playlistIds: plInfo?.ids ?? [],
        playlistNames,
        normalizedSpaced: spaced,
        normalizedCompact: compact,
      };
    });
  }

  /**
   * Busca de forma 100% síncrona y recursiva en la biblioteca local en RAM (0 DB calls).
   */
  searchLocal(rawQuery: string, limit = 30): LocalSearchMatch[] {
    const q = normalizeSearchText(rawQuery);
    if (!q.compact) return [];

    const hits = recursiveScanEntries(this.localEntries, (entry) =>
      scoreSearchMatch(rawQuery, entry.normalizedSpaced, entry.normalizedCompact)
    );

    hits.sort((a, b) => b.score - a.score || a.item.track.title.localeCompare(b.item.track.title));

    return hits.slice(0, limit).map((h) => ({
      track: h.item.track,
      playlistNames: h.item.playlistNames,
      score: h.score,
    }));
  }

  /**
   * Almacena resultados de Audius en el caché aislado en RAM.
   */
  cacheAudiusResults(rawQuery: string, results: AudiusCatalogTrack[]): void {
    const { compact } = normalizeSearchText(rawQuery);
    if (compact) {
      this.audiusCache.set(compact, results);
    }
    for (const item of results) {
      const { spaced, compact: itemCompact } = normalizeSearchText(
        `${item.title} ${item.artist} ${item.genre}`
      );
      this.allCachedAudiusById.set(item.id, { item, spaced, compact: itemCompact });
    }
  }

  /**
   * Busca recursivamente en los resultados cacheados de Audius (exacto o por prefijo en RAM).
   */
  searchCachedAudius(rawQuery: string, limit = 24): CatalogSearchMatch[] {
    const { compact } = normalizeSearchText(rawQuery);
    if (!compact) return [];

    const pool = Array.from(this.allCachedAudiusById.values());
    const hits = recursiveScanEntries(pool, (entry) =>
      scoreSearchMatch(rawQuery, entry.spaced, entry.compact)
    );
    hits.sort((a, b) => b.score - a.score);

    return hits.slice(0, limit).map((h) => ({
      item: h.item.item,
      score: h.score,
    }));
  }

  hasExactAudiusCache(rawQuery: string): AudiusCatalogTrack[] | null {
    const { compact } = normalizeSearchText(rawQuery);
    if (!compact) return null;
    return this.audiusCache.get(compact) ?? null;
  }

  /**
   * Busca recursivamente si algún prefijo más corto en memoria ya fue cacheado para dar vista previa instantánea.
   */
  resolvePrefixCacheRecursive(compactQuery: string): AudiusCatalogTrack[] | null {
    if (compactQuery.length < 2) return null;
    const hit = this.audiusCache.get(compactQuery);
    if (hit) return hit;
    return this.resolvePrefixCacheRecursive(compactQuery.slice(0, -1));
  }
}
