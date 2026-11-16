import type { ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import {
  inspectAudioContainer,
  orderSoundCloudTranscodings as selectSoundCloudTranscodings,
  remuxFragmentedMp4ToStandardM4a,
} from '../src/lib/audio/audioContainer.ts';

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

export interface CatalogHandler {
  handle(res: ServerResponse, reqPath: string, url: URL, method: string): Promise<void>;
}

/**
 * Catálogo remoto (SoundCloud + Audius) con cachés en memoria.
 * Lo comparten el plugin de Vite (dev/preview) y las funciones serverless de Vercel.
 */
export function createCatalogHandler(): CatalogHandler {
  let cachedAudiusHosts: string[] = [];
  let cachedAudiusHostsAt = 0;

  async function resolveAudiusHosts(): Promise<string[]> {
    const now = Date.now();
    if (cachedAudiusHosts.length > 0 && now - cachedAudiusHostsAt < 10 * 60 * 1000) {
      return cachedAudiusHosts;
    }
    try {
      const resp = await fetch('https://api.audius.co', {
        signal: AbortSignal.timeout(5000),
      });
      if (resp.ok) {
        const json = (await resp.json()) as { data?: string[] };
        const valid = (json.data ?? []).filter((h) => /^https:\/\/[a-zA-Z0-9.-]+$/.test(h));
        if (valid.length > 0) {
          cachedAudiusHosts = valid;
          cachedAudiusHostsAt = now;
          return cachedAudiusHosts;
        }
      }
    } catch {
      // Usar respaldo si api.audius.co falla temporalmente
    }
    return cachedAudiusHosts.length > 0
      ? cachedAudiusHosts
      : [
        'https://discoveryprovider.audius.co',
        'https://discoveryprovider2.audius.co',
        'https://discoveryprovider3.audius.co',
      ];
  }

  interface RawAudiusTrack {
    id?: string;
    title?: string;
    duration?: number;
    genre?: string;
    user?: { name?: string; handle?: string };
    artwork?: { '150x150'?: string; '480x480'?: string };
  }

  interface SoundCloudTranscoding {
    url?: string;
    snipped?: boolean;
    format?: { protocol?: string; mime_type?: string };
  }

  interface RawSoundCloudTrack {
    id?: number;
    title?: string;
    duration?: number;
    full_duration?: number;
    genre?: string;
    artwork_url?: string | null;
    playback_count?: number;
    policy?: string;
    track_authorization?: string;
    user?: { username?: string };
    publisher_metadata?: { artist?: string };
    media?: { transcodings?: SoundCloudTranscoding[] };
  }

  interface CatalogTrackResult {
    id: string;
    title: string;
    artist: string;
    duration: number;
    genre: string;
    artworkUrl: string | null;
    host: string;
  }

  const MIN_FULL_SONG_SECONDS = 60;

  // SoundCloud marca como MONETIZE las pistas reproducibles con publicidad; sólo
  // BLOCK/SNIP impiden entregar el audio completo.
  const isPlayablePolicy = (policy: string | undefined): boolean =>
    policy === 'ALLOW' || policy === 'MONETIZE';

  let cachedScClientId: string | null = null;
  let cachedScClientIdAt = 0;

  let trendingCache: { tracks: CatalogTrackResult[]; expiresAt: number } | null = null;
  const searchCache = new Map<string, { tracks: CatalogTrackResult[]; expiresAt: number }>();
  const streamCache = new Map<string, { buffer: Buffer; mimeType: string; cachedAt: number }>();
  const MAX_STREAM_CACHE_BYTES = 48 * 1024 * 1024;
  const STREAM_CACHE_TTL_MS = 10 * 60 * 1000;

  function cacheStreamBuffer(key: string, buffer: Buffer, mimeType: string): void {
    if (buffer.length > 16 * 1024 * 1024) return;
    streamCache.delete(key);
    streamCache.set(key, { buffer, mimeType, cachedAt: Date.now() });
    let totalBytes = 0;
    for (const entry of streamCache.values()) {
      totalBytes += entry.buffer.length;
    }
    for (const [oldKey, oldVal] of streamCache.entries()) {
      if (totalBytes <= MAX_STREAM_CACHE_BYTES && streamCache.size <= 8) break;
      streamCache.delete(oldKey);
      totalBytes -= oldVal.buffer.length;
    }
  }

  // Pre-calentar credenciales/nodos al arrancar para que la primera petición no espere
  void resolveSoundCloudClientId(false);
  void resolveAudiusHosts();

  async function resolveSoundCloudClientId(forceRefresh = false): Promise<string | null> {
    const now = Date.now();
    if (!forceRefresh && cachedScClientId && now - cachedScClientIdAt < 2 * 60 * 60 * 1000) {
      return cachedScClientId;
    }
    try {
      const home = await (
        await fetch('https://soundcloud.com/', {
          signal: AbortSignal.timeout(6000),
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
        })
      ).text();
      const scripts = [...home.matchAll(/src="(https:\/\/a-v2\.sndcdn\.com\/assets\/[^"]+\.js)"/g)].map(
        (m) => m[1]
      );
      for (const scriptUrl of scripts.slice(-6).reverse()) {
        const js = await (await fetch(scriptUrl, { signal: AbortSignal.timeout(6000) })).text();
        const match = js.match(/client_id\s*[:=]\s*["']([a-zA-Z0-9]{20,40})["']/);
        if (match) {
          cachedScClientId = match[1];
          cachedScClientIdAt = now;
          return cachedScClientId;
        }
      }
    } catch {
      // Fallback silencioso
    }
    return cachedScClientId;
  }

  function orderSoundCloudTranscodings(track: RawSoundCloudTrack): SoundCloudTranscoding[] {
    return selectSoundCloudTranscodings(track.media?.transcodings);
  }

  function pickSoundCloudTranscoding(track: RawSoundCloudTrack): SoundCloudTranscoding | null {
    return orderSoundCloudTranscodings(track)[0] ?? null;
  }

  function scoreSoundCloudCandidate(track: RawSoundCloudTrack, query: string): number {
    const title = (track.title ?? '').toLowerCase();
    const artist = (track.user?.username ?? track.publisher_metadata?.artist ?? '').toLowerCase();
    const qLower = query.toLowerCase();
    const tokens = qLower.split(/\s+/).filter((t) => t.length >= 2);
    let score = Math.log10(Math.max(10, track.playback_count ?? 10)) * 10;

    for (const tok of tokens) {
      if (title.includes(tok)) score += 25;
      if (artist.includes(tok)) score += 15;
    }

    const noiseTerms = [
      'slowed',
      'reverb',
      'sped up',
      'nightcore',
      '8d',
      'karaoke',
      'instrumental',
      'remix',
      'bootleg',
    ];
    for (const term of noiseTerms) {
      if (title.includes(term) && !qLower.includes(term)) {
        score -= 18;
      }
    }
    if (track.media?.transcodings?.some((tr) => tr.format?.protocol === 'progressive' && !tr.snipped)) {
      score += 8;
    }
    return score;
  }

  function mapAudiusTracks(rawList: RawAudiusTrack[], host: string): CatalogTrackResult[] {
    return rawList
      .filter((t) => Boolean(t.id && t.title) && (Number(t.duration) || 0) >= MIN_FULL_SONG_SECONDS)
      .map((t) => ({
        id: String(t.id),
        title: String(t.title ?? 'Sin título'),
        artist: String(t.user?.name || t.user?.handle || ''),
        duration: Number(t.duration) || 0,
        genre: String(t.genre ?? ''),
        artworkUrl: t.artwork?.['150x150'] ?? t.artwork?.['480x480'] ?? null,
        host,
      }));
  }

  function mapSoundCloudTracks(rawList: RawSoundCloudTrack[], query: string): CatalogTrackResult[] {
    const valid = rawList.filter((t) => {
      if (!t.id || !t.title) return false;
      if (!isPlayablePolicy(t.policy)) return false;
      const durSec = Math.round((t.duration || 0) / 1000);
      if (durSec < MIN_FULL_SONG_SECONDS) return false;
      return pickSoundCloudTranscoding(t) !== null;
    });

    valid.sort((a, b) => scoreSoundCloudCandidate(b, query) - scoreSoundCloudCandidate(a, query));

    return valid.map((t) => ({
      id: `sc-${String(t.id)}`,
      title: String(t.title ?? 'Sin título'),
      artist: String(t.publisher_metadata?.artist || t.user?.username || ''),
      duration: Math.round((t.duration || 0) / 1000),
      genre: String(t.genre ?? ''),
      artworkUrl: t.artwork_url ? t.artwork_url.replace('-large', '-t300x300') : null,
      host: 'soundcloud',
    }));
  }

  async function searchSoundCloudCatalog(query: string, limit: number): Promise<CatalogTrackResult[]> {
    let clientId = await resolveSoundCloudClientId(false);
    if (!clientId) return [];

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const endpoint = `https://api-v2.soundcloud.com/search/tracks?q=${encodeURIComponent(query)}&client_id=${encodeURIComponent(clientId)}&limit=${Math.min(50, Math.max(limit * 2, 35))}`;
        const resp = await fetch(endpoint, { signal: AbortSignal.timeout(3800) });
        if ((resp.status === 401 || resp.status === 403) && attempt === 0) {
          clientId = await resolveSoundCloudClientId(true);
          if (!clientId) return [];
          continue;
        }
        if (!resp.ok) return [];
        const payload = (await resp.json()) as { collection?: RawSoundCloudTrack[] };
        return mapSoundCloudTracks(Array.isArray(payload.collection) ? payload.collection : [], query).slice(
          0,
          limit
        );
      } catch {
        return [];
      }
    }
    return [];
  }

  async function fetchPopularDefaultCatalog(limit: number): Promise<CatalogTrackResult[]> {
    try {
      const seeds = [
        'Bad Bunny Titi Me Pregunto',
        'Karol G Provenza',
        'Grupo Niche Cali Pachanguero',
        'Daddy Yankee Gasolina',
        'Feid Luna',
      ];
      const results = await Promise.all(seeds.map((s) => searchSoundCloudCatalog(s, 5)));
      const merged: CatalogTrackResult[] = [];
      const seen = new Set<string>();
      for (let i = 0; i < 5; i++) {
        for (const list of results) {
          const item = list[i];
          if (item && !seen.has(item.id)) {
            seen.add(item.id);
            merged.push(item);
          }
        }
      }
      if (merged.length > 0) {
        return merged.slice(0, limit);
      }

      const hosts = await resolveAudiusHosts();
      for (const host of hosts.slice(0, 2)) {
        try {
          const trResp = await fetch(`${host}/v1/tracks/trending?limit=${limit}&app_name=GradMix`, {
            signal: AbortSignal.timeout(5000),
          });
          if (trResp.ok) {
            const payload = (await trResp.json()) as { data?: RawAudiusTrack[] };
            const mapped = mapAudiusTracks(Array.isArray(payload.data) ? payload.data : [], host);
            if (mapped.length > 0) return mapped.slice(0, limit);
          }
        } catch {
          // Intentar siguiente host
        }
      }
    } catch {
      // Ignorar
    }
    return [];
  }

  async function searchAudiusCatalog(query: string, limit: number): Promise<CatalogTrackResult[]> {
    const hosts = await resolveAudiusHosts();
    for (const host of hosts.slice(0, 2)) {
      try {
        const endpoint = `${host}/v1/tracks/search?query=${encodeURIComponent(query)}&limit=${Math.max(limit * 2, 16)}&app_name=GradMix`;
        const resp = await fetch(endpoint, { signal: AbortSignal.timeout(2800) });
        if (!resp.ok) continue;
        const payload = (await resp.json()) as { data?: RawAudiusTrack[] };
        return mapAudiusTracks(Array.isArray(payload.data) ? payload.data : [], host).slice(0, limit);
      } catch {
        // Intentar siguiente nodo
      }
    }
    return [];
  }

  async function fetchSegmentsBuffer(urls: string[], signal: AbortSignal): Promise<Buffer> {
    const chunks: Buffer[] = new Array(urls.length);
    const CONCURRENCY = Math.min(16, urls.length);
    let nextIdx = 0;

    async function worker(): Promise<void> {
      while (nextIdx < urls.length) {
        const idx = nextIdx++;
        const r = await fetch(urls[idx], { signal });
        if (!r.ok) {
          throw new Error(`Error de segmento HLS HTTP ${r.status}`);
        }
        chunks[idx] = Buffer.from(await r.arrayBuffer());
      }
    }

    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
    return Buffer.concat(chunks);
  }

  async function streamSoundCloudFullTrack(
    scId: string,
    res: ServerResponse
  ): Promise<boolean> {
    let clientId = await resolveSoundCloudClientId(false);
    if (!clientId) return false;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 35_000);

    try {
      let trackMeta: RawSoundCloudTrack | null = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        const metaResp = await fetch(
          `https://api-v2.soundcloud.com/tracks/${scId}?client_id=${encodeURIComponent(clientId)}`,
          { signal: controller.signal }
        );
        if ((metaResp.status === 401 || metaResp.status === 403) && attempt === 0) {
          clientId = await resolveSoundCloudClientId(true);
          if (!clientId) return false;
          continue;
        }
        if (metaResp.ok) {
          trackMeta = (await metaResp.json()) as RawSoundCloudTrack;
        }
        break;
      }

      if (!trackMeta || !isPlayablePolicy(trackMeta.policy)) return false;
      const transcodings = orderSoundCloudTranscodings(trackMeta);
      if (transcodings.length === 0) return false;

      const authQuery = trackMeta.track_authorization
        ? `&track_authorization=${encodeURIComponent(trackMeta.track_authorization)}`
        : '';

      for (const transcoding of transcodings) {
        if (!transcoding.url) continue;
        const sep = transcoding.url.includes('?') ? '&' : '?';
        const resolvedResp = await fetch(
          `${transcoding.url}${sep}client_id=${encodeURIComponent(clientId)}${authQuery}`,
          { signal: controller.signal }
        );
        if (!resolvedResp.ok) continue;
        const resolvedJson = (await resolvedResp.json()) as { url?: string };
        if (!resolvedJson.url) continue;

        if (transcoding.format?.protocol === 'progressive') {
          const upstream = await fetch(resolvedJson.url, {
            redirect: 'follow',
            signal: controller.signal,
          });
          const upstreamType = (upstream.headers.get('content-type') ?? '').toLowerCase();
          if (
            upstream.ok &&
            upstream.body &&
            !upstreamType.includes('text/html') &&
            !upstreamType.includes('application/json')
          ) {
            clearTimeout(timer);
            pipeUpstreamAudio(upstream, res, controller);
            return true;
          }
          await upstream.body?.cancel().catch(() => { });
          continue;
        }

        // HLS VOD (audio/mpeg o fragmented MP4 audio/mp4 sin cifrado)
        const m3u8Resp = await fetch(resolvedJson.url, { signal: controller.signal });
        if (!m3u8Resp.ok) continue;
        const m3u8Text = await m3u8Resp.text();
        if (/#EXT-X-KEY/i.test(m3u8Text)) continue;

        const mapMatch = m3u8Text.match(/#EXT-X-MAP:URI="([^"]+)"/);
        const segUrls = m3u8Text
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line && !line.startsWith('#'));

        if (segUrls.length === 0) continue;

        const allUrls = mapMatch ? [mapMatch[1], ...segUrls] : segUrls;
        const assembled = await fetchSegmentsBuffer(allUrls, controller.signal);
        const containerInfo = inspectAudioContainer(assembled);
        if (containerInfo.encrypted || containerInfo.kind === 'invalid-text') continue;
        clearTimeout(timer);

        // Convertir fMP4 sin cifrar en .m4a estándar con moov/mvhd completo para evitar duraciones corruptas en escritorio/móvil
        const remuxed = containerInfo.fragmentedMp4
          ? remuxFragmentedMp4ToStandardM4a(assembled)
          : null;
        const outputBuf = remuxed
          ? Buffer.from(remuxed.buffer, remuxed.byteOffset, remuxed.byteLength)
          : assembled;

        const mimeType =
          containerInfo.mimeType ??
          (transcoding.format?.mime_type?.includes('mp4') ? 'audio/mp4' : 'audio/mpeg');

        cacheStreamBuffer(`sc-${scId}`, outputBuf, mimeType);
        res.statusCode = 200;
        res.setHeader('Content-Type', mimeType);
        res.setHeader('Content-Length', outputBuf.length);
        res.setHeader('Cache-Control', 'no-store');
        res.end(outputBuf);
        return true;
      }

      return false;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  function pipeUpstreamAudio(
    upstream: Response,
    res: ServerResponse,
    controller: AbortController
  ): void {
    res.statusCode = 200;
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'audio/mpeg');
    const contentLen = upstream.headers.get('content-length');
    if (contentLen) res.setHeader('Content-Length', contentLen);
    res.setHeader('Cache-Control', 'no-store');

    const nodeStream = Readable.fromWeb(
      upstream.body as unknown as import('node:stream/web').ReadableStream
    );

    const cleanupStream = () => {
      if (!res.writableEnded) {
        try {
          controller.abort();
        } catch {
          // Ignorar
        }
        nodeStream.destroy();
      }
    };

    nodeStream.on('error', () => {
      if (!res.destroyed) res.destroy();
    });
    res.on('error', cleanupStream);
    res.on('close', cleanupStream);

    nodeStream.pipe(res);
  }

  async function handleCatalogApi(
    res: ServerResponse,
    reqPath: string,
    url: URL,
    method: string
  ): Promise<void> {
    if (method !== 'GET') {
      sendJson(res, 405, { error: 'Método no permitido.' });
      return;
    }

    if (reqPath === '/api/catalog/trending') {
      const limit = Math.min(30, Math.max(1, Number(url.searchParams.get('limit') ?? 20)));
      if (trendingCache && Date.now() < trendingCache.expiresAt && trendingCache.tracks.length > 0) {
        sendJson(res, 200, { tracks: trendingCache.tracks.slice(0, limit), host: 'catalog' });
        return;
      }
      const tracks = await fetchPopularDefaultCatalog(limit);
      if (tracks.length > 0) {
        trendingCache = { tracks, expiresAt: Date.now() + 10 * 60 * 1000 };
      }
      sendJson(res, 200, { tracks, host: 'catalog' });
      return;
    }

    if (reqPath === '/api/catalog/search') {
      const q = (url.searchParams.get('q') ?? '').trim();
      const limit = Math.min(30, Math.max(1, Number(url.searchParams.get('limit') ?? 20)));
      if (!q) {
        sendJson(res, 200, { tracks: [], host: '' });
        return;
      }

      const cacheKey = `${q.toLowerCase()}|${limit}`;
      const cached = searchCache.get(cacheKey);
      if (cached && Date.now() < cached.expiresAt) {
        sendJson(res, 200, { tracks: cached.tracks, host: 'catalog' });
        return;
      }

      const [scTracks, audiusTracks] = await Promise.all([
        searchSoundCloudCatalog(q, limit),
        searchAudiusCatalog(q, Math.max(4, Math.floor(limit / 3))),
      ]);

      const combined = [...scTracks, ...audiusTracks].slice(0, limit);
      if (combined.length > 0) {
        if (searchCache.size >= 60) {
          const oldestKey = searchCache.keys().next().value;
          if (oldestKey !== undefined) searchCache.delete(oldestKey);
        }
        searchCache.set(cacheKey, { tracks: combined, expiresAt: Date.now() + 3 * 60 * 1000 });
      }
      sendJson(res, 200, { tracks: combined, host: 'catalog' });
      return;
    }

    if (reqPath === '/api/catalog/stream') {
      const trackId = (url.searchParams.get('trackId') ?? '').trim();
      if (!/^[A-Za-z0-9_-]{1,40}$/.test(trackId)) {
        sendJson(res, 400, { error: 'trackId inválido.' });
        return;
      }

      const cachedStream = streamCache.get(trackId);
      if (cachedStream && Date.now() - cachedStream.cachedAt < STREAM_CACHE_TTL_MS) {
        res.statusCode = 200;
        res.setHeader('Content-Type', cachedStream.mimeType);
        res.setHeader('Content-Length', cachedStream.buffer.length);
        res.setHeader('Cache-Control', 'no-store');
        res.end(cachedStream.buffer);
        return;
      }

      // Stream completo ensamblado (HLS/progressive FULL) para pistas SoundCloud
      if (trackId.startsWith('sc-')) {
        const scId = trackId.slice(3);
        if (!/^\d{1,20}$/.test(scId)) {
          sendJson(res, 400, { error: 'ID inválido.' });
          return;
        }
        const served = await streamSoundCloudFullTrack(scId, res);
        if (!served && !res.headersSent) {
          sendJson(res, 502, { error: 'No se pudo descargar la canción completa.' });
        }
        return;
      }

      const hosts = await resolveAudiusHosts();
      const preferred = (url.searchParams.get('host') ?? '').trim();
      const orderedHosts =
        preferred && hosts.includes(preferred)
          ? [preferred, ...hosts.filter((h) => h !== preferred)]
          : hosts;

      for (const host of orderedHosts.slice(0, 4)) {
        const controller = new AbortController();
        const connectTimer = setTimeout(() => controller.abort(), 12_000);
        try {
          const streamUrl = `${host}/v1/tracks/${encodeURIComponent(trackId)}/stream?app_name=GradMix`;
          const upstream = await fetch(streamUrl, {
            redirect: 'follow',
            signal: controller.signal,
          });
          clearTimeout(connectTimer);
          if (!upstream.ok || !upstream.body) {
            await upstream.body?.cancel().catch(() => { });
            continue;
          }
          const upstreamType = (upstream.headers.get('content-type') ?? '').toLowerCase();
          if (upstreamType.includes('text/html') || upstreamType.includes('application/json')) {
            await upstream.body?.cancel().catch(() => { });
            continue;
          }

          pipeUpstreamAudio(upstream, res, controller);
          return;
        } catch {
          clearTimeout(connectTimer);
          // Intentar siguiente nodo
        }
      }

      sendJson(res, 502, { error: 'No se pudo descargar el audio.' });
      return;
    }

    sendJson(res, 404, { error: 'Ruta de catálogo no encontrada.' });
  }
  return { handle: handleCatalogApi };
}
