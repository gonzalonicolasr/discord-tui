import { describe, expect, test } from "bun:test";

import { countRtcp, keyframeInfo, negotiatedOf, recordNegotiated, watchStream } from "../../src/golive/stats";
import { fakeToken } from "../helpers/fake-token";

/** WS falso con la forma de lo que usa la librería: addEventListener("message"/"close") y send(). */
function fakeWs() {
  const listeners = new Map<string, Array<(e: any) => void>>();
  const sent: unknown[] = [];
  return {
    sent,
    readyState: 1,
    addEventListener(ev: string, fn: (e: any) => void) {
      listeners.set(ev, [...(listeners.get(ev) ?? []), fn]);
    },
    send(data: unknown) {
      sent.push(data);
    },
    /** Discord manda algo por el WS del stream. */
    receive(data: string | ArrayBuffer) {
      for (const fn of listeners.get("message") ?? []) fn({ data });
    },
  };
}

/** Conexión falsa con la forma de WebRtcConnWrapper de la librería. */
function fakeConn() {
  const ws = fakeWs();
  const conn = {
    ready: true,
    webRtcConn: { state: () => "connected" },
    mediaConnection: { ws, daveReady: 1, _daveProtocolVersion: 1, sendOpcode: (op: number, d: unknown) => ws.send(JSON.stringify({ op, d })) },
    video: 0,
    audio: 0,
    sendVideoFrame(_f: Buffer, _ft: number) {
      if (!conn.ready) return;
      conn.video++;
    },
    sendAudioFrame(_f: Buffer, _ft: number) {
      if (!conn.ready) return;
      conn.audio++;
    },
  };
  return conn;
}

function setup() {
  let t = 0;
  const lines: Array<{ event: string; fields: any }> = [];
  const conn = fakeConn();
  const stats = watchStream(conn, {
    log: { info: (event, fields) => void lines.push({ event, fields }) },
    now: () => t,
    intervalMs: 0, // sin timer: el test llama a report()
  });
  const last = () => JSON.parse(lines.at(-1)!.fields.msg);
  return { conn, stats, lines, last, advance: (ms: number) => void (t += ms) };
}

