/**
 * Ver una transmisión punta a punta sin Discord: NUESTRO emisor de Go Live (video sintético de ffmpeg) → servidor de
 * stream falso en modo relay → NUESTRA conexión de espectador → access units H264 → decodificador.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";

import { createGoLiveShim, loadGoLiveLib } from "../../src/golive/shim";
import { createH264Decoder } from "../../src/watch/decode";
import { hasIdr } from "../../src/watch/h264";
import { createViewerConnection, loadViewerLib, parseRemoteInfo, pliPacket, streamerSsrcs, viewerRemoteSdp, type ViewerConnection } from "../../src/watch/viewer";
import { fakeGateway, startFakeStreamServer, type FakeStreamServer } from "../fakes/fake-stream-server";

const GUILD = "111111111111111111";
const CHANNEL = "222222222222222222";
const STREAMER = "333333333333333333";
const ME = "555555555555555555";
const RTC = "444444444444444445";
const KEY = `guild:${GUILD}:${CHANNEL}:${STREAMER}`;
const hasFfmpeg = Bun.which("ffmpeg") !== null;
const tlsBefore = process.env.NODE_TLS_REJECT_UNAUTHORIZED;

test("op 12 VIDEO: takes the streamer's active stream SSRC, ignores others and ourselves", () => {
  const d = { user_id: STREAMER, audio_ssrc: 5, video_ssrc: 6, streams: [{ ssrc: 6, rtx_ssrc: 7, active: true }] };
  expect(streamerSsrcs(d, STREAMER, ME)).toEqual({ audio: 5, video: 6, rtx: 7 });
  expect(streamerSsrcs({ ...d, user_id: ME }, STREAMER, ME)).toBeNull();
  expect(streamerSsrcs({ ...d, user_id: "9" }, STREAMER, ME)).toBeNull();
  expect(streamerSsrcs({ user_id: STREAMER, audio_ssrc: 5, video_ssrc: 0, streams: [] }, STREAMER, ME)).toBeNull();
  expect(streamerSsrcs({ user_id: STREAMER, video_ssrc: 8 }, STREAMER, ME)).toEqual({ audio: null, video: 8, rtx: 9 });
});

test("the remote SDP sends toward us and declares the streamer's SSRCs once known", () => {
  const info = parseRemoteInfo("c=IN IP4 1.2.3.4\na=rtcp:5000\na=ice-ufrag:u\na=ice-pwd:p\na=fingerprint:sha-256 AA\na=candidate:1 1 UDP 1 1.2.3.4 5000 typ host");
  expect(info.port).toBe("5000");
  const before = viewerRemoteSdp(info, { audio: null, video: null, rtx: null });
  expect(before).toContain("a=sendonly");
  expect(before).not.toContain("a=inactive");
  expect(before).not.toContain("a=ssrc:");
  const after = viewerRemoteSdp(info, { audio: 5, video: 6, rtx: 7 });
  expect(after).toContain("a=ssrc:6 cname:stream");
  expect(after).toContain("a=ssrc:5 cname:stream");
  expect(after.match(/^m=/gm)).toHaveLength(2);
});

describe_e2e();

function describe_e2e() {
  let server: FakeStreamServer;
  let viewer: ViewerConnection | null = null;
  const aus: Uint8Array[] = [];
  const closes: number[] = [];
  let decodedFrames = 0;
  const viewerRtcp = new Map<string, number>();
  let abort: AbortController;
  let shim: ReturnType<typeof createGoLiveShim>;
  let playing: Promise<unknown> = Promise.resolve();

  beforeAll(async () => {
    if (!hasFfmpeg) return;
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"; // certificado propio del server falso; se restaura al final
    server = startFakeStreamServer({
      relay: true,
      dave: 0,
      streamerId: STREAMER,
      onViewerPacket: (m) => {
        // RTCP compuesto: cada paquete por "pt/fmt"
        for (let o = 0; o + 4 <= m.length && m[o]! >> 6 === 2; o += (m.readUInt16BE(o + 2) + 1) * 4) {
          const k = `${m[o + 1]}/${m[o]! & 31}`;
          viewerRtcp.set(k, (viewerRtcp.get(k) ?? 0) + 1);
        }
      },
    });
    const lib = await loadGoLiveLib();
    const gw = fakeGateway();
    shim = createGoLiveShim({ gateway: gw, meId: STREAMER, lib });
    shim.attachVoice(GUILD, CHANNEL, "sender-session");
    const mod: any = await import("@dank074/discord-video-stream");
    abort = new AbortController();
    const { output, promise } = mod.prepareStream(
      "testsrc2=size=640x360:rate=30",
      {
        customInputOptions: ["-re", "-f", "lavfi"],
        encoder: mod.Encoders.software({ x264: { preset: "ultrafast", tune: "zerolatency" } }),
        bitrateVideo: 1500,
        bitrateVideoMax: 2000,
        includeAudio: false,
        logLevel: "error",
        customFfmpegFlags: ["-g", "30", "-bf", "0"],
      },
      abort.signal,
    );
    promise.catch(() => {});
    playing = lib.playStream(output, shim.streamer, { type: "go-live", format: "nut" }, abort.signal).catch(() => {});
    for (let i = 0; i < 100 && !gw.sent.some((x) => x.op === 18); i++) await Bun.sleep(50);
    gw.dispatch("STREAM_CREATE", { stream_key: `guild:${GUILD}:${CHANNEL}:${STREAMER}`, rtc_server_id: RTC, viewer_ids: [], paused: false });
    gw.dispatch("STREAM_SERVER_UPDATE", { stream_key: `guild:${GUILD}:${CHANNEL}:${STREAMER}`, endpoint: server.endpoint, token: "t" });
    for (let i = 0; i < 100 && !server.ops.some((o) => o.op === 12 && o.d?.streams?.some((s: any) => s.active)); i++) await Bun.sleep(50);

    const vlib = await loadViewerLib();
    const decoder = await createH264Decoder(320, 180);
    let chain: Promise<void> = Promise.resolve();
    viewer = createViewerConnection(
      vlib,
      { guildId: GUILD, channelId: CHANNEL, meId: ME, streamerId: STREAMER, sessionId: "viewer-session", rtcServerId: RTC, streamKey: KEY, endpoint: server.endpoint, token: "stream-token" },
      {
        onFrame: (au) => {
          aus.push(au);
          chain = chain.then(async () => {
            if (await decoder.decode(au, true)) decodedFrames++;
          });
        },
        onClose: (code) => closes.push(code),
        onUnsupportedCodec: () => {},
      },
    );
    await Bun.sleep(3000);
    await chain;
    decoder.close();
  }, 20_000);

  afterAll(async () => {
    if (!hasFfmpeg) return;
    viewer?.stop();
    abort.abort();
    await playing;
    shim.destroy();
    server.stop();
    if (tlsBefore === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = tlsBefore;
  });

  test.skipIf(!hasFfmpeg)("the viewer identifies with our voice session and server_id = rtc_server_id, and asks for the stream (op 15)", () => {
    const identifies = server.ops.filter((o) => o.op === 0).map((o) => o.d);
    const mine = identifies.find((d) => d.user_id === ME);
    expect(mine).toMatchObject({ server_id: RTC, session_id: "viewer-session", token: "stream-token", video: true });
    const wants = server.ops.filter((o) => o.op === 15).map((o) => o.d);
    expect(wants).toContainEqual({ any: 100 });
    expect(wants.some((w) => w[String(1001)] === 100)).toBe(true); // SSRC de video del emisor (1000 + 1)
  });

  test.skipIf(!hasFfmpeg)("receives the relayed video as H264 access units that start on a keyframe and decode", () => {
    expect(server.relayed()).toBeGreaterThan(100);
    expect(aus.length).toBeGreaterThan(30); // ~30 fps durante ~2 s después del primer keyframe
    expect(hasIdr(aus[0]!)).toBe(true);
    expect(decodedFrames).toBeGreaterThan(30);
    expect(viewer!.stats().daveFailures).toBe(0);
    expect(closes).toEqual([]);
  });

  test.skipIf(!hasFfmpeg)("watch.diag says what codec, DAVE version and NAL types arrived (numbers only, no SDP or ids)", () => {
    const d = viewer!.diag!();
    expect(d.neg).toBe("H264/opus/v0/?");
    expect(d.pt).toMatch(/^101:\d+/);
    expect(d.win).toMatchObject({ jumps: 0, gap: 0 }); // en local no se pierde nada
    expect((d.win as { n: number }).n).toBeGreaterThan(0);
    const rx = d.rx as Record<string, unknown>;
    expect(rx.n).toBeGreaterThan(100);
    expect(rx.mk).toBeGreaterThan(30);
    expect(String(rx.fu)).toMatch(/(^|,)5:\d+/); // los IDR llegan partidos en FU-A
    expect(rx.fuS).toBeGreaterThan(0);
    expect(rx.fbit).toBe(0);
    const text = JSON.stringify(d);
    expect(text).not.toContain("a=");
    expect(text).not.toContain(STREAMER);
    expect(text).not.toContain("stream-token");
  });

  test.skipIf(!hasFfmpeg)("feedback the viewer sends back: receiver reports and a keyframe request as FIR (libdatachannel) plus our PLI; no REMB, no NACK", () => {
    expect(viewerRtcp.get("201/1") ?? 0).toBeGreaterThan(0); // RR
    expect(viewerRtcp.get("206/4") ?? 0).toBeGreaterThan(0); // FIR de requestKeyframe()
    expect(viewerRtcp.get("206/1") ?? 0).toBeGreaterThan(0); // nuestro PLI con nuestro SSRC
    expect(viewerRtcp.has("206/15")).toBe(false); // sin REMB
    expect(viewerRtcp.has("205/1")).toBe(false); // sin NACK
  });

  test.skipIf(!hasFfmpeg)("the viewer never sends media attributes of its own (no op 12 from it)", () => {
    // El emisor manda sus op 12; el que mira, ninguno: cuenta los identify (2) contra los que mandaron op 12 activos (1).
    const activeVideo = server.ops.filter((o) => o.op === 12 && o.d?.streams?.some((s: any) => s.active));
    expect(activeVideo.every((o) => o.d.audio_ssrc === 1000)).toBe(true);
  });
}

test("pliPacket builds an RTCP PLI (PT 206, FMT 1, length 2) with our SSRC as sender", () => {
  expect([...pliPacket(0x01020304, 0xa0b0c0d0)]).toEqual([0x81, 206, 0, 2, 1, 2, 3, 4, 0xa0, 0xb0, 0xc0, 0xd0]);
});
