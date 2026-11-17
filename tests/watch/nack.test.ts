import { expect, test } from "bun:test";

import { NACK_GIVE_UP_MS, NACK_INTERVAL_MS, NACK_MAX_MISSING, NACK_MAX_TRIES, NACK_REORDER_MS, NACK_USELESS_AFTER, RESEND_MIN_MS, NackTracker, nackPacket } from "../../src/watch/nack";

/** Lee un Generic NACK: los números de secuencia pedidos. */
function nackedSeqs(b: Buffer): number[] {
  expect(b[0]).toBe(0x81);
  expect(b[1]).toBe(205);
  expect((b.readUInt16BE(2) + 1) * 4).toBe(b.length);
  const out: number[] = [];
  for (let o = 12; o < b.length; o += 4) {
    const pid = b.readUInt16BE(o);
    const blp = b.readUInt16BE(o + 2);
    out.push(pid);
    for (let i = 0; i < 16; i++) if (blp & (1 << i)) out.push((pid + i + 1) & 0xffff);
  }
  return out;
}

test("nackPacket: PT 205 FMT 1 with our SSRC as sender, the video SSRC as media, and missing seqs grouped in PID+BLP", () => {
  const b = nackPacket(0x01020304, 0xa0b0c0d0, [100, 101, 116, 117, 200]);
  expect([...b.subarray(0, 12)]).toEqual([0x81, 205, 0, 5, 1, 2, 3, 4, 0xa0, 0xb0, 0xc0, 0xd0]);
  expect(b.length).toBe(12 + 3 * 4); // 100(+101,+116) · 117 · 200
  expect(b.readUInt16BE(12)).toBe(100);
  expect(b.readUInt16BE(14)).toBe((1 << 0) | (1 << 15));
  expect(nackedSeqs(b)).toEqual([100, 101, 116, 117, 200]);
  expect(nackedSeqs(nackPacket(1, 2, [65534, 65535, 0, 1]))).toEqual([65534, 65535, 0, 1]); // vuelta del contador
});

test("NackTracker waits NACK_REORDER_MS, asks for the gaps grouped, again every NACK_INTERVAL_MS, and stops after NACK_MAX_TRIES or NACK_GIVE_UP_MS", () => {
  let t = 0;
  const n = new NackTracker(() => t);
  for (const seq of [10, 11, 15, 16]) expect(n.received(seq)).toBeNull();
  expect(n.due()).toEqual([]); // todavía puede ser desorden
  t += NACK_REORDER_MS;
  expect(n.due()).toEqual([12, 13, 14]);
  expect(n.due()).toEqual([]); // no inunda: el mismo pedido recién después del intervalo
  t += NACK_INTERVAL_MS;
  expect(n.received(13)).toBe("resent"); // llegó 70 ms después de pedirlo: respuesta creíble
  expect(n.due()).toEqual([12, 14]);
  let asked12 = 2;
  for (let i = 0; i < 20; i++) {
    t += NACK_INTERVAL_MS;
    if (n.due().includes(12)) asked12++;
  }
  expect(asked12).toBe(Math.min(NACK_MAX_TRIES, Math.ceil((NACK_GIVE_UP_MS - NACK_REORDER_MS) / NACK_INTERVAL_MS)));
  expect(n.pending).toBe(0);
  expect(n.received(12)).toBeNull(); // ya abandonado: no cuenta como recuperado
});

test("NackTracker: a packet that arrives out of order before being asked for is 'late', not 'resent'; wraps around 65535; a huge jump resets", () => {
  const n = new NackTracker(() => 0);
  n.received(65534);
  n.received(1); // faltan 65535 y 0
  expect(n.received(65535)).toBe("late"); // llegó desordenado, nunca se pidió
  expect(n.due()).toEqual([]);
  n.received(1 + NACK_MAX_MISSING + 5);
  expect(n.pending).toBe(0);
});

test("only an arrival RESEND_MIN_MS or more after the first request counts as an answer; earlier is the delayed original", () => {
  let t = 0;
  const n = new NackTracker(() => t);
  for (const seq of [1, 5]) n.received(seq); // faltan 2, 3, 4
  t += NACK_REORDER_MS;
  expect(n.due()).toEqual([2, 3, 4]);
  t += RESEND_MIN_MS - 1;
  expect(n.received(2)).toBe("stray"); // ya venía en camino antes del NACK
  t += 1;
  expect(n.received(3)).toBe("resent");
  t += NACK_INTERVAL_MS + 30; // otro pedido de 4 en el medio: se mide desde el primero
  expect(n.due()).toEqual([4]);
  t += 2;
  expect(n.received(4)).toBe("resent");
  expect({ asked: n.asked, answered: n.answered }).toEqual({ asked: 3, answered: 2 });
  expect(n.delaySummary()).toBe(`${RESEND_MIN_MS}/${RESEND_MIN_MS + NACK_INTERVAL_MS + 32}/${RESEND_MIN_MS + NACK_INTERVAL_MS + 32}`);
  expect(new NackTracker().delaySummary()).toBe("-");
});

test("useless: after NACK_USELESS_AFTER distinct numbers asked with fewer than 1 in 10 answered (retries do not count twice)", () => {
  let t = 0;
  const lose = (n: NackTracker, from: number, count: number, answer: number) => {
    n.received(from);
    n.received(from + count + 1); // faltan count números
    t += NACK_REORDER_MS;
    n.due();
    t += NACK_INTERVAL_MS;
    n.due(); // reintento: mismo número, no suma a asked
    t += RESEND_MIN_MS;
    for (let i = 1; i <= answer; i++) n.received(from + i);
  };
  const silent = new NackTracker(() => t);
  lose(silent, 100, NACK_USELESS_AFTER - 1, 0);
  expect(silent.asked).toBe(NACK_USELESS_AFTER - 1);
  expect(silent.useless).toBe(false); // todavía pocos
  lose(silent, 300, 1, 0);
  expect(silent.useless).toBe(true);
  const answering = new NackTracker(() => t);
  lose(answering, 100, NACK_USELESS_AFTER, NACK_USELESS_AFTER / 10);
  expect(answering.useless).toBe(false); // 1 de cada 10 alcanza
});
