/**
 * Señal sintética "tipo voz" (no es audio de nadie): tren de pulsos a ~130 Hz con vibrato, tres formantes, envolvente
 * silábica y un poco de ruido. No es estacionaria como un seno fijo, así que un PLC que "sigue la onda" no sale bien
 * de casualidad. Basada en el script del review (rev-opusleak2/tmp/plc2.ts).
 */
export function voiceLike(seconds: number): Int16Array {
  const SR = 48_000;
  const n = seconds * SR;
  const out = new Int16Array(n * 2);
  let phase = 0;
  let seed = 1;
  const noise = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32 - 0.5);
  const formants = [
    [700, 80],
    [1200, 100],
    [2600, 150],
  ].map(([f, bw]) => ({
    a1: 2 * Math.exp((-Math.PI * bw!) / SR) * Math.cos((2 * Math.PI * f!) / SR),
    a2: -Math.exp((-2 * Math.PI * bw!) / SR),
    y1: 0,
    y2: 0,
  }));
  for (let i = 0; i < n; i += 1) {
    const f0 = 130 + 8 * Math.sin((2 * Math.PI * 4 * i) / SR);
    phase += f0 / SR;
    let pulse = 0;
    if (phase >= 1) {
      phase -= 1;
      pulse = 1;
    }
    let s = 0;
    for (const r of formants) {
      const y = pulse * 0.5 + noise() * 0.02 + r.a1 * r.y1 + r.a2 * r.y2;
      r.y2 = r.y1;
      r.y1 = y;
      s += y;
    }
    const envelope = 0.5 + 0.5 * Math.sin((2 * Math.PI * 3 * i) / SR - 1);
    const v = Math.max(-32000, Math.min(32000, s * 2600 * envelope));
    out[2 * i] = v;
    out[2 * i + 1] = v;
  }
  return out;
}

/** Frames de 20 ms (3840 bytes s16le estéreo) de una señal. */
export function framesOf(pcm: Int16Array): Uint8Array[] {
  const frames: Uint8Array[] = [];
  for (let offset = 0; offset + 960 * 2 <= pcm.length; offset += 960 * 2)
    frames.push(new Uint8Array(pcm.buffer, pcm.byteOffset + offset * 2, 3840).slice());
  return frames;
}

/** SNR en dB de `got` contra `ref` (PCM s16le). */
export function snrDb(got: Uint8Array, ref: Uint8Array): number {
  const a = new Int16Array(got.buffer, got.byteOffset, got.byteLength / 2);
  const b = new Int16Array(ref.buffer, ref.byteOffset, ref.byteLength / 2);
  let error = 0;
  let signal = 0;
  for (let i = 0; i < b.length; i += 1) {
    error += (a[i]! - b[i]!) ** 2;
    signal += b[i]! ** 2;
  }
  return 10 * Math.log10(signal / Math.max(error, 1));
}
