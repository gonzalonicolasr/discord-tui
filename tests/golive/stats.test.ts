import { describe, expect, test } from "bun:test";

import { watchStream } from "../../src/golive/stats";

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
