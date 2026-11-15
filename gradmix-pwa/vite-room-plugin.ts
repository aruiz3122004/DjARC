import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import net, { type Socket } from 'node:net';
import os from 'node:os';
import nodePath from 'node:path';
import { Readable, type Duplex } from 'node:stream';
import type { Connect, Plugin } from 'vite';
import {
  inspectAudioContainer,
  orderSoundCloudTranscodings as selectSoundCloudTranscodings,
  remuxFragmentedMp4ToStandardM4a,
} from './src/lib/audio/audioContainer.ts';

interface RoomPermissions {
  canSkip: boolean;
  canPause: boolean;
  canAdd: boolean;
  canRemove: boolean;
}

interface RoomParticipant {
  id: string;
  name: string;
  isHost: boolean;
  joinedAt: number;
  permissions: RoomPermissions;
}

interface RoomTrackInternal {
  id: string;
  title: string;
  artist: string;
  duration: number;
  addedById: string;
  addedByName: string;
  addedAt: number;
  mimeType: string;
  fileName: string;
  audioBuffer: Buffer | null;
}

interface RoomTrackItemSync {
  id: string;
  title: string;
  artist: string;
  duration: number;
}

interface RoomRecord {
  code: string;
  passwordHash: Buffer;
  passwordSalt: string;
  hostId: string;
  inviteToken: string;
  createdAt: number;
  expiresAt: number;
  maxDurationHours: number;
  participants: Map<string, RoomParticipant>;
  tracks: RoomTrackInternal[];
  nowPlayingTitle: string | null;
  isPlaying: boolean;
  sseClients: Map<string, ServerResponse>;
  wsClients: Map<string, Set<Socket>>;
}

const HUB_HOST = '127.0.0.1';
const HUB_PORT = 4185;
const MAX_ROOM_HOURS = 10;
const MAX_UPLOAD_BYTES = 35 * 1024 * 1024;
const BUNDLE_TTL_MS = 24 * 3600 * 1000;
const BUNDLE_ROOT_DIR = nodePath.join(os.tmpdir(), 'gradmix-bundles');

interface BundleTrackMeta {
  title: string;
  artist: string;
  fileName: string;
  duration: number;
  bpm: number | null;
  block: string;
  mimeType: string;
  byteLength: number;
}

interface BundleDiskRecord {
  id: string;
  playlistName: string;
  block: string;
  createdAt: number;
  expiresAt: number;
  tracks: BundleTrackMeta[];
}

function hashPassword(password: string, salt: string): Buffer {
  return crypto.scryptSync(password, salt, 32);
}

function verifyPassword(password: string, salt: string, expectedHash: Buffer): boolean {
  const actual = hashPassword(password, salt);
  if (actual.length !== expectedHash.length) return false;
  return crypto.timingSafeEqual(actual, expectedHash);
}

function generateRoomCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  const bytes = crypto.randomBytes(6);
  for (let i = 0; i < 6; i++) {
    out += chars[bytes[i] % chars.length];
  }
  return out;
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > 512 * 1024) {
      throw new Error('Payload demasiado grande.');
    }
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return (raw ? JSON.parse(raw) : {}) as T;
}

