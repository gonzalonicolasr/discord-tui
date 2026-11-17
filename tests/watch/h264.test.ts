import { describe, expect, test } from "bun:test";

import { H264Depacketizer, KEYFRAME_PATIENCE, KEYFRAME_RETRY, MAX_PENDING_FRAMES, RtpH264Stats, assembleAccessUnit, hasIdr, parseRtp, splitAnnexB, type RtpPacket } from "../../src/watch/h264";

function rtp(opts: { seq: number; ts: number; marker?: boolean; pt?: number; ssrc?: number; payload: Uint8Array; ext?: boolean; pad?: number }): Uint8Array {
  const ext = opts.ext ? new Uint8Array([0xbe, 0xde, 0, 1, 0x10, 0xaa, 0, 0]) : new Uint8Array(0);
  const pad = opts.pad ?? 0;
  const buf = new Uint8Array(12 + ext.length + opts.payload.length + pad);
  buf[0] = 0x80 | (opts.ext ? 0x10 : 0) | (pad ? 0x20 : 0);
  buf[1] = (opts.marker ? 0x80 : 0) | (opts.pt ?? 101);
  const v = new DataView(buf.buffer);
  v.setUint16(2, opts.seq & 0xffff);
  v.setUint32(4, opts.ts);
  v.setUint32(8, opts.ssrc ?? 1001);
  buf.set(ext, 12);
  buf.set(opts.payload, 12 + ext.length);
  if (pad) buf[buf.length - 1] = pad;
  return buf;
}
const pkt = (o: Parameters<typeof rtp>[0]): RtpPacket => parseRtp(rtp(o))!;

const SPS = new Uint8Array([0x67, 0x42, 0x00, 0x1f]);
const PPS = new Uint8Array([0x68, 0xce, 0x3c, 0x80]);
const IDR = new Uint8Array([0x65, ...new Array(10).fill(7)]);
const P = new Uint8Array([0x41, 1, 2, 3]);
const sc = [0, 0, 0, 1];

test("parseRtp reads header fields, skips extension and padding, and ignores RTCP", () => {
  const p = parseRtp(rtp({ seq: 65535, ts: 123456, marker: true, payload: P, ext: true, pad: 3 }))!;
  expect(p).toMatchObject({ marker: true, payloadType: 101, sequence: 65535, timestamp: 123456, ssrc: 1001 });
  expect([...p.payload]).toEqual([...P]);
  const rtcp = new Uint8Array(12);
  rtcp[0] = 0x80;
  rtcp[1] = 200; // SR
  expect(parseRtp(rtcp)).toBeNull();
  expect(parseRtp(new Uint8Array(4))).toBeNull();
});

test("splitAnnexB handles 3- and 4-byte start codes", () => {
  const data = new Uint8Array([0, 0, 0, 1, ...SPS, 0, 0, 1, ...PPS, 0, 0, 0, 1, ...P]);
  expect(splitAnnexB(data).map((n) => [...n])).toEqual([[...SPS], [...PPS], [...P]]);
});

test("assembleAccessUnit rebuilds single NALs, STAP-A and FU-A with 4-byte start codes", () => {
  const stap = new Uint8Array([0x78, 0, SPS.length, ...SPS, 0, PPS.length, ...PPS]);
  const fuStart = new Uint8Array([0x7c, 0x80 | 5, ...IDR.subarray(1, 6)]);
  const fuEnd = new Uint8Array([0x7c, 0x40 | 5, ...IDR.subarray(6)]);
  const au = assembleAccessUnit([stap, fuStart, fuEnd])!;
  expect([...au]).toEqual([...sc, ...SPS, ...sc, ...PPS, ...sc, ...IDR]);
  expect(hasIdr(au)).toBe(true);
  expect(assembleAccessUnit([fuStart])).toBeNull(); // FU-A sin final
  expect(assembleAccessUnit([fuEnd])).toBeNull(); // FU-A sin comienzo
});

test("depacketizer waits for the first keyframe, then emits frames in order (reordered packets too)", () => {
  let losses = 0;
  const d = new H264Depacketizer(() => losses++);
  expect(d.push(pkt({ seq: 10, ts: 0, marker: true, payload: P }))).toEqual([]); // P antes de un IDR: se descarta
  const fuA = new Uint8Array([0x7c, 0x80 | 5, ...IDR.subarray(1, 6)]);
  const fuB = new Uint8Array([0x7c, 0x40 | 5, ...IDR.subarray(6)]);
  expect(d.push(pkt({ seq: 12, ts: 3000, marker: true, payload: fuB }))).toEqual([]); // llega antes que su comienzo
  const out = d.push(pkt({ seq: 11, ts: 3000, payload: fuA }));
  expect(out).toHaveLength(1);
  expect(hasIdr(out[0]!)).toBe(true);
  const next = d.push(pkt({ seq: 13, ts: 6000, marker: true, payload: P }));
  expect([...next[0]!]).toEqual([...sc, ...P]);
  expect(losses).toBe(0);
});