describe("go live stats", () => {
  test("counts video and audio frames, their media clock (sum of frame times) and still hands them to the library", () => {
    const s = setup();
    for (let i = 0; i < 30; i++) s.conn.sendVideoFrame(Buffer.alloc(1), 1000 / 30);
    for (let i = 0; i < 50; i++) s.conn.sendAudioFrame(Buffer.alloc(1), 20);
    s.advance(1000);
    s.stats.report();
    expect(s.conn.video).toBe(30);
    expect(s.conn.audio).toBe(50);
    expect(s.lines.at(-1)!.event).toBe("golive.stats");
    expect(s.last()).toMatchObject({ s: 1, v: 30, a: 50, v_ms: 1000, a_ms: 1000, vd: 0, ad: 0, rtc: "connected", dave: 1, dave_v: 1, waiting: "no" });
  });

  test("frames the library drops because WebRTC is not connected are counted apart", () => {
    const s = setup();
    s.conn.ready = false;
    s.conn.sendVideoFrame(Buffer.alloc(1), 33);
    s.conn.sendAudioFrame(Buffer.alloc(1), 20);
    s.stats.report();
    expect(s.last()).toMatchObject({ v: 0, vd: 1, a: 0, ad: 1 });
  });

  test("video idle while audio keeps going = the library is holding the video back for the audio", () => {
    const s = setup();
    s.conn.sendVideoFrame(Buffer.alloc(1), 33);
    s.conn.sendAudioFrame(Buffer.alloc(1), 20);
    s.advance(3000);
    s.conn.sendAudioFrame(Buffer.alloc(1), 20);
    s.stats.report();
    expect(s.last()).toMatchObject({ v_idle_ms: 3000, a_idle_ms: 0, waiting: "video" });
    s.advance(3000);
    s.stats.report();
    expect(s.last()).toMatchObject({ waiting: "both" });
  });

  test("before any frame: idle is null and nothing is waiting yet", () => {
    const s = setup();
    s.stats.report();
    expect(s.last()).toMatchObject({ v: 0, a: 0, v_idle_ms: null, a_idle_ms: null, waiting: "none-yet" });
  });

  test("op codes in and out of the stream WS since the last line, never their payloads", () => {
    const s = setup();
    const ws = s.conn.mediaConnection.ws;
    ws.receive(JSON.stringify({ op: 6, d: { t: 1 } }));
    ws.receive(JSON.stringify({ op: 6, d: { t: 2 } }));
    ws.receive(JSON.stringify({ op: 5, d: { user_id: "1", ssrc: 9 } }));
    const bin = new Uint8Array([0, 7, 25, 1, 2, 3]).buffer; // seq (2 bytes) + op 25 + datos
    ws.receive(bin);
    s.conn.mediaConnection.sendOpcode(3, { t: 9 });
    ws.send(new Uint8Array([26, 1, 2]));
    s.stats.report();
    const line = s.lines.at(-1)!.fields.msg as string;
    expect(s.last()).toMatchObject({ in: { "6": 2, "5": 1, b25: 1 }, out: { "3": 1, b26: 1 } });
    expect(line).not.toContain("user_id");
    expect(line).not.toContain("ssrc\":9");
    expect(ws.sent).toHaveLength(2); // los mensajes igual salen
    s.stats.report();
    expect(s.last()).toMatchObject({ in: {}, out: {} });
  });

  test("a stream WS reopened by the library (resume) gets watched too", () => {
    const s = setup();
    const second = fakeWs();
    (s.conn.mediaConnection as any).ws = second;
    s.stats.report();
    second.receive(JSON.stringify({ op: 9, d: {} }));
    s.stats.report();
    expect(s.last()).toMatchObject({ ws: 2, in: { "9": 1 } });
  });

  test("stop() writes a last line with why and stops counting", () => {
    const s = setup();
    s.conn.sendVideoFrame(Buffer.alloc(1), 33);
    s.stats.stop("ws-4006");
    expect(s.lines.at(-1)!.fields.state).toBe("ws-4006");
    expect(s.last()).toMatchObject({ v: 1 });
    const n = s.lines.length;
    s.stats.stop("again");
    s.stats.report();
    expect(s.lines.length).toBe(n);
  });

  test("tolerates a connection without WebRTC, DAVE or WS (the fakes and odd states)", () => {
    const lines: any[] = [];
    const stats = watchStream({}, { log: { info: (_e, f) => void lines.push(f) }, now: () => 0, intervalMs: 0 });
    stats.report();
    expect(JSON.parse(lines[0].msg)).toMatchObject({ v: 0, rtc: null, dave: 0, dave_v: null });
    stats.stop("idle");
  });
});