async function readBinaryBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > maxBytes) {
      throw new Error('El archivo excede el límite de 35 MB por pista.');
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

function toPublicRoom(room: RoomRecord) {
  return {
    code: room.code,
    hostId: room.hostId,
    inviteToken: room.inviteToken,
    createdAt: room.createdAt,
    expiresAt: room.expiresAt,
    maxDurationHours: room.maxDurationHours,
    participants: Array.from(room.participants.values()),
    tracks: room.tracks.map((t) => ({
      id: t.id,
      title: t.title,
      artist: t.artist,
      duration: t.duration,
      addedById: t.addedById,
      addedByName: t.addedByName,
      addedAt: t.addedAt,
      hasAudioRelay: t.audioBuffer !== null,
    })),
    nowPlayingTitle: room.nowPlayingTitle,
    isPlaying: room.isPlaying,
  };
}

function encodeWsFrame(opcode: number, payload: Buffer): Buffer {
  const len = payload.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.allocUnsafe(2);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.allocUnsafe(4);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function sendWsText(socket: Socket, text: string): boolean {
  if (socket.destroyed || !socket.writable) return false;
  try {
    socket.write(encodeWsFrame(0x1, Buffer.from(text, 'utf8')));
    return true;
  } catch {
    return false;
  }
}

function broadcastEvent(room: RoomRecord, event: string, data: unknown, onlyId?: string): void {
  const jsonStr = JSON.stringify(data);
  const ssePayload = `event: ${event}\ndata: ${jsonStr}\n\n`;
  for (const [participantId, clientRes] of room.sseClients.entries()) {
    if (onlyId && participantId !== onlyId) continue;
    try {
      clientRes.write(ssePayload);
    } catch {
      room.sseClients.delete(participantId);
    }
  }

  const wsPayload = JSON.stringify({ event, data });
  for (const [participantId, sockets] of room.wsClients.entries()) {
    if (onlyId && participantId !== onlyId) continue;
    for (const sock of sockets) {
      if (!sendWsText(sock, wsPayload)) {
        sockets.delete(sock);
      }
    }
    if (sockets.size === 0) {
      room.wsClients.delete(participantId);
    }
  }
}

function verifyInviteToken(provided: string, expected: string): boolean {
  if (!provided || !expected) return false;
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function createRoomRequestHandler() {
  const rooms = new Map<string, RoomRecord>();
  const idempotentResults = new Map<string, { expiresAt: number; status: number; body: unknown }>();
  const inFlightIdempotent = new Map<string, Promise<{ status: number; body: unknown }>>();

  const getIdempotencyKey = (req: IncomingMessage, scope: string): string | null => {
    const raw = req.headers['idempotency-key'];
    const key = Array.isArray(raw) ? raw[0] : raw;
    if (!key || !key.trim()) return null;
    return `${scope}:${key.trim().slice(0, 96)}`;
  };

  const handleIdempotentJson = async (
    req: IncomingMessage,
    res: ServerResponse,
    scope: string,
    producer: () => Promise<{ status: number; body: unknown }>
  ): Promise<void> => {
    const fullKey = getIdempotencyKey(req, scope);
    if (!fullKey) {
      const result = await producer();
      sendJson(res, result.status, result.body);
      return;
    }

    const now = Date.now();
    for (const [k, v] of idempotentResults.entries()) {
      if (now >= v.expiresAt) idempotentResults.delete(k);
    }

    const cached = idempotentResults.get(fullKey);
    if (cached && now < cached.expiresAt) {
      sendJson(res, cached.status, cached.body);
      return;
    }

    let pending = inFlightIdempotent.get(fullKey);
    if (!pending) {
      pending = producer()
        .then((result) => {
          if (result.status < 500) {
            idempotentResults.set(fullKey, {
              expiresAt: Date.now() + 90_000,
              status: result.status,
              body: result.body,
            });
            if (idempotentResults.size > 400) {
              const firstKey = idempotentResults.keys().next().value;
              if (firstKey) idempotentResults.delete(firstKey);
            }
          }
          return result;
        })
        .finally(() => {
          inFlightIdempotent.delete(fullKey);
        });
      inFlightIdempotent.set(fullKey, pending);
    }

    const result = await pending;
    sendJson(res, result.status, result.body);
  };

  const attachWsClient = (room: RoomRecord, participantId: string, socket: Socket) => {
    let set = room.wsClients.get(participantId);
    if (!set) {
      set = new Set();
      room.wsClients.set(participantId, set);
    }
    set.add(socket);
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 15_000);

    let pending = Buffer.alloc(0);
    const cleanup = () => {
      clearInterval(pingTimer);
      set?.delete(socket);
      if (set && set.size === 0) {
        room.wsClients.delete(participantId);
      }
    };

    const pingTimer = setInterval(() => {
      if (socket.destroyed || !socket.writable) {
        cleanup();
        return;
      }
      try {
        socket.write(encodeWsFrame(0x9, Buffer.alloc(0)));
      } catch {
        cleanup();
      }
    }, 25_000);
    pingTimer.unref?.();

    socket.on('data', (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 2) {
        const firstByte = pending[0];
        const secondByte = pending[1];
        const opcode = firstByte & 0x0f;
        const masked = (secondByte & 0x80) !== 0;
        let payloadLen = secondByte & 0x7f;
        let offset = 2;

        if (payloadLen === 126) {
          if (pending.length < 4) return;
          payloadLen = pending.readUInt16BE(2);
          offset = 4;
        } else if (payloadLen === 127) {
          if (pending.length < 10) return;
          const bigLen = pending.readBigUInt64BE(2);
          if (bigLen > BigInt(256 * 1024)) {
            socket.destroy();
            return;
          }
          payloadLen = Number(bigLen);
          offset = 10;
        }

        const maskBytes = masked ? 4 : 0;
        const totalLen = offset + maskBytes + payloadLen;
        if (pending.length < totalLen) return;

        let payload = pending.subarray(offset + maskBytes, totalLen);
        if (masked) {
          const mask = pending.subarray(offset, offset + 4);
          const unmasked = Buffer.allocUnsafe(payloadLen);
          for (let i = 0; i < payloadLen; i++) {
            unmasked[i] = payload[i] ^ mask[i % 4];
          }
          payload = unmasked;
        }
        pending = pending.subarray(totalLen);

        if (opcode === 0x8) {
          try {
            socket.write(encodeWsFrame(0x8, Buffer.alloc(0)));
          } catch {
            // Ignorar
          }
          socket.destroy();
          return;
        }
        if (opcode === 0x9) {
          try {
            socket.write(encodeWsFrame(0xA, payload));
          } catch {
            // Ignorar
          }
        } else if (opcode === 0x1) {
          try {
            const msg = JSON.parse(payload.toString('utf8')) as { type?: string };
            if (msg.type === 'sync') {
              sendWsText(socket, JSON.stringify({ event: 'room-state', data: toPublicRoom(room) }));
            }
          } catch {
            // Ignorar frames no JSON
          }
        }
      }
    });

    const initialTimer = setTimeout(() => {
      if (!socket.destroyed && socket.writable) {
        sendWsText(socket, JSON.stringify({ event: 'room-state', data: toPublicRoom(room) }));
      }
    }, 30);
    initialTimer.unref?.();

    const fullCleanup = () => {
      clearTimeout(initialTimer);
      cleanup();
    };

    socket.on('close', fullCleanup);
    socket.on('error', fullCleanup);
    socket.on('end', fullCleanup);
  };

  const destroyRoom = (code: string, reason: string) => {
    const room = rooms.get(code);
    if (!room) return;
    broadcastEvent(room, 'room-closed', { reason });
    for (const client of room.sseClients.values()) {
      try {
        client.end();
      } catch {
        // Ignorar
      }
    }
    room.sseClients.clear();
    for (const sockets of room.wsClients.values()) {
      for (const sock of sockets) {
        try {
          sock.write(encodeWsFrame(0x8, Buffer.alloc(0)));
          sock.destroy();
        } catch {
          // Ignorar
        }
      }
    }
    room.wsClients.clear();
    for (const trk of room.tracks) {
      trk.audioBuffer = null;
    }
    room.tracks = [];
    rooms.delete(code);
  };

  const sweepTimer = setInterval(() => {
    const now = Date.now();
    for (const [code, room] of rooms.entries()) {
      if (now >= room.expiresAt) {
        destroyRoom(code, 'La sala alcanzó su tiempo máximo y se autodestruyó.');
      }
    }
    void cleanupExpiredBundles(now);
  }, 15_000);
  sweepTimer.unref?.();

  async function cleanupExpiredBundles(now: number): Promise<void> {
    try {
      const entries = await fsp.readdir(BUNDLE_ROOT_DIR, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const dir = nodePath.join(BUNDLE_ROOT_DIR, entry.name);
        try {
          const raw = await fsp.readFile(nodePath.join(dir, 'manifest.json'), 'utf8');
          const parsed = JSON.parse(raw) as BundleDiskRecord;
          if (now >= parsed.expiresAt) {
            await fsp.rm(dir, { recursive: true, force: true });
          }
        } catch {
          const stat = await fsp.stat(dir).catch(() => null);
          if (stat && now - stat.mtimeMs > BUNDLE_TTL_MS) {
            await fsp.rm(dir, { recursive: true, force: true });
          }
        }
      }
    } catch {
      // El directorio aún no existe
    }
  }

  async function handleBundleApi(
    req: IncomingMessage,
    res: ServerResponse,
    reqPath: string,
    method: string
  ): Promise<void> {
    // POST /api/bundles -> Inicializar paquete en disco (idempotente)
    if (reqPath === '/api/bundles' && method === 'POST') {
      const body = await readJsonBody<{
        playlistName?: string;
        block?: string;
        tracks?: BundleTrackMeta[];
      }>(req);

      await handleIdempotentJson(req, res, 'POST:/api/bundles', async () => {
        const tracks = Array.isArray(body.tracks) ? body.tracks : [];
        if (tracks.length === 0 || tracks.length > 300) {
          return { status: 400, body: { error: 'La playlist debe tener entre 1 y 300 canciones.' } };
        }

        const id = generateRoomCode() + generateRoomCode().slice(0, 2);
        const bundleDir = nodePath.join(BUNDLE_ROOT_DIR, id);
        await fsp.mkdir(bundleDir, { recursive: true });

        const now = Date.now();
        const record: BundleDiskRecord = {
          id,
          playlistName: String(body.playlistName ?? 'Playlist').slice(0, 80) || 'Playlist',
          block: String(body.block ?? 'Fiesta Principal').slice(0, 40),
          createdAt: now,
          expiresAt: now + BUNDLE_TTL_MS,
          tracks: tracks.map((t) => ({
            title: String(t.title ?? 'Sin título').slice(0, 120),
            artist: String(t.artist ?? 'Biblioteca Local').slice(0, 120),
            fileName: String(t.fileName ?? 'pista.mp3').slice(0, 140),
            duration: Number(t.duration) || 0,
            bpm: typeof t.bpm === 'number' ? t.bpm : null,
            block: String(t.block ?? 'Fiesta Principal').slice(0, 40),
            mimeType: String(t.mimeType ?? 'audio/mpeg').slice(0, 60),
            byteLength: Number(t.byteLength) || 0,
          })),
        };

        await fsp.writeFile(nodePath.join(bundleDir, 'manifest.json'), JSON.stringify(record), 'utf8');
        return { status: 201, body: { id, expiresAt: record.expiresAt } };
      });
      return;
    }

    const trackUploadMatch = reqPath.match(/^\/api\/bundles\/([A-Za-z0-9_-]+)\/tracks\/(\d+)$/);
    if (trackUploadMatch) {
      const id = trackUploadMatch[1].toUpperCase();
      const idx = Number(trackUploadMatch[2]);
      const bundleDir = nodePath.join(BUNDLE_ROOT_DIR, id);
      const manifestPath = nodePath.join(bundleDir, 'manifest.json');

      let record: BundleDiskRecord;
      try {
        record = JSON.parse(await fsp.readFile(manifestPath, 'utf8')) as BundleDiskRecord;
      } catch {
        sendJson(res, 404, { error: 'Paquete no encontrado o expirado.' });
        return;
      }

      if (Date.now() >= record.expiresAt) {
        await fsp.rm(bundleDir, { recursive: true, force: true });
        sendJson(res, 410, { error: 'El link de la playlist expiró.' });
        return;
      }

      if (!Number.isInteger(idx) || idx < 0 || idx >= record.tracks.length) {
        sendJson(res, 404, { error: 'Índice de pista inválido.' });
        return;
      }

      const binPath = nodePath.join(bundleDir, `track-${idx}.bin`);

      if (method === 'POST') {
        let received = 0;
        const writeStream = fs.createWriteStream(binPath);
        try {
          for await (const chunk of req) {
            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            received += buf.length;
            if (received > MAX_UPLOAD_BYTES) {
              writeStream.destroy();
              await fsp.rm(binPath, { force: true });
              sendJson(res, 413, { error: 'Archivo excede 35 MB.' });
              return;
            }
            writeStream.write(buf);
          }
          await new Promise<void>((resolve, reject) => {
            writeStream.end(() => resolve());
            writeStream.on('error', reject);
          });
          sendJson(res, 200, { ok: true, bytes: received });
        } catch {
          writeStream.destroy();
          sendJson(res, 500, { error: 'Error al guardar pista en paquete.' });
        }
        return;
      }

      if (method === 'GET') {
        try {
          const stat = await fsp.stat(binPath);
          res.statusCode = 200;
          res.setHeader('Content-Type', record.tracks[idx].mimeType || 'audio/mpeg');
          res.setHeader('Content-Length', stat.size);
          res.setHeader('Cache-Control', 'no-store');
          fs.createReadStream(binPath).pipe(res);
        } catch {
          sendJson(res, 404, { error: 'Archivo de pista aún no disponible.' });
        }
        return;
      }
    }

    const getMatch = reqPath.match(/^\/api\/bundles\/([A-Za-z0-9_-]+)$/);
    if (getMatch && method === 'GET') {
      const id = getMatch[1].toUpperCase();
      const bundleDir = nodePath.join(BUNDLE_ROOT_DIR, id);
      try {
        const record = JSON.parse(
          await fsp.readFile(nodePath.join(bundleDir, 'manifest.json'), 'utf8')
        ) as BundleDiskRecord;
        if (Date.now() >= record.expiresAt) {
          await fsp.rm(bundleDir, { recursive: true, force: true });
          sendJson(res, 410, { error: 'El link de la playlist expiró.' });
          return;
        }
        sendJson(res, 200, record);
      } catch {
        sendJson(res, 404, { error: 'Playlist compartida no encontrada o expirada.' });
      }
      return;
    }

    sendJson(res, 404, { error: 'Ruta de paquete no encontrada.' });
  }

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
      if (t.policy !== 'ALLOW') return false;
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

      if (!trackMeta || trackMeta.policy !== 'ALLOW') return false;
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

  const handleHttp = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const rawUrl = req.url ?? '';
    const url = new URL(rawUrl, 'http://localhost');
    const reqPath = url.pathname;
    const method = (req.method ?? 'GET').toUpperCase();

    if (reqPath.startsWith('/api/bundles')) {
      try {
        await handleBundleApi(req, res, reqPath, method);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Error interno en paquete.';
        if (!res.headersSent) sendJson(res, 400, { error: message });
      }
      return;
    }

    if (reqPath.startsWith('/api/catalog')) {
      try {
        await handleCatalogApi(res, reqPath, url, method);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Error al consultar catálogo.';
        if (!res.headersSent) sendJson(res, 500, { error: message });
      }
      return;
    }

    const path = reqPath;

    try {
      // POST /api/rooms -> Crear sala (idempotente por Idempotency-Key)
      if (path === '/api/rooms' && method === 'POST') {
        const body = await readJsonBody<{
          hostName?: string;
          password?: string;
          durationHours?: number;
          customCode?: string;
        }>(req);

        await handleIdempotentJson(req, res, 'POST:/api/rooms', async () => {
          const requestedCode = (body.customCode ?? '')
            .trim()
            .toUpperCase()
            .replace(/[^A-Z0-9_-]/g, '')
            .slice(0, 16);
          let code = requestedCode || generateRoomCode();
          while (rooms.has(code)) {
            code = generateRoomCode();
          }

          const password = String(body.password ?? '');
          const durationHours = Math.min(
            MAX_ROOM_HOURS,
            Math.max(0.25, Number(body.durationHours) || MAX_ROOM_HOURS)
          );
          const now = Date.now();
          const expiresAt = now + durationHours * 3600 * 1000;
          const hostId = `host-${crypto.randomUUID()}`;
          const hostName = (body.hostName ?? 'Host DJ').trim().slice(0, 32) || 'Host DJ';
          const salt = crypto.randomBytes(12).toString('hex');
          const inviteToken = crypto.randomBytes(12).toString('base64url');

          const hostParticipant: RoomParticipant = {
            id: hostId,
            name: hostName,
            isHost: true,
            joinedAt: now,
            permissions: { canSkip: true, canPause: true, canAdd: true, canRemove: true },
          };

          const room: RoomRecord = {
            code,
            passwordHash: hashPassword(password, salt),
            passwordSalt: salt,
            hostId,
            inviteToken,
            createdAt: now,
            expiresAt,
            maxDurationHours: durationHours,
            participants: new Map([[hostId, hostParticipant]]),
            tracks: [],
            nowPlayingTitle: null,
            isPlaying: false,
            sseClients: new Map(),
            wsClients: new Map(),
          };

          rooms.set(code, room);
          return {
            status: 201,
            body: {
              participantId: hostId,
              room: toPublicRoom(room),
            },
          };
        });
        return;
      }

      const match = path.match(/^\/api\/rooms\/([^/]+)(?:\/(.*))?$/);
      if (!match) {
        sendJson(res, 404, { error: 'Ruta de sala no encontrada.' });
        return;
      }

      const code = decodeURIComponent(match[1]).trim().toUpperCase();
      const subPath = match[2] ?? '';
      const room = rooms.get(code);

      if (!room) {
        sendJson(res, 404, { error: 'La sala no existe o ya se autodestruyó.' });
        return;
      }

      if (Date.now() >= room.expiresAt) {
        destroyRoom(code, 'Tiempo límite de sala cumplido.');
        sendJson(res, 410, { error: 'La sala expiró y se autodestruyó.' });
        return;
      }

      // POST /api/rooms/:code/join (soporta link directo con inviteToken sin clave, e idempotencia)
      if (subPath === 'join' && method === 'POST') {
        const body = await readJsonBody<{
          password?: string;
          inviteToken?: string;
          userName?: string;
        }>(req);
        await handleIdempotentJson(req, res, `POST:/api/rooms/${code}/join`, async () => {
          const inviteValid = verifyInviteToken(String(body.inviteToken ?? ''), room.inviteToken);
          const password = String(body.password ?? '');
          if (!inviteValid && !verifyPassword(password, room.passwordSalt, room.passwordHash)) {
            return { status: 403, body: { error: 'Clave incorrecta.' } };
          }

          const participantId = `usr-${crypto.randomUUID()}`;
          const userName = (body.userName ?? 'Invitado').trim().slice(0, 32) || 'Invitado';
          const participant: RoomParticipant = {
            id: participantId,
            name: userName,
            isHost: false,
            joinedAt: Date.now(),
            permissions: { canSkip: false, canPause: false, canAdd: true, canRemove: false },
          };

          room.participants.set(participantId, participant);
          const publicRoom = toPublicRoom(room);
          broadcastEvent(room, 'room-state', publicRoom);

          return {
            status: 200,
            body: {
              participantId,
              room: publicRoom,
            },
          };
        });
        return;
      }

      // GET /api/rooms/:code/events?participantId=...
      if (subPath === 'events' && method === 'GET') {
        const participantId = url.searchParams.get('participantId') ?? '';
        if (!room.participants.has(participantId)) {
          sendJson(res, 403, { error: 'Participante no autorizado.' });
          return;
        }

        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders?.();

        room.sseClients.set(participantId, res);
        res.write(`event: room-state\ndata: ${JSON.stringify(toPublicRoom(room))}\n\n`);

        const keepAlive = setInterval(() => {
          try {
            res.write(': ping\n\n');
          } catch {
            clearInterval(keepAlive);
          }
        }, 20_000);

        req.on('close', () => {
          clearInterval(keepAlive);
          room.sseClients.delete(participantId);
        });
        return;
      }

      // POST /api/rooms/:code/permissions
      if (subPath === 'permissions' && method === 'POST') {
        const body = await readJsonBody<{
          hostId?: string;
          targetParticipantId?: string;
          permissions?: Partial<RoomPermissions>;
        }>(req);

        if (body.hostId !== room.hostId) {
          sendJson(res, 403, { error: 'Solo el host puede cambiar permisos.' });
          return;
        }

        const target = body.targetParticipantId
          ? room.participants.get(body.targetParticipantId)
          : undefined;
        if (!target || target.isHost) {
          sendJson(res, 404, { error: 'Usuario no encontrado.' });
          return;
        }

        target.permissions = {
          canSkip: Boolean(body.permissions?.canSkip),
          canPause: Boolean(body.permissions?.canPause),
          canAdd: Boolean(body.permissions?.canAdd),
          canRemove: Boolean(body.permissions?.canRemove),
        };

        const publicRoom = toPublicRoom(room);
        broadcastEvent(room, 'room-state', publicRoom);
        sendJson(res, 200, { room: publicRoom });
        return;
      }

      // POST /api/rooms/:code/tracks (idempotente por Idempotency-Key)
      if (subPath === 'tracks' && method === 'POST') {
        const participantId = String(req.headers['x-participant-id'] ?? '');
        const participant = room.participants.get(participantId);
        if (!participant) {
          sendJson(res, 403, { error: 'No perteneces a esta sala.' });
          return;
        }
        if (!participant.isHost && !participant.permissions.canAdd) {
          sendJson(res, 403, { error: 'No tienes permiso para añadir canciones.' });
          return;
        }

        const audioBuffer = await readBinaryBody(req, MAX_UPLOAD_BYTES);
        if (audioBuffer.length === 0) {
          sendJson(res, 400, { error: 'Archivo vacío.' });
          return;
        }

        await handleIdempotentJson(req, res, `POST:/api/rooms/${code}/tracks`, async () => {
          const decodeHeader = (name: string, fallback: string) => {
            const val = req.headers[name];
            if (!val || Array.isArray(val)) return fallback;
            try {
              return decodeURIComponent(val).slice(0, 120) || fallback;
            } catch {
              return val.slice(0, 120) || fallback;
            }
          };

          const trackId = `rtrk-${crypto.randomUUID()}`;
          const fileName = decodeHeader('x-track-filename', 'pista.mp3');
          const title = decodeHeader('x-track-title', fileName);
          const artist = decodeHeader('x-track-artist', participant.name);
          const duration = Math.max(0, Number(req.headers['x-track-duration'] ?? 0) || 0);
          const mimeType = String(req.headers['content-type'] ?? 'audio/mpeg');

          const newTrack: RoomTrackInternal = {
            id: trackId,
            title,
            artist,
            duration,
            addedById: participant.id,
            addedByName: participant.name,
            addedAt: Date.now(),
            mimeType,
            fileName,
            audioBuffer,
          };

          room.tracks.push(newTrack);
          const publicRoom = toPublicRoom(room);
          broadcastEvent(room, 'room-state', publicRoom);
          broadcastEvent(
            room,
            'new-room-track',
            {
              trackId,
              title,
              artist,
              duration,
              fileName,
              mimeType,
              addedByName: participant.name,
            },
            room.hostId
          );

          return { status: 201, body: { trackId, room: publicRoom } };
        });
        return;
      }

      // GET /api/rooms/:code/tracks/:trackId/audio
      const trackAudioMatch = subPath.match(/^tracks\/([A-Za-z0-9_-]+)\/audio$/);
      if (trackAudioMatch && method === 'GET') {
        const participantId = url.searchParams.get('participantId') ?? '';
        if (participantId !== room.hostId) {
          sendJson(res, 403, { error: 'Solo el host descarga el audio para reproducir.' });
          return;
        }
        const track = room.tracks.find((t) => t.id === trackAudioMatch[1]);
        if (!track || !track.audioBuffer) {
          sendJson(res, 404, { error: 'Audio ya procesado o no encontrado.' });
          return;
        }

        const buf = track.audioBuffer;
        track.audioBuffer = null;

        res.statusCode = 200;
        res.setHeader('Content-Type', track.mimeType || 'audio/mpeg');
        res.setHeader('Content-Length', buf.length);
        res.setHeader('Cache-Control', 'no-store');
        res.end(buf);

        broadcastEvent(room, 'room-state', toPublicRoom(room));
        return;
      }

      // DELETE /api/rooms/:code/tracks/:trackId
      const trackDeleteMatch = subPath.match(/^tracks\/([A-Za-z0-9_-]+)$/);
      if (trackDeleteMatch && method === 'DELETE') {
        const body = await readJsonBody<{ participantId?: string }>(req);
        const participant = body.participantId
          ? room.participants.get(body.participantId)
          : undefined;
        if (!participant || (!participant.isHost && !participant.permissions.canRemove)) {
          sendJson(res, 403, { error: 'Sin permiso para eliminar canciones.' });
          return;
        }

        const trackId = trackDeleteMatch[1];
        const target = room.tracks.find((t) => t.id === trackId);
        if (target) {
          target.audioBuffer = null;
        }
        room.tracks = room.tracks.filter((t) => t.id !== trackId);

        const publicRoom = toPublicRoom(room);
        broadcastEvent(room, 'room-state', publicRoom);
        broadcastEvent(
          room,
          'room-command',
          { action: 'remove-track', trackId, byName: participant.name },
          room.hostId
        );
        sendJson(res, 200, { room: publicRoom });
        return;
      }

      // POST /api/rooms/:code/command
      if (subPath === 'command' && method === 'POST') {
        const body = await readJsonBody<{
          participantId?: string;
          action?: 'toggle-play' | 'skip-next' | 'previous';
        }>(req);

        const participant = body.participantId
          ? room.participants.get(body.participantId)
          : undefined;
        if (
          body.action !== 'toggle-play' &&
          body.action !== 'skip-next' &&
          body.action !== 'previous'
        ) {
          sendJson(res, 400, { error: 'Acción inválida.' });
          return;
        }
        const allowed =
          Boolean(participant) &&
          (participant!.isHost ||
            (body.action === 'toggle-play'
              ? participant!.permissions.canPause
              : participant!.permissions.canSkip));
        if (!allowed || !participant) {
          sendJson(res, 403, { error: 'Sin permiso para controlar reproducción.' });
          return;
        }

        broadcastEvent(
          room,
          'room-command',
          { action: body.action, byName: participant.name },
          room.hostId
        );
        sendJson(res, 200, { ok: true });
        return;
      }

      // POST /api/rooms/:code/state
      if (subPath === 'state' && method === 'POST') {
        const body = await readJsonBody<{
          hostId?: string;
          nowPlayingTitle?: string | null;
          isPlaying?: boolean;
          tracks?: RoomTrackItemSync[];
        }>(req);

        if (body.hostId !== room.hostId) {
          sendJson(res, 403, { error: 'Solo el host sincroniza el estado.' });
          return;
        }

        room.nowPlayingTitle = body.nowPlayingTitle ?? null;
        room.isPlaying = Boolean(body.isPlaying);
        if (Array.isArray(body.tracks)) {
          const existingMap = new Map(room.tracks.map((t) => [t.id, t]));
          room.tracks = body.tracks.map((item) => {
            const prev = existingMap.get(item.id);
            return {
              id: item.id,
              title: item.title,
              artist: item.artist,
              duration: item.duration,
              addedById: prev?.addedById ?? room.hostId,
              addedByName: prev?.addedByName ?? 'Host',
              addedAt: prev?.addedAt ?? Date.now(),
              mimeType: prev?.mimeType ?? 'audio/mpeg',
              fileName: prev?.fileName ?? item.title,
              audioBuffer: prev?.audioBuffer ?? null,
            };
          });
        }

        const publicRoom = toPublicRoom(room);
        broadcastEvent(room, 'room-state', publicRoom);
        sendJson(res, 200, { room: publicRoom });
        return;
      }

      // GET /api/rooms/:code?participantId=...
      if (subPath === '' && method === 'GET') {
        const participantId = url.searchParams.get('participantId') ?? '';
        if (!room.participants.has(participantId)) {
          sendJson(res, 403, { error: 'Participante no autorizado.' });
          return;
        }
        sendJson(res, 200, { room: toPublicRoom(room) });
        return;
      }

      // DELETE /api/rooms/:code
      if (subPath === '' && method === 'DELETE') {
        const body = await readJsonBody<{ hostId?: string }>(req);
        if (body.hostId !== room.hostId) {
          sendJson(res, 403, { error: 'Solo el host puede cerrar la sala.' });
          return;
        }
        destroyRoom(code, 'El host cerró la sala.');
        sendJson(res, 200, { closed: true });
        return;
      }

      sendJson(res, 404, { error: 'Endpoint de sala no encontrado.' });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Error interno en sala.';
      sendJson(res, 400, { error: message });
    }
  };

  const handleUpgrade = (req: IncomingMessage, socket: Duplex, _head: Buffer): boolean => {
    const rawUrl = req.url ?? '';
    const url = new URL(rawUrl, 'http://localhost');
    const wsMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/ws$/);
    if (!wsMatch) return false;

    const code = decodeURIComponent(wsMatch[1]).trim().toUpperCase();
    const participantId = url.searchParams.get('participantId') ?? '';
    const wsKey = req.headers['sec-websocket-key'];

    if (!wsKey || Array.isArray(wsKey)) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return true;
    }

    const room = rooms.get(code);
    if (!room || Date.now() >= room.expiresAt || !room.participants.has(participantId)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return true;
    }

    const acceptKey = crypto
      .createHash('sha1')
      .update(`${wsKey.trim()}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');

    const rawSock = socket as Socket;
    rawSock.setNoDelay?.(true);
    rawSock.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey}\r\n\r\n`
    );

    attachWsClient(room, participantId, rawSock);
    return true;
  };

  return { handleHttp, handleUpgrade };
}

