import { describe, expect, test } from "bun:test";

import { createMixer, mixFrames } from "../../src/voice/mixer";
import { pcmOf, sampleAt } from "../helpers/pcm";

interface Harness {
  writes: Uint8Array[];
  advance(ms: number): void;
  tick(): void;
  cleared: boolean;
  mixer: ReturnType<typeof createMixer>;
}

function harness(gainFor?: (userId: string) => number): Harness {
  let t = 1000;
  let fn: (() => void) | null = null;
  const h: Harness = {
    writes: [],
    cleared: false,
    advance(ms: number): void {
      t += ms;
      fn?.();
    },
    tick(): void {
      fn?.();
    },
    mixer: undefined as unknown as ReturnType<typeof createMixer>,
  };
  h.mixer = createMixer({
    playback: { write: (pcm) => h.writes.push(pcm) },
    now: () => t,
    setTimer: (f) => {
      fn = f;
      return 1;
    },
    clearTimer: () => {
      fn = null;
      h.cleared = true;
    },
    gainFor,
  });
  return h;
}

function fill(h: Harness, userId: string, sample: number, count: number): void {
  const jb = h.mixer.buffer(userId);
  for (let i = 0; i < count; i += 1) jb.push(pcmOf(sample));
}

describe("mixFrames", () => {
  test("saturates", () => {
    expect(sampleAt(mixFrames([pcmOf(30000), pcmOf(30000)]), 0)).toBe(32767);
    expect(sampleAt(mixFrames([pcmOf(-30000), pcmOf(-30000)]), 0)).toBe(-32768);
  });

  test("sums samples", () => {
    expect(sampleAt(mixFrames([pcmOf(100), pcmOf(-30)]), 5)).toBe(70);
  });

  test("no frames gives 3840 zero bytes", () => {
    const out = mixFrames([]);
    expect(out.length).toBe(3840);
    expect(out.every((b) => b === 0)).toBe(true);
  });
});

describe("createMixer", () => {
  test("writes one frame per 20 ms and catches up after a 60 ms stall", () => {
    const h = harness();
    fill(h, "a", 10, 10);
    h.mixer.start();
    h.advance(10);
    expect(h.writes.length).toBe(0);
    h.advance(10);
    expect(h.writes.length).toBe(1);
    h.advance(20);
    expect(h.writes.length).toBe(2);
    h.advance(60);
    expect(h.writes.length).toBe(5);
    expect(sampleAt(h.writes[0]!, 0)).toBe(10);
  });

  test("resyncs when lag exceeds 100 ms", () => {
    const h = harness();
    fill(h, "a", 10, 10);
    h.mixer.start();
    h.advance(300);
    expect(h.writes.length).toBe(5);
    h.advance(10);
    expect(h.writes.length).toBe(5);
    h.advance(10);
    expect(h.writes.length).toBe(6);
  });

  test("writes nothing when no user produced a frame", () => {
    const h = harness();
    h.mixer.buffer("a");
    h.mixer.start();
    h.advance(100);
    expect(h.writes.length).toBe(0);
  });

  test("muted mixer writes nothing and discards buffers", () => {
    const h = harness();
    fill(h, "a", 10, 5);
    h.mixer.setMuted(true);
    h.mixer.start();
    h.advance(60);
    expect(h.writes.length).toBe(0);
    expect(h.mixer.buffer("a").size).toBe(2);
    h.mixer.setMuted(false);
    h.advance(20);
    expect(h.writes.length).toBe(1);
  });

  test("applies gain per user", () => {
    const h = harness((id) => (id === "a" ? 50 : 100));
    fill(h, "a", 1000, 3);
    fill(h, "b", 1000, 3);
    h.mixer.start();
    h.advance(20);
    expect(sampleAt(h.writes[0]!, 0)).toBe(1500);
  });

  test("users with empty buffers don't block others", () => {
    const h = harness();
    fill(h, "a", 10, 3);
    fill(h, "b", 20, 1);
    h.mixer.start();
    h.advance(20);
    expect(h.writes.length).toBe(1);
    expect(sampleAt(h.writes[0]!, 0)).toBe(10);
  });

  test("buffer is created on demand and reused; remove and activeUsers", () => {
    const h = harness();
    const jb = h.mixer.buffer("a");
    expect(h.mixer.buffer("a")).toBe(jb);
    h.mixer.buffer("b");
    expect(h.mixer.activeUsers().sort()).toEqual(["a", "b"]);
    h.mixer.remove("a");
    expect(h.mixer.activeUsers()).toEqual(["b"]);
  });

  test("stop clears the timer", () => {
    const h = harness();
    fill(h, "a", 10, 5);
    h.mixer.start();
    h.mixer.stop();
    expect(h.cleared).toBe(true);
    h.advance(100);
    expect(h.writes.length).toBe(0);
  });
});