// El diagnóstico nunca puede tirar abajo zcord ni la transmisión: en Bun una excepción en un interval o un rechazo sin
// manejar terminan el proceso. Ante cualquier error se apaga solo, con una línea en el log.
describe("go live stats never throw", () => {
  function collect() {
    const lines: Array<{ event: string; fields: any }> = [];
    return { lines, log: { info: (event: string, fields: any) => void lines.push({ event, fields }) } };
  }

  test("a frozen connection: watchStream does not throw, says it is off and the frames still go out", () => {
    const c = collect();
    let sent = 0;
    const conn = Object.freeze({ ready: true, sendVideoFrame: () => void sent++, sendAudioFrame: () => void sent++ });
    let stats: ReturnType<typeof watchStream> | null = null;
    expect(() => (stats = watchStream(conn, { log: c.log, intervalMs: 5 }))).not.toThrow();
    expect(c.lines.at(-1)).toMatchObject({ event: "golive.stats", fields: { state: "off" } });
    conn.sendVideoFrame();
    expect(sent).toBe(1);
    expect(() => stats!.report()).not.toThrow();
    expect(() => stats!.stop("idle")).not.toThrow();
  });

  test("a getter that throws: report() does not throw, the diagnostics switch off once and the timer stops", async () => {
    const c = collect();
    const conn: any = fakeConn();
    const ws = conn.mediaConnection.ws;
    conn.mediaConnection = {
      ws,
      get daveReady() {
        throw new TypeError("session disposed");
      },
    };
    const stats = watchStream(conn, { log: c.log, intervalMs: 5 });
    expect(() => stats.report()).not.toThrow();
    expect(c.lines.filter((l) => l.fields?.state === "off")).toHaveLength(1);
    const n = c.lines.length;
    await Bun.sleep(40); // varios ticks del timer real
    expect(c.lines.length).toBe(n);
    expect(() => stats.stop("idle")).not.toThrow();
  });

  test("the real timer: a tick that throws switches off instead of throwing out of the interval", async () => {
    const c = collect();
    const conn: any = fakeConn();
    let fail = false;
    conn.webRtcConn = null;
    Object.defineProperty(conn, "mediaConnection", {
      get() {
        if (fail) throw new TypeError("gone");
        return { ws: null };
      },
    });
    watchStream(conn, { log: c.log, intervalMs: 5 });
    fail = true;
    await Bun.sleep(40);
    expect(c.lines.filter((l) => l.fields?.state === "off")).toHaveLength(1);
    const n = c.lines.length;
    await Bun.sleep(30);
    expect(c.lines.length).toBe(n);
  });

  test("stop() whose last line throws does not throw and leaves no timer running", async () => {
    let calls = 0;
    const conn: any = fakeConn();
    const stats = watchStream(conn, {
      log: {
        info: () => {
          calls++;
          throw new Error("disk full");
        },
      },
      intervalMs: 5,
    });
    expect(() => stats.stop("idle")).not.toThrow();
    const n = calls;
    await Bun.sleep(40);
    expect(calls).toBe(n);
  });

  test("counting can never break the library's send: a ready getter that throws still reaches the original", () => {
    const c = collect();
    let calls = 0;
    const conn: any = {
      get ready(): boolean {
        throw new TypeError("odd");
      },
      sendVideoFrame: () => void calls++,
      sendAudioFrame: () => void calls++,
    };
    watchStream(conn, { log: c.log, intervalMs: 0 });
    expect(() => conn.sendVideoFrame(Buffer.alloc(1), 33)).not.toThrow();
    expect(() => conn.sendAudioFrame(Buffer.alloc(1), 20)).not.toThrow();
    expect(calls).toBe(2);
  });
});

describe("go live stats wrappers", () => {
  test("pass every argument through, keep this, the return value and the exception", () => {
    const seen: unknown[][] = [];
    const conn: any = {
      ready: true,
      sendVideoFrame(this: unknown, ...args: unknown[]) {
        seen.push([this, ...args]);
        if (args[0] === "throw") throw new RangeError("boom");
        return 42;
      },
      sendAudioFrame(this: unknown, ...args: unknown[]) {
        seen.push([this, ...args]);
        return 7;
      },
    };
    watchStream(conn, { log: { info() {} }, intervalMs: 0 });
    const buf = Buffer.alloc(8);
    expect(conn.sendVideoFrame(buf, 33, "extra")).toBe(42);
    expect(seen[0]).toEqual([conn, buf, 33, "extra"]);
    expect(seen[0]![1]).toBe(buf);
    expect(conn.sendAudioFrame(buf, 20, 1, 2)).toBe(7);
    expect(seen[1]).toEqual([conn, buf, 20, 1, 2]);
    expect(() => conn.sendVideoFrame("throw", 33)).toThrow(RangeError);
  });
});

describe("go live stats count what the library really sent", () => {
  test("a send that throws is not counted as sent", () => {
    const lines: any[] = [];
    const conn: any = {
      ready: true,
      sendVideoFrame() {
        throw new RangeError("boom");
      },
      sendAudioFrame() {},
    };
    const stats = watchStream(conn, { log: { info: (_e, f) => void lines.push(f) }, intervalMs: 0 });
    expect(() => conn.sendVideoFrame(Buffer.alloc(1), 33)).toThrow(RangeError);
    stats.report();
    expect(JSON.parse(lines.at(-1).msg)).toMatchObject({ v: 0, vd: 0, v_ms: 0 });
  });

  test("connected but without a packetizer yet (the library drops it): counted as dropped", () => {
    const lines: any[] = [];
    const conn: any = {
      ready: true,
      _videoPacketizer: undefined,
      _audioPacketizer: { rtpConfig: {} },
      sendVideoFrame() {},
      sendAudioFrame() {},
    };
    const stats = watchStream(conn, { log: { info: (_e, f) => void lines.push(f) }, intervalMs: 0 });
    conn.sendVideoFrame(Buffer.alloc(1), 33);
    conn.sendAudioFrame(Buffer.alloc(1), 20);
    stats.report();
    expect(JSON.parse(lines.at(-1).msg)).toMatchObject({ v: 0, vd: 1, a: 1, ad: 0 });
  });
});

