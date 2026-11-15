export interface AudioContainerInspection {
  kind: 'mp4' | 'mp3' | 'ogg' | 'flac' | 'wav' | 'webm' | 'aac' | 'invalid-text' | 'unknown';
  mimeType: string | null;
  codec: string | null;
  encrypted: boolean;
  fragmentedMp4: boolean;
}

export interface SoundCloudTranscodingLike {
  url?: string;
  snipped?: boolean;
  format?: { protocol?: string; mime_type?: string };
}

const ADTS_SAMPLE_RATES = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
];

function readUint32BE(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] << 24) |
      (bytes[offset + 1] << 16) |
      (bytes[offset + 2] << 8) |
      bytes[offset + 3]) >>>
    0
  );
}

function readAscii4(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(
    bytes[offset] ?? 0,
    bytes[offset + 1] ?? 0,
    bytes[offset + 2] ?? 0,
    bytes[offset + 3] ?? 0
  );
}

function readBoxHeader(
  bytes: Uint8Array,
  offset: number,
  limit: number
): { type: string; headerSize: number; boxSize: number } | null {
  if (offset + 8 > limit) return null;
  const rawSize = readUint32BE(bytes, offset);
  const type = readAscii4(bytes, offset + 4);
  if (rawSize === 0) {
    return { type, headerSize: 8, boxSize: limit - offset };
  }
  if (rawSize === 1) {
    if (offset + 16 > limit) return null;
    const high = readUint32BE(bytes, offset + 8);
    const low = readUint32BE(bytes, offset + 12);
    const boxSize = high * 4294967296 + low;
    if (boxSize < 16 || offset + boxSize > limit) return null;
    return { type, headerSize: 16, boxSize };
  }
  if (rawSize < 8 || offset + rawSize > limit) return null;
  return { type, headerSize: 8, boxSize: rawSize };
}

function scanMp4MoovBoxes(
  bytes: Uint8Array,
  start: number,
  end: number,
  state: { encrypted: boolean; codec: string | null; esdsConfig: { profile: number; freqIdx: number; chanCfg: number } | null }
): void {
  const containerBoxes = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl']);
  let offset = start;

  while (offset + 8 <= end) {
    const box = readBoxHeader(bytes, offset, end);
    if (!box) break;
    const contentStart = offset + box.headerSize;
    const contentEnd = offset + box.boxSize;

    if (box.type === 'enca' || box.type === 'encv' || box.type === 'sinf' || box.type === 'schi') {
      state.encrypted = true;
    } else if (box.type === 'mp4a') {
      if (!state.codec) state.codec = 'aac';
      // AudioSampleEntry tiene 28 bytes de cabecera antes de cajas hijas (esds/btrt)
      if (contentStart + 28 < contentEnd) {
        scanMp4MoovBoxes(bytes, contentStart + 28, contentEnd, state);
      }
    } else if (box.type === 'alac' || box.type === 'ac-3' || box.type === 'ec-3' || box.type === 'mlpa' || box.type === 'Opus') {
      state.codec = box.type === 'Opus' ? 'opus' : box.type;
    } else if (box.type === 'stsd') {
      // FullBox (4 bytes flags) + entry_count (4 bytes) = 8 bytes
      if (contentStart + 8 < contentEnd) {
        scanMp4MoovBoxes(bytes, contentStart + 8, contentEnd, state);
      }
    } else if (box.type === 'esds') {
      state.esdsConfig = parseAudioSpecificConfigFromEsds(bytes, contentStart, contentEnd);
    } else if (containerBoxes.has(box.type)) {
      scanMp4MoovBoxes(bytes, contentStart, contentEnd, state);
    }

    offset = contentEnd;
  }
}

