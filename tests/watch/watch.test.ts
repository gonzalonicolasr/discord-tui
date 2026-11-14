/**
 * El watcher (src/watch/watch.ts) contra un gateway falso y una conexión de espectador falsa: shapes de los ops
 * 20/19, el flujo STREAM_CREATE + STREAM_SERVER_UPDATE, los cortes y la decodificación solo con la vista abierta.
 */
import { describe, expect, test } from "bun:test";

import { createStore, emptyState } from "../../src/store/store";
import type { DecodedFrame, H264Decoder } from "../../src/watch/decode";
import type { ViewerEvents, ViewerParams } from "../../src/watch/viewer";
import { WATCH_ERRORS, createStreamWatcher, watchDeleteMessage } from "../../src/watch/watch";
import { fakeGateway } from "../fakes/fake-stream-server";

const GUILD = "100000000000000001";
const VOICE_A = "100000000000000003";
const VOICE_B = "100000000000000004";
const ME = "100000000000000010";
const RAGNAR = "100000000000000020";
const KEY = `guild:${GUILD}:${VOICE_A}:${RAGNAR}`;
const IDR = new Uint8Array([0, 0, 0, 1, 0x65, 1, 2]);
const P = new Uint8Array([0, 0, 0, 1, 0x41, 1, 2]);

function setup(opts: { inVoice?: boolean; streaming?: boolean; decodeMs?: number } = {}) {
  const store = createStore(emptyState());
  store.dispatch({
    type: "gw",
    t: "READY",
    d: {
      user: { id: ME, username: "gon" },
      users: [{ id: RAGNAR, username: "ramiro", global_name: "Ramiro" }],
      guilds: [{ id: GUILD, name: "g", roles: [], channels: [{ id: VOICE_A, type: 2, name: "Voz" }, { id: VOICE_B, type: 2, name: "Voz 2" }] }],
    },
  });
  const gw = fakeGateway();
  const conns: Array<{ params: ViewerParams; events: ViewerEvents; stopped: boolean; keyframes: number }> = [];
  const decoded: Array<{ au: Uint8Array; want: boolean }> = [];
  let decoders = 0;
  let closed = 0;
  let clock = 0;
  const watcher = createStreamWatcher({
    store,
    gateway: gw,
    loadLib: async () => ({}) as any,
    connect: (_lib, params, events) => {
      const c = { params, events, stopped: false, keyframes: 0 };
      conns.push(c);
      return { requestKeyframe: () => void c.keyframes++, stats: () => ({ packets: 0, frames: 0, dropped: 0, daveFailures: 0 }), stop: () => void (c.stopped = true) };
    },
    createDecoder: async (): Promise<H264Decoder> => {
      decoders++;
      return {
        async decode(au, want) {
          decoded.push({ au, want });
          if (opts.decodeMs) await Bun.sleep(opts.decodeMs);
          return want ? { width: 4, height: 2, rgba: new Uint8Array(32) } : null;
        },
        resize() {},
        close: () => void closed++,
      };
    },
    timeoutMs: 100,
    maxFps: 10,
    now: () => clock,
  });
  if (opts.inVoice !== false) {
    gw.dispatch("VOICE_STATE_UPDATE", { guild_id: GUILD, user_id: ME, channel_id: VOICE_A, session_id: "voice-session-1" });
    store.dispatch({ type: "gw", t: "VOICE_STATE_UPDATE", d: { guild_id: GUILD, user_id: ME, channel_id: VOICE_A } });
    store.dispatch({ type: "voice/joining", guildId: GUILD, channelId: VOICE_A });
    store.dispatch({ type: "voice/status", status: "connected" });
  }
  const ramiro = { guild_id: GUILD, user_id: RAGNAR, channel_id: VOICE_A, self_stream: opts.streaming !== false };
  store.dispatch({ type: "gw", t: "VOICE_STATE_UPDATE", d: ramiro });
  gw.dispatch("VOICE_STATE_UPDATE", ramiro);
  const watch = () => store.getState().voice.watch;
  const notices = () => Object.values(store.getState().notices).map((n: any) => n.text);
  const discordAnswers = () => {
    gw.dispatch("STREAM_CREATE", { stream_key: KEY, rtc_server_id: "555", rtc_channel_id: VOICE_A, viewer_ids: [ME], paused: false });
    gw.dispatch("STREAM_SERVER_UPDATE", { stream_key: KEY, endpoint: "stream.example:443", token: "stream-token" });
  };
  return {
    store, gw, watcher, conns, decoded, watch, notices, discordAnswers,
    decoders: () => decoders, closed: () => closed, tick: (ms: number) => void (clock += ms),
  };
}

const flush = () => Bun.sleep(5);

