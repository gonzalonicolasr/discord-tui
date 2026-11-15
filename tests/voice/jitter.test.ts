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
    const jb = createJitterBuffer();
    for (let i = 1; i <= 3; i += 1) jb.push(pcmOf(i));
    for (let i = 0; i < 4; i += 1) jb.pop(); // 3 frames y un slot vacío
    jb.push(pcmOf(4)); // el audio vuelve: fue un corte
    expect(jb.takeStats!()).toMatchObject({ underruns: 1, drops: 0 });
    expect(jb.takeStats!()).toMatchObject({ underruns: 0, drops: 0 });
    const full = createJitterBuffer({ maxFrames: 4 });
    for (let i = 1; i <= 7; i += 1) full.push(pcmOf(i)); // 7 en un buffer de 4: tira 3
    expect(full.takeStats!()).toMatchObject({ underruns: 0, drops: 3 });
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

describe("adaptive jitter buffer", () => {
  /** Una frase: `frames` paquetes, uno por slot, salvo `hold` slots sin nada en el medio (la red los retiene). */
  function phrase(jb: ReturnType<typeof createJitterBuffer>, frames: number, hold = 0): ("#" | ".")[] {
    const out: ("#" | ".")[] = [];
    const slot = () => out.push(jb.pop() ? "#" : ".");
    for (let i = 0; i < frames; i += 1) {
      if (hold > 0 && i === Math.floor(frames / 2)) {
        for (let h = 0; h < hold; h += 1) slot();
        for (let h = 0; h < hold; h += 1) jb.push(pcmOf(1));
      }
      jb.push(pcmOf(1));
      slot();
    }
    jb.end!();
    for (let i = 0; i < 30; i += 1) slot();
    return out;
  }
  const cutsIn = (slots: ("#" | ".")[]) => {
    const text = slots.join("");
    return text.slice(text.indexOf("#"), text.lastIndexOf("#") + 1).split("").filter((s) => s === ".").length;
  };

  test("after a 120 ms hold the next phrase starts with enough cushion and is not cut", () => {
    const jb = createJitterBuffer({ prebufferFrames: 3, rebufferFrames: 2 });
    expect(cutsIn(phrase(jb, 50, 6))).toBeGreaterThan(0); // la primera enseña
    // 6 frames retenidos = 7 slots sin paquetes: colchón de 8 (160 ms).
    expect(jb.takeStats!().targetFrames).toBe(8);
    expect(cutsIn(phrase(jb, 50, 6))).toBe(0);
  });

  test("on an even network the cushion stays at the base: no extra latency", () => {
    const jb = createJitterBuffer({ prebufferFrames: 3, rebufferFrames: 2 });
    for (let i = 0; i < 5; i += 1) phrase(jb, 50);
    expect(jb.takeStats!().targetFrames).toBe(2);
    // La frase arranca con 2 frames, igual que antes de ser adaptativo.
    jb.push(pcmOf(1));
    expect(jb.pop()).toBeNull();
    jb.push(pcmOf(1));
    expect(jb.pop()).not.toBeNull();
  });

  test("the learned cushion goes down a frame per 10 s of even voice, never below the base", () => {
    const jb = createJitterBuffer({ prebufferFrames: 3, rebufferFrames: 2 });
    phrase(jb, 50, 6);
    jb.takeStats!();
    // La primera ventana de 10 s todavía incluye el hueco; la segunda ya no: baja un frame.
    // (takeStats da el máximo de la ventana: la segunda lectura da el valor actual)
    const current = () => (jb.takeStats!(), jb.takeStats!().targetFrames);
    for (let i = 0; i < 2; i += 1) phrase(jb, 500);
    expect(current()).toBe(7);
    for (let i = 0; i < 20; i += 1) phrase(jb, 500);
    expect(current()).toBe(2);
  });

  test("a long silence between phrases is a pause, not jitter", () => {
    const jb = createJitterBuffer({ prebufferFrames: 3, rebufferFrames: 2 });
    for (let i = 0; i < 3; i += 1) jb.push(pcmOf(1));
    for (let i = 0; i < 100; i += 1) jb.pop(); // dejó de mandar sin avisar (sin frames de silencio)
    jb.push(pcmOf(1));
    expect(jb.takeStats!().targetFrames).toBe(2);
  });
});