function parseAudioSpecificConfigFromEsds(
  bytes: Uint8Array,
  start: number,
  end: number
): { profile: number; freqIdx: number; chanCfg: number } | null {
  // FullBox version/flags (4 bytes), luego descriptores MPEG-4 buscando tag 0x05 (DecoderSpecificInfo)
  let pos = start + 4;
  while (pos + 2 < end) {
    const tag = bytes[pos++];
    let size = 0;
    for (let i = 0; i < 4 && pos < end; i++) {
      const b = bytes[pos++];
      size = (size << 7) | (b & 0x7f);
      if ((b & 0x80) === 0) break;
    }
    if (tag === 0x03) {
      // ES_Descriptor: skip 2-byte ES_ID + 1-byte flags (+ optional fields)
      if (pos + 3 > end) return null;
      const flags = bytes[pos + 2];
      pos += 3;
      if (flags & 0x80) pos += 2;
      if (flags & 0x40) pos += 1 + (bytes[pos] ?? 0);
      if (flags & 0x20) pos += 2;
      continue;
    }
    if (tag === 0x04) {
      // DecoderConfigDescriptor: 13 bytes antes de subdescriptores
      pos += 13;
      continue;
    }
    if (tag === 0x05 && pos + 2 <= end && size >= 2) {
      const b0 = bytes[pos];
      const b1 = bytes[pos + 1];
      const audioObjectType = (b0 >> 3) & 0x1f;
      const freqIdx = ((b0 & 0x07) << 1) | ((b1 >> 7) & 0x01);
      const chanCfg = (b1 >> 3) & 0x0f;
      if (audioObjectType > 0 && freqIdx < ADTS_SAMPLE_RATES.length) {
        return { profile: audioObjectType, freqIdx, chanCfg };
      }
      return null;
    }
    pos += size;
  }
  return null;
}

function looksLikeTextError(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return true;
  let i = 0;
  while (i < Math.min(bytes.length, 32) && (bytes[i] === 0x20 || bytes[i] === 0x09 || bytes[i] === 0x0d || bytes[i] === 0x0a)) {
    i++;
  }
  const head = String.fromCharCode(...bytes.slice(i, i + 16)).toLowerCase();
  return head.startsWith('{') || head.startsWith('<html') || head.startsWith('<!doc') || head.startsWith('<?xml');
}

/**
 * Inspecciona la cabecera binaria de un archivo/stream para identificar el contenedor real,
 * detectar cifrado DRM (enca/sinf) y prevenir falsos positivos por extensión o MIME erróneo.
 */
export function inspectAudioContainer(bytes: Uint8Array): AudioContainerInspection {
  if (looksLikeTextError(bytes)) {
    return {
      kind: 'invalid-text',
      mimeType: null,
      codec: 'invalid-text',
      encrypted: false,
      fragmentedMp4: false,
    };
  }

  if (bytes.length >= 12 && readAscii4(bytes, 4) === 'ftyp') {
    const state = {
      encrypted: false,
      codec: null as string | null,
      esdsConfig: null as { profile: number; freqIdx: number; chanCfg: number } | null,
    };
    let fragmentedMp4 = false;
    let offset = 0;
    const scanLimit = Math.min(bytes.length, 256 * 1024);

    while (offset + 8 <= scanLimit) {
      const box = readBoxHeader(bytes, offset, bytes.length);
      if (!box) break;
      if (box.type === 'moov') {
        scanMp4MoovBoxes(bytes, offset + box.headerSize, offset + box.boxSize, state);
      } else if (box.type === 'moof' || box.type === 'styp') {
        fragmentedMp4 = true;
      }
      if (box.type === 'mdat' && state.codec) break;
      offset += box.boxSize;
    }

    return {
      kind: 'mp4',
      mimeType: 'audio/mp4',
      codec: state.encrypted ? 'drm' : state.codec,
      encrypted: state.encrypted,
      fragmentedMp4,
    };
  }

  if (
    bytes.length >= 3 &&
    bytes[0] === 0x49 &&
    bytes[1] === 0x44 &&
    bytes[2] === 0x33
  ) {
    return { kind: 'mp3', mimeType: 'audio/mpeg', codec: 'mp3', encrypted: false, fragmentedMp4: false };
  }
  if (bytes.length >= 4 && readAscii4(bytes, 0) === 'OggS') {
    return { kind: 'ogg', mimeType: 'audio/ogg', codec: 'ogg', encrypted: false, fragmentedMp4: false };
  }
  if (bytes.length >= 4 && readAscii4(bytes, 0) === 'fLaC') {
    return { kind: 'flac', mimeType: 'audio/flac', codec: 'flac', encrypted: false, fragmentedMp4: false };
  }
  if (
    bytes.length >= 12 &&
    readAscii4(bytes, 0) === 'RIFF' &&
    readAscii4(bytes, 8) === 'WAVE'
  ) {
    return { kind: 'wav', mimeType: 'audio/wav', codec: 'pcm', encrypted: false, fragmentedMp4: false };
  }
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x1a &&
    bytes[1] === 0x45 &&
    bytes[2] === 0xdf &&
    bytes[3] === 0xa3
  ) {
    return { kind: 'webm', mimeType: 'audio/webm', codec: 'opus/vorbis', encrypted: false, fragmentedMp4: false };
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xf6) === 0xf0) {
    return { kind: 'aac', mimeType: 'audio/aac', codec: 'aac', encrypted: false, fragmentedMp4: false };
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) {
    return { kind: 'mp3', mimeType: 'audio/mpeg', codec: 'mp3', encrypted: false, fragmentedMp4: false };
  }

  return { kind: 'unknown', mimeType: null, codec: null, encrypted: false, fragmentedMp4: false };
}

