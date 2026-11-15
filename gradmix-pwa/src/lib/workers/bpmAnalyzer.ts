import { readAudioArrayBuffer, readAudioBlob } from '../storage/opfsStorage';
import type { BpmAnalyzeRequest, BpmAnalyzeResponse } from './bpmWorker';

/**
 * Extrae rápidamente la duración de un File de audio sin decodificar todo el PCM a RAM.
 */
export function extractAudioDurationQuick(file: File): Promise<number> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const audio = document.createElement('audio');
    audio.preload = 'metadata';

    const cleanup = () => {
      audio.removeAttribute('src');
      audio.load();
      URL.revokeObjectURL(url);
    };

    const timer = window.setTimeout(() => {
      cleanup();
      resolve(0);
    }, 4000);

    audio.onloadedmetadata = () => {
      window.clearTimeout(timer);
      const dur = Number.isFinite(audio.duration) ? audio.duration : 0;
      cleanup();
      resolve(dur);
    };

    audio.onerror = () => {
      window.clearTimeout(timer);
      cleanup();
      resolve(0);
    };

    audio.src = url;
  });
}

/**
 * Cola secuencial de análisis de BPM en Web Worker.
 * Procesa exactamente 1 canción a la vez para no superar nunca el presupuesto de RAM
 * al importar carpetas con 100+ canciones.
 */
export class BpmAnalyzerQueue {
  private worker: Worker | null = null;
  private queue: Array<{ id: string; opfsKey: string }> = [];
  private processing = false;
  private decodeCtx: AudioContext | null = null;
  private onResult: (id: string, bpm: number | null, duration?: number) => void;

  constructor(onResult: (id: string, bpm: number | null, duration?: number) => void) {
    this.onResult = onResult;
  }

  private ensureWorker(): Worker {
    if (!this.worker) {
      this.worker = new Worker(new URL('./bpmWorker.ts', import.meta.url), {
        type: 'module',
      });
    }
    return this.worker;
  }

  enqueue(id: string, opfsKey: string): void {
    if (this.queue.some((item) => item.id === id)) return;
    this.queue.push({ id, opfsKey });
    if (!this.processing) {
      void this.processNext();
    }
  }

  removeFromQueue(id: string): void {
    this.queue = this.queue.filter((item) => item.id !== id);
  }

  private async processNext(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    try {
      while (this.queue.length > 0) {
        const item = this.queue.shift()!;
        try {
          const result = await this.analyzeSingleTrack(item.id, item.opfsKey);
          this.onResult(item.id, result.bpm, result.duration);
        } catch {
          this.onResult(item.id, null);
        }
        // Pausa generosa para no competir por CPU con clics de reproducción ni UI
        await new Promise((r) => setTimeout(r, 180));
      }
    } finally {
      this.processing = false;
      if (this.decodeCtx && this.decodeCtx.state !== 'closed') {
        try {
          await this.decodeCtx.close();
        } catch {
          // Ignorar
        }
        this.decodeCtx = null;
      }
    }
  }

  private async analyzeSingleTrack(
    id: string,
    opfsKey: string
  ): Promise<{ bpm: number | null; duration: number }> {
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;

    if (!this.decodeCtx || this.decodeCtx.state === 'closed') {
      this.decodeCtx = new AudioCtx();
    }

    try {
      const arrayBuf = await readAudioArrayBuffer(opfsKey);
      const decoded = await this.decodeCtx.decodeAudioData(arrayBuf);
      const duration = decoded.duration;

    // Tomamos una ventana de máximo 40 segundos desde el ~25% del tema (evitando intros silenciosas)
    const targetRate = 11025;
    const windowSec = Math.min(40, Math.max(8, duration * 0.7));
    const startSec = duration > 50 ? duration * 0.25 : 0;

    const srcSampleRate = decoded.sampleRate;
    const startSample = Math.floor(startSec * srcSampleRate);
    const endSample = Math.min(decoded.length, Math.floor((startSec + windowSec) * srcSampleRate));
    const step = Math.max(1, Math.floor(srcSampleRate / targetRate));
    const outLength = Math.floor((endSample - startSample) / step);

    const monoDownsampled = new Float32Array(outLength);
    const numChannels = decoded.numberOfChannels;
    const ch0 = decoded.getChannelData(0);
    const ch1 = numChannels > 1 ? decoded.getChannelData(1) : null;

    for (let i = 0, srcIdx = startSample; i < outLength; i++, srcIdx += step) {
      monoDownsampled[i] = ch1 ? (ch0[srcIdx] + ch1[srcIdx]) * 0.5 : ch0[srcIdx];
    }

    const actualRate = srcSampleRate / step;
    const worker = this.ensureWorker();

    const bpm = await new Promise<number | null>((resolve) => {
      const handleMsg = (ev: MessageEvent<BpmAnalyzeResponse>) => {
        if (ev.data.id !== id) return;
        worker.removeEventListener('message', handleMsg);
        worker.removeEventListener('error', handleErr);
        resolve(ev.data.bpm);
      };
      const handleErr = () => {
        worker.removeEventListener('message', handleMsg);
        worker.removeEventListener('error', handleErr);
        resolve(null);
      };
      worker.addEventListener('message', handleMsg);
      worker.addEventListener('error', handleErr);

      const req: BpmAnalyzeRequest = {
        id,
        sampleRate: actualRate,
        samples: monoDownsampled,
      };
      // Transferencia zero-copy del ArrayBuffer al Worker
      worker.postMessage(req, [monoDownsampled.buffer]);
    });

      return { bpm, duration };
    } catch {
      const blob = await readAudioBlob(opfsKey);
      const fallbackFile = new File([blob], opfsKey, { type: blob.type || 'audio/mpeg' });
      const duration = await extractAudioDurationQuick(fallbackFile);
      return { bpm: null, duration };
    }
  }

  dispose(): void {
    this.queue = [];
    this.worker?.terminate();
    this.worker = null;
    if (this.decodeCtx && this.decodeCtx.state !== 'closed') {
      void this.decodeCtx.close();
      this.decodeCtx = null;
    }
  }
}
