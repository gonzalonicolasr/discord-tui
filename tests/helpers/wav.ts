// Arma archivos WAV de prueba (por defecto PCM s16 estéreo 48 kHz) con una muestra constante.
export function makeWav(opts: {
  ms: number;
  channels?: number;
  rate?: number;
  bits?: number;
  format?: number;
  sample?: number;
  extraChunk?: boolean;
  noFmt?: boolean;
}): Uint8Array {
  const channels = opts.channels ?? 2;
  const rate = opts.rate ?? 48_000;
  const bits = opts.bits ?? 16;
  const bytesPerSample = bits / 8;
  const instants = Math.round((opts.ms / 1000) * rate);
  const dataBytes = instants * channels * bytesPerSample;
  const chunks: Uint8Array[] = [];

  const chunk = (id: string, body: Uint8Array): void => {
    const head = new Uint8Array(8);
    for (let i = 0; i < 4; i += 1) head[i] = id.charCodeAt(i);
    new DataView(head.buffer).setUint32(4, body.byteLength, true);
    chunks.push(head, body);
    if (body.byteLength % 2 === 1) chunks.push(new Uint8Array(1));
  };

  if (opts.extraChunk) chunk("LIST", new TextEncoder().encode("INFOISFT\u0005\u0000\u0000\u0000test\u0000"));
  if (!opts.noFmt) {
    const fmt = new Uint8Array(16);
    const v = new DataView(fmt.buffer);
    v.setUint16(0, opts.format ?? 1, true);
    v.setUint16(2, channels, true);
    v.setUint32(4, rate, true);
    v.setUint32(8, rate * channels * bytesPerSample, true);
    v.setUint16(12, channels * bytesPerSample, true);
    v.setUint16(14, bits, true);
    chunk("fmt ", fmt);
  }
  const data = new Uint8Array(dataBytes);
  if (bits === 16) {
    const v = new DataView(data.buffer);
    for (let i = 0; i < dataBytes; i += 2) v.setInt16(i, opts.sample ?? 0, true);
  }
  chunk("data", data);

  const body = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(12 + body);
  out.set(new TextEncoder().encode("RIFF"), 0);
  new DataView(out.buffer).setUint32(4, 4 + body, true);
  out.set(new TextEncoder().encode("WAVE"), 8);
  let offset = 12;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}
