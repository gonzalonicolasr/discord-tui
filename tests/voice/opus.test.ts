import { describe, expect, test } from "bun:test";

import { createOpusCodec } from "../../src/voice/opus";
import { createWasmOpus, setWasmModuleFactoryForTests } from "../../src/voice/opus-wasm";
import { fakeOpusModule } from "../helpers/fake-opus-module";
import { FRAME_BYTES, bestCorrelation, sampleAt, silence, sine440 } from "../helpers/pcm";

function rms(pcm: Uint8Array): number {
  let sum = 0;
  const count = pcm.length / 2;
  for (let i = 0; i < count; i += 1) {
    const sample = sampleAt(pcm, i);
    sum += sample * sample;
  }
  return Math.sqrt(sum / count);
}

describe("createOpusCodec", () => {
  for (const prefer of ["native", "wasm"] as const) {
    test(`opus ${prefer} reports its backend`, () => {
      const codec = createOpusCodec({ prefer });
      expect(["native", "wasm"]).toContain(codec.backend);
    });

    test(`opus ${prefer} round-trips a 440 Hz sine with the same length and shape`, () => {
      const codec = createOpusCodec({ prefer });
      const input = sine440();
      const encoded = codec.encode(input);
      // El segundo frame del decodificador todavía carga el arranque del codec.
      codec.decode(encoded);
      const out = codec.decode(encoded);
      expect(out.length).toBe(FRAME_BYTES);
      // Opus tiene delay algorítmico: se compara la forma dejando correr el desfasaje, no la fase exacta.
      expect(bestCorrelation(input, out)).toBeGreaterThan(0.7);
      expect(rms(out)).toBeGreaterThan(1000);
    });

    test(`opus ${prefer} decodes silence back to a near-silent frame`, () => {
      const codec = createOpusCodec({ prefer });
      const encoded = codec.encode(silence());
      codec.decode(encoded);
      const out = codec.decode(encoded);
      expect(rms(out)).toBeLessThan(500);
    });
  }

  test("encode+decode p99 under 5 ms per frame", () => {
    const codec = createOpusCodec();
    const pcm = sine440();
    codec.decode(codec.encode(pcm));
    const times: number[] = [];
    for (let i = 0; i < 50; i += 1) {
      const start = performance.now();
      codec.decode(codec.encode(pcm));
      times.push(performance.now() - start);
    }
    times.sort((a, b) => a - b);
    const p99 = times[Math.floor(times.length * 0.99)] ?? Infinity;
    expect(p99).toBeLessThan(5);
  });
});

test("many codecs alive at once keep working (opusscript's own wrapper aborts from the 5th instance)", () => {
  const encoder = createOpusCodec({ prefer: "wasm" });
  const decoders = Array.from({ length: 30 }, () => createOpusCodec({ prefer: "wasm" }));
  const input = sine440();
  for (let i = 0; i < 300; i += 1) decoders[i % 30]!.decode(encoder.encode(input));
  const out = decoders[29]!.decode(encoder.encode(input));
  expect(rms(out)).toBeGreaterThan(1000);
  for (const d of decoders) d.destroy();
  encoder.destroy();
});

/** Junta frames Opus de 20 ms en un solo paquete "code 3" (RFC 6716 §3.2.5): un paquete válido de hasta 120 ms. */
function longPacket(frames: Uint8Array[]): Uint8Array {
  const bytes = [(frames[0]![0]! & 0xfc) | 3, 0x80 | frames.length];
  for (const frame of frames.slice(0, -1)) {
    const length = frame.length - 1;
    if (length < 252) bytes.push(length);
    else {
      const first = 252 + ((length - 252) & 3);
      bytes.push(first, (length - first) / 4);
    }
  }
  for (const frame of frames) bytes.push(...frame.subarray(1));
  return Uint8Array.from(bytes);
}

test("a 120 ms Opus packet decodes whole and does not overwrite the other codecs in the WASM heap", () => {
  const encoder = createOpusCodec({ prefer: "wasm" });
  const frames = Array.from({ length: 6 }, () => encoder.encode(sine440()));
  const decoder = createOpusCodec({ prefer: "wasm" });
  const neighbours = Array.from({ length: 8 }, () => createOpusCodec({ prefer: "wasm" }));

  const out = decoder.decode(longPacket(frames));

  expect(out.length).toBe(FRAME_BYTES * 6);
  // Los que estaban al lado en el heap siguen decodificando bien, y el que recibió el paquete largo también.
  for (const codec of [...neighbours, decoder]) {
    codec.decode(frames[0]!);
    expect(rms(codec.decode(frames[1]!))).toBeGreaterThan(1000);
  }
  expect(encoder.encode(sine440()).length).toBeGreaterThan(0);
  for (const codec of [...neighbours, decoder, encoder]) codec.destroy();
});

test("the encoder rejects a frame size Opus cannot encode here or that does not match the PCM", () => {
  const codec = createWasmOpus(2);
  const pcmFor = (samples: number) => new Uint8Array(samples * 2 * 2);
  // 120 ms trapeaba dentro del WASM y 100 ms se colgaba: se rechazan antes de llegar al C++.
  expect(() => codec.encode(pcmFor(5760), 5760)).toThrow(RangeError);
  expect(() => codec.encode(pcmFor(4800), 4800)).toThrow(RangeError);
  // 20 ms de PCM con un frameSize de 40 ms leería memoria que no es del frame.
  expect(() => codec.encode(pcmFor(960), 1920)).toThrow(RangeError);
  expect(codec.encode(pcmFor(960), 960).length).toBeGreaterThan(0);
  expect(codec.encode(pcmFor(2880), 2880).length).toBeGreaterThan(0);
  codec.delete();
});

test("after a trap in the shared WASM module, that codec and the next ones move to a fresh module", () => {
  let modules = 0;
  setWasmModuleFactoryForTests(() => {
    modules += 1;
    return fakeOpusModule({ trapOn: 0xee });
  });
  try {
    const a = createOpusCodec({ prefer: "wasm" });
    const b = createOpusCodec({ prefer: "wasm" });
    expect(modules).toBe(1);
    // Ese paquete se pierde, pero el códec sigue andando sobre un módulo nuevo.
    expect(() => a.decode(Uint8Array.of(0xee))).toThrow(WebAssembly.RuntimeError);
    expect(a.decode(Uint8Array.of(1)).length).toBe(3840);
    expect(modules).toBe(2);
    expect(createOpusCodec({ prefer: "wasm" }).decode(Uint8Array.of(1)).length).toBe(3840);
    expect(modules).toBe(2);
    // El que estaba en el módulo roto se muda en su primer uso (también el encoder del micrófono).
    expect(b.encode(new Uint8Array(3840)).length).toBe(1);
    expect(modules).toBe(2);
  } finally {
    setWasmModuleFactoryForTests(null);
  }
});

test("codecs on a dropped WASM module move too even if that module answers with errors instead of trapping", () => {
  let modules = 0;
  setWasmModuleFactoryForTests(() => {
    modules += 1;
    return fakeOpusModule({ trapOn: 0xee, brokenReturns: -4 });
  });
  try {
    const a = createOpusCodec({ prefer: "wasm" });
    const b = createOpusCodec({ prefer: "wasm" });
    expect(() => a.decode(Uint8Array.of(0xee))).toThrow(WebAssembly.RuntimeError);
    // b no trapeó, pero su módulo ya no es confiable: se muda antes de decodificar y no pierde nada.
    expect(b.decode(Uint8Array.of(1)).length).toBe(3840);
    expect(modules).toBe(2);
  } finally {
    setWasmModuleFactoryForTests(null);
  }
});