/**
 * Extrae tramas AAC crudas desde un MP4 fragmentado sin cifrar (moov/esds + moof/trun + mdat)
 * anteponiendo cabeceras ADTS de 7 bytes para navegadores cuyo demuxer MP4 rechace fMP4.
 */
export function extractAdtsFromFragmentedMp4(bytes: Uint8Array): Uint8Array | null {
  if (bytes.length < 16 || readAscii4(bytes, 4) !== 'ftyp') return null;

  const state = {
    encrypted: false,
    codec: null as string | null,
    esdsConfig: null as { profile: number; freqIdx: number; chanCfg: number } | null,
  };

  let offset = 0;
  let defaultSampleSize = 0;
  const sampleChunks: Uint8Array[] = [];
  let pendingTrunSizes: number[] | null = null;

  while (offset + 8 <= bytes.length) {
    const box = readBoxHeader(bytes, offset, bytes.length);
    if (!box) break;
    const contentStart = offset + box.headerSize;
    const contentEnd = offset + box.boxSize;

    if (box.type === 'moov') {
      scanMp4MoovBoxes(bytes, contentStart, contentEnd, state);
      if (state.encrypted || state.codec !== 'aac') return null;
      // Leer trex/mehd si existiera default_sample_size (fallback opcional)
    } else if (box.type === 'moof') {
      pendingTrunSizes = null;
      let mOff = contentStart;
      while (mOff + 8 <= contentEnd) {
        const sub = readBoxHeader(bytes, mOff, contentEnd);
        if (!sub) break;
        if (sub.type === 'traf') {
          let tOff = mOff + sub.headerSize;
          const tEnd = mOff + sub.boxSize;
          while (tOff + 8 <= tEnd) {
            const tb = readBoxHeader(bytes, tOff, tEnd);
            if (!tb) break;
            const tcStart = tOff + tb.headerSize;
            const tcEnd = tOff + tb.boxSize;
            if (tb.type === 'tfhd' && tcStart + 8 <= tcEnd) {
              const flags = readUint32BE(bytes, tcStart) & 0xffffff;
              let p = tcStart + 8;
              if (flags & 0x000001) p += 8;
              if (flags & 0x000002) p += 4;
              if (flags & 0x000008) p += 4;
              if ((flags & 0x000010) && p + 4 <= tcEnd) {
                defaultSampleSize = readUint32BE(bytes, p);
              }
            } else if (tb.type === 'trun' && tcStart + 8 <= tcEnd) {
              const flags = readUint32BE(bytes, tcStart) & 0xffffff;
              const sampleCount = readUint32BE(bytes, tcStart + 4);
              let p = tcStart + 8;
              if (flags & 0x000001) p += 4; // data_offset
              if (flags & 0x000004) p += 4; // first_sample_flags
              const hasDuration = Boolean(flags & 0x000100);
              const hasSize = Boolean(flags & 0x000200);
              const hasFlags = Boolean(flags & 0x000400);
              const hasCto = Boolean(flags & 0x000800);
              const sizes: number[] = [];
              for (let s = 0; s < sampleCount; s++) {
                if (hasDuration) p += 4;
                if (hasSize) {
                  if (p + 4 > tcEnd) break;
                  sizes.push(readUint32BE(bytes, p));
                  p += 4;
                } else if (defaultSampleSize > 0) {
                  sizes.push(defaultSampleSize);
                }
                if (hasFlags) p += 4;
                if (hasCto) p += 4;
              }
              if (sizes.length > 0) pendingTrunSizes = sizes;
            }
            tOff = tcEnd;
          }
        }
        mOff += sub.boxSize;
      }
    } else if (box.type === 'mdat' && pendingTrunSizes && state.esdsConfig) {
      const { profile, freqIdx, chanCfg } = state.esdsConfig;
      const adtsProfile = Math.max(0, profile - 1);
      let cursor = contentStart;
      for (const frameLen of pendingTrunSizes) {
        if (frameLen <= 0 || cursor + frameLen > contentEnd) break;
        const fullLen = frameLen + 7;
        const out = new Uint8Array(fullLen);
        out[0] = 0xff;
        out[1] = 0xf1;
        out[2] = ((adtsProfile & 0x03) << 6) | ((freqIdx & 0x0f) << 2) | ((chanCfg >> 2) & 0x01);
        out[3] = ((chanCfg & 0x03) << 6) | ((fullLen >> 11) & 0x03);
        out[4] = (fullLen >> 3) & 0xff;
        out[5] = ((fullLen & 0x07) << 5) | 0x1f;
        out[6] = 0xfc;
        out.set(bytes.subarray(cursor, cursor + frameLen), 7);
        sampleChunks.push(out);
        cursor += frameLen;
      }
      pendingTrunSizes = null;
    }

    offset = contentEnd;
  }

  if (sampleChunks.length === 0) return null;
  const totalBytes = sampleChunks.reduce((acc, c) => acc + c.length, 0);
  const combined = new Uint8Array(totalBytes);
  let writePos = 0;
  for (const chunk of sampleChunks) {
    combined.set(chunk, writePos);
    writePos += chunk.length;
  }
  return combined;
}

