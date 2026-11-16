/**
 * Prueba de humo del API de GradMix (salas + paquetes).
 *
 *   node scripts/smoke.mjs                                # contra wrangler dev
 *   node scripts/smoke.mjs https://api.gradmix.arc03.online
 *
 * Crea una sala efímera con código aleatorio, ejercita WebSocket, SSE, subida y
 * descarga de audio, permisos, comandos y un paquete de playlist, y al final
 * cierra la sala para no dejar basura en R2.
 */
const BASE = (process.argv[2] || 'http://127.0.0.1:8787').replace(/\/+$/, '');
const WS_BASE = BASE.replace(/^http/i, 'ws');
const ORIGIN = 'https://gradmix.arc03.online';

let passed = 0;
function assert(cond, message) {
  if (!cond) throw new Error(`FALLO: ${message}`);
  passed += 1;
  console.log(`ok - ${message}`);
}

async function postJson(path, body, headers = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data = {};
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  return { status: res.status, data };
}

function randomCode(prefix) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = prefix;
  for (let i = 0; i < 5; i += 1) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}

/** Colector de eventos WebSocket: permite esperar eventos sin perder frames. */
function createWsCollector(ws) {
  const seen = [];
  const waiters = [];
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(String(ev.data));
    seen.push(msg.event);
    for (const waiter of [...waiters]) {
      if (waiter.event !== msg.event) continue;
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve();
    }
  });
  return {
    seen,
    waitFor(eventName, timeoutMs = 8000) {
      if (seen.includes(eventName)) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const waiter = {
          event: eventName,
          resolve: () => {
            clearTimeout(timer);
            resolve();
          },
        };
        const timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error(`timeout esperando ${eventName}`));
        }, timeoutMs);
        waiters.push(waiter);
      });
    },
  };
}

console.log(`Probando API en ${BASE}\n`);

// --- Salud y CORS ---
const health = await fetch(`${BASE}/api/health`, { headers: { Origin: ORIGIN } });
assert(health.status === 200, 'GET /api/health responde 200');
assert(
  health.headers.get('access-control-allow-origin') === ORIGIN,
  'CORS permite https://gradmix.arc03.online'
);

const preflight = await fetch(`${BASE}/api/rooms`, {
  method: 'OPTIONS',
  headers: {
    Origin: ORIGIN,
    'Access-Control-Request-Method': 'POST',
    'Access-Control-Request-Headers': 'content-type,x-participant-id',
  },
});
assert(preflight.status === 204, 'preflight OPTIONS responde 204');

const blocked = await fetch(`${BASE}/api/rooms`, {
  method: 'OPTIONS',
  headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' },
});
assert(blocked.status === 403, 'preflight de origen desconocido responde 403');

// --- Sala ---
const code = randomCode('QA');
const created = await postJson('/api/rooms', {
  hostName: 'Host Smoke',
  password: 'clave123',
  durationHours: 1,
  customCode: code,
});
assert(created.status === 201, `crear sala ${code} (status ${created.status})`);
const hostId = created.data.participantId;
const room = created.data.room;
assert(room?.code === code, 'código personalizado respetado');
assert(typeof room?.inviteToken === 'string' && room.inviteToken.length > 6, 'inviteToken presente');

const wrong = await postJson(`/api/rooms/${code}/join`, { password: 'mala', userName: 'Intruso' });
assert(wrong.status === 403, 'clave incorrecta rechazada');

const joined = await postJson(`/api/rooms/${code}/join`, { password: 'clave123', userName: 'Invitado' });
assert(joined.status === 200, 'join con clave correcta');
const guestId = joined.data.participantId;
assert(joined.data.room.participants.length === 2, 'dos participantes en la sala');

const invited = await postJson(`/api/rooms/${code}/join`, {
  inviteToken: room.inviteToken,
  userName: 'Invitado Token',
});
assert(invited.status === 200, 'join con token de invitación');

const snapshot = await fetch(`${BASE}/api/rooms/${code}?participantId=${hostId}`);
assert(snapshot.status === 200, 'GET estado de sala con participante válido');

const unauthorized = await fetch(`${BASE}/api/rooms/${code}?participantId=nope`);
assert(unauthorized.status === 403, 'estado sin participante -> 403');

// --- WebSocket ---
const ws = new WebSocket(`${WS_BASE}/api/rooms/${code}/ws?participantId=${hostId}`);
const collector = createWsCollector(ws);
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('timeout abriendo WebSocket')), 8000);
  ws.addEventListener('open', () => {
    clearTimeout(timer);
    resolve();
  });
  ws.addEventListener('error', () => {
    clearTimeout(timer);
    reject(new Error('error abriendo WebSocket'));
  });
});
ws.send(JSON.stringify({ type: 'sync' }));
await collector.waitFor('room-state');
assert(true, 'WebSocket entrega room-state');

// --- Subida de pista por invitado ---
const audioBytes = new Uint8Array(256 * 1024).map((_, i) => i % 251);
const upload = await fetch(`${BASE}/api/rooms/${code}/tracks`, {
  method: 'POST',
  headers: {
    'Content-Type': 'audio/mpeg',
    'x-participant-id': guestId,
    'x-track-filename': encodeURIComponent('tema de prueba.mp3'),
    'x-track-title': encodeURIComponent('Tema de Prueba'),
    'x-track-artist': encodeURIComponent('Artista QA'),
  },
  body: audioBytes,
});
const uploadData = await upload.json();
assert(upload.status === 201, `subir pista a la sala (status ${upload.status})`);
const trackId = uploadData.trackId;
assert(Boolean(trackId), 'trackId devuelto al subir');
assert(uploadData.room.tracks.length === 1, 'pista visible en el estado de sala');

