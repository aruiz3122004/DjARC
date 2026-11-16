import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import net, { type Socket } from 'node:net';
import os from 'node:os';
import nodePath from 'node:path';
import { type Duplex } from 'node:stream';
import type { Connect, Plugin } from 'vite';
import { createCatalogHandler } from './server/catalog.ts';

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
  const catalogHandler = createCatalogHandler();
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
        await catalogHandler.handle(res, reqPath, url, method);
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
