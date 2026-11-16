import {
  BUNDLE_TTL_MS,
  MAX_UPLOAD_BYTES,
  type BundleRecord,
  type BundleTrackMeta,
  type Env,
  json,
  normalizeCode,
  readJson,
} from './shared.ts';

export class BundleDurableObject implements DurableObject {
  private readonly ctx: DurableObjectState;
  private readonly env: Env;
  private record: BundleRecord | null = null;
  private loaded = false;

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
    ctx.blockConcurrencyWhile(async () => {
      this.record = (await ctx.storage.get<BundleRecord>('bundle')) ?? null;
      this.loaded = true;
    });
  }

  async fetch(request: Request): Promise<Response> {
    if (!this.loaded) {
      await this.ctx.blockConcurrencyWhile(async () => {
        if (!this.loaded) {
          this.record = (await this.ctx.storage.get<BundleRecord>('bundle')) ?? null;
          this.loaded = true;
        }
      });
    }

    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    const path = url.pathname;

    try {
      if (path === '/api/bundles' && method === 'POST') {
        return await this.handleCreate(request);
      }

      const match = path.match(/^\/api\/bundles\/([^/]+)(?:\/(.*))?$/);
      if (!match) return json({ error: 'Ruta de paquete no encontrada.' }, 404);

      const id = normalizeCode(decodeURIComponent(match[1]));
      const subPath = match[2] ?? '';
      const record = this.record;

      if (!record || record.id !== id) {
        return json({ error: 'Paquete no encontrado o expirado.' }, 404);
      }

      if (Date.now() >= record.expiresAt) {
        await this.destroy();
        return json({ error: 'El link de la playlist expiró.' }, 410);
      }

      if (subPath === '' && method === 'GET') {
        return json(record);
      }

      const trackMatch = subPath.match(/^tracks\/(\d+)$/);
      if (trackMatch) {
        const index = Number(trackMatch[1]);
        if (!Number.isInteger(index) || index < 0 || index >= record.tracks.length) {
          return json({ error: 'Índice de pista inválido.' }, 404);
        }
        if (method === 'POST') {
          return await this.handleTrackUpload(request, record, index);
        }
        if (method === 'GET') {
          return await this.handleTrackDownload(record, index);
        }
      }

      return json({ error: 'Ruta de paquete no encontrada.' }, 404);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Error interno en paquete.';
      return json({ error: message }, 400);
    }
  }

  private async handleCreate(request: Request): Promise<Response> {
    if (this.record) {
      return json({ error: 'El paquete ya existe.' }, 409);
    }

    const id = normalizeCode(request.headers.get('x-bundle-id') ?? '');
    if (!id) return json({ error: 'Identificador de paquete inválido.' }, 400);

    const body = await readJson<{
      playlistName?: string;
      block?: string;
      tracks?: BundleTrackMeta[];
    }>(request);

    const tracks = Array.isArray(body.tracks) ? body.tracks : [];
    if (tracks.length === 0 || tracks.length > 300) {
      return json({ error: 'La playlist debe tener entre 1 y 300 canciones.' }, 400);
    }

    const now = Date.now();
    const record: BundleRecord = {
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

    this.record = record;
    await this.ctx.storage.put('bundle', record);
    await this.ctx.storage.setAlarm(record.expiresAt);

    return json({ id, expiresAt: record.expiresAt }, 201);
  }

  private async handleTrackUpload(
    request: Request,
    record: BundleRecord,
    index: number
  ): Promise<Response> {
    const declaredLength = Number(request.headers.get('content-length') ?? 0);
    if (declaredLength > MAX_UPLOAD_BYTES) {
      return json({ error: 'Archivo excede 35 MB.' }, 413);
    }
    if (!request.body) {
      return json({ error: 'Archivo vacío.' }, 400);
    }
    if (!declaredLength || declaredLength <= 0) {
      return json({ error: 'La petición requiere Content-Length.' }, 411);
    }

    const key = bundleAudioKey(record.id, index);
    try {
      // R2 exige streams de longitud conocida: reenviamos el body original
      // (ya validado por Content-Length) en lugar de un TransformStream.
      const stored = await this.env.AUDIO.put(key, request.body, {
        httpMetadata: { contentType: record.tracks[index].mimeType || 'audio/mpeg' },
      });
      if (!stored || stored.size > MAX_UPLOAD_BYTES) {
        await this.env.AUDIO.delete(key).catch(() => {});
        return json({ error: 'Archivo excede 35 MB.' }, 413);
      }
      return json({ ok: true, bytes: stored.size });
    } catch (err) {
      console.error('bundle track upload failed', err);
      await this.env.AUDIO.delete(key).catch(() => {});
      return json({ error: 'No se pudo guardar el audio del paquete.' }, 500);
    }
  }

  private async handleTrackDownload(record: BundleRecord, index: number): Promise<Response> {
    const track = record.tracks[index];
    const object = await this.env.AUDIO.get(bundleAudioKey(record.id, index));
    if (!object) {
      return json({ error: 'Archivo de pista aún no disponible.' }, 404);
    }

    return new Response(object.body, {
      headers: {
        'Content-Type': track.mimeType || 'audio/mpeg',
        'Content-Length': String(object.size),
        'Cache-Control': 'no-store',
      },
    });
  }

  async alarm(): Promise<void> {
    if (!this.record) return;
    if (Date.now() >= this.record.expiresAt) {
      await this.destroy();
      return;
    }
    await this.ctx.storage.setAlarm(this.record.expiresAt);
  }

  private async destroy(): Promise<void> {
    const record = this.record;
    if (record) {
      const listed = await this.env.AUDIO.list({ prefix: `bundles/${record.id}/` });
      await Promise.all(listed.objects.map((obj) => this.env.AUDIO.delete(obj.key)));
    }
    this.record = null;
    await this.ctx.storage.deleteAll();
  }
}

function bundleAudioKey(id: string, index: number): string {
  return `bundles/${id}/track-${index}.bin`;
}
