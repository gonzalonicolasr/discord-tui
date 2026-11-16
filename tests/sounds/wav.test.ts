import { describe, expect, test } from "bun:test";

import { MAX_WAV_MS, WavError, parseWav, wavFrames } from "../../src/sounds/wav";
import { makeWav } from "../helpers/wav";

function reason(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof WavError) return error.reason;
    throw error;
  }
  return "ok";
}

describe("parseWav", () => {
  test("a valid 48 kHz stereo s16 PCM file gives its data and duration", () => {
    const wav = makeWav({ ms: 100 });
    const parsed = parseWav(wav);
    expect(parsed.durationMs).toBe(100);
    expect(parsed.data.byteLength).toBe(4800 * 4);
    expect(parsed.data[0]).toBe(wav[44]!);
  });

  test("skips extra chunks (LIST) and finds fmt and data anywhere", () => {
    const parsed = parseWav(makeWav({ ms: 40, extraChunk: true }));
    expect(parsed.durationMs).toBe(40);
  });

  test("truncated files are rejected", () => {
    const wav = makeWav({ ms: 100 });
    expect(reason(() => parseWav(wav.subarray(0, wav.byteLength - 10)))).toBe("truncated");
    expect(reason(() => parseWav(wav.subarray(0, 30)))).toBe("truncated");
    expect(reason(() => parseWav(wav.subarray(0, 8)))).toBe("truncated");
  });

  test("anything that is not a RIFF/WAVE file is rejected", () => {
    expect(reason(() => parseWav(new TextEncoder().encode("OggS not a wav file at all, sorry")))).toBe("not-wav");
  });

  test("odd formats are rejected: mono, 44.1 kHz, 24 bit, float, no data", () => {
    expect(reason(() => parseWav(makeWav({ ms: 50, channels: 1 })))).toBe("format");
    expect(reason(() => parseWav(makeWav({ ms: 50, rate: 44_100 })))).toBe("format");
    expect(reason(() => parseWav(makeWav({ ms: 50, bits: 24 })))).toBe("format");
    expect(reason(() => parseWav(makeWav({ ms: 50, format: 3 })))).toBe("format");
    expect(reason(() => parseWav(makeWav({ ms: 0 })))).toBe("empty");
    expect(reason(() => parseWav(makeWav({ ms: 50, noFmt: true })))).toBe("format");
  });

  test("files longer than the cap are rejected", () => {
    expect(reason(() => parseWav(makeWav({ ms: MAX_WAV_MS })))).toBe("ok");
    expect(reason(() => parseWav(makeWav({ ms: MAX_WAV_MS + 20 })))).toBe("too-long");
  });
});

describe("wavFrames", () => {
  test("cuts into 20 ms frames of 3840 bytes and pads the last one with silence", () => {
    const frames = wavFrames(parseWav(makeWav({ ms: 50, sample: 1000 })).data);
    expect(frames).toHaveLength(3);
    for (const frame of frames) expect(frame.byteLength).toBe(3840);
    const last = new DataView(frames[2]!.buffer, frames[2]!.byteOffset);
    expect(last.getInt16(0, true)).toBe(1000);
    // 10 ms de sonido (480 instantes estéreo = 1920 bytes) y el resto silencio.
    expect(last.getInt16(1916, true)).toBe(1000);
    expect(last.getInt16(1920, true)).toBe(0);
    expect(last.getInt16(3838, true)).toBe(0);
  });
});
