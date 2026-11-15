import { expect, test } from "bun:test";

import { createJitterBuffer } from "../../src/voice/jitter";
import { createOpusCodec } from "../../src/voice/opus";
import { createReceiver } from "../../src/voice/rx";
import { framesOf, snrDb, voiceLike } from "../helpers/voice-like";

/**
 * Receptor real + jitter buffer real + Opus WASM real, con una señal tipo voz. Un slot de 20 ms por vuelta: entran
 * los paquetes que llegaron, el mixer hace pop, y los que llegan "1 ms tarde" entran recién después de ese pop.
 * `arrival(k)` = slot en que llega el paquete k; con `.5` llega justo después del pop de ese slot.
 */
function play(arrival: (k: number) => number) {
  const pcm = framesOf(voiceLike(2));
  const encoder = createOpusCodec({ prefer: "wasm" });
  const packets = pcm.map((frame) => encoder.encode(frame));
  const reference = createOpusCodec({ prefer: "wasm" });
  const clean = packets.map((p) => reference.decode(p));
  const decoded: Uint8Array[] = [];
  const jb = createJitterBuffer({ prebufferFrames: 2, rebufferFrames: 2 });
  const listeners = new Set<(userId: string, opus: Uint8Array) => void>();
  const rx = createReceiver({
    session: { onOpus: (fn) => (listeners.add(fn), () => listeners.delete(fn)), onSpeaking: () => () => {} },
    mixer: { buffer: () => jb, remove: () => {} },
    makeDecoder: () => {
      const codec = createOpusCodec({ prefer: "wasm" });
      // Se guarda lo que sale de cada paquete real, en el orden en que llegan (que es el de envío).
      return { decode: (o: Uint8Array) => (decoded.push(codec.decode(o)), decoded.at(-1)!), destroy: codec.destroy };
    },
    isDeaf: () => false,
    onSpeaking: () => {},
    setTimer: (() => 0) as never,
    clearTimer: (() => {}) as never,
  });
  const send = (k: number) => listeners.forEach((fn) => fn("u", packets[k]!));
  let next = 0;
  for (let slot = 0; slot < packets.length + 20; slot += 1) {
    while (next < packets.length && arrival(next) <= slot) send(next++);
    jb.pop();
    while (next < packets.length && arrival(next) <= slot + 0.5) send(next++);
  }
  rx.stop();
  const worst = Math.min(...clean.map((c, k) => snrDb(decoded[k]!, c)));
  return { worst };
}

test("packets that only come late are decoded exactly as if on time (nothing moves the decoder ahead of them)", () => {
  for (const K of [30, 47, 61, 80]) {
    // Escalón: desde K todo llega un slot más tarde (y 1 ms después del pop).
    const step = play((k) => (k < K ? k : k + 1.5));
    expect(step.worst).toBeGreaterThan(40);
    // Ráfaga: K y K+1 retenidos y soltados juntos 2 slots después.
    const burst = play((k) => (k === K || k === K + 1 ? K + 2.5 : k));
    expect(burst.worst).toBeGreaterThan(40);
  }
});

test("a gap of really lost packets is left silent: the decoder is never asked for PLC (measured worse than silence)", () => {
  let asked = 0;
  const jb = createJitterBuffer({ prebufferFrames: 2, rebufferFrames: 2 });
  const listeners = new Set<(userId: string, opus: Uint8Array) => void>();
  const decoder = { decode: (o: Uint8Array) => new Uint8Array(3840).fill(o[0]!), conceal: () => (asked++, new Uint8Array(3840 * 6)) };
  createReceiver({
    session: { onOpus: (fn) => (listeners.add(fn), () => listeners.delete(fn)), onSpeaking: () => () => {} },
    mixer: { buffer: () => jb, remove: () => {} },
    makeDecoder: () => decoder,
    isDeaf: () => false,
    onSpeaking: () => {},
    setTimer: (() => 0) as never,
    clearTimer: (() => {}) as never,
  });
  const out: (number | null)[] = [];
  for (let k = 1; k <= 20; k += 1) {
    if (k < 8 || k > 13) listeners.forEach((fn) => fn("u", Uint8Array.of(k, 1, 2)));
    const frame = jb.pop();
    out.push(frame ? frame[0]! : null);
  }
  expect(asked).toBe(0);
  // Durante los 6 perdidos suena silencio (null), no voz inventada.
  expect(out.slice(7, 13).every((f) => f === null || f < 8)).toBe(true);
});
