/**
 * El `Streamer` REAL de @dank074/discord-video-stream manejado por el shim contra un gateway y un servidor de
 * stream FALSOS (los 14 chequeos del spike, ahora como test).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createGoLiveShim, loadGoLiveLib, streamKeyFor, type GoLiveLib } from "../../src/golive/shim";
import { fakeGateway, startFakeStreamServer, type FakeStreamServer } from "../fakes/fake-stream-server";

const GUILD = "111111111111111111";
const CHANNEL = "222222222222222222";
const ME = "333333333333333333";
const RTC_SERVER_ID = "444444444444444445";
const OUR_SESSION = "our-voice-session-id";
const KEY = `guild:${GUILD}:${CHANNEL}:${ME}`;

let lib: GoLiveLib;
let server: FakeStreamServer;
const tlsBefore = process.env.NODE_TLS_REJECT_UNAUTHORIZED;

beforeAll(async () => {
  // Solo para el WS al servidor falso con certificado propio; se restaura al final.
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  lib = await loadGoLiveLib();
  server = startFakeStreamServer();
});

afterAll(() => {
  server.stop();
  if (tlsBefore === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  else process.env.NODE_TLS_REJECT_UNAUTHORIZED = tlsBefore;
});

test("stream key for guild and DM calls", () => {
  expect(streamKeyFor(GUILD, CHANNEL, ME)).toBe(KEY);
  expect(streamKeyFor(null, CHANNEL, ME)).toBe(`call:${CHANNEL}:${ME}`);
});

// Si cargara zeromq, Bun entero haría panic (uv_async_init) y este archivo no llegaría acá.
test("loading the library under Bun works and silences its stderr logger", () => {
  expect(typeof lib.playStream).toBe("function");
  expect(process.env.DEBUG_LEVEL).toBe("OFF");
});

describe("shim over our gateway with our voice session", () => {
  const gw = fakeGateway();
  let shim: ReturnType<typeof createGoLiveShim>;
  let conn: any = null;

  beforeAll(async () => {
    shim = createGoLiveShim({ gateway: gw, meId: ME, lib });
    shim.attachVoice(GUILD, CHANNEL, OUR_SESSION);
    const ready = shim.streamer.createStream();
    // Lo que manda Discord. Nuestra voz también puede recibir VOICE_SERVER_UPDATE: el shim no debe abrir nada.
    gw.dispatch("VOICE_SERVER_UPDATE", { guild_id: GUILD, endpoint: server.endpoint, token: "x" });
    gw.dispatch("STREAM_CREATE", { stream_key: KEY, rtc_server_id: RTC_SERVER_ID, viewer_ids: [], paused: false });
    gw.dispatch("STREAM_SERVER_UPDATE", { stream_key: KEY, endpoint: server.endpoint, token: "stream-token-falso" });
    conn = await Promise.race([ready, Bun.sleep(5000).then(() => null)]);
    await Bun.sleep(300);
  });

  afterAll(() => shim.destroy());

  test("op 18 STREAM_CREATE and op 22 STREAM_SET_PAUSED(false) go through our gateway", () => {
    expect(gw.sent[0]).toEqual({ op: 18, d: { type: "guild", guild_id: GUILD, channel_id: CHANNEL, preferred_region: null } });
    expect(gw.sent[1]).toEqual({ op: 22, d: { stream_key: KEY, paused: false } });
  });

  test("never sends its own op 4 (our voice owns the voice state)", () => {
    expect(gw.sent.some((s) => s.op === 4)).toBe(false);
    expect(shim.blocked).toEqual([]);
  });

  test("createStream resolves (select_protocol_ack) over a single WS: the stream's", () => {
    expect(conn).not.toBeNull();
    expect(server.connections()).toBe(1);
  });

  test("identify reuses OUR voice session_id with server_id = rtc_server_id and video", () => {
    const identify = server.ops.find((o) => o.op === 0)?.d;
    expect(identify.server_id).toBe(RTC_SERVER_ID);
    expect(identify.session_id).toBe(OUR_SESSION);
    expect(identify.user_id).toBe(ME);
    expect(identify.video).toBe(true);
    expect(identify.streams[0].type).toBe("screen");
    expect(identify.max_dave_protocol_version).toBeGreaterThanOrEqual(1);
  });

  test("webrtc select protocol, DAVE key package (binary 26) on channel rtc_server_id - 1, op 12 video", () => {
    const select = server.ops.find((o) => o.op === 1)?.d;
    expect(select.protocol).toBe("webrtc");
    expect(select.sdp).toMatch(/a=fingerprint/);
    expect(server.ops.some((o) => o.binary === 26)).toBe(true);
    expect(server.ops.some((o) => o.op === 12)).toBe(true);
    expect(conn.mediaConnection.daveChannelId).toBe((BigInt(RTC_SERVER_ID) - 1n).toString());
  });

  test("the op 1 offers a single video codec, H264, plus opus: the server cannot pick one we do not send", () => {
    const select = server.ops.find((o) => o.op === 1)?.d;
    expect(select.codecs.map((c: any) => `${c.type}:${c.name}`).sort()).toEqual(["audio:opus", "video:H264"]);
    expect(select.codecs.find((c: any) => c.name === "H264")).toMatchObject({ payload_type: 101, rtx_payload_type: 102, encode: true });
  });

  test("destroy sends op 19 STREAM_DELETE once and stops listening to the gateway", () => {
    const before = gw.listenerCount("dispatch");
    shim.destroy();
    shim.destroy();
    expect(gw.sent.filter((s) => s.op === 19)).toEqual([{ op: 19, d: { stream_key: KEY } }]);
    expect(gw.listenerCount("dispatch")).toBe(before - 1);
  });

  test("after destroy the library does not reconnect to RESUME the stream it just stopped", async () => {
    await Bun.sleep(1000);
    expect(server.ops.some((o) => o.op === 7)).toBe(false);
    expect(server.connections()).toBe(1);
  });
});

test("the shim blocks any op other than 18/19/22", () => {
  const gw = fakeGateway();
  const shim = createGoLiveShim({ gateway: gw, meId: ME, lib });
  shim.attachVoice(GUILD, CHANNEL, OUR_SESSION);
  shim.streamer.signalVideo(true); // op 4 con self_video: no debe salir
  expect(gw.sent).toEqual([]);
  expect(shim.blocked).toEqual([4]);
  shim.destroy();
});

describe("the server picks another video codec (op 4 or op 14)", () => {
  const gw = fakeGateway();
  let other: FakeStreamServer;
  let shim: ReturnType<typeof createGoLiveShim>;
  const codecs: Array<{ codec: string; op: number }> = [];

  beforeAll(async () => {
    other = startFakeStreamServer({ videoCodec: "H265" });
    shim = createGoLiveShim({ gateway: gw, meId: ME, lib, onCodec: (codec, op) => void codecs.push({ codec, op }) });
    shim.attachVoice(GUILD, CHANNEL, OUR_SESSION);
    const ready = shim.streamer.createStream();
    gw.dispatch("STREAM_CREATE", { stream_key: KEY, rtc_server_id: RTC_SERVER_ID, viewer_ids: [], paused: false });
    gw.dispatch("STREAM_SERVER_UPDATE", { stream_key: KEY, endpoint: other.endpoint, token: "stream-token-falso" });
    await Promise.race([ready, Bun.sleep(5000)]);
    other.sendOp(14, { video_codec: "AV1", audio_codec: "opus", secret_key: [1, 2, 3], media_session_id: "x" });
    other.sendOp(14, { audio_codec: "opus" }); // sin video_codec: no avisa nada
    await Bun.sleep(300);
  });

  afterAll(() => {
    shim.destroy();
    other.stop();
  });

  test("the shim reports the op 4 codec and every op 14 video codec, and nothing else of those messages", () => {
    expect(codecs).toEqual([
      { codec: "H265", op: 4 },
      { codec: "AV1", op: 14 },
    ]);
  });
});

describe("declareSsrc: false (ZCORD_GOLIVE_SSRC=0)", () => {
  const gw = fakeGateway();
  let plain: FakeStreamServer;
  let shim: ReturnType<typeof createGoLiveShim>;

  beforeAll(async () => {
    plain = startFakeStreamServer();
    shim = createGoLiveShim({ gateway: gw, meId: ME, lib, declareSsrc: false });
    shim.attachVoice(GUILD, CHANNEL, OUR_SESSION);
    const ready = shim.streamer.createStream();
    gw.dispatch("STREAM_CREATE", { stream_key: KEY, rtc_server_id: RTC_SERVER_ID, viewer_ids: [], paused: false });
    gw.dispatch("STREAM_SERVER_UPDATE", { stream_key: KEY, endpoint: plain.endpoint, token: "stream-token-falso" });
    await Promise.race([ready, Bun.sleep(5000)]);
  });

  afterAll(() => {
    shim.destroy();
    plain.stop();
  });

  test("the offer goes without a=ssrc, as the library sends it", () => {
    const select = plain.ops.find((o) => o.op === 1)?.d;
    expect(select.sdp).toMatch(/a=fingerprint/);
    expect(select.sdp).not.toMatch(/^a=ssrc:/m);
  });
});

describe("noResumeAfterStop only skips the resume of OUR stop: drops we did not ask for still resume", () => {
  for (const [code, resumes] of [
    [1001, true],
    [4015, true],
    [4014, false],
  ] as const) {
    test(`the server closes the stream WS with ${code}: ${resumes ? "op 7 RESUME on a new connection" : "no resume"}`, async () => {
      const gw = fakeGateway();
      const srv = startFakeStreamServer();
      const shim = createGoLiveShim({ gateway: gw, meId: ME, lib });
      try {
        shim.attachVoice(GUILD, CHANNEL, OUR_SESSION);
        const ready = shim.streamer.createStream();
        gw.dispatch("STREAM_CREATE", { stream_key: KEY, rtc_server_id: RTC_SERVER_ID, viewer_ids: [], paused: false });
        gw.dispatch("STREAM_SERVER_UPDATE", { stream_key: KEY, endpoint: srv.endpoint, token: "stream-token-falso" });
        await Promise.race([ready, Bun.sleep(5000)]);
        srv.closeWith(code);
        for (let i = 0; i < 50 && srv.ops.filter((o) => o.op === 7).length === 0; i++) await Bun.sleep(20);
        if (!resumes) await Bun.sleep(500);
        expect(srv.ops.filter((o) => o.op === 7).length).toBe(resumes ? 1 : 0);
        expect(srv.connections()).toBe(resumes ? 2 : 1);
      } finally {
        shim.destroy();
        srv.stop();
      }
    });
  }
});
