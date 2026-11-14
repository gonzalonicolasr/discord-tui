import { expect, test } from "bun:test";
import { createDeflate, constants } from "node:zlib";

import { createZlibStreamInflater } from "../../src/gateway/inflate";

async function deflatedChunks(payloads: string[]): Promise<Buffer[]> {
  const deflate = createDeflate();
  const parts: Buffer[] = [];
  deflate.on("data", (chunk: Buffer) => parts.push(chunk));
  const chunks: Buffer[] = [];
  for (const payload of payloads) {
    deflate.write(payload);
    await new Promise<void>((resolve) => deflate.flush(constants.Z_SYNC_FLUSH, () => resolve()));
    chunks.push(Buffer.concat(parts));
    parts.length = 0;
  }
  deflate.destroy();
  return chunks;
}

test("inflater returns null until the 00 00 ff ff suffix arrives", async () => {
  const [chunk] = await deflatedChunks([JSON.stringify({ op: 10 })]);
  const half = Math.floor(chunk!.length / 2);
  const inflater = createZlibStreamInflater();
  expect(inflater.push(chunk!.subarray(0, half))).toBeNull();
  const text = inflater.push(chunk!.subarray(half));
  expect(JSON.parse(text!)).toEqual({ op: 10 });
});

test("inflater keeps context across messages", async () => {
  const chunks = await deflatedChunks([JSON.stringify({ op: 1 }), JSON.stringify({ op: 2 })]);
  const inflater = createZlibStreamInflater();
  expect(JSON.parse(inflater.push(chunks[0]!)!)).toEqual({ op: 1 });
  expect(JSON.parse(inflater.push(chunks[1]!)!)).toEqual({ op: 2 });
});

// Texto con poca repetición para que el historial comprimido crezca rápido (como un READY real de varios MB).
function noisy(i: number, size: number): string {
  let text = "";
  let x = i * 2654435761;
  while (text.length < size) {
    x = (x * 1103515245 + 12345) >>> 0;
    text += x.toString(36);
  }
  return JSON.stringify({ op: 0, s: i, d: { content: text } });
}

test("inflating a message costs the same late in the session as at the start (no re-inflating the history)", async () => {
  const payloads = Array.from({ length: 1500 }, (_, i) => noisy(i, 400));
  const chunks = await deflatedChunks(payloads);
  const inflater = createZlibStreamInflater();
  const times: number[] = [];
  for (const chunk of chunks) {
    const start = performance.now();
    inflater.push(chunk);
    times.push(performance.now() - start);
  }
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const early = mean(times.slice(50, 250));
  const late = mean(times.slice(-200));
  expect(late).toBeLessThan(Math.max(early * 4, 0.2));
}, 60_000);

test("inflater output is identical across many messages, including ones larger than the 32 KB window", async () => {
  const payloads = Array.from({ length: 300 }, (_, i) => (i % 50 === 7 ? noisy(i, 80_000) : noisy(i % 5, 300) + "ñandú 🎉"));
  const chunks = await deflatedChunks(payloads);
  const inflater = createZlibStreamInflater();
  const out = chunks.map((chunk) => inflater.push(chunk));
  expect(out).toEqual(payloads);
});