test("a lost packet drops the frame, asks for a keyframe once, and resumes on the next IDR", () => {
  let losses = 0;
  const d = new H264Depacketizer(() => losses++);
  d.push(pkt({ seq: 1, ts: 0, marker: true, payload: IDR }));
  // seq 2 (cuadro ts 3000) se pierde; el cuadro siguiente completo lo da por perdido
  expect(d.push(pkt({ seq: 3, ts: 3000, marker: true, payload: P }))).toEqual([]);
  expect(d.push(pkt({ seq: 4, ts: 6000, marker: true, payload: P }))).toEqual([]);
  expect(losses).toBe(1);
  expect(d.dropped).toBeGreaterThan(0);
  const out = d.push(pkt({ seq: 5, ts: 9000, marker: true, payload: IDR }));
  expect(out).toHaveLength(1);
  expect(d.push(pkt({ seq: 6, ts: 12000, marker: true, payload: P }))).toHaveLength(1);
});

test("if the keyframe never comes it re-asks every KEYFRAME_RETRY frames and resumes after KEYFRAME_PATIENCE", () => {
  let losses = 0;
  const d = new H264Depacketizer(() => losses++);
  d.push(pkt({ seq: 1, ts: 0, marker: true, payload: IDR }));
  d.push(pkt({ seq: 3, ts: 3000, marker: true, payload: P })); // seq 2 perdido
  let seq = 4;
  let emitted = 0;
  for (let i = 0; i < KEYFRAME_PATIENCE + 5; i++, seq++) emitted += d.push(pkt({ seq, ts: seq * 3000, marker: true, payload: P })).length;
  expect(losses).toBe(1 + Math.floor((KEYFRAME_PATIENCE - 1) / KEYFRAME_RETRY));
  expect(emitted).toBeGreaterThan(0);
  expect(d.concealed).toBe(1);
  expect(d.keyframes).toBe(1);
});

test("before any keyframe it never gives up waiting (no SPS/PPS to decode with)", () => {
  const d = new H264Depacketizer();
  let emitted = 0;
  for (let seq = 1; seq < 200; seq++) emitted += d.push(pkt({ seq, ts: seq * 3000, marker: true, payload: P })).length;
  expect(emitted).toBe(0);
});

test("sequence numbers wrap around 65535", () => {
  const d = new H264Depacketizer();
  expect(d.push(pkt({ seq: 65535, ts: 0, marker: true, payload: IDR }))).toHaveLength(1);
  expect(d.push(pkt({ seq: 0, ts: 3000, marker: true, payload: P }))).toHaveLength(1);
  expect(d.push(pkt({ seq: 65535, ts: 0, marker: true, payload: IDR }))).toEqual([]); // duplicado viejo
});

