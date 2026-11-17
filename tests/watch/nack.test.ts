import { expect, test } from "bun:test";

import { NACK_GIVE_UP_MS, NACK_INTERVAL_MS, NACK_MAX_MISSING, NACK_MAX_TRIES, NackTracker, nackPacket, unwrapRtx } from "../../src/watch/nack";

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

test("NackTracker asks for the gaps once, again every NACK_INTERVAL_MS, and stops after NACK_MAX_TRIES or NACK_GIVE_UP_MS", () => {
  let t = 0;
  const n = new NackTracker(() => t);
  for (const seq of [10, 11, 15, 16]) expect(n.received(seq)).toBe(false);
  expect(n.due()).toEqual([12, 13, 14]);
  expect(n.due()).toEqual([]); // no inunda: el mismo pedido recién después del intervalo
  t += NACK_INTERVAL_MS;
  expect(n.received(13)).toBe(true); // llegó el reenvío
  expect(n.due()).toEqual([12, 14]);
  let asked12 = 2; // t = 0 y t = NACK_INTERVAL_MS
  for (let i = 0; i < 20; i++) {
    t += NACK_INTERVAL_MS;
    if (n.due().includes(12)) asked12++;
  }
  expect(asked12).toBe(Math.min(NACK_MAX_TRIES, Math.ceil(NACK_GIVE_UP_MS / NACK_INTERVAL_MS)));
  expect(n.pending).toBe(0);
  expect(n.received(12)).toBe(false); // ya abandonado: no cuenta como recuperado
});

test("NackTracker: reordering is not loss, wraps around 65535, and a huge jump resets instead of asking for everything", () => {
  const n = new NackTracker(() => 0);
  n.received(65534);
  n.received(1); // faltan 65535 y 0
  expect(n.received(65535)).toBe(true); // llegó desordenado
  expect(n.due()).toEqual([0]);
  n.received(1 + NACK_MAX_MISSING + 5);
  expect(n.pending).toBe(0);
  expect(n.due()).toEqual([]);
});

test("unwrapRtx takes the original sequence number from the first two payload bytes; padding-only probes are ignored", () => {
  expect(unwrapRtx(new Uint8Array([0x12, 0x34, 9, 8]))).toEqual({ sequence: 0x1234, payload: new Uint8Array([9, 8]) });
  expect(unwrapRtx(new Uint8Array([0x12, 0x34]))).toBeNull();
  expect(unwrapRtx(new Uint8Array(0))).toBeNull();
});