function writeUint16BE(buf: Uint8Array, offset: number, val: number): void {
  buf[offset] = (val >>> 8) & 0xff;
  buf[offset + 1] = val & 0xff;
}

function writeUint32BE(buf: Uint8Array, offset: number, val: number): void {
  buf[offset] = (val >>> 24) & 0xff;
  buf[offset + 1] = (val >>> 16) & 0xff;
  buf[offset + 2] = (val >>> 8) & 0xff;
  buf[offset + 3] = val & 0xff;
}

function writeAscii4(buf: Uint8Array, offset: number, str: string): void {
  for (let i = 0; i < 4; i++) {
    buf[offset + i] = str.charCodeAt(i) & 0xff;
  }
}

function concatUint8Arrays(parts: ReadonlyArray<Uint8Array>): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.byteLength;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.byteLength;
  }
  return out;
}

function makeMp4ContainerBox(type: string, children: ReadonlyArray<Uint8Array>): Uint8Array {
  let payloadSize = 0;
  for (const c of children) payloadSize += c.byteLength;
  const out = new Uint8Array(8 + payloadSize);
  writeUint32BE(out, 0, out.byteLength);
  writeAscii4(out, 4, type);
  let pos = 8;
  for (const c of children) {
    out.set(c, pos);
    pos += c.byteLength;
  }
  return out;
}

function buildStandardFtypBox(): Uint8Array {
  const out = new Uint8Array(32);
  writeUint32BE(out, 0, 32);
  writeAscii4(out, 4, 'ftyp');
  writeAscii4(out, 8, 'M4A ');
  writeUint32BE(out, 12, 0);
  writeAscii4(out, 16, 'M4A ');
  writeAscii4(out, 20, 'isom');
  writeAscii4(out, 24, 'iso2');
  writeAscii4(out, 28, 'mp42');
  return out;
}

function writeIdentityMatrix(buf: Uint8Array, offset: number): void {
  writeUint32BE(buf, offset, 0x00010000);
  writeUint32BE(buf, offset + 16, 0x00010000);
  writeUint32BE(buf, offset + 32, 0x40000000);
}

function buildMvhdBox(timescale: number, duration: number): Uint8Array {
  const out = new Uint8Array(108);
  writeUint32BE(out, 0, 108);
  writeAscii4(out, 4, 'mvhd');
  writeUint32BE(out, 20, timescale);
  writeUint32BE(out, 24, Math.min(0xffffffff, Math.max(1, duration >>> 0)));
  writeUint32BE(out, 28, 0x00010000); // rate 1.0
  writeUint16BE(out, 32, 0x0100); // volume 1.0
  writeIdentityMatrix(out, 44);
  writeUint32BE(out, 104, 2); // next_track_id
  return out;
}

