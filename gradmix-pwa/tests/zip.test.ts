import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectAudioContainer, remuxFragmentedMp4ToStandardM4a } from '../src/lib/audio/audioContainer.ts';
import { buildZipBlobFromEntries, parsePlaylistZipFile } from '../src/lib/utils/zip.ts';

test('buildZipBlobFromEntries y parsePlaylistZipFile empaquetan y comprimen canciones en .zip', async () => {
  const mp3Bytes = new Uint8Array(Buffer.from('ID3\x03\x00\x00\x00\x00\x00\x0ahello-mp3'));
  // Entrada repetitiva tipo PCM WAV (>64B) para verificar método DEFLATE (8)
  const wavHeader = Buffer.from('RIFF\x24\x10\x00\x00WAVEfmt ');
  const wavBody = Buffer.alloc(4096, 0x55);
  const wavBytes = new Uint8Array(Buffer.concat([wavHeader, wavBody]));

  const zipBlob = await buildZipBlobFromEntries([
    { fileName: 'Jr. Boombastick - Pérdida Grande.wav', bytes: wavBytes },
    { fileName: 'Grupo Niche - Busca Por Dentro.mp3', bytes: mp3Bytes },
  ]);

  assert.ok(zipBlob.size < wavBytes.byteLength + mp3Bytes.byteLength);

  const rawHead = new Uint8Array(await zipBlob.slice(0, 10).arrayBuffer());
  assert.equal(rawHead[0], 0x50); // P
  assert.equal(rawHead[1], 0x4b); // K
  assert.equal(rawHead[2], 0x03);
  assert.equal(rawHead[3], 0x04);
  assert.equal(rawHead[8], 8); // DEFLATE method 8 para la entrada compresible

  const file = new File([zipBlob], 'Fiesta_Principal.zip', { type: 'application/zip' });
  const parsed = await parsePlaylistZipFile(file);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].fileName, 'Jr. Boombastick - Pérdida Grande.wav');
  assert.equal(parsed[0].mimeType, 'audio/wav');
  assert.deepEqual(new Uint8Array(await parsed[0].blob.arrayBuffer()), wavBytes);

  assert.equal(parsed[1].fileName, 'Grupo Niche - Busca Por Dentro.mp3');
  assert.equal(parsed[1].mimeType, 'audio/mpeg');
  assert.deepEqual(new Uint8Array(await parsed[1].blob.arrayBuffer()), mp3Bytes);
});

test('remuxFragmentedMp4ToStandardM4a convierte fMP4 a .m4a estándar no fragmentado con duración en moov', () => {
  const makeBox = (type: string, payload: Uint8Array) => {
    const out = new Uint8Array(8 + payload.byteLength);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, out.byteLength);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(payload, 8);
    return out;
  };
  const concat = (...arrs: Uint8Array[]) => {
    const total = arrs.reduce((s, a) => s + a.byteLength, 0);
    const out = new Uint8Array(total);
    let p = 0;
    for (const a of arrs) {
      out.set(a, p);
      p += a.byteLength;
    }
    return out;
  };

  const ftyp = makeBox('ftyp', new Uint8Array(Buffer.from('iso5\x00\x00\x00\x00iso6mp41', 'latin1')));
  const mdhdPayload = new Uint8Array(24);
  new DataView(mdhdPayload.buffer).setUint32(12, 44100); // timescale = 44100
  const mdhd = makeBox('mdhd', mdhdPayload);
  const stsd = makeBox('stsd', new Uint8Array(20)); // mínimo 16+4 con entrada falsa
  const stbl = makeBox('stbl', stsd);
  const minf = makeBox('minf', stbl);
  const mdia = makeBox('mdia', concat(mdhd, minf));
  const trak = makeBox('trak', mdia);
  const moov = makeBox('moov', trak);

  // trun flags=0x201 (data-offset + sample-size), 2 muestras de 4 bytes
  const trunPayload = new Uint8Array(20);
  const trv = new DataView(trunPayload.buffer);
  trv.setUint32(0, 0x000201);
  trv.setUint32(4, 2);
  trv.setUint32(8, 0);
  trv.setUint32(12, 4);
  trv.setUint32(16, 4);
  const tfhdPayload = new Uint8Array(12);
  const tfv = new DataView(tfhdPayload.buffer);
  tfv.setUint32(0, 0x000008); // default-sample-duration
  tfv.setUint32(4, 1);
  tfv.setUint32(8, 1024);
  const traf = makeBox('traf', concat(makeBox('tfhd', tfhdPayload), makeBox('trun', trunPayload)));
  const moof = makeBox('moof', traf);
  const mdat = makeBox('mdat', new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));

  const fmp4 = concat(ftyp, moov, moof, mdat);
  const remuxed = remuxFragmentedMp4ToStandardM4a(fmp4);
  assert.ok(remuxed !== null);
  const info = inspectAudioContainer(remuxed!);
  assert.equal(info.kind, 'mp4');
  assert.equal(info.fragmentedMp4, false);
});
