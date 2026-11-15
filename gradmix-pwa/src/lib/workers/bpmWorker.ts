/**
 * Web Worker dedicado para detección ligera de BPM (60 Hz - 150 Hz).
 * Analiza la energía del bombo y bajo sin bloquear el hilo principal de la UI.
 */

export interface BpmAnalyzeRequest {
  id: string;
  sampleRate: number;
  samples: Float32Array;
}

export interface BpmAnalyzeResponse {
  id: string;
  bpm: number | null;
}

/**
 * Filtro pasa-banda biquad ligero (60 Hz - 150 Hz) para aislar golpes de bombo.
 */
function isolateKickBand(samples: Float32Array, sampleRate: number): Float32Array {
  const out = new Float32Array(samples.length);

  // Filtro pasa-alto simple (~55 Hz) seguido de pasa-bajo (~155 Hz)
  const dt = 1 / sampleRate;
  const rcHp = 1 / (2 * Math.PI * 55);
  const alphaHp = rcHp / (rcHp + dt);

  const rcLp = 1 / (2 * Math.PI * 155);
  const alphaLp = dt / (rcLp + dt);

  let prevIn = 0;
  let prevHp = 0;
  let prevLp = 0;

  for (let i = 0; i < samples.length; i++) {
    const x = samples[i];
    const hp = alphaHp * (prevHp + x - prevIn);
    prevIn = x;
    prevHp = hp;

    const lp = prevLp + alphaLp * (hp - prevLp);
    prevLp = lp;
    out[i] = lp;
  }

  return out;
}

function detectBpmFromPcm(samples: Float32Array, sampleRate: number): number | null {
  if (samples.length < sampleRate * 4) {
    return null;
  }

  const filtered = isolateKickBand(samples, sampleRate);

  // Envolvente de energía RMS cada ~10 ms
  const hop = Math.max(1, Math.floor(sampleRate * 0.01));
  const frameRate = sampleRate / hop;
  const numFrames = Math.floor(filtered.length / hop);
  if (numFrames < 200) return null;

  const energy = new Float32Array(numFrames);
  for (let f = 0; f < numFrames; f++) {
    let sum = 0;
    const start = f * hop;
    for (let k = 0; k < hop; k++) {
      const s = filtered[start + k];
      sum += s * s;
    }
    energy[f] = Math.sqrt(sum / hop);
  }

  // Función de ataque (onset) con diferencia positiva respecto a media móvil local
  const onset = new Float32Array(numFrames);
  const avgWindow = 16;
  for (let f = 1; f < numFrames; f++) {
    let localSum = 0;
    let count = 0;
    const wStart = Math.max(0, f - avgWindow);
    for (let j = wStart; j < f; j++) {
      localSum += energy[j];
      count++;
    }
    const localMean = count > 0 ? localSum / count : 0;
    const diff = energy[f] - Math.max(energy[f - 1], localMean * 1.12);
    onset[f] = diff > 0 ? diff : 0;
  }

  // Autocorrelación en rango típico de fiesta (70 - 175 BPM)
  const minBpm = 70;
  const maxBpm = 175;
  const minLag = Math.floor((60 / maxBpm) * frameRate);
  const maxLag = Math.ceil((60 / minBpm) * frameRate);

  let bestScore = -1;
  let bestLag = 0;

  for (let lag = minLag; lag <= maxLag; lag++) {
    let corr = 0;
    const limit = numFrames - lag;
    for (let i = 0; i < limit; i++) {
      corr += onset[i] * onset[i + lag];
    }

    // Ponderación suave hacia el rango bailable estándar (88 - 142 BPM)
    const candidateBpm = (60 * frameRate) / lag;
    let weight = 1.0;
    if (candidateBpm >= 88 && candidateBpm <= 142) {
      weight = 1.15;
    }
    const score = (corr / limit) * weight;

    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }

  if (bestLag <= 0 || bestScore <= 0) {
    return null;
  }

  let bpm = (60 * frameRate) / bestLag;

  // Normalización octava para evitar mitades o dobles extremos
  while (bpm < 78) bpm *= 2;
  while (bpm > 165) bpm /= 2;

  return Math.round(bpm);
}

self.onmessage = (event: MessageEvent<BpmAnalyzeRequest>) => {
  const { id, sampleRate, samples } = event.data;
  try {
    const bpm = detectBpmFromPcm(samples, sampleRate);
    const response: BpmAnalyzeResponse = { id, bpm };
    self.postMessage(response);
  } catch {
    const response: BpmAnalyzeResponse = { id, bpm: null };
    self.postMessage(response);
  }
};
