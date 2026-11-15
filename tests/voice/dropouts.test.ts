import { describe, expect, test } from "bun:test";

import { createMixer } from "../../src/voice/mixer";
import { pcmOf, sampleAt } from "../helpers/pcm";

const FRAME_MS = 20;
/** Tope de la cola de salida de `startPlayback` (src/voice/audio-io.ts, `queuedFrames` por defecto). */
const MAX_QUEUED = 10;

/**
 * Llamada simulada con reloj falso, de a 1 ms. Una persona habla en frases (1,5 s de voz y 0,5 s de silencio) y manda
 * un frame de 20 ms cada 20 ms; el primer frame de silencio (fin de la frase) viaja por la misma red, detrás de la voz
 * (el receptor se lo avisa al jitter buffer con `end()`). El mixer real saca un frame cada 20 ms (con `timerJitter` el
 * timer se corre ±ms en cada tick, como uno real) hacia una "pw-cat" que reproduce un frame cada 20 ms de su cola (con
 * el tope de 10 frames de audio-io): si la cola está vacía, se oye un hueco. Como en el event loop real, cuando se
 * traba primero corre el timer atrasado del mixer y recién después se entregan los paquetes que llegaron mientras tanto.
 * Cada frame lleva su número de paquete (1, 2, 3…) como muestra, así se sabe qué se oyó y con cuánta demora.
 */
function simulate(opts: {
  seconds: number;
  /** Cuándo llega el paquete enviado en `sentAt` (null = se perdió). */
  arrival?: (sentAt: number) => number | null;
  /** Pausas del event loop: [desde, duración] en ms. */
  stalls?: [number, number][];
  /** El timer del mixer se corre hasta ± estos ms en cada tick. */
  timerJitter?: number;
  /** Demora extra de la red por paquete: |gaussiana| con este desvío, en ms. */
  arrivalSigma?: number;
}) {
  let seed = 11;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
  const gauss = () => Math.sqrt(-2 * Math.log(1 - rnd())) * Math.cos(2 * Math.PI * rnd());
  let t = 0;
  let tick = null as (() => void) | null;
  const output: number[] = [];
  let queueDrops = 0;
  const mixer = createMixer({
    playback: {
      write: (pcm) => {
        if (output.length >= MAX_QUEUED) {
          output.shift();
          queueDrops += 1;
        }
        output.push(sampleAt(pcm, 0));
      },
    },
    now: () => t,
    setTimer: (fn) => ((tick = fn), 1),
    clearTimer: () => {},
    continuous: true,
    prerollFrames: 5,
  });
  const network = opts.arrival ?? ((sentAt: number) => sentAt + 5);
  const arrival = (sentAt: number) => {
    const at = network(sentAt);
    return at === null ? null : at + (opts.arrivalSigma ? Math.abs(gauss()) * opts.arrivalSigma : 0);
  };
  type Event = { at: number; packet: number; end: boolean };
  const events: Event[] = [];
  /** Paquete n → cuándo se mandó y de qué frase es. */
  const sentAt: number[] = [0];
  const phraseOf: number[] = [-1];
  for (let at = 0; at < opts.seconds * 1000; at += FRAME_MS) {
    const phrase = Math.floor(at / 2000);
    const inPhrase = at % 2000;
    if (inPhrase >= 1500) {
      if (inPhrase === 1500) events.push({ at: arrival(at) ?? at + 5, packet: 0, end: true });
      continue;
    }
    const packet = sentAt.length;
    sentAt.push(at);
    phraseOf.push(phrase);
    const arrives = arrival(at);
    if (arrives !== null) events.push({ at: arrives, packet, end: false });
  }
  // La red no desordena: cada paquete llega, como pronto, cuando llegó el anterior.
  for (let i = 1; i < events.length; i += 1) if (events[i]!.at < events[i - 1]!.at) events[i]!.at = events[i - 1]!.at;
  const stalled = (ms: number) => (opts.stalls ?? []).some(([from, length]) => ms >= from && ms < from + length);

  const played: { sample: number; at: number }[] = [];
  let deviceAt: number | null = null;
  mixer.start();
  let nextTick = FRAME_MS;
  let next = 0;
  let jitterMsMax = 0;
  const end = opts.seconds * 1000 + 500;
  for (t = 0; t <= end; t += 1) {
    // pw-cat reproduce a su ritmo aunque zcord esté trabado.
    if (deviceAt === null && output.length > 0) deviceAt = t;
    if (deviceAt !== null && t >= deviceAt) {
      played.push({ sample: output.length > 0 ? output.shift()! : -1, at: t });
      deviceAt += FRAME_MS;
    }
    if (stalled(t)) continue;
    if (t >= nextTick) {
      tick?.();
      const jitter = opts.timerJitter ? Math.round((rnd() * 2 - 1) * opts.timerJitter) : 0;
      nextTick = t + FRAME_MS + jitter;
    }
    while (next < events.length && events[next]!.at <= t) {
      const e = events[next]!;
      if (e.end) mixer.buffer("u").end?.();
      else mixer.buffer("u").push(pcmOf(e.packet));
      next += 1;
    }
    if (t % 1000 === 0) {
      const stats = mixer.stats();
      if (t > 10_000) jitterMsMax = Math.max(jitterMsMax, stats.jitterMsMax);
    }
  }
  const phrases = opts.seconds / 2;
  /**
   * Frames que se oyen sin la voz en medio de una frase (lo que Gon oye como "se corta"), desde `fromPhrase`.
   * `silence`: zcord escribió silencio (jitter buffer vacío o silencio metido por el mixer); `starved`: pw-cat se
   * quedó sin datos (zcord trabado más que su colchón).
   */
  const cuts = (fromPhrase: number, kind: "silence" | "starved") => {
    let total = 0;
    for (let phrase = fromPhrase; phrase < phrases; phrase += 1) {
      let first = -1;
      let last = -1;
      played.forEach((p, i) => {
        if (p.sample > 0 && phraseOf[p.sample] === phrase) {
          if (first === -1) first = i;
          last = i;
        }
      });
      if (first === -1) continue;
      for (let i = first; i <= last; i += 1) {
        const s = played[i]!.sample;
        if (kind === "silence" ? s === 0 : s === -1) total += 1;
      }
    }
    return total;
  };
  /** Demora media entre que se mandó un frame y que pw-cat lo reprodujo, desde `fromPhrase`. */
  const latencyMs = (fromPhrase: number) => {
    const ms = played.filter((p) => p.sample > 0 && phraseOf[p.sample]! >= fromPhrase).map((p) => p.at - sentAt[p.sample]!);
    return ms.reduce((a, b) => a + b, 0) / ms.length;
  };
  return { cuts, latencyMs, queueDrops: () => queueDrops, jitterMsMax: () => jitterMsMax };
}

