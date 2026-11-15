import assert from 'node:assert/strict';
import test from 'node:test';
import { PlaybackQueue, sortTrackIds } from '../src/lib/utils/queue.ts';
import type { Track } from '../src/lib/types.ts';

function makeTrack(id: string, title: string, bpm: number | null): Track {
  return {
    id,
    fileName: `${title}.mp3`,
    opfsKey: `${id}.mp3`,
    title,
    artist: 'Tester',
    duration: 180,
    sizeBytes: 3_000_000,
    mimeType: 'audio/mpeg',
    bpm,
    bpmStatus: bpm ? 'done' : 'error',
    block: 'Fiesta Principal',
    playCount: 0,
    addedAt: 1000,
  };
}

test('PlaybackQueue avanza secuencialmente incluso con canciones repetidas en la lista', () => {
  const q = new PlaybackQueue();
  q.setRepeatMode('off');
  q.setPlaylistOrder(['a', 'b', 'a', 'c']);

  assert.equal(q.advanceNext(), 'a');
  assert.equal(q.advanceNext(), 'b');
  assert.equal(q.advanceNext(), 'a');
  assert.equal(q.advanceNext(), 'c');
  assert.equal(q.advanceNext(), null);
});

test('PlaybackQueue respeta repeat one en avance automático pero permite saltar manualmente', () => {
  const q = new PlaybackQueue();
  q.setPlaylistOrder(['a', 'b', 'c']);
  q.setRepeatMode('one');
  q.setCurrentTrack('a', false, 0);

  // Automático repite la misma canción
  assert.equal(q.advanceNext(false), 'a');
  assert.equal(q.advanceNext(false), 'a');

  // Salto manual avanza a la siguiente
  assert.equal(q.advanceNext(true), 'b');
  assert.equal(q.stepPrevious(), 'a');
});

test('PlaybackQueue en modo aleatorio recorre todas las pistas antes de repetir', () => {
  const q = new PlaybackQueue();
  const list = ['t1', 't2', 't3', 't4', 't5'];
  q.setPlaylistOrder(list);
  q.setRepeatMode('all');
  q.setShuffle(true);
  q.setCurrentTrack('t1', false);

  const visited = ['t1'];
  for (let i = 0; i < 4; i++) {
    const next = q.advanceNext(false);
    assert.ok(next);
    visited.push(next);
  }
  assert.equal(new Set(visited).size, 5);

  // Retroceder sigue el historial real reproducido
  assert.equal(q.stepPrevious(), visited[3]);
  assert.equal(q.stepPrevious(), visited[2]);
});

test('sortTrackIds ordena por BPM ascendente dejando pistas sin BPM al final', () => {
  const tracks = [
    makeTrack('1', 'Rápida', 132),
    makeTrack('2', 'Sin BPM', null),
    makeTrack('3', 'Lenta', 95),
    makeTrack('4', 'Media', 118),
  ];
  const map = new Map(tracks.map((t) => [t.id, t]));
  const sorted = sortTrackIds(['1', '2', '3', '4'], map, 'bpm-asc');
  assert.deepEqual(sorted, ['3', '4', '1', '2']);
});

test('PlaybackQueue enqueueNext reproduce pistas en cola inmediatamente después de la actual', () => {
  const q = new PlaybackQueue();
  const known = new Set(['p1', 'p2', 'p3', 'ext1', 'ext2']);
  q.setPlaylistOrder(['p1', 'p2', 'p3'], known);
  q.setCurrentTrack('p1', false, 0);

  q.enqueueNext('ext1');
  q.enqueueNext('ext2');

  assert.equal(q.peekNextTrackId(false), 'ext1');
  assert.deepEqual(q.getUpNextIds(), ['ext1', 'ext2']);

  assert.equal(q.advanceNext(false), 'ext1');
  assert.equal(q.advanceNext(false), 'ext2');
  // Al vaciarse la cola "siguiente", retoma p2 en la playlist donde estaba
  assert.equal(q.advanceNext(false), 'p2');
  assert.equal(q.advanceNext(false), 'p3');
});
