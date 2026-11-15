import assert from 'node:assert/strict';
import test from 'node:test';
import { extractAudioTags } from '../src/lib/utils/audioTags.ts';
import {
  cleanDisplayArtist,
  cleanDisplayTitle,
  inferAudioMimeType,
  isSupportedAudioFile,
  parseTrackFilename,
} from '../src/lib/utils/format.ts';

function makeId3v2Tag(title: string, artist: string): Uint8Array {
  const frame = (id: string, value: string): Uint8Array => {
    const valBytes = Buffer.from(value, 'utf8');
    const bodyLen = 1 + valBytes.length;
    const buf = Buffer.alloc(10 + bodyLen);
    buf.write(id, 0, 4, 'ascii');
    buf.writeUInt32BE(bodyLen, 4);
    buf[10] = 0x03; // UTF-8
    valBytes.copy(buf, 11);
    return buf;
  };
  const body = Buffer.concat([frame('TIT2', title), frame('TPE1', artist)]);
  const header = Buffer.alloc(10);
  header.write('ID3', 0, 3, 'ascii');
  header[3] = 3; // v2.3
  header[6] = (body.length >> 21) & 0x7f;
  header[7] = (body.length >> 14) & 0x7f;
  header[8] = (body.length >> 7) & 0x7f;
  header[9] = body.length & 0x7f;
  return new Uint8Array(Buffer.concat([header, body]));
}

function makeMp4Box(name: string, payload: Uint8Array): Buffer {
  const out = Buffer.alloc(8 + payload.length);
  out.writeUInt32BE(out.length, 0);
  out.write(name, 4, 4, 'latin1');
  Buffer.from(payload).copy(out, 8);
  return out;
}

function makeMp4Tags(title: string, artist: string): Uint8Array {
  const dataBox = (text: string) => {
    const t = Buffer.from(text, 'utf8');
    const payload = Buffer.alloc(8 + t.length);
    t.copy(payload, 8);
    return makeMp4Box('data', payload);
  };
  const namBox = makeMp4Box('\xA9nam', dataBox(title));
  const artBox = makeMp4Box('\xA9ART', dataBox(artist));
  const ilst = makeMp4Box('ilst', Buffer.concat([namBox, artBox]));
  const meta = makeMp4Box('meta', Buffer.concat([Buffer.alloc(4), ilst]));
  const udta = makeMp4Box('udta', meta);
  const moov = makeMp4Box('moov', udta);
  const ftyp = makeMp4Box('ftyp', Buffer.from('M4A \0\0\0\0', 'latin1'));
  return new Uint8Array(Buffer.concat([ftyp, moov]));
}

test('isSupportedAudioFile e inferAudioMimeType aceptan formatos más allá de MP3 y WAV', () => {
  const cases: Array<[string, string, string]> = [
    ['pista.m4a', '', 'audio/mp4'],
    ['pista.flac', '', 'audio/flac'],
    ['pista.ogg', 'application/ogg', 'application/ogg'],
    ['pista.opus', '', 'audio/opus'],
    ['pista.3gp', 'video/3gpp', 'audio/3gpp'],
    ['pista.amr', '', 'audio/amr'],
    ['pista.aiff', '', 'audio/aiff'],
    ['pista.wma', '', 'audio/x-ms-wma'],
    ['pista.webm', 'video/webm', 'audio/webm'],
  ];

  for (const [name, mime, expectedMime] of cases) {
    const fileLike = { name, type: mime } as unknown as File;
    assert.equal(isSupportedAudioFile(fileLike), true, `Debe aceptar ${name}`);
    assert.equal(inferAudioMimeType(name, mime), expectedMime);
  }
});

test('parseTrackFilename y limpieza eliminan sufijos técnicos y Biblioteca Local', () => {
  assert.equal(cleanDisplayTitle('Plus(M4A 128K)'), 'Plus');
  assert.equal(cleanDisplayArtist('Biblioteca Local'), '');
  const parsed = parseTrackFilename('03 - Daddy Yankee - Gasolina(MP3_192K).mp3');
  assert.equal(parsed.artist, 'Daddy Yankee');
  assert.equal(parsed.title, 'Gasolina');
});

test('extractAudioTags extrae título y artista de cabeceras ID3v2 y átomos MP4/M4A', async () => {
  const id3Blob = new Blob([makeId3v2Tag('Provenza', 'Karol G')]);
  const id3Tags = await extractAudioTags(id3Blob);
  assert.equal(id3Tags.title, 'Provenza');
  assert.equal(id3Tags.artist, 'Karol G');

  const mp4Blob = new Blob([makeMp4Tags('Cali Pachanguero', 'Grupo Niche')]);
  const mp4Tags = await extractAudioTags(mp4Blob);
  assert.equal(mp4Tags.title, 'Cali Pachanguero');
  assert.equal(mp4Tags.artist, 'Grupo Niche');
});
