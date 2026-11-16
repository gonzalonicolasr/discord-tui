// Sonoridad de un sonido corto: filtro K de BS.1770 a 48 kHz y el máximo en ventanas de 100 ms (saltos de 10 ms),
// en LUFS aproximados. Es la medida con la que se normalizaron los WAV de src/sounds/wav (ver CREDITS.md).
const SR = 48_000;

function biquad(x: Float64Array, b: readonly number[], a: readonly number[]): Float64Array {
  const y = new Float64Array(x.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < x.length; i += 1) {
    const v = b[0]! * x[i]! + b[1]! * x1 + b[2]! * x2 - a[1]! * y1 - a[2]! * y2;
    x2 = x1;
    x1 = x[i]!;
    y2 = y1;
    y1 = v;
    y[i] = v;
  }
  return y;
}

/** `mono`: muestras de −1 a 1. */
export function loudness(mono: Float64Array): number {
  const shelf = biquad(mono, [1.53512485958697, -2.69169618940638, 1.19839281085285], [1, -1.69065929318241, 0.73248077421585]);
  const k = biquad(shelf, [1, -2, 1], [1, -1.99004745483398, 0.99007225036621]);
  const window = SR / 10;
  let best = -120;
  for (let i = 0; i < Math.max(1, k.length - window + 1); i += SR / 100) {
    let sum = 0;
    for (let j = i; j < Math.min(k.length, i + window); j += 1) sum += k[j]! ** 2;
    best = Math.max(best, -0.691 + 10 * Math.log10(sum / window + 1e-20));
  }
  return best;
}