describe("watch", () => {
  test("op 20 WATCH_STREAM with the streamer's key; connects with our voice session after STREAM_CREATE + STREAM_SERVER_UPDATE", async () => {
    const s = setup();
    await s.watcher.watch(RAGNAR);
    expect(s.gw.sent).toEqual([{ op: 20, d: { stream_key: KEY } }]);
    expect(s.watch()).toEqual({ status: "connecting", userId: RAGNAR, error: null });
    s.discordAnswers();
    await flush();
    expect(s.conns).toHaveLength(1);
    expect(s.conns[0]!.params).toEqual({
      guildId: GUILD, channelId: VOICE_A, meId: ME, streamerId: RAGNAR, sessionId: "voice-session-1",
      rtcServerId: "555", streamKey: KEY, endpoint: "stream.example:443", token: "stream-token",
    });
    s.conns[0]!.events.onFrame(IDR);
    expect(s.watch().status).toBe("watching");
  });

  test("not in voice / not streaming / yourself: a Spanish notice and nothing sent", async () => {
    const out = setup({ inVoice: false });
    await out.watcher.watch(RAGNAR);
    expect(out.notices()).toContain(WATCH_ERRORS.notInVoice);
    const quiet = setup({ streaming: false });
    await quiet.watcher.watch(RAGNAR);
    expect(quiet.notices()).toContain(WATCH_ERRORS.notStreaming);
    await quiet.watcher.watch(ME);
    expect(quiet.notices()).toContain(WATCH_ERRORS.self);
    expect(out.gw.sent).toEqual([]);
    expect(quiet.gw.sent).toEqual([]);
  });

  test("stop sends op 19 STREAM_DELETE {stream_key} and closes the connection", async () => {
    const s = setup();
    await s.watcher.watch(RAGNAR);
    s.discordAnswers();
    await flush();
    await s.watcher.stop();
    expect(s.gw.sent.at(-1)).toEqual({ op: 19, d: { stream_key: KEY } });
    expect(s.conns[0]!.stopped).toBe(true);
    expect(s.watch()).toEqual({ status: "idle", userId: null, error: null });
  });

  test("toggle on the same person stops; one stream at a time", async () => {
    const s = setup();
    await s.watcher.toggle(RAGNAR);
    await s.watcher.toggle(RAGNAR);
    expect(s.gw.sent.map((x) => x.op)).toEqual([20, 19]);
  });

  test("no answer from Discord: times out with a message", async () => {
    const s = setup();
    await s.watcher.watch(RAGNAR);
    await Bun.sleep(150);
    expect(s.watch()).toMatchObject({ status: "error", error: WATCH_ERRORS.noResponse });
    expect(s.gw.sent.at(-1)).toEqual({ op: 19, d: { stream_key: KEY } });
  });
});

describe("stops by itself", () => {
  test("STREAM_DELETE stream_ended: '<name> dejó de transmitir', no op 19 back", async () => {
    const s = setup();
    await s.watcher.watch(RAGNAR);
    s.discordAnswers();
    await flush();
    s.gw.dispatch("STREAM_DELETE", { stream_key: KEY, reason: "stream_ended" });
    expect(s.watch().status).toBe("idle");
    expect(s.notices()).toContain("Ramiro dejó de transmitir");
    expect(s.gw.sent.map((x) => x.op)).toEqual([20]);
    expect(s.conns[0]!.stopped).toBe(true);
  });

  test("STREAM_DELETE unauthorized / stream_full leave an error in the pane", async () => {
    const s = setup();
    await s.watcher.watch(RAGNAR);
    s.gw.dispatch("STREAM_DELETE", { stream_key: KEY, reason: "unauthorized" });
    expect(s.watch()).toMatchObject({ status: "error", userId: RAGNAR, error: "no tenés permiso para ver esta transmisión" });
    expect(watchDeleteMessage("stream_full", "X")!.text).toContain("llena");
    // ✕ cerrar en error: vuelve a idle sin mandar nada
    await s.watcher.stop();
    expect(s.watch().status).toBe("idle");
    expect(s.gw.sent.map((x) => x.op)).toEqual([20]);
  });

  test("the streamer stops (self_stream false) or leaves the channel", async () => {
    const s = setup();
    await s.watcher.watch(RAGNAR);
    s.gw.dispatch("VOICE_STATE_UPDATE", { guild_id: GUILD, user_id: RAGNAR, channel_id: VOICE_A, self_stream: false });
    expect(s.watch().status).toBe("idle");
    expect(s.notices()).toContain("Ramiro dejó de transmitir");
  });

  test("leaving voice or moving to another channel stops watching (op 19)", async () => {
    const s = setup();
    await s.watcher.watch(RAGNAR);
    s.store.dispatch({ type: "voice/moved", guildId: GUILD, channelId: VOICE_B });
    expect(s.watch().status).toBe("idle");
    expect(s.notices()).toContain(WATCH_ERRORS.leftVoice);
    expect(s.gw.sent.at(-1)).toEqual({ op: 19, d: { stream_key: KEY } });
  });

  test("gateway lost / new session / stream WS closed for good", async () => {
    const a = setup();
    await a.watcher.watch(RAGNAR);
    a.gw.status("disconnected");
    expect(a.watch()).toMatchObject({ status: "error", error: WATCH_ERRORS.gatewayLost });

    const b = setup();
    await b.watcher.watch(RAGNAR);
    b.gw.session("identified");
    expect(b.watch()).toMatchObject({ status: "error", error: WATCH_ERRORS.newSession });
    expect(b.gw.sent.map((x) => x.op)).toEqual([20]); // la sesión vieja ya no existe

    const c = setup();
    await c.watcher.watch(RAGNAR);
    c.discordAnswers();
    await flush();
    c.conns[0]!.events.onClose(4015); // reanudable: sigue
    expect(c.watch().status).toBe("connecting");
    c.conns[0]!.events.onClose(4004);
    expect(c.watch()).toMatchObject({ status: "error", error: "Discord rechazó la autenticación de la transmisión" });
  });

  test("STREAM_SERVER_UPDATE with endpoint null drops the connection and reconnects on the next server", async () => {
    const s = setup();
    await s.watcher.watch(RAGNAR);
    s.discordAnswers();
    await flush();
    s.gw.dispatch("STREAM_SERVER_UPDATE", { stream_key: KEY, endpoint: null, token: "x" });
    expect(s.conns[0]!.stopped).toBe(true);
    s.gw.dispatch("STREAM_SERVER_UPDATE", { stream_key: KEY, endpoint: "other.example:443", token: "t2" });
    await flush();
    expect(s.conns).toHaveLength(2);
    expect(s.conns[1]!.params.endpoint).toBe("other.example:443");
  });

  test("a non-H264 stream stops with a message", async () => {
    const s = setup();
    await s.watcher.watch(RAGNAR);
    s.discordAnswers();
    await flush();
    s.conns[0]!.events.onUnsupportedCodec("AV1");
    expect(s.watch().error).toContain("solo se puede ver H264");
  });
});