// El identify del stream lleva el token: el diagnóstico saca solo el número de op, sin materializar el mensaje.
describe("go live stats read only the op number", () => {
  test("outgoing identify and incoming messages are never parsed, kept or logged beyond their op number", () => {
    const token = fakeToken("golive-stats");
    const lines: any[] = [];
    const conn = fakeConn();
    const ws = conn.mediaConnection.ws;
    const stats = watchStream(conn, { log: { info: (e, f) => void lines.push({ e, f }) }, intervalMs: 0 });
    const realParse = JSON.parse;
    let parsedOurs = 0;
    JSON.parse = ((text: string, ...rest: any[]) => {
      if (typeof text === "string" && text.includes(token)) parsedOurs++;
      return (realParse as any)(text, ...rest);
    }) as typeof JSON.parse;
    try {
      ws.send(JSON.stringify({ op: 0, d: { server_id: "1", session_id: "secret-session", token, video: true } }));
      ws.receive(JSON.stringify({ op: 4, d: { sdp: `a=ice-pwd:${token}`, dave_protocol_version: 1 } }));
      ws.receive(`{"seq":12,"op":5,"d":{"user_id":"123","token":"${token}"}}`);
    } finally {
      JSON.parse = realParse;
    }
    expect(parsedOurs).toBe(0);
    stats.report();
    const text = JSON.stringify(lines);
    expect(text).not.toContain(token);
    expect(text).not.toContain("secret-session");
    expect(text).not.toContain("ice-pwd");
    expect(text).not.toContain("user_id");
    expect(realParse(lines.at(-1).f.msg)).toMatchObject({ out: { "0": 1 }, in: { "4": 1, "5": 1 } });
    expect(ws.sent[0]).toContain(token); // el mensaje igual sale entero
  });

  test("an op that is not the leading key is not guessed from inside the payload", () => {
    const lines: any[] = [];
    const conn = fakeConn();
    const ws = conn.mediaConnection.ws;
    const stats = watchStream(conn, { log: { info: (_e, f) => void lines.push(f) }, intervalMs: 0 });
    ws.receive('{"d":{"op":99},"op":5}');
    ws.receive("not json");
    ws.receive('{"op":12345678,"d":{}}');
    stats.report();
    expect(JSON.parse(lines.at(-1).msg).in).toEqual({ "?": 3 });
  });
});

describe("negotiatedOf (select protocol ack, op 4)", () => {
  test("video codec / audio codec / DAVE version / mode, never the SDP, keys or ids", () => {
    const token = fakeToken();
    const d = { sdp: "a=fingerprint:sha-256 AA", secret_key: [1, 2, 3], media_session_id: token, video_codec: "H264", audio_codec: "opus", dave_protocol_version: 1, mode: "aead_aes256_gcm_rtpsize" };
    expect(negotiatedOf(d)).toBe("H264/opus/v1/aead_aes256_gcm_rtpsize");
  });

  test("missing or odd values are a question mark (nothing free-form gets into the log)", () => {
    expect(negotiatedOf({})).toBe("?/?/v?/?");
    expect(negotiatedOf(null)).toBe("?/?/v?/?");
    expect(negotiatedOf({ video_codec: "H264 with spaces", audio_codec: "x".repeat(50), dave_protocol_version: "1", mode: 3 })).toBe("?/?/v?/?");
    expect(negotiatedOf({ video_codec: "AV1", dave_protocol_version: 0 })).toBe("AV1/?/v0/?");
  });
});

