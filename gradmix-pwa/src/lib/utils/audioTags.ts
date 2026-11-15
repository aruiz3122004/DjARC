/**
 * Extractor ligero de etiquetas incrustadas (ID3v2 para MP3/AAC y átomos MP4/M4A)
 * leyendo únicamente las cabeceras necesarias sin decodificar el audio en RAM.
 */

export interface ExtractedAudioTags {
  title?: string;
  artist?: string;
}

function cleanTagString(raw: string): string {
  return raw.replace(/\0/g, '').replace(/\s+/g, ' ').trim();
}

function decodeId3Text(bytes: Uint8Array): string {
  if (bytes.length === 0) return '';
  const encoding = bytes[0];
  const payload = bytes.subarray(1);

  try {
    if (encoding === 0) {
      return cleanTagString(new TextDecoder('latin1').decode(payload));
    }
    if (encoding === 1) {
      if (payload.length >= 2 && payload[0] === 0xff && payload[1] === 0xfe) {
        return cleanTagString(new TextDecoder('utf-16le').decode(payload.subarray(2)));
      }
      if (payload.length >= 2 && payload[0] === 0xfe && payload[1] === 0xff) {
        return cleanTagString(new TextDecoder('utf-16be').decode(payload.subarray(2)));
      }
      return cleanTagString(new TextDecoder('utf-16le').decode(payload));
    }
    if (encoding === 2) {
      return cleanTagString(new TextDecoder('utf-16be').decode(payload));
    }
    if (encoding === 3) {
      return cleanTagString(new TextDecoder('utf-8').decode(payload));
    }
  } catch {
    // Fallback Latin1
  }
  return cleanTagString(new TextDecoder('latin1').decode(bytes));
}

function parseId3v2(buf: Uint8Array): ExtractedAudioTags {
  const out: ExtractedAudioTags = {};
  if (buf.length < 10 || buf[0] !== 0x49 || buf[1] !== 0x44 || buf[2] !== 0x33) {
    return out;
  }

  const version = buf[3];
  const tagSize =
    ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
  const limit = Math.min(buf.length, 10 + tagSize);

  let pos = 10;
  // Saltar extended header si bit 6 activo
  if ((buf[5] & 0x40) !== 0 && pos + 4 <= limit) {
    const extSize =
      version === 4
        ? ((buf[pos] & 0x7f) << 21) |
          ((buf[pos + 1] & 0x7f) << 14) |
          ((buf[pos + 2] & 0x7f) << 7) |
          (buf[pos + 3] & 0x7f)
        : ((buf[pos] << 24) | (buf[pos + 1] << 16) | (buf[pos + 2] << 8) | buf[pos + 3]) >>> 0;
    pos += Math.max(4, extSize);
  }

  if (version === 2) {
    while (pos + 6 <= limit) {
      const id = String.fromCharCode(buf[pos], buf[pos + 1], buf[pos + 2]);
      if (buf[pos] === 0) break;
      const frameSize = (buf[pos + 3] << 16) | (buf[pos + 4] << 8) | buf[pos + 5];
      pos += 6;
      if (frameSize <= 0 || pos + frameSize > limit) break;
      if (id === 'TT2' && !out.title) out.title = decodeId3Text(buf.subarray(pos, pos + frameSize));
      if (id === 'TP1' && !out.artist) out.artist = decodeId3Text(buf.subarray(pos, pos + frameSize));
      pos += frameSize;
    }
    return out;
  }

  while (pos + 10 <= limit) {
    if (buf[pos] === 0) break;
    const id = String.fromCharCode(buf[pos], buf[pos + 1], buf[pos + 2], buf[pos + 3]);
    const frameSize =
      version === 4
        ? ((buf[pos + 4] & 0x7f) << 21) |
          ((buf[pos + 5] & 0x7f) << 14) |
          ((buf[pos + 6] & 0x7f) << 7) |
          (buf[pos + 7] & 0x7f)
        : ((buf[pos + 4] << 24) |
            (buf[pos + 5] << 16) |
            (buf[pos + 6] << 8) |
            buf[pos + 7]) >>>
          0;
    pos += 10;
    if (frameSize <= 0 || pos + frameSize > limit) break;
    const slice = buf.subarray(pos, pos + frameSize);
    if (id === 'TIT2' && !out.title) {
      out.title = decodeId3Text(slice);
    } else if (id === 'TPE1') {
      out.artist = decodeId3Text(slice);
    } else if (id === 'TPE2' && !out.artist) {
      out.artist = decodeId3Text(slice);
    }
    pos += frameSize;
  }

  return out;
}