function proxyUpgradeToSharedHub(req: IncomingMessage, clientSocket: Duplex, head: Buffer): void {
  const upstream = net.connect(HUB_PORT, HUB_HOST, () => {
    upstream.setNoDelay(true);
    (clientSocket as Socket).setNoDelay?.(true);
    const lines: string[] = [`${req.method ?? 'GET'} ${req.url ?? '/'} HTTP/1.1`];
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined) continue;
      if (k.toLowerCase() === 'host') {
        lines.push(`Host: ${HUB_HOST}:${HUB_PORT}`);
        continue;
      }
      if (Array.isArray(v)) {
        for (const item of v) lines.push(`${k}: ${item}`);
      } else {
        lines.push(`${k}: ${v}`);
      }
    }
    lines.push('', '');
    upstream.write(lines.join('\r\n'));
    if (head.length > 0) upstream.write(head);
    clientSocket.pipe(upstream);
    upstream.pipe(clientSocket);
  });

  const teardown = () => {
    if (!clientSocket.destroyed) clientSocket.destroy();
    if (!upstream.destroyed) upstream.destroy();
  };
  upstream.on('error', teardown);
  clientSocket.on('error', teardown);
}

/**
 * Proxy HTTP/SSE hacia el Hub compartido en 127.0.0.1:4179 para que
 * `npm run dev` (PC localhost) y `vite preview` (Cloudflare Tunnel móvil)
 * compartan exactamente las mismas salas en tiempo real.
 */