/** Las primeras frases enseñan al buffer cuánto jitter hay: los cortes se cuentan desde la quinta. */
const FROM = 5;

describe("dropouts while listening (fake clock)", () => {
  test("even network, exact timer: no cuts of either kind", () => {
    const sim = simulate({ seconds: 20 });
    expect(sim.cuts(0, "silence")).toBe(0);
    expect(sim.cuts(0, "starved")).toBe(0);
  });

  test("timer jitter of ±1 ms and 1 ms of network jitter: no cuts and no extra latency (the cushion stays at 40 ms)", () => {
    const exact = simulate({ seconds: 40 });
    const noisy = simulate({ seconds: 40, timerJitter: 1, arrivalSigma: 1 });
    expect(noisy.cuts(FROM, "silence")).toBe(0);
    expect(noisy.cuts(FROM, "starved")).toBe(0);
    // El cruce de un borde de tick no es jitter: el colchón no sube y la demora es la de la red perfecta.
    expect(noisy.jitterMsMax()).toBe(40);
    expect(noisy.latencyMs(FROM)).toBeLessThanOrEqual(exact.latencyMs(FROM) + 5);
  });

  test("network jitter: bursts of 80-150 ms (plus timer jitter) do not cut phrases once the buffer learned them", () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
    // Cada ~700 ms la red se traba entre 80 y 150 ms y después suelta los paquetes juntos.
    const bursts: [number, number][] = [];
    for (let at = 300; at < 40_000; at += 600 + Math.floor(rnd() * 200)) bursts.push([at, 80 + Math.floor(rnd() * 70)]);
    const sim = simulate({
      seconds: 40,
      timerJitter: 1,
      arrival: (sentAt) => {
        const burst = bursts.find(([from, length]) => sentAt >= from && sentAt < from + length);
        return burst ? burst[0] + burst[1] + 5 : sentAt + 5;
      },
    });
    expect(sim.cuts(FROM, "silence")).toBe(0);
    expect(sim.cuts(FROM, "starved")).toBe(0);
    expect(sim.queueDrops()).toBe(0);
  });

  test("event-loop stalls of 60-90 ms: zcord writes no silence in a phrase once the buffer learned them", () => {
    const stalls: [number, number][] = [];
    for (let at = 250; at < 40_000; at += 700) stalls.push([at, 60 + ((at / 700) % 4) * 10]);
    const sim = simulate({ seconds: 40, stalls, timerJitter: 1 });
    expect(sim.cuts(FROM, "silence")).toBe(0);
    // Con el desfase del timer, 90 ms trabado puede pasar los 100 ms de colchón de pw-cat por un frame.
    expect(sim.cuts(FROM, "starved")).toBeLessThanOrEqual(stalls.length);
  });

  test("an event-loop stall longer than pw-cat's cushion only costs the time pw-cat had nothing, no extra silence", () => {
    // 150 ms trabado con 100 ms de colchón en pw-cat: se pierden ~50-60 ms (lo que pw-cat no tuvo), no 150.
    const stalls: [number, number][] = [];
    for (let at = 10_250; at < 40_000; at += 2_000) stalls.push([at, 150]);
    const sim = simulate({ seconds: 40, stalls, timerJitter: 1 });
    // La primera pausa cae en la frase 5 (la que enseña): se mira desde la 6.
    expect(sim.cuts(6, "silence")).toBe(0);
    // Lo que pw-cat no tuvo: la pausa (150) + el desfase del tick (hasta 20) − su colchón (80-100 según la fase)
    // = hasta 90 ms, o sea 4 frames por pausa como mucho. En la tabla del informe va el número medido.
    expect(sim.cuts(6, "starved")).toBeLessThanOrEqual((stalls.length - 1) * 4);
  });
});