function buildTkhdBox(duration: number): Uint8Array {
  const out = new Uint8Array(92);
  writeUint32BE(out, 0, 92);
  writeAscii4(out, 4, 'tkhd');
  writeUint32BE(out, 8, 0x00000007); // version 0, enabled | in_movie | in_preview
  writeUint32BE(out, 20, 1); // track_id
  writeUint32BE(out, 28, Math.min(0xffffffff, Math.max(1, duration >>> 0)));
  writeUint16BE(out, 42, 0x0100); // volume 1.0
  writeIdentityMatrix(out, 48);
  return out;
}

function buildMdhdBox(timescale: number, duration: number, lang = 0x55c4): Uint8Array {
  const out = new Uint8Array(32);
  writeUint32BE(out, 0, 32);
  writeAscii4(out, 4, 'mdhd');
  writeUint32BE(out, 20, timescale);
  writeUint32BE(out, 24, Math.min(0xffffffff, Math.max(1, duration >>> 0)));
  writeUint16BE(out, 28, lang);
  return out;
}

function buildDefaultSounHdlr(): Uint8Array {
  const out = new Uint8Array(45);
  writeUint32BE(out, 0, 45);
  writeAscii4(out, 4, 'hdlr');
  writeAscii4(out, 16, 'soun');
  const label = 'SoundHandler\0';
  for (let i = 0; i < label.length; i++) out[32 + i] = label.charCodeAt(i);
  return out;
}

function buildDefaultSmhd(): Uint8Array {
  const out = new Uint8Array(16);
  writeUint32BE(out, 0, 16);
  writeAscii4(out, 4, 'smhd');
  return out;
}

function buildDefaultDinf(): Uint8Array {
  const out = new Uint8Array(36);
  writeUint32BE(out, 0, 36);
  writeAscii4(out, 4, 'dinf');
  writeUint32BE(out, 8, 28);
  writeAscii4(out, 12, 'dref');
  writeUint32BE(out, 20, 1);
  writeUint32BE(out, 24, 12);
  writeAscii4(out, 28, 'url ');
  writeUint32BE(out, 32, 1); // self-contained
  return out;
}

function buildSttsBox(durations: ReadonlyArray<number>): Uint8Array {
  const runs: Array<{ count: number; delta: number }> = [];
  for (const d of durations) {
    const delta = Math.max(1, d >>> 0);
    const last = runs[runs.length - 1];
    if (last && last.delta === delta) {
      last.count += 1;
    } else {
      runs.push({ count: 1, delta });
    }
  }
  const out = new Uint8Array(16 + runs.length * 8);
  writeUint32BE(out, 0, out.byteLength);
  writeAscii4(out, 4, 'stts');
  writeUint32BE(out, 12, runs.length);
  for (let i = 0; i < runs.length; i++) {
    writeUint32BE(out, 16 + i * 8, runs[i].count);
    writeUint32BE(out, 20 + i * 8, runs[i].delta);
  }
  return out;
}

function buildStscSingleChunkBox(totalSamples: number): Uint8Array {
  const out = new Uint8Array(28);
  writeUint32BE(out, 0, 28);
  writeAscii4(out, 4, 'stsc');
  writeUint32BE(out, 12, 1);
  writeUint32BE(out, 16, 1); // first_chunk
  writeUint32BE(out, 20, totalSamples);
  writeUint32BE(out, 24, 1); // sample_description_index
  return out;
}

function buildStszBox(sizes: ReadonlyArray<number>): Uint8Array {
  const out = new Uint8Array(20 + sizes.length * 4);
  writeUint32BE(out, 0, out.byteLength);
  writeAscii4(out, 4, 'stsz');
  writeUint32BE(out, 12, 0);
  writeUint32BE(out, 16, sizes.length);
  for (let i = 0; i < sizes.length; i++) {
    writeUint32BE(out, 20 + i * 4, sizes[i] >>> 0);
  }
  return out;
}

function buildStcoSingleChunkBox(offset: number): Uint8Array {
  const out = new Uint8Array(20);
  writeUint32BE(out, 0, 20);
  writeAscii4(out, 4, 'stco');
  writeUint32BE(out, 12, 1);
  writeUint32BE(out, 16, offset >>> 0);
  return out;
}

