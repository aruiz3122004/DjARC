import assert from 'node:assert/strict';
import test from 'node:test';
import {
  IsolatedSearchEngine,
  normalizeSearchText,
  recursiveSubsequenceScore,
} from '../src/lib/search/searchEngine.ts';
import type { Playlist, Track } from '../src/lib/types.ts';

function sampleTrack(id: string, title: string, artist: string): Track {
  return {
    id,
    fileName: `${artist} - ${title}.mp3`,
    opfsKey: `${id}.mp3`,
    title,
    artist,
    duration: 180,
    sizeBytes: 3_000_000,
    mimeType: 'audio/mpeg',
    bpm: 124,
    bpmStatus: 'done',
    block: 'Fiesta Principal',
    playCount: 0,
    addedAt: Date.now(),
  };
}

test('normalizeSearchText es flexible con mayúsculas, minúsculas, tildes y puntos', () => {
  const a = normalizeSearchText('Dr. Dre - Nuthin.');
  const b = normalizeSearchText('DR DRE nuthin');
  assert.equal(a.spaced, 'dr dre nuthin');
  assert.equal(a.compact, 'drdrenuthin');
  assert.equal(b.compact, a.compact);
});

test('IsolatedSearchEngine encuentra coincidencias locales de forma recursiva sin usar DB', () => {
  const engine = new IsolatedSearchEngine();
  const tracks: Track[] = [
    sampleTrack('1', 'Still D.R.E.', 'Dr. Dre'),
    sampleTrack('2', 'Tití Me Preguntó', 'Bad-Bunny'),
    sampleTrack('3', 'Around The World', 'Daft Punk'),
  ];
  const playlists: Playlist[] = [
    {
      id: 'pl-1',
      name: 'Fiesta.Principal',
      block: 'Fiesta Principal',
      trackIds: ['1', '2', '3'],
      createdAt: 1,
      updatedAt: 1,
    },
  ];

  engine.syncMemoryIndex(tracks, playlists);

  const r1 = engine.searchLocal('drdre still');
  assert.equal(r1[0]?.track.id, '1');

  const r2 = engine.searchLocal('TITI.me pregunto');
  assert.equal(r2[0]?.track.id, '2');

  const r3 = engine.searchLocal('fiesta principal');
  assert.equal(r3.length, 3);
});

test('recursiveSubsequenceScore detecta coincidencias parciales recursivamente', () => {
  const score = recursiveSubsequenceScore('dftpnk', 'daftpunk');
  assert.ok(score > 20);
  const miss = recursiveSubsequenceScore('zzz', 'daftpunk');
  assert.equal(miss, -1);
});
