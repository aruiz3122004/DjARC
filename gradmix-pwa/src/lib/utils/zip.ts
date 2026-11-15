const ZIP_AUDIO_EXT =
  /\.(mp3|wav|wave|m4a|m4b|m4p|m4r|mp4|aac|ogg|oga|opus|flac|webm|weba|3gp|3gpp|amr|aif|aiff|aifc|caf|wma|alac|ac3|mka)$/i;

const ZIP_MIME_BY_EXT: Record<string, string> = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  wave: 'audio/wav',
  m4a: 'audio/mp4',
  m4b: 'audio/mp4',
  m4p: 'audio/mp4',
  m4r: 'audio/mp4',
  mp4: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/opus',
  flac: 'audio/flac',
  webm: 'audio/webm',
  weba: 'audio/webm',
  '3gp': 'audio/3gpp',
  '3gpp': 'audio/3gpp',
  amr: 'audio/amr',
  aif: 'audio/aiff',
  aiff: 'audio/aiff',
  aifc: 'audio/aiff',
  caf: 'audio/x-caf',
  wma: 'audio/x-ms-wma',
  alac: 'audio/mp4',
  ac3: 'audio/ac3',
  mka: 'audio/x-matroska',
};

function inferZipAudioMime(fileName: string): string {
  const m = fileName.toLowerCase().match(/\.([a-z0-9]+)$/);
  return (m && ZIP_MIME_BY_EXT[m[1]]) || 'audio/mpeg';
}

export interface ZipImportedAudioEntry {
  fileName: string;
  mimeType: string;
  blob: Blob;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function toDosTimeDate(timestampMs: number): { time: number; date: number } {
  const d = new Date(timestampMs);
  const year = Math.max(1980, d.getFullYear()) - 1980;
  const month = d.getMonth() + 1;
  const day = d.getDate();
  const hours = d.getHours();
  const minutes = d.getMinutes();
  const seconds = Math.floor(d.getSeconds() / 2);
  return {
    time: ((hours & 0x1f) << 11) | ((minutes & 0x3f) << 5) | (seconds & 0x1f),
    date: ((year & 0x7f) << 9) | ((month & 0x0f) << 5) | (day & 0x1f),
  };
}

export function sanitizeZipEntryFileName(
  title: string,
  artist: string,
  originalFileName: string,
  usedNames: Set<string>
): string {
  const extMatch = originalFileName.match(/\.([a-zA-Z0-9]{2,5})$/);
  const ext = extMatch ? `.${extMatch[1].toLowerCase()}` : '.mp3';
  const rawBase = artist ? `${artist} - ${title}` : title;
  const cleanBase =
    rawBase
      .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 110) || 'pista';

  let candidate = `${cleanBase}${ext}`;
  let suffix = 2;
  while (usedNames.has(candidate.toLowerCase())) {
    candidate = `${cleanBase} (${suffix})${ext}`;
    suffix += 1;
  }
  usedNames.add(candidate.toLowerCase());
  return candidate;
}

async function tryDeflateRaw(data: Uint8Array): Promise<Uint8Array | null> {
  if (typeof CompressionStream === 'undefined' || data.byteLength < 64) {
    return null;
  }
  try {
    const cs = new CompressionStream('deflate-raw');
    const stream = new Blob([new Uint8Array(data)]).stream().pipeThrough(cs);
    const compressed = new Uint8Array(await new Response(stream).arrayBuffer());
    return compressed.byteLength > 0 && compressed.byteLength < data.byteLength
      ? compressed
      : null;
  } catch {
    return null;
  }
}

/**
 * Construye un archivo `.zip` estándar comprimiendo con DEFLATE (método 8) cuando reduce
 * tamaño y con respaldo STORE (método 0), con cada canción como archivo independiente.
 */
export async function buildZipBlobFromEntries(
  entries: ReadonlyArray<{ fileName: string; bytes: Uint8Array; modifiedAt?: number }>
): Promise<Blob> {
  const encoder = new TextEncoder();
  const parts: BlobPart[] = [];
  const centralDir: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.fileName);
    const data = entry.bytes;
    const sum = crc32(data);
    const deflated = await tryDeflateRaw(data);
    const method = deflated ? 8 : 0;
    const payload = deflated ?? data;
    const { time, date } = toDosTimeDate(entry.modifiedAt ?? Date.now());

    // Local File Header (30 bytes + filename)
    const lfh = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(lfh.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true); // version needed 2.0
    lv.setUint16(6, 0x0800, true); // UTF-8 filename flag
    lv.setUint16(8, method, true);
    lv.setUint16(10, time, true);
    lv.setUint16(12, date, true);
    lv.setUint32(14, sum, true);
    lv.setUint32(18, payload.byteLength, true);
    lv.setUint32(22, data.byteLength, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);
    lfh.set(nameBytes, 30);

    parts.push(lfh, new Uint8Array(payload));

    // Central Directory Header (46 bytes + filename)
    const cdh = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cdh.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, method, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, date, true);
    cv.setUint32(16, sum, true);
    cv.setUint32(20, payload.byteLength, true);
    cv.setUint32(24, data.byteLength, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true);
    cv.setUint16(36, 0, true);
    cv.setUint32(38, 0, true);
    cv.setUint32(42, offset, true);
    cdh.set(nameBytes, 46);
    centralDir.push(cdh);

    offset += lfh.byteLength + payload.byteLength;
  }

  let cdSize = 0;
  for (const ch of centralDir) {
    parts.push(new Uint8Array(ch));
    cdSize += ch.byteLength;
  }

  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  ev.setUint16(20, 0, true);
  parts.push(eocd);

  return new Blob(parts, { type: 'application/zip' });
}