/**
 * Remuxa un MP4 fragmentado sin cifrar (`moov` + `moof`/`mdat`) a un `.m4a` ISO-BMFF
 * estándar no fragmentado con duración y tabla de muestras reales en `moov`, para que
 * reproductores de escritorio/móvil no reporten duraciones erróneas (p. ej. 435 horas).
 */
export function remuxFragmentedMp4ToStandardM4a(bytes: Uint8Array): Uint8Array | null {
  if (bytes.length < 16 || readAscii4(bytes, 4) !== 'ftyp') return null;

  const init: {
    encrypted: boolean;
    mdhdTimescale: number;
    mdhdLang: number;
    trexDefaultDuration: number;
    trexDefaultSize: number;
    stsdBox: Uint8Array | null;
    hdlrBox: Uint8Array | null;
    smhdBox: Uint8Array | null;
    dinfBox: Uint8Array | null;
    udtaBox: Uint8Array | null;
  } = {
    encrypted: false,
    mdhdTimescale: 44100,
    mdhdLang: 0x55c4,
    trexDefaultDuration: 1024,
    trexDefaultSize: 0,
    stsdBox: null,
    hdlrBox: null,
    smhdBox: null,
    dinfBox: null,
    udtaBox: null,
  };

  const inspectInitContainers = (start: number, end: number): void => {
    const containers = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'mvex']);
    let pos = start;
    while (pos + 8 <= end) {
      const box = readBoxHeader(bytes, pos, end);
      if (!box) break;
      const cStart = pos + box.headerSize;
      const cEnd = pos + box.boxSize;
      if (box.type === 'enca' || box.type === 'encv' || box.type === 'sinf' || box.type === 'schi') {
        init.encrypted = true;
      } else if (box.type === 'mdhd' && cStart + 24 <= cEnd) {
        const ver = bytes[cStart];
        if (ver === 0 && cStart + 20 <= cEnd) {
          const ts = readUint32BE(bytes, cStart + 12);
          if (ts > 0) init.mdhdTimescale = ts;
          init.mdhdLang = (bytes[cStart + 20] << 8) | bytes[cStart + 21];
        } else if (ver === 1 && cStart + 32 <= cEnd) {
          const ts = readUint32BE(bytes, cStart + 20);
          if (ts > 0) init.mdhdTimescale = ts;
          init.mdhdLang = (bytes[cStart + 32] << 8) | bytes[cStart + 33];
        }
      } else if (box.type === 'trex' && cStart + 24 <= cEnd) {
        const defDur = readUint32BE(bytes, cStart + 12);
        const defSz = readUint32BE(bytes, cStart + 16);
        if (defDur > 0) init.trexDefaultDuration = defDur;
        if (defSz > 0) init.trexDefaultSize = defSz;
      } else if (box.type === 'stsd') {
        init.stsdBox = bytes.slice(pos, cEnd);
        if (cStart + 8 < cEnd) inspectInitContainers(cStart + 8, cEnd);
      } else if (box.type === 'hdlr') {
        init.hdlrBox = bytes.slice(pos, cEnd);
      } else if (box.type === 'smhd') {
        init.smhdBox = bytes.slice(pos, cEnd);
      } else if (box.type === 'dinf') {
        init.dinfBox = bytes.slice(pos, cEnd);
      } else if (box.type === 'udta') {
        init.udtaBox = bytes.slice(pos, cEnd);
      } else if (containers.has(box.type)) {
        inspectInitContainers(cStart, cEnd);
      }
      pos = cEnd;
    }
  };

  const sampleSizes: number[] = [];
  const sampleDurations: number[] = [];
  const payloadChunks: Uint8Array[] = [];
  let pendingSamples: Array<{ dur: number; size: number }> | null = null;
  let offset = 0;

  while (offset + 8 <= bytes.length) {
    const box = readBoxHeader(bytes, offset, bytes.length);
    if (!box) break;
    const cStart = offset + box.headerSize;
    const cEnd = offset + box.boxSize;

    if (box.type === 'moov') {
      inspectInitContainers(cStart, cEnd);
      if (init.encrypted || !init.stsdBox) return null;
    } else if (box.type === 'moof') {
      pendingSamples = null;
      let tfDefaultDur = init.trexDefaultDuration;
      let tfDefaultSize = init.trexDefaultSize;
      let mOff = cStart;
      while (mOff + 8 <= cEnd) {
        const sub = readBoxHeader(bytes, mOff, cEnd);
        if (!sub) break;
        if (sub.type === 'traf') {
          let tOff = mOff + sub.headerSize;
          const tEnd = mOff + sub.boxSize;
          while (tOff + 8 <= tEnd) {
            const tb = readBoxHeader(bytes, tOff, tEnd);
            if (!tb) break;
            const tcStart = tOff + tb.headerSize;
            const tcEnd = tOff + tb.boxSize;
            if (tb.type === 'tfhd' && tcStart + 8 <= tcEnd) {
              const flags = readUint32BE(bytes, tcStart) & 0xffffff;
              let p = tcStart + 8;
              if (flags & 0x000001) p += 8;
              if (flags & 0x000002) p += 4;
              if ((flags & 0x000008) && p + 4 <= tcEnd) {
                const d = readUint32BE(bytes, p);
                if (d > 0) tfDefaultDur = d;
                p += 4;
              }
              if ((flags & 0x000010) && p + 4 <= tcEnd) {
                tfDefaultSize = readUint32BE(bytes, p);
              }
            } else if (tb.type === 'trun' && tcStart + 8 <= tcEnd) {
              const flags = readUint32BE(bytes, tcStart) & 0xffffff;
              const sampleCount = readUint32BE(bytes, tcStart + 4);
              let p = tcStart + 8;
              if (flags & 0x000001) p += 4;
              if (flags & 0x000004) p += 4;
              const hasDur = Boolean(flags & 0x000100);
              const hasSize = Boolean(flags & 0x000200);
              const hasFlags = Boolean(flags & 0x000400);
              const hasCto = Boolean(flags & 0x000800);
              const fragSamples: Array<{ dur: number; size: number }> = [];
              for (let s = 0; s < sampleCount; s++) {
                let dur = tfDefaultDur;
                if (hasDur) {
                  if (p + 4 > tcEnd) break;
                  dur = readUint32BE(bytes, p) || tfDefaultDur;
                  p += 4;
                }
                let size = tfDefaultSize;
                if (hasSize) {
                  if (p + 4 > tcEnd) break;
                  size = readUint32BE(bytes, p);
                  p += 4;
                }
                if (hasFlags) p += 4;
                if (hasCto) p += 4;
                if (size > 0) fragSamples.push({ dur, size });
              }
              if (fragSamples.length > 0) pendingSamples = fragSamples;
            }
            tOff = tcEnd;
          }
        }
        mOff += sub.boxSize;
      }
    } else if (box.type === 'mdat' && pendingSamples) {
      let fragBytes = 0;
      for (const s of pendingSamples) fragBytes += s.size;
      if (fragBytes > 0 && cStart + fragBytes <= cEnd) {
        payloadChunks.push(bytes.subarray(cStart, cStart + fragBytes));
        for (const s of pendingSamples) {
          sampleDurations.push(s.dur);
          sampleSizes.push(s.size);
        }
      }
      pendingSamples = null;
    }

    offset = cEnd;
  }

  if (!init.stsdBox || init.encrypted || sampleSizes.length === 0) {
    return null;
  }

  let totalPayload = 0;
  for (const chunk of payloadChunks) totalPayload += chunk.byteLength;
  if (totalPayload === 0) return null;

  let totalMediaDuration = 0;
  for (const d of sampleDurations) totalMediaDuration += d;
  const movieTimescale = 1000;
  const movieDuration = Math.max(
    1,
    Math.round((totalMediaDuration / init.mdhdTimescale) * movieTimescale)
  );

  const ftyp = buildStandardFtypBox();
  const stts = buildSttsBox(sampleDurations);
  const stsc = buildStscSingleChunkBox(sampleSizes.length);
  const stsz = buildStszBox(sampleSizes);
  const stcoPlaceholder = buildStcoSingleChunkBox(0);

  const stbl = makeMp4ContainerBox('stbl', [init.stsdBox, stts, stsc, stsz, stcoPlaceholder]);
  const minf = makeMp4ContainerBox('minf', [
    init.smhdBox ?? buildDefaultSmhd(),
    init.dinfBox ?? buildDefaultDinf(),
    stbl,
  ]);
  const mdia = makeMp4ContainerBox('mdia', [
    buildMdhdBox(init.mdhdTimescale, totalMediaDuration, init.mdhdLang),
    init.hdlrBox ?? buildDefaultSounHdlr(),
    minf,
  ]);
  const trak = makeMp4ContainerBox('trak', [buildTkhdBox(movieDuration), mdia]);
  const moovChildren: Uint8Array[] = [buildMvhdBox(movieTimescale, movieDuration), trak];
  if (init.udtaBox) moovChildren.push(init.udtaBox);
  const moov = makeMp4ContainerBox('moov', moovChildren);

  const mdatPayloadOffset = ftyp.byteLength + moov.byteLength + 8;
  // Parcheamos la entrada única de stco (los últimos 4 bytes de stbl dentro de moov antes de udta)
  const udtaLen = init.udtaBox ? init.udtaBox.byteLength : 0;
  const stcoEntryOffset = moov.byteLength - udtaLen - 4;
  writeUint32BE(moov, stcoEntryOffset, mdatPayloadOffset);

  const mdatHeader = new Uint8Array(8);
  writeUint32BE(mdatHeader, 0, 8 + totalPayload);
  writeAscii4(mdatHeader, 4, 'mdat');

  return concatUint8Arrays([ftyp, moov, mdatHeader, ...payloadChunks]);
}