describe("continuous mode (keeps pw-cat fed)", () => {
  function harness(prerollFrames = 4) {
    let t = 0;
    let tick: (() => void) | null = null;
    const written: Uint8Array[] = [];
    const mixer = createMixer({
      playback: { write: (pcm) => void written.push(pcm) },
      now: () => t,
      setTimer: (fn) => ((tick = fn), 1),
      clearTimer: () => {},
      continuous: true,
      prerollFrames,
    });
    return { mixer, written, advance: (ms: number) => ((t += ms), tick?.()) };
  }

  test("starts with a cushion of silence and writes one frame per slot even when nobody talks", () => {
    const h = harness(4);
    h.mixer.start();
    expect(h.written).toHaveLength(4);
    for (let i = 0; i < 10; i += 1) h.advance(20);
    expect(h.written).toHaveLength(14);
    expect(h.written.every((f) => f.length === 3840)).toBe(true);
  });

  test("an event-loop stall over 100 ms re-adds the cushion", () => {
    const h = harness(4);
    h.mixer.start();
    h.advance(300);
    expect(h.written).toHaveLength(4 + 5 + 4);
  });

  test("undeafen re-adds the cushion; deafened writes nothing", () => {
    const h = harness(3);
    h.mixer.start();
    h.mixer.setMuted(true);
    h.advance(20);
    expect(h.written).toHaveLength(3);
    h.mixer.setMuted(false);
    expect(h.written).toHaveLength(6);
  });

  test("after draining mid-sentence the jitter buffer resumes with 2 frames, not 3", () => {
    const h = harness(0);
    h.mixer.start();
    const jb = h.mixer.buffer("a");
    for (let i = 0; i < 3; i += 1) jb.push(new Uint8Array(3840).fill(9));
    for (let i = 0; i < 3; i += 1) expect(jb.pop()).not.toBeNull();
    jb.push(new Uint8Array(3840).fill(9));
    expect(jb.pop()).toBeNull();
    jb.push(new Uint8Array(3840).fill(9));
    expect(jb.pop()).not.toBeNull();
  });
});

test("setPlayback moves the stream to a new output with its own cushion; idleMs counts from the last real audio", () => {
  let t = 0;
  let tick: (() => void) | null = null;
  const first: Uint8Array[] = [];
  const second: Uint8Array[] = [];
  const mixer = createMixer({
    playback: { write: (p) => void first.push(p) },
    now: () => t,
    setTimer: (fn) => ((tick = fn), 1),
    clearTimer: () => {},
    continuous: true,
    prerollFrames: 3,
  });
  mixer.start();
  const jb = mixer.buffer("a");
  for (let i = 0; i < 3; i += 1) jb.push(pcmOf(100));
  t += 20;
  tick!();
  expect(mixer.idleMs()).toBe(0);
  t += 1000;
  expect(mixer.idleMs()).toBe(1000);
  mixer.setPlayback({ write: (p) => void second.push(p) });
  expect(second).toHaveLength(3);
  const before = first.length;
  t += 20;
  tick!();
  expect(first).toHaveLength(before);
  expect(second.length).toBeGreaterThan(3);
});

describe("mixer.play (event sounds)", () => {
  test("a one-shot is summed into the next slots, one frame per slot, then stops", () => {
    const h = harness();
    h.mixer.start();
    fill(h, "a", 100, 3);
    h.mixer.play([pcmOf(10), pcmOf(20)]);
    h.advance(20);
    h.advance(20);
    h.advance(20);
    expect(h.writes.map((w) => sampleAt(w, 0))).toEqual([110, 120, 100]);
  });

  test("with nobody talking the one-shot alone is written; two overlap and add up", () => {
    const h = harness();
    h.mixer.start();
    h.mixer.play([pcmOf(10), pcmOf(10)]);
    h.mixer.play([pcmOf(5)]);
    h.advance(20);
    h.advance(20);
    h.advance(20);
    expect(h.writes.map((w) => sampleAt(w, 0))).toEqual([15, 10]);
  });

  test("deafened (muted mixer): people are dropped but the one-shot still plays, after a short cushion", () => {
    const h = harness();
    h.mixer.start();
    h.mixer.setMuted(true);
    fill(h, "a", 100, 2);
    h.mixer.play([pcmOf(7)]);
    expect(h.writes.map((w) => sampleAt(w, 0))).toEqual([0, 0]);
    h.advance(20);
    h.advance(20);
    expect(h.writes.map((w) => sampleAt(w, 0))).toEqual([0, 0, 7]);
  });
});

describe("mixer diagnostics", () => {
  test("late ticks, skipped slots and the worst event-loop delay are counted per window", () => {
    const h = harness();
    h.mixer.start();
    h.advance(20); // a tiempo
    h.advance(65); // 3 slots juntos: atraso de 45 ms
    h.advance(200); // 10 slots (quedaban 5 ms del anterior): se mezclan 5 y se saltean 5, 185 ms tarde
    expect(h.mixer.stats()).toEqual({ underruns: 0, jitterDrops: 0, lateTicks: 2, skippedFrames: 5, loopLagMaxMs: 185 });
    expect(h.mixer.stats()).toEqual({ underruns: 0, jitterDrops: 0, lateTicks: 0, skippedFrames: 0, loopLagMaxMs: 0 });
  });

  test("jitter buffer underruns of everyone (including people who were removed) are added up", () => {
    const h = harness();
    h.mixer.start();
    for (const user of ["a", "b"]) {
      fill(h, user, 100, 3);
    }
    for (let i = 0; i < 4; i += 1) h.advance(20);
    fill(h, "a", 100, 1);
    fill(h, "b", 100, 1);
    h.mixer.remove("b");
    expect(h.mixer.stats().underruns).toBe(2);
  });
});