await collector.waitFor('new-room-track');
assert(true, 'host recibe new-room-track por WebSocket');

// --- SSE ---
const sseController = new AbortController();
const sse = await fetch(`${BASE}/api/rooms/${code}/events?participantId=${guestId}`, {
  signal: sseController.signal,
});
assert(
  sse.status === 200 && (sse.headers.get('content-type') || '').includes('text/event-stream'),
  'SSE conectado'
);
const reader = sse.body.getReader();
const firstChunk = await Promise.race([
  reader.read(),
  new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), 5000)),
]);
sseController.abort();
const sseText = firstChunk?.value ? new TextDecoder().decode(firstChunk.value) : '';
assert(sseText.includes('event: room-state'), 'SSE envía room-state inicial');

// --- Audio: solo el host y una sola vez ---
const guestAudio = await fetch(
  `${BASE}/api/rooms/${code}/tracks/${trackId}/audio?participantId=${guestId}`
);
assert(guestAudio.status === 403, 'solo el host descarga el audio');

const audioResp = await fetch(
  `${BASE}/api/rooms/${code}/tracks/${trackId}/audio?participantId=${hostId}`
);
const audioBody = new Uint8Array(await audioResp.arrayBuffer());
assert(audioResp.status === 200, 'host descarga el audio');
assert(audioBody.byteLength === audioBytes.byteLength, 'bytes de audio intactos');
assert(
  audioResp.headers.get('content-type') === 'audio/mpeg',
  'content-type del audio conservado'
);

const secondDownload = await fetch(
  `${BASE}/api/rooms/${code}/tracks/${trackId}/audio?participantId=${hostId}`
);
assert(secondDownload.status === 404, 'el audio se consume una sola vez');

// --- Permisos y comandos ---
const noPerm = await postJson(`/api/rooms/${code}/command`, {
  participantId: guestId,
  action: 'toggle-play',
});
assert(noPerm.status === 403, 'invitado sin permiso no puede pausar');

const grant = await postJson(`/api/rooms/${code}/permissions`, {
  hostId,
  targetParticipantId: guestId,
  permissions: { canSkip: true, canPause: true, canAdd: true, canRemove: false },
});
assert(
  grant.status === 200 &&
    grant.data.room.participants.find((p) => p.id === guestId).permissions.canPause,
  'el host actualiza permisos'
);

const nowPerm = await postJson(`/api/rooms/${code}/command`, {
  participantId: guestId,
  action: 'toggle-play',
});
assert(nowPerm.status === 200, 'invitado con permiso puede pausar');

const syncState = await postJson(`/api/rooms/${code}/state`, {
  hostId,
  nowPlayingTitle: 'Tema de Prueba',
  isPlaying: true,
});
assert(
  syncState.status === 200 && syncState.data.room.nowPlayingTitle === 'Tema de Prueba',
  'el host sincroniza el estado'
);

// --- Paquete (link de playlist) ---
const bundle = await postJson('/api/bundles', {
  playlistName: 'Playlist Smoke',
  block: 'Fiesta Principal',
  tracks: [
    {
      title: 'Tema de Prueba',
      artist: 'Artista QA',
      fileName: 'tema.mp3',
      duration: 180,
      bpm: 120,
      block: 'Fiesta Principal',
      mimeType: 'audio/mpeg',
      byteLength: audioBytes.byteLength,
    },
  ],
});
assert(bundle.status === 201 && Boolean(bundle.data.id), 'crear paquete');
const bundleId = bundle.data.id;

const bundleUpload = await fetch(`${BASE}/api/bundles/${bundleId}/tracks/0`, {
  method: 'POST',
  headers: { 'Content-Type': 'audio/mpeg' },
  body: audioBytes,
});
assert(bundleUpload.status === 200, 'subir audio al paquete');

const manifest = await fetch(`${BASE}/api/bundles/${bundleId}`);
const manifestData = await manifest.json();
assert(
  manifestData.playlistName === 'Playlist Smoke' && manifestData.tracks.length === 1,
  'manifiesto del paquete'
);

const bundleAudio = await fetch(`${BASE}/api/bundles/${bundleId}/tracks/0`);
const bundleBytes = new Uint8Array(await bundleAudio.arrayBuffer());
assert(bundleBytes.byteLength === audioBytes.byteLength, 'audio del paquete intacto');

const badIndex = await fetch(`${BASE}/api/bundles/${bundleId}/tracks/9`);
assert(badIndex.status === 404, 'índice de pista inválido -> 404');

// --- Cierre ---
const close = await fetch(`${BASE}/api/rooms/${code}`, {
  method: 'DELETE',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ hostId }),
});
assert(close.status === 200, 'el host cierra la sala');

const afterClose = await fetch(`${BASE}/api/rooms/${code}?participantId=${hostId}`);
assert(afterClose.status === 404, 'sala eliminada tras el cierre');

ws.close();
console.log(`\n${passed} comprobaciones OK. Todo correcto.`);
