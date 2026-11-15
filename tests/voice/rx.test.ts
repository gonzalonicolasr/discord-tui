import { expect, test } from "bun:test";

import { SILENCE_FRAME } from "../../src/voice/constants";
import { createReceiver } from "../../src/voice/rx";

function harness(opts: { deaf?: boolean; failFor?: string } = {}) {
  const opusListeners = new Set<(userId: string, opus: Uint8Array) => void>();
  const speakingListeners = new Set<(userId: string, on: boolean) => void>();
  const pushed: Record<string, Uint8Array[]> = {};
  const removed: string[] = [];
  const speaking: [string, boolean][] = [];
  const timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
  let decoders = 0;
  let deaf = opts.deaf ?? false;
  const rx = createReceiver({
    session: {
      onOpus: (fn) => {
        opusListeners.add(fn);
        return () => opusListeners.delete(fn);
      },
      onSpeaking: (fn) => {
        speakingListeners.add(fn);
        return () => speakingListeners.delete(fn);
      },
    },
    mixer: {
      buffer: (userId) => ({
        push: (pcm: Uint8Array) => (pushed[userId] ??= []).push(pcm),
        pop: () => null,
        size: 0,
        reset: () => {},
      }),
      remove: (userId) => removed.push(userId),
    },
    makeDecoder: () => {
      decoders += 1;
      return {
        decode: (opus: Uint8Array) => {
          if (opus[0] === 0xee) throw new Error("bad");
          return Uint8Array.of(opus[0]!);
        },
      };
    },
    isDeaf: () => deaf,
    onSpeaking: (userId, on) => speaking.push([userId, on]),
    setTimer: ((fn: () => void, ms: number) => {
      const t = { fn, ms, cleared: false };
      timers.push(t);
      return t;
    }) as never,
    clearTimer: ((t: { cleared: boolean }) => {
      t.cleared = true;
    }) as never,
  });
  const opus = (userId: string, bytes: Uint8Array) => opusListeners.forEach((fn) => fn(userId, bytes));
  const fireTimers = () => timers.filter((t) => !t.cleared).forEach((t) => ((t.cleared = true), t.fn()));
  return { rx, opus, pushed, removed, speaking, fireTimers, decoders: () => decoders, setDeaf: (d: boolean) => (deaf = d) };
}

test("opus from two users is decoded into each user's buffer with one decoder each", () => {
  const h = harness();
  h.opus("a", Uint8Array.of(1));
  h.opus("b", Uint8Array.of(2));
  h.opus("a", Uint8Array.of(3));
  expect(h.pushed.a!.map((p) => p[0])).toEqual([1, 3]);
  expect(h.pushed.b!.map((p) => p[0])).toEqual([2]);
  expect(h.decoders()).toBe(2);
  expect(h.speaking).toEqual([["a", true], ["b", true]]);
});

test("five silence frames end speaking without decoding them", () => {
  const h = harness();
  h.opus("a", Uint8Array.of(1));
  for (let i = 0; i < 5; i += 1) h.opus("a", SILENCE_FRAME);
  expect(h.pushed.a).toHaveLength(1);
  expect(h.speaking.at(-1)).toEqual(["a", false]);
});

test("300 ms without packets ends speaking", () => {
  const h = harness();
  h.opus("a", Uint8Array.of(1));
  h.fireTimers();
  expect(h.speaking).toEqual([["a", true], ["a", false]]);
});

test("deafened: nothing decoded nor pushed, speaking still reported", () => {
  const h = harness({ deaf: true });
  h.opus("a", Uint8Array.of(1));
  expect(h.pushed.a).toBeUndefined();
  expect(h.decoders()).toBe(0);
  expect(h.speaking).toEqual([["a", true]]);
});

test("decode error is counted and other users keep playing", () => {
  const h = harness();
  h.opus("a", Uint8Array.of(0xee));
  h.opus("b", Uint8Array.of(2));
  expect(h.rx.stats().decodeErrors).toBe(1);
  expect(h.pushed.b).toHaveLength(1);
});

test("removing a user frees its decoder and buffer", () => {
  const h = harness();
  h.opus("a", Uint8Array.of(1));
  h.rx.removeUser("a");
  expect(h.removed).toEqual(["a"]);
  expect(h.rx.stats().usersActive).toBe(0);
  h.opus("a", Uint8Array.of(2));
  expect(h.decoders()).toBe(2);
});

test("a decoder that cannot be created is not retried on every packet and the others keep playing", () => {
  const opusListeners = new Set<(userId: string, opus: Uint8Array) => void>();
  let attempts = 0;
  const errors: unknown[] = [];
  const pushed: string[] = [];
  let clock = 0;
  createReceiver({
    session: { onOpus: (fn) => (opusListeners.add(fn), () => opusListeners.delete(fn)), onSpeaking: () => () => {} },
    mixer: { buffer: (userId) => ({ push: () => void pushed.push(userId), pop: () => null, size: 0, reset: () => {} }), remove: () => {} },
    makeDecoder: () => {
      attempts += 1;
      if (attempts === 1) throw new Error("no pude cargar Opus");
      return { decode: (o: Uint8Array) => o };
    },
    isDeaf: () => false,
    onSpeaking: () => {},
    onDecoderError: (e) => void errors.push(e),
    now: () => clock,
    setTimer: (() => 0) as never,
    clearTimer: (() => {}) as never,
  });
  const send = (userId: string) => opusListeners.forEach((fn) => fn(userId, Uint8Array.of(1, 2, 3, 4)));
  for (let i = 0; i < 50; i += 1) send("a");
  expect(attempts).toBe(1);
  expect(errors).toHaveLength(1);
  send("b");
  expect(pushed).toContain("b");
  clock = 6_000;
  send("a");
  expect(pushed).toContain("a");
});

