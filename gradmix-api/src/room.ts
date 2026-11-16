import {
  GUEST_INACTIVITY_MS,
  MAX_ROOM_HOURS,
  MAX_UPLOAD_BYTES,
  PASSWORD_ITERATIONS,
  type Env,
  type RoomDoc,
  type RoomParticipant,
  type RoomPermissions,
  type RoomQueuePreviewItem,
  type RoomTrackMeta,
  hashPassword,
  json,
  normalizeCode,
  randomSalt,
  randomToken,
  readJson,
  timingSafeStringEqual,
  verifyPassword,
} from './shared.ts';

interface SseClient {
  participantId: string;
  writer: WritableStreamDefaultWriter<Uint8Array>;
  timer: ReturnType<typeof setInterval>;
}

interface TrackUploadHeaders {
  participantId: string;
  title: string;
  artist: string;
  fileName: string;
  duration: number;
  mimeType: string;
}

export class RoomDurableObject implements DurableObject {
  private readonly ctx: DurableObjectState;
  private readonly env: Env;
  private doc: RoomDoc | null = null;
  private loaded = false;
  private readonly sseClients = new Map<string, SseClient>();
  private readonly lastSeenMemory = new Map<string, number>();
  private readonly encoder = new TextEncoder();

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
    ctx.blockConcurrencyWhile(() => this.hydrateFromStorage());
  }

  private async hydrateFromStorage(): Promise<void> {
    this.doc = (await this.ctx.storage.get<RoomDoc>('room')) ?? null;
    this.lastSeenMemory.clear();
    const seenEntries = await this.ctx.storage.list<number>({ prefix: 'seen:' });
    for (const [k, ts] of seenEntries) {
      if (typeof ts === 'number') {
        this.lastSeenMemory.set(k.slice(5), ts);
      }
    }
    this.loaded = true;
  }

  async fetch(request: Request): Promise<Response> {
    if (!this.loaded) {
      await this.ctx.blockConcurrencyWhile(async () => {
        if (!this.loaded) {
          await this.hydrateFromStorage();
        }
      });
    }

    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    const path = url.pathname;

    try {
      if (path === '/api/rooms' && method === 'POST') {
        return await this.handleCreate(request);
      }

      const match = path.match(/^\/api\/rooms\/([^/]+)(?:\/(.*))?$/);
      if (!match) return json({ error: 'Ruta de sala no encontrada.' }, 404);

      const code = normalizeCode(decodeURIComponent(match[1]));
      const subPath = match[2] ?? '';
      const room = this.doc;

      if (!room || room.code !== code) {
        return json({ error: 'La sala no existe o ya se autodestruyó.' }, 404);
      }

      if (Date.now() >= room.expiresAt) {
        await this.destroyRoom('Tiempo límite de sala cumplido.');
        return json({ error: 'La sala expiró y se autodestruyó.' }, 410);
      }

      if (subPath === 'join' && method === 'POST') return await this.handleJoin(request, room);
      if (subPath === 'events' && method === 'GET') return this.handleEvents(url, room);
      if (subPath === 'ws' && method === 'GET') return this.handleWebSocket(request, url, room);
      if (subPath === 'heartbeat' && method === 'POST') return await this.handleHeartbeat(request, room);
      if (subPath === 'leave' && method === 'POST') return await this.handleLeave(request, room);
      if (subPath === 'now-audio' && method === 'POST') return await this.handleNowAudioUpload(request, room);
      if (subPath === 'now-audio' && method === 'GET') return await this.handleNowAudioGet(request, url, room);
      if (subPath === 'permissions' && method === 'POST') {
        return await this.handlePermissions(request, room);
      }
      if (subPath === 'tracks' && method === 'POST') return await this.handleTrackUpload(request, room);
      if (subPath === 'command' && method === 'POST') return await this.handleCommand(request, room);
      if (subPath === 'state' && method === 'POST') return await this.handleStateSync(request, room);

      const kickMatch = subPath.match(/^participants\/([A-Za-z0-9_-]+)$/);
      if (kickMatch && method === 'DELETE') {
        return await this.handleKickParticipant(request, room, kickMatch[1]);
      }

      const audioMatch = subPath.match(/^tracks\/([A-Za-z0-9_-]+)\/audio$/);
      if (audioMatch && method === 'GET') return await this.handleTrackAudio(url, room, audioMatch[1]);

      const deleteMatch = subPath.match(/^tracks\/([A-Za-z0-9_-]+)$/);
      if (deleteMatch && method === 'DELETE') {
        return await this.handleTrackDelete(request, room, deleteMatch[1]);
      }

      if (subPath === '' && method === 'GET') {
        const participantId = url.searchParams.get('participantId') ?? '';
        if (!this.findParticipant(room, participantId)) {
          return json({ error: 'Participante no autorizado.' }, 403);
        }
        return json({ room: this.publicRoom(room) });
      }

      if (subPath === '' && method === 'DELETE') {
        const body = await readJson<{ hostId?: string }>(request);
        if (body.hostId !== room.hostId) {
          return json({ error: 'Solo el host puede cerrar la sala.' }, 403);
        }
        await this.destroyRoom('El host cerró la sala.');
        return json({ closed: true });
      }

      return json({ error: 'Endpoint de sala no encontrado.' }, 404);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Error interno en sala.';
      return json({ error: message }, 400);
    }
  }

  private async handleCreate(request: Request): Promise<Response> {
    if (this.doc) {
      return json({ error: 'El código de sala ya está en uso.' }, 409);
    }

    const body = await readJson<{
      hostName?: string;
      password?: string;
      durationHours?: number;
      deviceId?: string;
    }>(request);
    const code = normalizeCode(request.headers.get('x-room-code') ?? '');
    if (!code) return json({ error: 'Código de sala inválido.' }, 400);

    const password = String(body.password ?? '');
    const durationHours = Math.min(
      MAX_ROOM_HOURS,
      Math.max(0.25, Number(body.durationHours) || MAX_ROOM_HOURS)
    );
    const now = Date.now();
    const salt = randomSalt();
    const hostId = `host-${crypto.randomUUID()}`;
    const hostName = (body.hostName ?? 'Host DJ').trim().slice(0, 32) || 'Host DJ';
    const hostDeviceId =
      String(body.deviceId ?? '').trim().slice(0, 96) || `host-dev-${code}`;

    const host: RoomParticipant = {
      id: hostId,
      name: hostName,
      isHost: true,
      joinedAt: now,
      lastSeenAt: now,
      deviceId: hostDeviceId,
      permissions: { canSkip: true, canPause: true, canAdd: true, canRemove: true },
    };

    const doc: RoomDoc = {
      code,
      passwordHash: await hashPassword(password, salt),
      passwordSalt: salt,
      passwordIterations: PASSWORD_ITERATIONS,
      hostId,
      inviteToken: randomToken(12),
      createdAt: now,
      expiresAt: now + durationHours * 3600 * 1000,
      maxDurationHours: durationHours,
      participants: [host],
      tracks: [],
      playbackQueue: [],
      nowPlayingTitle: null,
      nowPlayingArtist: null,
      nowPlayingTrackKey: null,
      nowAudioTrackKey: null,
      nowPlayingAudioMime: null,
      hasLiveAudio: false,
      basePositionSec: 0,
      playbackSyncedAtMs: now,
      isPlaying: false,
    };

    this.doc = doc;
    this.lastSeenMemory.set(hostId, now);
    await this.persist(doc);
    await this.scheduleNextAlarm(doc);

    return json({ participantId: hostId, room: this.publicRoom(doc) }, 201);
  }

  private async handleJoin(request: Request, room: RoomDoc): Promise<Response> {
    const body = await readJson<{
      password?: string;
      inviteToken?: string;
      userName?: string;
      deviceId?: string;
    }>(request);

    const inviteValid =
      Boolean(body.inviteToken) &&
      timingSafeStringEqual(String(body.inviteToken ?? ''), room.inviteToken);
    const password = String(body.password ?? '');
    const passwordValid = await verifyPassword(
      password,
      room.passwordSalt,
      room.passwordHash,
      room.passwordIterations
    );

    if (!inviteValid && !passwordValid) {
      return json({ error: 'Clave incorrecta.' }, 403);
    }

    const now = Date.now();
    const userName = (body.userName ?? 'Invitado').trim().slice(0, 32) || 'Invitado';
    const clientIp = (
      request.headers.get('CF-Connecting-IP') ??
      request.headers.get('x-forwarded-for')?.split(',')[0] ??
      ''
    ).trim();
    const deviceId =
      String(body.deviceId ?? '').trim().slice(0, 96) ||
      `ip:${clientIp || 'unknown'}:${userName.toLowerCase()}`;

    // Reutilizar slot si el mismo dispositivo reconecta (evita duplicados)
    const existing = room.participants.find((p) => !p.isHost && p.deviceId === deviceId);
    let participantId: string;

    if (existing) {
      existing.name = userName;
      existing.lastSeenAt = now;
      participantId = existing.id;
    } else {
      participantId = `usr-${crypto.randomUUID()}`;
      const participant: RoomParticipant = {
        id: participantId,
        name: userName,
        isHost: false,
        joinedAt: now,
        lastSeenAt: now,
        deviceId,
        permissions: { canSkip: false, canPause: false, canAdd: true, canRemove: false },
      };
      room.participants.push(participant);
    }

    this.lastSeenMemory.set(participantId, now);
    await this.persist(room);
    await this.scheduleNextAlarm(room);

    const state = this.publicRoom(room);
    this.broadcast('room-state', state);
    return json({ participantId, room: state });
  }

  private handleEvents(url: URL, room: RoomDoc): Response {
    const participantId = url.searchParams.get('participantId') ?? '';
    if (!this.findParticipant(room, participantId)) {
      return json({ error: 'Participante no autorizado.' }, 403);
    }

    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    const key = `${participantId}:${crypto.randomUUID()}`;

    const timer = setInterval(() => {
      writer.write(this.encoder.encode(': ping\n\n')).catch(() => this.closeSseClient(key));
    }, 20_000);

    this.sseClients.set(key, { participantId, writer, timer });
    writer
      .write(
        this.encoder.encode(
          `event: room-state\ndata: ${JSON.stringify(this.publicRoom(room))}\n\n`
        )
      )
      .catch(() => this.closeSseClient(key));

    return new Response(readable, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'X-Accel-Buffering': 'no',
      },
    });
  }

  private closeSseClient(key: string): void {
    const client = this.sseClients.get(key);
    if (!client) return;
    clearInterval(client.timer);
    this.sseClients.delete(key);
    client.writer.close().catch(() => { });
  }

  private handleWebSocket(request: Request, url: URL, room: RoomDoc): Response {
    const participantId = url.searchParams.get('participantId') ?? '';
    if ((request.headers.get('Upgrade') ?? '').toLowerCase() !== 'websocket') {
      return json({ error: 'Se requiere WebSocket.' }, 400);
    }
    if (!this.findParticipant(room, participantId)) {
      return json({ error: 'Participante no autorizado.' }, 403);
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ participantId });
    this.touchParticipant(room, participantId);

    server.send(
      JSON.stringify({ event: 'room-state', data: this.publicRoom(room) })
    );

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') return;
    const attachment = ws.deserializeAttachment() as { participantId?: string } | null;
    if (this.doc && attachment?.participantId) {
      this.touchParticipant(this.doc, attachment.participantId);
    }
    try {
      const parsed = JSON.parse(message) as { type?: string };
      if (parsed.type === 'sync' && this.doc) {
        ws.send(JSON.stringify({ event: 'room-state', data: this.publicRoom(this.doc) }));
      } else if (parsed.type === 'audio-heartbeat' && this.doc) {
        ws.send(
          JSON.stringify({
            event: 'audio-pulse',
            data: {
              serverTimeMs: Date.now(),
              isPlaying: this.doc.isPlaying,
              trackKey: this.doc.nowPlayingTrackKey ?? null,
            },
          })
        );
      }
    } catch {
      // Ignorar frames que no sean JSON
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    try {
      ws.close(1000, 'closed');
    } catch {
      // Ignorar
    }
  }

  private async handlePermissions(request: Request, room: RoomDoc): Promise<Response> {
    const body = await readJson<{
      hostId?: string;
      targetParticipantId?: string;
      permissions?: Partial<RoomPermissions>;
    }>(request);

    if (body.hostId !== room.hostId) {
      return json({ error: 'Solo el host puede cambiar permisos.' }, 403);
    }

    const target = body.targetParticipantId
      ? this.findParticipant(room, body.targetParticipantId)
      : undefined;
    if (!target || target.isHost) {
      return json({ error: 'Usuario no encontrado.' }, 404);
    }

    target.permissions = {
      canSkip: Boolean(body.permissions?.canSkip),
      canPause: Boolean(body.permissions?.canPause),
      canAdd: Boolean(body.permissions?.canAdd),
      canRemove: Boolean(body.permissions?.canRemove),
    };

    await this.persist(room);
    const state = this.publicRoom(room);
    this.broadcast('room-state', state);
    return json({ room: state });
  }

  private async handleTrackUpload(request: Request, room: RoomDoc): Promise<Response> {
    const participantId = request.headers.get('x-participant-id') ?? '';
    const participant = this.findParticipant(room, participantId);
    if (!participant) {
      return json({ error: 'No perteneces a esta sala.' }, 403);
    }
    if (!participant.isHost && !participant.permissions.canAdd) {
      return json({ error: 'No tienes permiso para añadir canciones.' }, 403);
    }

    const declaredLength = Number(request.headers.get('content-length') ?? 0);
    if (declaredLength > MAX_UPLOAD_BYTES) {
      return json({ error: 'El archivo excede el límite de 35 MB por pista.' }, 413);
    }
    if (!request.body) {
      return json({ error: 'Archivo vacío.' }, 400);
    }
    if (!declaredLength || declaredLength <= 0) {
      return json({ error: 'La petición requiere Content-Length.' }, 411);
    }

    const headers: TrackUploadHeaders = {
      participantId,
      fileName: decodeHeader(request, 'x-track-filename', 'pista.mp3'),
      title: decodeHeader(request, 'x-track-title', 'pista.mp3'),
      artist: decodeHeader(request, 'x-track-artist', participant.name),
      duration: Math.max(0, Number(request.headers.get('x-track-duration') ?? 0) || 0),
      mimeType: request.headers.get('content-type') ?? 'audio/mpeg',
    };

    const trackId = `rtrk-${crypto.randomUUID()}`;
    const key = roomAudioKey(room.code, trackId);

    try {
      // R2 exige streams de longitud conocida: reenviamos el body original
      // (ya validado por Content-Length) en lugar de un TransformStream.
      const stored = await this.env.AUDIO.put(key, request.body, {
        httpMetadata: { contentType: headers.mimeType },
      });
      if (!stored || stored.size > MAX_UPLOAD_BYTES) {
        await this.env.AUDIO.delete(key).catch(() => { });
        return json({ error: 'El archivo excede el límite de 35 MB por pista.' }, 413);
      }
    } catch (err) {
      console.error('room track upload failed', err);
      await this.env.AUDIO.delete(key).catch(() => { });
      return json({ error: 'No se pudo guardar el audio de la pista.' }, 500);
    }

    const track: RoomTrackMeta = {
      id: trackId,
      title: headers.title,
      artist: headers.artist,
      duration: headers.duration,
      addedById: participant.id,
      addedByName: participant.name,
      addedAt: Date.now(),
      mimeType: headers.mimeType,
      fileName: headers.fileName,
      hasAudioRelay: true,
    };

    room.tracks.push(track);
    await this.persist(room);

    const state = this.publicRoom(room);
    this.broadcast('room-state', state);
    this.broadcast(
      'new-room-track',
      {
        trackId,
        title: track.title,
        artist: track.artist,
        duration: track.duration,
        fileName: track.fileName,
        mimeType: track.mimeType,
        addedByName: participant.name,
      },
      room.hostId
    );

    return json({ trackId, room: state }, 201);
  }

  private async handleTrackAudio(url: URL, room: RoomDoc, trackId: string): Promise<Response> {
    const participantId = url.searchParams.get('participantId') ?? '';
    if (participantId !== room.hostId) {
      return json({ error: 'Solo el host descarga el audio para reproducir.' }, 403);
    }

    const track = room.tracks.find((t) => t.id === trackId);
    if (!track || !track.hasAudioRelay) {
      return json({ error: 'Audio ya procesado o no encontrado.' }, 404);
    }

    const object = await this.env.AUDIO.get(roomAudioKey(room.code, trackId));
    if (!object) {
      track.hasAudioRelay = false;
      await this.persist(room);
      return json({ error: 'Audio no encontrado en el almacenamiento.' }, 404);
    }

    track.hasAudioRelay = false;
    await this.persist(room);
    this.broadcast('room-state', this.publicRoom(room));

    return new Response(object.body, {
      headers: {
        'Content-Type': track.mimeType || 'audio/mpeg',
        'Content-Length': String(object.size),
        'Cache-Control': 'no-store',
      },
    });
  }

  private async handleTrackDelete(
    request: Request,
    room: RoomDoc,
    trackId: string
  ): Promise<Response> {
    const body = await readJson<{ participantId?: string }>(request);
    const participant = body.participantId
      ? this.findParticipant(room, body.participantId)
      : undefined;
    if (!participant || (!participant.isHost && !participant.permissions.canRemove)) {
      return json({ error: 'Sin permiso para eliminar canciones.' }, 403);
    }

    room.tracks = room.tracks.filter((t) => t.id !== trackId);
    await this.persist(room);
    await this.env.AUDIO.delete(roomAudioKey(room.code, trackId)).catch(() => { });

    const state = this.publicRoom(room);
    this.broadcast('room-state', state);
    this.broadcast(
      'room-command',
      { action: 'remove-track', trackId, byName: participant.name },
      room.hostId
    );

    return json({ room: state });
  }

  private async handleCommand(request: Request, room: RoomDoc): Promise<Response> {
    const body = await readJson<{
      participantId?: string;
      action?:
      | 'toggle-play'
      | 'skip-next'
      | 'previous'
      | 'remove-queue-track'
      | 'move-queue-track';
      trackId?: string;
      direction?: 'up' | 'down';
    }>(request);

    const validAction =
      body.action === 'toggle-play' ||
      body.action === 'skip-next' ||
      body.action === 'previous' ||
      body.action === 'remove-queue-track' ||
      body.action === 'move-queue-track';
    if (!validAction) {
      return json({ error: 'Acción inválida.' }, 400);
    }

    if (
      (body.action === 'remove-queue-track' || body.action === 'move-queue-track') &&
      !String(body.trackId ?? '').trim()
    ) {
      return json({ error: 'Falta trackId.' }, 400);
    }
    if (body.action === 'move-queue-track' && body.direction !== 'up' && body.direction !== 'down') {
      return json({ error: 'Dirección inválida.' }, 400);
    }

    const participant = body.participantId
      ? this.findParticipant(room, body.participantId)
      : undefined;

    let allowed = false;
    if (participant) {
      if (participant.isHost) {
        allowed = true;
      } else if (body.action === 'toggle-play') {
        allowed = participant.permissions.canPause;
      } else if (body.action === 'skip-next' || body.action === 'previous') {
        allowed = participant.permissions.canSkip;
      } else if (body.action === 'remove-queue-track') {
        allowed = participant.permissions.canRemove;
      } else if (body.action === 'move-queue-track') {
        allowed = participant.permissions.canAdd;
      }
    }

    if (!allowed || !participant) {
      return json({ error: 'Sin permiso para esta acción en la sala.' }, 403);
    }

    if (body.action === 'toggle-play') {
      room.isPlaying = !room.isPlaying;
      room.playbackSyncedAtMs = Date.now();
      await this.persist(room);
      this.broadcast('room-state', this.publicRoom(room));
      this.broadcast(
        'room-command',
        {
          action: 'toggle-play',
          targetPlaying: room.isPlaying,
          byName: participant.name,
        },
        room.hostId
      );
      return json({ ok: true, isPlaying: room.isPlaying });
    }

    this.broadcast(
      'room-command',
      {
        action: body.action,
        trackId: body.trackId ? String(body.trackId).slice(0, 80) : undefined,
        direction: body.direction,
        byName: participant.name,
      },
      room.hostId
    );
    return json({ ok: true });
  }

  private async handleHeartbeat(request: Request, room: RoomDoc): Promise<Response> {
    const body = await readJson<{ participantId?: string }>(request);
    if (!body.participantId || !this.findParticipant(room, body.participantId)) {
      return json({ error: 'Participante no activo en la sala.' }, 403);
    }
    this.touchParticipant(room, body.participantId);
    return json({ ok: true, serverTimeMs: Date.now() });
  }

  private async handleLeave(request: Request, room: RoomDoc): Promise<Response> {
    const body = await readJson<{ participantId?: string }>(request);
    if (body.participantId && body.participantId !== room.hostId) {
      await this.evictParticipant(room, body.participantId, 'Saliste de la sala.');
    }
    return json({ left: true });
  }

  private async handleKickParticipant(
    request: Request,
    room: RoomDoc,
    targetId: string
  ): Promise<Response> {
    const body = await readJson<{ hostId?: string }>(request);
    if (body.hostId !== room.hostId) {
      return json({ error: 'Solo el host puede eliminar participantes.' }, 403);
    }
    const target = this.findParticipant(room, targetId);
    if (!target || target.isHost) {
      return json({ error: 'Participante no encontrado.' }, 404);
    }
    await this.evictParticipant(room, targetId, 'El host te eliminó de la sala.');
    return json({ room: this.publicRoom(room) });
  }

  private async handleNowAudioUpload(request: Request, room: RoomDoc): Promise<Response> {
    const hostId = request.headers.get('x-host-id') ?? '';
    if (hostId !== room.hostId) {
      return json({ error: 'Solo el host puede emitir el audio de la sala.' }, 403);
    }
    const trackKey = (request.headers.get('x-track-key') ?? '').slice(0, 140);
    if (!trackKey) return json({ error: 'Falta x-track-key.' }, 400);

    const declaredLen = Number(request.headers.get('content-length') ?? 0);
    if (declaredLen > MAX_UPLOAD_BYTES) {
      return json({ error: 'El archivo excede 35 MB.' }, 413);
    }
    if (!request.body || declaredLen <= 0) {
      return json({ error: 'Audio vacío o sin Content-Length.' }, 400);
    }

    const mimeType = request.headers.get('content-type') ?? 'audio/mpeg';
    const r2Key = roomNowAudioKey(room.code);
    try {
      const stored = await this.env.AUDIO.put(r2Key, request.body, {
        httpMetadata: { contentType: mimeType },
      });
      if (!stored || stored.size > MAX_UPLOAD_BYTES) {
        await this.env.AUDIO.delete(r2Key).catch(() => { });
        return json({ error: 'El archivo excede 35 MB.' }, 413);
      }
    } catch {
      return json({ error: 'Error guardando audio en emisión.' }, 500);
    }

    room.nowPlayingTrackKey = trackKey;
    room.nowAudioTrackKey = trackKey;
    room.nowPlayingAudioMime = mimeType;
    room.hasLiveAudio = true;
    await this.persist(room);

    const state = this.publicRoom(room);
    this.broadcast('room-state', state);
    return json({ ok: true, trackKey });
  }

  private async handleNowAudioGet(
    request: Request,
    url: URL,
    room: RoomDoc
  ): Promise<Response> {
    const participantId = url.searchParams.get('participantId') ?? '';
    if (!this.findParticipant(room, participantId)) {
      return json({ error: 'No perteneces a esta sala.' }, 403);
    }
    this.touchParticipant(room, participantId);

    const r2Key = roomNowAudioKey(room.code);
    const rangeHeader = request.headers.get('range');
    const mimeType = room.nowPlayingAudioMime || 'audio/mpeg';

    if (rangeHeader) {
      const m = rangeHeader.match(/bytes=(\d+)-(\d*)/);
      if (m) {
        const headObj = await this.env.AUDIO.head(r2Key);
        if (!headObj) return json({ error: 'No hay audio en emisión aún.' }, 404);
        const total = headObj.size;
        const start = Math.min(total - 1, Number(m[1]));
        const end = m[2] ? Math.min(total - 1, Number(m[2])) : total - 1;
        const length = end - start + 1;
        const obj = await this.env.AUDIO.get(r2Key, { range: { offset: start, length } });
        if (!obj) return json({ error: 'No hay audio en emisión aún.' }, 404);
        return new Response(obj.body, {
          status: 206,
          headers: {
            'Content-Type': mimeType,
            'Content-Range': `bytes ${start}-${end}/${total}`,
            'Content-Length': String(length),
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'no-store',
          },
        });
      }
    }

    const obj = await this.env.AUDIO.get(r2Key);
    if (!obj) {
      return json({ error: 'No hay audio en emisión aún.' }, 404);
    }
    return new Response(obj.body, {
      status: 200,
      headers: {
        'Content-Type': mimeType,
        'Content-Length': String(obj.size),
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
      },
    });
  }

  private async handleStateSync(request: Request, room: RoomDoc): Promise<Response> {
    const body = await readJson<{
      hostId?: string;
      nowPlayingTitle?: string | null;
      nowPlayingArtist?: string | null;
      nowPlayingTrackKey?: string | null;
      basePositionSec?: number;
      isPlaying?: boolean;
      tracks?: Array<{ id: string; title: string; artist: string; duration: number }>;
      playbackQueue?: RoomQueuePreviewItem[];
    }>(request);

    if (body.hostId !== room.hostId) {
      return json({ error: 'Solo el host sincroniza el estado.' }, 403);
    }

    room.nowPlayingTitle = body.nowPlayingTitle ?? null;
    if (body.nowPlayingArtist !== undefined) {
      room.nowPlayingArtist = body.nowPlayingArtist ?? null;
    }
    if (body.nowPlayingTrackKey !== undefined) {
      room.nowPlayingTrackKey = body.nowPlayingTrackKey ?? null;
    }
    if (typeof body.basePositionSec === 'number' && Number.isFinite(body.basePositionSec)) {
      room.basePositionSec = Math.max(0, body.basePositionSec);
      room.playbackSyncedAtMs = Date.now();
    }
    room.isPlaying = Boolean(body.isPlaying);

    if (Array.isArray(body.playbackQueue)) {
      room.playbackQueue = body.playbackQueue.slice(0, 100).map((item) => ({
        id: String(item.id ?? '').slice(0, 80),
        title: String(item.title ?? 'Sin título').slice(0, 140),
        artist: String(item.artist ?? '').slice(0, 100),
        duration: Number(item.duration) || 0,
      }));
    }

    if (Array.isArray(body.tracks)) {
      const existing = new Map(room.tracks.map((t) => [t.id, t]));
      room.tracks = body.tracks.map((item) => {
        const prev = existing.get(item.id);
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
          hasAudioRelay: prev?.hasAudioRelay ?? false,
        };
      });
    }

    await this.pruneInactiveGuests(room, false);
    await this.persist(room);
    const state = this.publicRoom(room);
    this.broadcast('room-state', state);
    return json({ room: state });
  }

  async alarm(): Promise<void> {
    if (!this.doc) return;
    if (Date.now() >= this.doc.expiresAt) {
      await this.destroyRoom('La sala alcanzó su tiempo máximo y se autodestruyó.');
      return;
    }

    const changed = await this.pruneInactiveGuests(this.doc, true);
    if (changed && this.doc) {
      await this.persist(this.doc);
      this.broadcast('room-state', this.publicRoom(this.doc));
    }
    if (this.doc) {
      await this.scheduleNextAlarm(this.doc);
    }
  }

  private getLastSeen(participant: RoomParticipant): number {
    return this.lastSeenMemory.get(participant.id) ?? participant.lastSeenAt ?? participant.joinedAt;
  }

  private touchParticipant(room: RoomDoc, participantId: string): void {
    const p = this.findParticipant(room, participantId);
    if (!p) return;
    const now = Date.now();
    this.lastSeenMemory.set(participantId, now);
    p.lastSeenAt = now;
  }

  private async scheduleNextAlarm(room: RoomDoc): Promise<void> {
    const hasGuests = room.participants.some((p) => !p.isHost);
    const nextCheck = hasGuests
      ? Math.min(room.expiresAt, Date.now() + 5000)
      : room.expiresAt;
    await this.ctx.storage.setAlarm(nextCheck);
  }

  private async pruneInactiveGuests(room: RoomDoc, notifyKicked: boolean): Promise<boolean> {
    const now = Date.now();
    const staleIds = room.participants
      .filter((p) => !p.isHost && now - this.getLastSeen(p) > GUEST_INACTIVITY_MS)
      .map((p) => p.id);

    if (staleIds.length === 0) return false;
    for (const staleId of staleIds) {
      if (notifyKicked) {
        this.broadcast(
          'room-kicked',
          { reason: 'Eliminado por inactividad (10 s sin recibir datos).' },
          staleId
        );
      }
      this.closeParticipantConnections(staleId);
      this.lastSeenMemory.delete(staleId);
    }
    const staleSet = new Set(staleIds);
    room.participants = room.participants.filter((p) => !staleSet.has(p.id));
    return true;
  }

  private closeParticipantConnections(participantId: string): void {
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as { participantId?: string } | null;
      if (attachment?.participantId === participantId) {
        try {
          ws.close(1000, 'kicked');
        } catch {
          // Ignorar
        }
      }
    }
    for (const [key, client] of this.sseClients) {
      if (client.participantId === participantId) {
        this.closeSseClient(key);
      }
    }
  }

  private async evictParticipant(room: RoomDoc, targetId: string, reason: string): Promise<void> {
    if (targetId === room.hostId) return;
    this.broadcast('room-kicked', { reason }, targetId);
    this.closeParticipantConnections(targetId);
    this.lastSeenMemory.delete(targetId);
    room.participants = room.participants.filter((p) => p.id !== targetId);
    await this.persist(room);
    await this.scheduleNextAlarm(room);
    this.broadcast('room-state', this.publicRoom(room));
  }

  private async persist(room: RoomDoc): Promise<void> {
    this.doc = room;
    await this.ctx.storage.put('room', room);
  }

  private async destroyRoom(reason: string): Promise<void> {
    const room = this.doc;
    this.broadcast('room-closed', { reason });
    if (room) {
      for (const track of room.tracks) {
        await this.env.AUDIO.delete(roomAudioKey(room.code, track.id)).catch(() => { });
      }
      await this.env.AUDIO.delete(roomNowAudioKey(room.code)).catch(() => { });
    }
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.close(1000, 'room-closed');
      } catch {
        // Ignorar
      }
    }
    for (const key of Array.from(this.sseClients.keys())) {
      this.closeSseClient(key);
    }
    this.lastSeenMemory.clear();
    this.doc = null;
    await this.ctx.storage.deleteAll();
  }

  private findParticipant(room: RoomDoc, participantId: string): RoomParticipant | undefined {
    return room.participants.find((p) => p.id === participantId);
  }

  private publicRoom(room: RoomDoc) {
    return {
      code: room.code,
      hostId: room.hostId,
      inviteToken: room.inviteToken,
      createdAt: room.createdAt,
      expiresAt: room.expiresAt,
      maxDurationHours: room.maxDurationHours,
      participants: room.participants,
      tracks: room.tracks.map((t) => ({
        id: t.id,
        title: t.title,
        artist: t.artist,
        duration: t.duration,
        addedById: t.addedById,
        addedByName: t.addedByName,
        addedAt: t.addedAt,
        hasAudioRelay: t.hasAudioRelay,
      })),
      playbackQueue: room.playbackQueue ?? [],
      nowPlayingTitle: room.nowPlayingTitle,
      nowPlayingArtist: room.nowPlayingArtist ?? null,
      nowPlayingTrackKey: room.nowPlayingTrackKey ?? null,
      hasLiveAudio: Boolean(
        room.hasLiveAudio &&
        room.nowPlayingTrackKey &&
        room.nowAudioTrackKey === room.nowPlayingTrackKey
      ),
      basePositionSec: room.basePositionSec ?? 0,
      playbackSyncedAtMs: room.playbackSyncedAtMs ?? Date.now(),
      isPlaying: room.isPlaying,
    };
  }

  private broadcast(event: string, data: unknown, onlyParticipantId?: string): void {
    const wsPayload = JSON.stringify({ event, data });
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as { participantId?: string } | null;
      if (onlyParticipantId && attachment?.participantId !== onlyParticipantId) continue;
      try {
        ws.send(wsPayload);
      } catch {
        // Socket cerrado
      }
    }

    const ssePayload = this.encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    for (const [key, client] of this.sseClients) {
      if (onlyParticipantId && client.participantId !== onlyParticipantId) continue;
      client.writer.write(ssePayload).catch(() => this.closeSseClient(key));
    }
  }
}

function roomAudioKey(code: string, trackId: string): string {
  return `rooms/${code}/${trackId}`;
}

function roomNowAudioKey(code: string): string {
  return `rooms/${code}/now-audio`;
}

function decodeHeader(request: Request, name: string, fallback: string): string {
  const raw = request.headers.get(name);
  if (!raw) return fallback;
  try {
    return decodeURIComponent(raw).slice(0, 120) || fallback;
  } catch {
    return raw.slice(0, 120) || fallback;
  }
}