/** Paquetes RTCP armados a mano (RFC 3550 / 4585). */
const rtcp = {
  pli: (media: number) => Buffer.from([0x81, 206, 0, 2, 0, 0, 0x10, 0x92, ...u32(media)]),
  fir: (media: number) => Buffer.from([0x84, 206, 0, 4, 0, 0, 0x10, 0x92, 0, 0, 0, 0, ...u32(media), 1, 0, 0, 0]),
  /** NACK: pid + blp (cada bit de blp es otro paquete perdido). */
  nack: (media: number, pid: number, blp: number) => Buffer.from([0x81, 205, 0, 3, 0, 0, 0x10, 0x92, ...u32(media), pid >> 8, pid & 0xff, blp >> 8, blp & 0xff]),
  /** RR con un bloque: fraction lost (0-255) y cumulative lost. */
  rr: (media: number, fraction: number, cumulative: number) =>
    Buffer.from([0x81, 201, 0, 7, 0, 0, 0x10, 0x92, ...u32(media), fraction, (cumulative >> 16) & 0xff, (cumulative >> 8) & 0xff, cumulative & 0xff, ...new Array(16).fill(0)]),
  /** REMB: bitrate = mantissa << exp. */
  remb: (bps: number) => {
    let exp = 0;
    while (bps >> exp > 0x3ffff) exp++;
    const m = bps >> exp;
    return Buffer.from([0x8f, 206, 0, 5, 0, 0, 0x10, 0x92, 0, 0, 0, 0, 0x52, 0x45, 0x4d, 0x42, 1, (exp << 2) | ((m >> 16) & 3), (m >> 8) & 0xff, m & 0xff, ...u32(1001)]);
  },
};
function u32(n: number): number[] {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

describe("countRtcp (what the viewers' side reports back)", () => {
  const fresh = () => ({ pli: 0, fir: 0, nack: 0, nack_pkts: 0, rr: 0, loss_pct: 0, lost: null as number | null, remb_kbps: null as number | null });

  test("PLI, FIR, NACK (with the lost packets of its bitmask), RR loss and REMB, also inside a compound packet", () => {
    const c = fresh();
    countRtcp(Buffer.concat([rtcp.rr(1001, 64, 12), rtcp.pli(1001)]), c, 1001);
    countRtcp(rtcp.fir(1001), c, 1001);
    countRtcp(rtcp.nack(1001, 100, 0b101), c, 1001);
    countRtcp(rtcp.remb(2_500_000), c, 1001);
    expect(c).toEqual({ pli: 1, fir: 1, nack: 1, nack_pkts: 3, rr: 1, loss_pct: 25, lost: 12, remb_kbps: 2500 });
  });

  test("report blocks about another SSRC (the audio) do not count as video loss", () => {
    const c = fresh();
    countRtcp(rtcp.rr(1000, 255, 99), c, 1001);
    expect(c).toMatchObject({ rr: 1, loss_pct: 0, lost: null });
  });

  test("garbage, RTP and truncated packets are ignored without throwing", () => {
    const c = fresh();
    countRtcp(Buffer.from([0x80, 101, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9]), c, 1001);
    countRtcp(Buffer.from([0x81, 206, 0, 9]), c, 1001);
    countRtcp(Buffer.alloc(0), c, 1001);
    expect(c).toEqual(fresh());
  });
});

describe("keyframeInfo (size of the keyframe the library hands to WebRTC)", () => {
  const sc = [0, 0, 0, 1];
  test("an IDR access unit: its bytes and the RTP packets it takes (1220-byte fragments, one per small NAL)", () => {
    const au = Buffer.from([...sc, 0x67, ...new Array(37).fill(1), ...sc, 0x68, 1, 2, 3, 0, 0, 1, 0x65, ...new Array(36353).fill(7)]);
    expect(keyframeInfo(au)).toEqual({ bytes: au.length, packets: 2 + Math.ceil(36353 / 1218) });
  });

  test("a P frame or something that is not Annex-B is not a keyframe", () => {
    expect(keyframeInfo(Buffer.from([...sc, 0x41, 1, 2, 3]))).toBeNull();
    expect(keyframeInfo(Buffer.from([1, 2, 3, 4]))).toBeNull();
  });
});

describe("go live stats: keyframes, RTCP and what was negotiated", () => {
  /** Track de video falso: guarda el onMessage como lo haría libdatachannel. */
  function withTrack() {
    const s = setup();
    let deliver: ((m: Buffer) => void) | null = null;
    (s.conn as any)._videoTrack = { onMessage: (fn: (m: Buffer) => void) => void (deliver = fn) };
    (s.conn.mediaConnection as any).webRtcParams = { videoSsrc: 1001 };
    (s.conn as any)._videoCodec = "H264";
    s.stats.report(); // engancha el track
    return { ...s, rtcpIn: (b: Buffer) => deliver!(b) };
  }

  test("RTCP received on the video track since the last line, and the last keyframe sent (bytes / ~packets)", () => {
    const s = withTrack();
    s.rtcpIn(rtcp.pli(1001));
    s.rtcpIn(rtcp.nack(1001, 5, 0));
    const idr = Buffer.from([0, 0, 0, 1, 0x65, ...new Array(3000).fill(7)]);
    s.conn.sendVideoFrame(idr, 33);
    s.conn.sendVideoFrame(Buffer.from([0, 0, 0, 1, 0x41, 1]), 33);
    s.stats.report();
    expect(s.last()).toMatchObject({ codec: "H264", kf: `${idr.length}/3`, kfs: 1, rtcp: { pli: 1, nack: 1, nack_pkts: 1, fir: 0 } });
    s.stats.report();
    expect(s.last()).toMatchObject({ kf: `${idr.length}/3`, kfs: 0, rtcp: { pli: 0, nack: 0 } });
  });

  test("without a video track to watch, rtcp is null (not zero: nothing was listening)", () => {
    const s = setup();
    s.stats.report();
    expect(s.last()).toMatchObject({ rtcp: null, kf: null, neg: "-" });
  });

  test("recordNegotiated keeps what the op 4 said for this connection and still runs the library's handler", () => {
    const media: any = { got: null, handleProtocolAck(d: unknown) { this.got = d; } };
    recordNegotiated(media);
    const d = { sdp: "x", video_codec: "H264", audio_codec: "opus", dave_protocol_version: 1 };
    media.handleProtocolAck(d);
    expect(media.got).toBe(d);
    let t = 0;
    const lines: any[] = [];
    const stats = watchStream({ mediaConnection: media }, { log: { info: (_e, f) => void lines.push(f) }, now: () => t, intervalMs: 0 });
    stats.report();
    expect(JSON.parse(lines.at(-1).msg).neg).toBe("H264/opus/v1/?");
    expect(() => recordNegotiated(null)).not.toThrow();
    expect(() => recordNegotiated(Object.freeze({ handleProtocolAck() {} }))).not.toThrow();
  });
});

describe("golive.stats shows the op 4 and the op 14 codecs", () => {
  test("neg is the op 4; upd / upd_n are the last op 14 video/audio codec and how many op 14 came", () => {
    const ws = fakeWs();
    const media: any = { ws, handleProtocolAck() {}, setupEvents() {} };
    recordNegotiated(media);
    media.handleProtocolAck({ video_codec: "H264", audio_codec: "opus", dave_protocol_version: 1 });
    media.setupEvents();
    ws.receive(JSON.stringify({ op: 14, d: { video_codec: "H265", audio_codec: "opus", secret_key: [9, 9] } }));
    ws.receive(JSON.stringify({ op: 5, d: { video_codec: "VP8" } })); // no es un op 14: no cuenta
    const lines: any[] = [];
    const stats = watchStream({ mediaConnection: media }, { log: { info: (_e, f) => void lines.push(f) }, now: () => 0, intervalMs: 0 });
    stats.report();
    const msg = JSON.parse(lines.at(-1).msg);
    expect(msg).toMatchObject({ neg: "H264/opus/v1/?", upd: "H265/opus", upd_n: 1 });
    expect(lines.at(-1).msg).not.toContain("secret_key");
  });
});