function proxyToSharedHub(req: IncomingMessage, res: ServerResponse): void {
  const headers = { ...req.headers, host: `${HUB_HOST}:${HUB_PORT}` };
  const proxyReq = http.request(
    {
      hostname: HUB_HOST,
      port: HUB_PORT,
      path: req.url,
      method: req.method,
      headers,
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
      proxyRes.pipe(res);
    }
  );

  proxyReq.on('error', () => {
    if (!res.headersSent) {
      sendJson(res, 502, { error: 'Hub de sala temporalmente no disponible.' });
    }
  });

  res.on('close', () => {
    if (!res.writableEnded) {
      proxyReq.destroy();
    }
  });

  req.pipe(proxyReq);
}

function createSharedRoomBridge() {
  const { handleHttp, handleUpgrade } = createRoomRequestHandler();
  let mode: 'pending' | 'hub' | 'proxy' = 'pending';

  const hubServer = http.createServer((req, res) => {
    void handleHttp(req, res);
  });

  hubServer.on('upgrade', (req, socket, head) => {
    if (!handleUpgrade(req, socket, head)) {
      socket.destroy();
    }
  });

  hubServer.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      mode = 'proxy';
    }
  });

  const g = globalThis as Record<string, unknown>;
  const prevHub = g.__gradmixHubServer as (http.Server & { closeAllConnections?: () => void }) | undefined;
  const startListen = () => {
    g.__gradmixHubServer = hubServer;
    hubServer.listen(HUB_PORT, HUB_HOST, () => {
      mode = 'hub';
    });
    hubServer.unref?.();
  };

  if (prevHub && prevHub !== hubServer) {
    try {
      prevHub.closeAllConnections?.();
      prevHub.close(() => startListen());
    } catch {
      startListen();
    }
  } else {
    startListen();
  }

  const middleware: Connect.NextHandleFunction = (req, res, next) => {
    const rawUrl = req.url ?? '';
    if (
      !rawUrl.startsWith('/api/rooms') &&
      !rawUrl.startsWith('/api/bundles') &&
      !rawUrl.startsWith('/api/catalog')
    ) {
      next();
      return;
    }

    // /api/bundles y /api/catalog funcionan directo en este servidor
    // sin depender del Hub en memoria de 4179.
    if (rawUrl.startsWith('/api/bundles') || rawUrl.startsWith('/api/catalog')) {
      void handleHttp(req, res);
      return;
    }

    if (mode === 'proxy') {
      proxyToSharedHub(req, res);
      return;
    }

    void handleHttp(req, res);
  };

  const attachUpgrade = (httpServer: http.Server | null | undefined) => {
    if (!httpServer) return;
    httpServer.on('upgrade', (req, socket, head) => {
      const rawUrl = req.url ?? '';
      if (!/^\/api\/rooms\/[^/]+\/ws(\?|$)/.test(rawUrl)) return;
      if (mode === 'proxy') {
        proxyUpgradeToSharedHub(req, socket, head);
        return;
      }
      handleUpgrade(req, socket, head);
    });
  };

  return { middleware, attachUpgrade };
}

export function gradmixRoomPlugin(): Plugin {
  return {
    name: 'gradmix-room-relay',
    configureServer(server) {
      const bridge = createSharedRoomBridge();
      server.middlewares.use(bridge.middleware);
      bridge.attachUpgrade(server.httpServer as http.Server | null);
    },
    configurePreviewServer(server) {
      const bridge = createSharedRoomBridge();
      server.middlewares.use(bridge.middleware);
      bridge.attachUpgrade(server.httpServer as http.Server | null);
    },
  };
}