describe("decoding", () => {
  test("nothing is decoded while no view is subscribed; with a view: from a keyframe, scaled at most maxFps", async () => {
    const s = setup();
    await s.watcher.watch(RAGNAR);
    s.discordAnswers();
    await flush();
    const conn = s.conns[0]!;
    conn.events.onFrame(IDR);
    await flush();
    expect(s.decoders()).toBe(0);
    const frames: DecodedFrame[] = [];
    const sub = s.watcher.subscribe(640, 360, (f) => frames.push(f));
    expect(conn.keyframes).toBe(1); // al abrir la vista pide un keyframe
    conn.events.onFrame(P); // antes del keyframe: se tira
    conn.events.onFrame(IDR);
    await flush();
    s.tick(30);
    conn.events.onFrame(P);
    await flush();
    s.tick(100);
    conn.events.onFrame(P);
    await flush();
    expect(s.decoded.map((d) => d.au)).toEqual([IDR, P, P]);
    expect(s.decoded.map((d) => d.want)).toEqual([true, false, true]); // 10 fps: 100 ms entre cuadros mostrados
    expect(frames).toHaveLength(2);
    sub.unsubscribe();
    await flush();
    expect(s.closed()).toBe(1);
    conn.events.onFrame(IDR);
    await flush();
    expect(s.decoded).toHaveLength(3);
  });

  test("showing the view again without a decoder keeps asking for a keyframe while P frames arrive", async () => {
    const s = setup();
    await s.watcher.watch(RAGNAR);
    s.discordAnswers();
    await flush();
    const conn = s.conns[0]!;
    const first = s.watcher.subscribe(640, 360, () => {});
    conn.events.onFrame(IDR);
    await flush();
    first.unsubscribe(); // cierra el decoder
    await flush();
    s.watcher.subscribe(640, 360, () => {});
    expect(conn.keyframes).toBe(2);
    for (let i = 0; i < 200; i++) conn.events.onFrame(P);
    await flush();
    expect(conn.keyframes).toBeGreaterThan(2); // se reintenta el PLI cada KEYFRAME_RETRY cuadros
    expect(s.decoded).toHaveLength(1); // sin decoder no se sigue con cuadros P: solo con keyframe
    await s.watcher.stop();
  });

  test("a decoder that can't keep up drops the queue and asks for a keyframe", async () => {
    const s = setup({ decodeMs: 20 });
    await s.watcher.watch(RAGNAR);
    s.discordAnswers();
    await flush();
    const conn = s.conns[0]!;
    s.watcher.subscribe(640, 360, () => {});
    conn.events.onFrame(IDR);
    for (let i = 0; i < 40; i++) conn.events.onFrame(P);
    expect(conn.keyframes).toBeGreaterThanOrEqual(2);
    await s.watcher.stop();
  });
});