export function describeUnsupportedAudioReason(
  fileName: string,
  bytes: Uint8Array,
  explicitMime?: string
): string {
  const info = inspectAudioContainer(bytes);
  if (info.encrypted) {
    return `"${fileName}" tiene protección DRM/cifrado y ningún navegador puede decodificarla. Búscala de nuevo para usar una versión sin cifrar o elimínala de la lista.`;
  }
  if (info.kind === 'invalid-text') {
    return `"${fileName}" no contiene audio válido (archivo vacío, dañado o respuesta inválida del servidor).`;
  }
  const lowerExt = fileName.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '';
  if (
    info.codec === 'alac' ||
    info.codec === 'ac-3' ||
    info.codec === 'ec-3' ||
    info.codec === 'mlpa' ||
    ['wma', 'amr', 'caf', 'alac', 'ac3'].includes(lowerExt) ||
    explicitMime?.includes('wma')
  ) {
    const label = (info.codec ?? lowerExt).toUpperCase();
    return `"${fileName}" usa códec ${label}, no compatible con este navegador. Convierte o carga la pista en MP3, AAC o WAV.`;
  }
  return `Este navegador no puede decodificar "${fileName}".`;
}

/**
 * Filtra y ordena transcodings de SoundCloud excluyendo flujos DRM cifrados
 * (`cbc-encrypted-hls`, `ctr-encrypted-hls`), previews recortados (`snipped`) y playlists heredadas 404.
 */
