import { describe, expect, test } from "bun:test";

import { createJitterBuffer } from "../../src/voice/jitter";
import { pcmOf, sampleAt } from "../helpers/pcm";

describe("createJitterBuffer", () => {
  test("null until 3 frames, then FIFO", () => {
    const jb = createJitterBuffer();
    jb.push(pcmOf(1));
    expect(jb.pop()).toBeNull();
    jb.push(pcmOf(2));
    expect(jb.pop()).toBeNull();
    jb.push(pcmOf(3));
    expect(jb.size).toBe(3);
    expect(sampleAt(jb.pop()!, 0)).toBe(1);
    expect(sampleAt(jb.pop()!, 0)).toBe(2);
    expect(sampleAt(jb.pop()!, 0)).toBe(3);
    expect(jb.size).toBe(0);
  });

  test("drained buffer prebuffers again instead of repeating", () => {
    const jb = createJitterBuffer();
    for (let i = 1; i <= 3; i += 1) jb.push(pcmOf(i));
    jb.pop();
    jb.pop();
    jb.pop();
    expect(jb.pop()).toBeNull();
    jb.push(pcmOf(4));
    expect(jb.pop()).toBeNull();
    jb.push(pcmOf(5));
    jb.push(pcmOf(6));
    expect(sampleAt(jb.pop()!, 0)).toBe(4);
  });

  test("keeps playing while frames remain after prebuffer", () => {
    const jb = createJitterBuffer({ prebufferFrames: 2 });
    jb.push(pcmOf(1));
    jb.push(pcmOf(2));
    expect(sampleAt(jb.pop()!, 0)).toBe(1);
    jb.push(pcmOf(3));
    expect(sampleAt(jb.pop()!, 0)).toBe(2);
    expect(sampleAt(jb.pop()!, 0)).toBe(3);
  });

  test("overflow drops the oldest", () => {
    const jb = createJitterBuffer({ maxFrames: 4 });
    for (let i = 1; i <= 6; i += 1) jb.push(pcmOf(i));
    expect(jb.size).toBe(4);
    expect(sampleAt(jb.pop()!, 0)).toBe(3);
  });

  test("reset empties and requires prebuffer again", () => {
    const jb = createJitterBuffer();
    for (let i = 1; i <= 3; i += 1) jb.push(pcmOf(i));
    jb.reset();
    expect(jb.size).toBe(0);
    jb.push(pcmOf(7));
    expect(jb.pop()).toBeNull();
  });
});

describe("jitter buffer diagnostics", () => {
  test("emptying in the middle of a phrase counts as an underrun when audio comes back; a full buffer counts drops", () => {
    const jb = createJitterBuffer({ maxFrames: 4 });
    for (let i = 1; i <= 3; i += 1) jb.push(pcmOf(i));
    for (let i = 0; i < 4; i += 1) jb.pop(); // 3 frames y un slot vacío
    jb.push(pcmOf(4)); // el audio vuelve: fue un corte
    for (let i = 5; i <= 10; i += 1) jb.push(pcmOf(i)); // 7 en un buffer de 4: tira 3
    expect(jb.takeStats!()).toEqual({ underruns: 1, drops: 3 });
    expect(jb.takeStats!()).toEqual({ underruns: 0, drops: 0 });
  });

  test("emptying after the speaker ended the phrase is not an underrun", () => {
    const jb = createJitterBuffer();
    for (let i = 1; i <= 3; i += 1) jb.push(pcmOf(i));
    jb.end!();
    for (let i = 0; i < 5; i += 1) jb.pop();
    jb.push(pcmOf(4));
    expect(jb.takeStats!().underruns).toBe(0);
  });

  test("audio that comes back after a long pause is a new phrase, not an underrun", () => {
    const jb = createJitterBuffer();
    for (let i = 1; i <= 3; i += 1) jb.push(pcmOf(i));
    for (let i = 0; i < 3 + 30; i += 1) jb.pop(); // 600 ms sin nada
    jb.push(pcmOf(4));
    expect(jb.takeStats!().underruns).toBe(0);
  });
});