test("diagnostic: compares the decoded level with a reference decoder for the first 50 packets (levels only)", () => {
  const opusListeners = new Set<(userId: string, opus: Uint8Array) => void>();
  const pcm = (amp: number) => {
    const b = new Uint8Array(3840);
    const v = new DataView(b.buffer);
    for (let i = 0; i < 1920; i += 1) v.setInt16(i * 2, i % 2 ? amp : -amp, true);
    return b;
  };
  const reports: [string, number, number, number][] = [];
  const rx = createReceiver({
    session: { onOpus: (fn) => (opusListeners.add(fn), () => opusListeners.delete(fn)), onSpeaking: () => () => {} },
    mixer: { buffer: () => ({ push: () => {}, pop: () => null, size: 0, reset: () => {} }), remove: () => {} },
    makeDecoder: () => ({ decode: () => pcm(100) }),
    referenceDecoder: () => ({ decode: () => pcm(10000) }),
    onDecoderCheck: (u, ours, ref, n) => void reports.push([u, Math.round(ours), Math.round(ref), n]),
    isDeaf: () => false,
    onSpeaking: () => {},
    setTimer: (() => 0) as never,
    clearTimer: (() => {}) as never,
  });
  for (let i = 0; i < 60; i += 1) opusListeners.forEach((fn) => fn("u", Uint8Array.of(1, 2, 3, i)));
  expect(reports).toEqual([["u", -50, -10, 50]]);
  expect(Math.round(rx.stats().peakDb)).toBe(-50);
  expect(rx.stats().peakDb).toBe(-96);
});

function clockHarness(opts: { failCreate?: (attempt: number) => boolean; reference?: boolean } = {}) {
  const opusListeners = new Set<(userId: string, opus: Uint8Array) => void>();
  let clock = 0;
  let created = 0;
  let destroyed = 0;
  let refsCreated = 0;
  let refsDestroyed = 0;
  const errors: [unknown, number][] = [];
  const pushed: string[] = [];
  const rx = createReceiver({
    session: { onOpus: (fn) => (opusListeners.add(fn), () => opusListeners.delete(fn)), onSpeaking: () => () => {} },
    mixer: { buffer: (userId) => ({ push: () => void pushed.push(userId), pop: () => null, size: 0, reset: () => {} }), remove: () => {} },
    makeDecoder: () => {
      created += 1;
      if (opts.failCreate?.(created)) throw new Error("no pude cargar Opus");
      return { decode: (o: Uint8Array) => o, destroy: () => void (destroyed += 1) };
    },
    ...(opts.reference
      ? {
          referenceDecoder: () => {
            refsCreated += 1;
            return { decode: (o: Uint8Array) => o, destroy: () => void (refsDestroyed += 1) };
          },
          onDecoderCheck: () => {},
        }
      : {}),
    isDeaf: () => false,
    onSpeaking: () => {},
    onDecoderError: (e) => void errors.push([e, 0]),
    now: () => clock,
    setTimer: (() => 0) as never,
    clearTimer: (() => {}) as never,
  });
  return {
    rx,
    errors,
    pushed,
    send: (userId: string) => opusListeners.forEach((fn) => fn(userId, Uint8Array.of(1, 2, 3, 4))),
    advance: (ms: number) => void (clock += ms),
    counts: () => ({ created, destroyed, refsCreated, refsDestroyed }),
  };
}

test("the decoder of someone who stopped talking a long time ago (or left the channel) is freed during the call", () => {
  const h = clockHarness();
  h.send("gone");
  h.send("talker");
  expect(h.rx.stats().usersActive).toBe(2);
  // "gone" no manda nada más; "talker" sigue hablando de a ratos.
  for (let minute = 0; minute < 3; minute += 1) {
    h.advance(60_000);
    h.send("talker");
  }
  expect(h.counts().destroyed).toBe(1);
  expect(h.rx.stats().usersActive).toBe(1);
  // Si vuelve, se le crea un decoder nuevo y se lo escucha.
  h.send("gone");
  expect(h.counts().created).toBe(3);
  expect(h.pushed.filter((u) => u === "gone")).toHaveLength(2);
});

test("stopping the receiver frees the reference decoders that had not finished their 50 packets", () => {
  const h = clockHarness({ reference: true });
  for (let i = 0; i < 10; i += 1) {
    h.send("a");
    h.send("b");
  }
  expect(h.counts().refsCreated).toBe(2);
  h.rx.stop();
  expect(h.counts().refsDestroyed).toBe(2);
  expect(h.counts().destroyed).toBe(2);
});
