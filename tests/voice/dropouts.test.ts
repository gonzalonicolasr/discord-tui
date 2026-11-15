import { describe, expect, test } from "bun:test";

import { createMixer } from "../../src/voice/mixer";
import { pcmOf, sampleAt } from "../helpers/pcm";

const FRAME_MS = 20;

/**
 * Llamada simulada con reloj falso, de a 1 ms. Una persona habla en frases (1,5 s de voz y 0,5 s de silencio, como
 * hablan las personas) y manda un frame de 20 ms cada 20 ms; al terminar cada frase manda silencio (el receptor se lo
 * avisa al jitter buffer con `end()`). El mixer saca un frame cada 20 ms hacia una "pw-cat" que reproduce un frame
 * cada 20 ms de su cola: si la cola está vacía, se oye un hueco. Como en el event loop real, cuando se traba primero
 * corre el timer atrasado del mixer y recién después se entregan los paquetes que llegaron mientras estaba trabado.
 */
function simulate(opts: {
  seconds: number;
  /** Cuándo llega el paquete enviado en `sentAt` (null = se perdió). */
  arrival?: (sentAt: number) => number | null;
  /** Pausas del event loop: [desde, duración] en ms. */
  stalls?: [number, number][];
}) {
  let t = 0;
  let tick = null as (() => void) | null;
  const output: number[] = [];
  const mixer = createMixer({
    playback: { write: (pcm) => void output.push(sampleAt(pcm, 0)) },
    now: () => t,
    setTimer: (fn) => ((tick = fn), 1),
    clearTimer: () => {},
    continuous: true,
    prerollFrames: 5,
  });
  const arrival = opts.arrival ?? ((sentAt) => sentAt + 5);
  type Event = { at: number; phrase: number; end: boolean };
  const events: Event[] = [];
  for (let sentAt = 0; sentAt < opts.seconds * 1000; sentAt += FRAME_MS) {
    const phrase = Math.floor(sentAt / 2000);
    const inPhrase = sentAt % 2000;
    if (inPhrase >= 1500) {
      // El primer frame de silencio (fin de la frase) viaja por la misma red, detrás de la voz.
      if (inPhrase === 1500) events.push({ at: arrival(sentAt) ?? sentAt + 5, phrase, end: true });
      continue;
    }
    const at = arrival(sentAt);
    if (at !== null) events.push({ at, phrase, end: false });
  }
  events.sort((a, b) => a.at - b.at);
  const stalled = (ms: number) => (opts.stalls ?? []).some(([from, length]) => ms >= from && ms < from + length);

  const played: number[] = [];
  let deviceAt: number | null = null;
  mixer.start();
  let nextTick = FRAME_MS;
  let next = 0;
  const end = opts.seconds * 1000 + 500;
  for (t = 0; t <= end; t += 1) {
    // pw-cat reproduce a su ritmo aunque zcord esté trabado.
    if (deviceAt === null && output.length > 0) deviceAt = t;
    if (deviceAt !== null && t >= deviceAt) {
      played.push(output.length > 0 ? output.shift()! : -1);
      deviceAt += FRAME_MS;
    }
    if (stalled(t)) continue;
    if (t >= nextTick) {
      tick?.();
      nextTick = t + FRAME_MS;
    }
    while (next < events.length && events[next]!.at <= t) {
      const e = events[next]!;
      if (e.end) mixer.buffer("u").end?.();
      else mixer.buffer("u").push(pcmOf(100 + e.phrase));
      next += 1;
    }
  }
  /** Frames que se oyen sin la voz en medio de una frase (lo que Gon oye como "se corta"), desde `fromPhrase`. */
  const cuts = (fromPhrase = 0) => {
    let total = 0;
    for (let phrase = fromPhrase; phrase < opts.seconds / 2; phrase += 1) {
      const first = played.indexOf(100 + phrase);
      const last = played.lastIndexOf(100 + phrase);
      if (first === -1) continue;
      for (let i = first; i <= last; i += 1) if (played[i] !== 100 + phrase) total += 1;
    }
    return total;
  };
  return { cuts, mixer };
}

describe("dropouts while listening (fake clock)", () => {
  test("even network, no stalls: no cuts", () => {
    expect(simulate({ seconds: 20 }).cuts()).toBe(0);
  });

  test("network jitter: bursts of 80-150 ms do not cut phrases once the buffer learned them", () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
    // Cada ~700 ms la red se traba entre 80 y 150 ms y después suelta los paquetes juntos.
    const bursts: [number, number][] = [];
    for (let at = 300; at < 40_000; at += 600 + Math.floor(rnd() * 200)) bursts.push([at, 80 + Math.floor(rnd() * 70)]);
    const sim = simulate({
      seconds: 40,
      arrival: (sentAt) => {
        const burst = bursts.find(([from, length]) => sentAt >= from && sentAt < from + length);
        return burst ? burst[0] + burst[1] + 5 : sentAt + 5;
      },
    });
    // Las primeras frases enseñan cuánto jitter hay; de la quinta en adelante no se corta más.
    expect(sim.cuts(5)).toBe(0);
  });
});