describe("depacketizer waiting for retransmissions (waitMs)", () => {
  const WAIT = 400;
  /** Un keyframe en FU-A de `n` paquetes desde `seq` (marker en el último). */
  const keyframe = (seq: number, ts: number, n: number): RtpPacket[] =>
    Array.from({ length: n }, (_, i) => {
      const fu = new Uint8Array([0x7c, (i === 0 ? 0x80 : 0) | (i === n - 1 ? 0x40 : 0) | 5, i & 0xff, 7, 7, 7]);
      return pkt({ seq: seq + i, ts, marker: i === n - 1, payload: fu });
    });
  const setup = () => {
    let t = 0;
    let losses = 0;
    const d = new H264Depacketizer(() => losses++, WAIT, () => t);
    return { d, advance: (ms: number) => void (t += ms), losses: () => losses };
  };

  test("a keyframe missing packets waits while later frames arrive, then completes with the late resends (reordered, duplicated)", () => {
    const { d, advance, losses } = setup();
    const kf = keyframe(100, 3000, 150);
    const lost = new Set([110, 111, 180, 249]); // incluye el último (el del marker)
    let out: Uint8Array[] = [];
    for (const p of kf) if (!lost.has(p.sequence)) out.push(...d.push(p));
    for (let i = 0; i < 5; i++) {
      advance(33);
      out.push(...d.push(pkt({ seq: 250 + i, ts: 6000 + i * 3000, marker: true, payload: P })));
    }
    expect(out).toEqual([]); // nada sale antes del keyframe: los P esperan detrás
    advance(100);
    // los reenvíos llegan desordenados y uno duplicado
    for (const seq of [249, 111, 180, 111, 110]) out.push(...d.push(kf[seq - 100]!, true));
    expect(out).toHaveLength(6); // el keyframe + los 5 P, en orden
    expect(hasIdr(out[0]!)).toBe(true);
    expect([...out[1]!]).toEqual([...sc, ...P]);
    expect(d.recovered).toBe(1);
    expect(d.dropped).toBe(0);
    expect(losses()).toBe(0);
    expect(d.push(kf[10]!, true)).toEqual([]); // un reenvío que llega después: viejo, se ignora
  });

  test("if the resends never come it drops the frame after waitMs (on the next packet or tick) and asks for a keyframe, like without NACK", () => {
    const { d, advance, losses } = setup();
    d.push(pkt({ seq: 1, ts: 0, marker: true, payload: IDR }));
    expect(d.push(pkt({ seq: 3, ts: 3000, marker: true, payload: P }))).toEqual([]); // seq 2 perdido
    expect(d.push(pkt({ seq: 4, ts: 6000, marker: true, payload: P }))).toEqual([]);
    advance(WAIT - 1);
    expect(d.tick()).toEqual([]);
    expect(d.dropped).toBe(0); // todavía espera
    advance(1);
    d.tick();
    expect(d.dropped).toBe(1);
    expect(losses()).toBe(1);
    expect(d.push(pkt({ seq: 2, ts: 3000, payload: P }), true)).toEqual([]); // reenvío tardío: ya descartado
    expect(d.push(pkt({ seq: 5, ts: 9000, marker: true, payload: IDR }))).toHaveLength(1);
    expect(d.recovered).toBe(0);
  });

  test("a resend that rescues an ordinary frame counts as recovered; reordering without loss is not", () => {
    const { d, advance } = setup();
    d.push(pkt({ seq: 1, ts: 0, marker: true, payload: IDR }));
    expect(d.push(pkt({ seq: 3, ts: 6000, marker: true, payload: P }))).toEqual([]);
    advance(50);
    expect(d.push(pkt({ seq: 2, ts: 3000, marker: true, payload: P }), true)).toHaveLength(2);
    expect(d.push(pkt({ seq: 5, ts: 12000, marker: true, payload: P }))).toEqual([]);
    expect(d.push(pkt({ seq: 4, ts: 9000, marker: true, payload: P }))).toHaveLength(2); // llegó tarde, sin NACK
    expect(d.recovered).toBe(1);
    expect(d.dropped).toBe(0);
  });

  test("each dropped frame is described: packets it had and missing, where they were missing, and which arrived after the drop", () => {
    const { d, advance } = setup();
    d.push(pkt({ seq: 1, ts: 0, marker: true, payload: IDR }));
    const kf = keyframe(2, 3000, 10); // seq 2..11
    for (const p of kf) if (![2, 6, 11].includes(p.sequence)) d.push(p); // falta principio, medio y final (marker)
    d.push(pkt({ seq: 12, ts: 6000, marker: true, payload: P }));
    advance(WAIT);
    d.tick();
    expect(d.lost).toEqual({ n: 1, had: 7, miss: 2, s: 1, m: 1, e: 1, late: 0 }); // 11 (el marker) no se sabe que falta
    d.push(kf[4]!); // seq 6 llega tarde
    d.push(kf[4]!); // y duplicado: cuenta una vez
    d.push(kf[9]!); // 11 no estaba anotado como faltante
    expect(d.lost.late).toBe(1);
  });

  test("memory is capped: with too many frames pending it stops waiting even before waitMs", () => {
    const { d, losses } = setup();
    d.push(pkt({ seq: 1, ts: 0, marker: true, payload: IDR }));
    let droppedAt = -1;
    // seq 2 nunca llega y el reloj no avanza
    for (let i = 0; i < MAX_PENDING_FRAMES + 5; i++) {
      d.push(pkt({ seq: 3 + i, ts: 3000 * (i + 2), marker: true, payload: P }));
      if (d.dropped && droppedAt < 0) droppedAt = i;
    }
    expect(droppedAt).toBe(MAX_PENDING_FRAMES); // cuando se pasa del tope
    expect(d.dropped).toBe(1);
    expect(losses()).toBeGreaterThanOrEqual(1); // PLI al tirarlo (y los re-pedidos de siempre)
    expect(d.push(pkt({ seq: 3 + MAX_PENDING_FRAMES + 5, ts: 999_000, marker: true, payload: IDR }))).toHaveLength(1);
  });
});