/**
 * Extrae las pistas de audio desde un archivo `.zip` usando Blob.slice (y `DecompressionStream`
 * si alguna entrada externa vino comprimida con deflate).
 */
export async function parsePlaylistZipFile(file: File): Promise<ZipImportedAudioEntry[]> {
  if (file.size < 22) {
    throw new Error('Archivo .zip inválido o vacío.');
  }

  const tailStart = Math.max(0, file.size - 65_557);
  const tailBytes = new Uint8Array(await file.slice(tailStart).arrayBuffer());
  const tailView = new DataView(tailBytes.buffer);

  let eocdPos = -1;
  for (let i = tailBytes.length - 22; i >= 0; i--) {
    if (tailView.getUint32(i, true) === 0x06054b50) {
      eocdPos = i;
      break;
    }
  }
  if (eocdPos === -1) {
    throw new Error('No se encontró el directorio central del archivo .zip.');
  }

  const totalEntries = tailView.getUint16(eocdPos + 10, true);
  const cdSize = tailView.getUint32(eocdPos + 12, true);
  const cdOffset = tailView.getUint32(eocdPos + 16, true);
  if (cdOffset + cdSize > file.size) {
    throw new Error('Archivo .zip truncado o corrupto.');
  }

  const cdBytes = new Uint8Array(await file.slice(cdOffset, cdOffset + cdSize).arrayBuffer());
  const cdView = new DataView(cdBytes.buffer);
  const decoder = new TextDecoder('utf-8');
  const results: ZipImportedAudioEntry[] = [];

  let cursor = 0;
  for (let idx = 0; idx < totalEntries && cursor + 46 <= cdBytes.length; idx++) {
    if (cdView.getUint32(cursor, true) !== 0x02014b50) break;

    const method = cdView.getUint16(cursor + 10, true);
    const compSize = cdView.getUint32(cursor + 20, true);
    const nameLen = cdView.getUint16(cursor + 28, true);
    const extraLen = cdView.getUint16(cursor + 30, true);
    const commentLen = cdView.getUint16(cursor + 32, true);
    const localOffset = cdView.getUint32(cursor + 42, true);

    const rawPath = decoder.decode(cdBytes.subarray(cursor + 46, cursor + 46 + nameLen));
    cursor += 46 + nameLen + extraLen + commentLen;

    const baseName = rawPath.split('/').pop() ?? rawPath;
    if (
      !baseName ||
      rawPath.endsWith('/') ||
      rawPath.includes('__MACOSX/') ||
      baseName.startsWith('._') ||
      !ZIP_AUDIO_EXT.test(baseName)
    ) {
      continue;
    }

    if (localOffset + 30 > file.size) continue;
    const lfhBytes = new Uint8Array(await file.slice(localOffset, localOffset + 30).arrayBuffer());
    const lfhView = new DataView(lfhBytes.buffer);
    if (lfhView.getUint32(0, true) !== 0x04034b50) continue;

    const lNameLen = lfhView.getUint16(26, true);
    const lExtraLen = lfhView.getUint16(28, true);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    if (dataStart + compSize > file.size) continue;

    const mime = inferZipAudioMime(baseName);
    const rawSlice = file.slice(dataStart, dataStart + compSize, mime);

    if (method === 0) {
      results.push({ fileName: baseName, mimeType: mime, blob: rawSlice });
    } else if (method === 8 && typeof DecompressionStream !== 'undefined') {
      const ds = new DecompressionStream('deflate-raw');
      const inflatedStream = rawSlice.stream().pipeThrough(ds);
      const inflatedBuf = await new Response(inflatedStream).arrayBuffer();
      results.push({
        fileName: baseName,
        mimeType: mime,
        blob: new Blob([inflatedBuf], { type: mime }),
      });
    }
  }

  if (results.length === 0) {
    throw new Error('El archivo .zip no contiene canciones compatibles.');
  }

  return results;
}