export function orderSoundCloudTranscodings<T extends SoundCloudTranscodingLike>(
  transcodings: readonly T[] | undefined
): T[] {
  const list = (transcodings ?? []).filter((tr) => {
    if (!tr.url || tr.snipped) return false;
    const proto = (tr.format?.protocol ?? '').toLowerCase();
    if (!proto || proto.includes('encrypted')) return false;
    if (proto !== 'progressive' && proto !== 'hls') return false;
    const mime = (tr.format?.mime_type ?? '').toLowerCase();
    if (mime.includes('mpegurl')) return false;
    return mime.includes('audio/mpeg') || mime.includes('mp4');
  });

  const rank = (tr: SoundCloudTranscodingLike): number => {
    const proto = (tr.format?.protocol ?? '').toLowerCase();
    const mime = (tr.format?.mime_type ?? '').toLowerCase();
    if (proto === 'progressive' && mime.includes('audio/mpeg')) return 0;
    if (proto === 'progressive') return 1;
    if (proto === 'hls' && mime.includes('audio/mpeg')) return 2;
    if (proto === 'hls' && mime.includes('mp4') && mime.includes('mp4a')) return 3;
    if (proto === 'hls' && mime.includes('mp4')) return 4;
    return 5;
  };

  return [...list].sort((a, b) => rank(a) - rank(b));
}