describe("RtpH264Stats (numbers for watch.diag)", () => {
  const stap = (...nals: Uint8Array[]) => new Uint8Array([0x18, ...nals.flatMap((n) => [n.length >> 8, n.length & 0xff, ...n])]);
  const fu = (nal: number, start: boolean, end: boolean, data: number[] = [9, 9]) =>
    new Uint8Array([(nal & 0xe0) | 28, (start ? 0x80 : 0) | (end ? 0x40 : 0) | (nal & 0x1f), ...data]);

  test("counts NAL types of single NALs, inside STAP-A and of the original NAL of each FU-A, and FU-A starts", () => {
    const s = new RtpH264Stats();
    s.observe(pkt({ seq: 1, ts: 0, payload: stap(SPS, PPS) }));
    s.observe(pkt({ seq: 2, ts: 0, payload: fu(0x65, true, false) }));
    s.observe(pkt({ seq: 3, ts: 0, payload: fu(0x65, false, false) }));
    s.observe(pkt({ seq: 4, ts: 0, marker: true, payload: fu(0x65, false, true) }));
    s.observe(pkt({ seq: 5, ts: 3000, marker: true, payload: P }));
    const d = s.summary();
    expect(d.nal).toBe("1:1");
    expect(d.stap).toBe("7:1,8:1");
    expect(d.fu).toBe("5:3");
    expect(d.fuS).toBe(1);
    expect(d.n).toBe(5);
    expect(d.mk).toBe(2);
    expect(d.ts).toBe(1);
  });

  test("payload size min/avg/max, padding-only packets, the F bit and sequence jumps", () => {
    const s = new RtpH264Stats();
    s.observe(pkt({ seq: 10, ts: 0, payload: new Uint8Array([0x41, 1, 2, 3, 4, 5]) })); // 6
    s.observe(pkt({ seq: 11, ts: 0, payload: new Uint8Array([0x41, 1]) })); // 2
    s.observe(pkt({ seq: 15, ts: 0, payload: new Uint8Array([0xc1, 1, 2, 3]) })); // salto de 3, F=1, 4
    s.observe(pkt({ seq: 16, ts: 0, payload: new Uint8Array(0), pad: 4 })); // solo padding
    const d = s.summary();
    expect(d.pay).toBe("0/3/6");
    expect(d.pad).toBe(1);
    expect(d.fbit).toBe(1);
    expect(d.jumps).toBe(1);
    expect(d.gap).toBe(3);
    // el primer byte de un paquete con F=1 no cuenta como tipo de NAL de H264
    expect(d.nal).toBe("1:2");
  });

  test("wraps the sequence number without counting a jump, and a reorder is a jump but not a gap", () => {
    const s = new RtpH264Stats();
    for (const seq of [65534, 65535, 0, 1]) s.observe(pkt({ seq, ts: 0, payload: P }));
    expect(s.summary()).toMatchObject({ jumps: 0, gap: 0 });
    s.observe(pkt({ seq: 0, ts: 0, payload: P })); // vuelve atrás
    expect(s.summary()).toMatchObject({ jumps: 1, gap: 0 });
  });

  test("an unknown or reserved NAL type (another codec or encrypted bytes) shows up as its number", () => {
    const s = new RtpH264Stats();
    s.observe(pkt({ seq: 1, ts: 0, payload: new Uint8Array([0x1e, 1]) })); // 30: reservado
    s.observe(pkt({ seq: 2, ts: 0, payload: new Uint8Array([0x00, 1]) })); // 0: no especificado
    expect(s.summary().nal).toBe("0:1,30:1");
  });

  test("empty summary before any packet", () => {
    expect(new RtpH264Stats().summary()).toEqual({ n: 0, mk: 0, pay: "-", pad: 0, fbit: 0, jumps: 0, gap: 0, ts: 0, nal: "", stap: "", fu: "", fuS: 0 });
  });
});

test("RtpH264Stats.window(): sequence jumps and missing packets since the previous call", () => {
  const s = new RtpH264Stats();
  for (const seq of [1, 2, 5, 6]) s.observe(pkt({ seq, ts: 0, payload: P })); // faltan 3 y 4
  expect(s.window()).toEqual({ n: 4, jumps: 1, gap: 2 });
  expect(s.window()).toEqual({ n: 0, jumps: 0, gap: 0 });
  for (const seq of [7, 10]) s.observe(pkt({ seq, ts: 0, payload: P }));
  expect(s.window()).toEqual({ n: 2, jumps: 1, gap: 2 });
  expect(s.summary()).toMatchObject({ n: 6, jumps: 2, gap: 4 }); // el total sigue
});