function readUint32BE(buf: Uint8Array, offset: number): number {
  return (
    ((buf[offset] << 24) | (buf[offset + 1] << 16) | (buf[offset + 2] << 8) | buf[offset + 3]) >>>
    0
  );
}

function atomName(buf: Uint8Array, offset: number): string {
  return String.fromCharCode(buf[offset], buf[offset + 1], buf[offset + 2], buf[offset + 3]);
}

function scanMp4Ilst(buf: Uint8Array, start: number, end: number, out: ExtractedAudioTags): void {
  const containers = new Set(['moov', 'udta', 'meta', 'ilst']);
  let pos = start;
  while (pos + 8 <= end) {
    let size = readUint32BE(buf, pos);
    const name = atomName(buf, pos + 4);
    let headerLen = 8;
    if (size === 1 && pos + 16 <= end) {
      const hi = readUint32BE(buf, pos + 8);
      const lo = readUint32BE(buf, pos + 12);
      size = hi * 2 ** 32 + lo;
      headerLen = 16;
    } else if (size === 0) {
      size = end - pos;
    }
    if (size < headerLen || pos + size > end) break;

    const childStart = pos + headerLen + (name === 'meta' ? 4 : 0);
    const childEnd = pos + size;

    if (containers.has(name) && childStart < childEnd) {
      scanMp4Ilst(buf, childStart, childEnd, out);
    } else if (name === '\xA9nam' || name === '\xA9ART' || name === 'aART') {
      let innerPos = childStart;
      while (innerPos + 8 <= childEnd) {
        const innerSize = readUint32BE(buf, innerPos);
        const innerName = atomName(buf, innerPos + 4);
        if (innerSize < 8 || innerPos + innerSize > childEnd) break;
        if (innerName === 'data' && innerSize > 16) {
          const val = cleanTagString(
            new TextDecoder('utf-8').decode(buf.subarray(innerPos + 16, innerPos + innerSize))
          );
          if (val) {
            if (name === '\xA9nam' && !out.title) out.title = val;
            if (name === '\xA9ART') out.artist = val;
            if (name === 'aART' && !out.artist) out.artist = val;
          }
        }
        innerPos += innerSize;
      }
    }
    pos += size;
  }
}

async function extractMp4TagsFromBlob(blob: Blob): Promise<ExtractedAudioTags> {
  const out: ExtractedAudioTags = {};
  let offset = 0;
  let boxes = 0;
  const maxSize = blob.size;

  while (offset + 8 <= maxSize && boxes < 64) {
    boxes++;
    const hdr = new Uint8Array(await blob.slice(offset, offset + 16).arrayBuffer());
    if (hdr.length < 8) break;
    let size = readUint32BE(hdr, 0);
    const name = atomName(hdr, 4);
    if (size === 1 && hdr.length >= 16) {
      size = readUint32BE(hdr, 8) * 2 ** 32 + readUint32BE(hdr, 12);
    } else if (size === 0) {
      size = maxSize - offset;
    }
    if (size < 8 || offset + size > maxSize) break;

    if (name === 'moov') {
      if (size <= 2 * 1024 * 1024) {
        const moovBuf = new Uint8Array(await blob.slice(offset, offset + size).arrayBuffer());
        scanMp4Ilst(moovBuf, 0, moovBuf.length, out);
      }
      break;
    }
    offset += size;
  }
  return out;
}

export async function extractAudioTags(blob: Blob): Promise<ExtractedAudioTags> {
  try {
    const headLen = Math.min(blob.size, 256 * 1024);
    if (headLen < 12) return {};
    const headBuf = new Uint8Array(await blob.slice(0, headLen).arrayBuffer());

    if (headBuf[0] === 0x49 && headBuf[1] === 0x44 && headBuf[2] === 0x33) {
      return parseId3v2(headBuf);
    }

    if (
      headBuf[4] === 0x66 &&
      headBuf[5] === 0x74 &&
      headBuf[6] === 0x79 &&
      headBuf[7] === 0x70
    ) {
      return await extractMp4TagsFromBlob(blob);
    }
  } catch {
    // Fallback silencioso a parser por nombre de archivo
  }
  return {};
}
