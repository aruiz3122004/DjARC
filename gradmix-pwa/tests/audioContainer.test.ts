import assert from 'node:assert/strict';
import test from 'node:test';
import {
  describeUnsupportedAudioReason,
  extractAdtsFromFragmentedMp4,
  inspectAudioContainer,
  orderSoundCloudTranscodings,
} from '../src/lib/audio/audioContainer.ts';

function box(type: string, ...parts: Uint8Array[]): Buffer {
  const payload = Buffer.concat(parts);
  const out = Buffer.alloc(8 + payload.length);
  out.writeUInt32BE(out.length, 0);
  out.write(type, 4, 4, 'latin1');
  payload.copy(out, 8);
  return out;
}

function fullBox(type: string, flags: number, ...parts: Uint8Array[]): Buffer {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(flags >>> 0, 0);
  return box(type, header, ...parts);
}

function makeMinimalMp4WithSampleEntry(entryType: string, extraEntryBytes = Buffer.alloc(0), withMoof = false): Uint8Array {
  const entryPayload = Buffer.concat([Buffer.alloc(28), extraEntryBytes]);
  const entry = box(entryType, entryPayload);
  const entryCount = Buffer.alloc(4);
  entryCount.writeUInt32BE(1, 0);
  const stsd = fullBox('stsd', 0, entryCount, entry);
  const stbl = box('stbl', stsd);
  const minf = box('minf', stbl);
  const mdia = box('mdia', minf);
  const trak = box('trak', mdia);
  const moov = box('moov', trak);
  const ftyp = box('ftyp', Buffer.from('iso5\0\0\0\x01iso5mp41', 'latin1'));
  if (!withMoof) {
    return new Uint8Array(Buffer.concat([ftyp, moov]));
  }
  const mfhd = fullBox('mfhd', 0, Buffer.alloc(4));
  const moof = box('moof', mfhd);
  return new Uint8Array(Buffer.concat([ftyp, moov, moof]));
}

test('orderSoundCloudTranscodings filtra DRM cifrado y prioriza streams reproducibles', () => {
  const onlyEncrypted = orderSoundCloudTranscodings([
    { url: 'https://sc/1', snipped: false, format: { protocol: 'cbc-encrypted-hls', mime_type: 'audio/mp4; codecs="mp4a.40.2"' } },
    { url: 'https://sc/2', snipped: false, format: { protocol: 'ctr-encrypted-hls', mime_type: 'audio/mp4; codecs="mp4a.40.2"' } },
    { url: 'https://sc/3', snipped: false, format: { protocol: 'cbc-encrypted-hls', mime_type: 'audio/mpegurl' } },
  ]);
  assert.equal(onlyEncrypted.length, 0);

  const mixed = orderSoundCloudTranscodings([
    { url: 'https://sc/enc', snipped: false, format: { protocol: 'cbc-encrypted-hls', mime_type: 'audio/mp4' } },
    { url: 'https://sc/snip', snipped: true, format: { protocol: 'progressive', mime_type: 'audio/mpeg' } },
    { url: 'https://sc/hls-mp4', snipped: false, format: { protocol: 'hls', mime_type: 'audio/mp4; codecs="mp4a.40.2"' } },
    { url: 'https://sc/hls-mp3', snipped: false, format: { protocol: 'hls', mime_type: 'audio/mpeg' } },
    { url: 'https://sc/prog-mp3', snipped: false, format: { protocol: 'progressive', mime_type: 'audio/mpeg' } },
  ]);
  assert.deepEqual(
    mixed.map((m) => m.url),
    ['https://sc/prog-mp3', 'https://sc/hls-mp3', 'https://sc/hls-mp4']
  );
});

test('inspectAudioContainer detecta MP4 cifrado con DRM (enca/sinf), ALAC y respuestas inválidas', () => {
  const encryptedMp4 = makeMinimalMp4WithSampleEntry('enca', box('sinf'), true);
  const drmInfo = inspectAudioContainer(encryptedMp4);
  assert.equal(drmInfo.kind, 'mp4');
  assert.equal(drmInfo.encrypted, true);
  assert.equal(drmInfo.codec, 'drm');
  assert.match(
    describeUnsupportedAudioReason('tema.m4a', encryptedMp4, 'audio/mp4'),
    /protección DRM\/cifrado/i
  );

  const clearAac = makeMinimalMp4WithSampleEntry('mp4a', Buffer.alloc(0), true);
  const aacInfo = inspectAudioContainer(clearAac);
  assert.equal(aacInfo.kind, 'mp4');
  assert.equal(aacInfo.encrypted, false);
  assert.equal(aacInfo.codec, 'aac');
  assert.equal(aacInfo.fragmentedMp4, true);

  const alacMp4 = makeMinimalMp4WithSampleEntry('alac', Buffer.alloc(0), false);
  const alacInfo = inspectAudioContainer(alacMp4);
  assert.equal(alacInfo.codec, 'alac');
  assert.match(
    describeUnsupportedAudioReason('lossless.m4a', alacMp4, 'audio/mp4'),
    /ALAC/i
  );

  const htmlPayload = new Uint8Array(Buffer.from('<html><body>Error 403</body></html>', 'utf8'));
  assert.equal(inspectAudioContainer(htmlPayload).kind, 'invalid-text');
});

test('extractAdtsFromFragmentedMp4 genera tramas ADTS válidas desde fMP4 AAC sin cifrar', () => {
  // esds con AudioSpecificConfig = 0x12 0x10 (AAC-LC=2, 44100Hz=4, Stereo=2)
  const esdsPayload = Buffer.from([
    0x03, 0x19, 0x00, 0x01, 0x00,
    0x04, 0x11, 0x40, 0x15, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x05, 0x02, 0x12, 0x10,
  ]);
  const esds = fullBox('esds', 0, esdsPayload);
  const mp4Init = makeMinimalMp4WithSampleEntry('mp4a', esds, false);

  const fakeFrame1 = Buffer.from([0x21, 0x11, 0x22, 0x33, 0x44]);
  const fakeFrame2 = Buffer.from([0x21, 0xaa, 0xbb, 0xcc]);

  // trun flags 0x000200 (sample_size_present)
  const sampleCount = Buffer.alloc(4);
  sampleCount.writeUInt32BE(2, 0);
  const sampleSizes = Buffer.alloc(8);
  sampleSizes.writeUInt32BE(fakeFrame1.length, 0);
  sampleSizes.writeUInt32BE(fakeFrame2.length, 4);
  const trun = fullBox('trun', 0x000200, sampleCount, sampleSizes);
  const traf = box('traf', trun);
  const moof = box('moof', traf);
  const mdat = box('mdat', fakeFrame1, fakeFrame2);

  const fmp4 = new Uint8Array(Buffer.concat([Buffer.from(mp4Init), moof, mdat]));
  const adts = extractAdtsFromFragmentedMp4(fmp4);
  assert.ok(adts, 'Debe extraer tramas ADTS');
  assert.equal(adts.length, 7 + fakeFrame1.length + 7 + fakeFrame2.length);
  // Verificar cabecera ADTS de la primera trama (syncword 0xFFF y longitud total 12 bytes)
  assert.equal(adts[0], 0xff);
  assert.equal(adts[1], 0xf1);
  const len1 = ((adts[3] & 0x03) << 11) | (adts[4] << 3) | ((adts[5] >> 5) & 0x07);
  assert.equal(len1, 7 + fakeFrame1.length);
});
