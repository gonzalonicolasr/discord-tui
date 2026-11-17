/**
 * Lo que Discord le devuelve al que transmite por RTCP (PLI, NACK, reports) tiene que llegar al track de video de la
 * librería: si no, ni su RtcpNackResponder ni nuestro diagnóstico lo ven. Con dos m-lines (audio + video) y sin
 * `a=ssrc` en la SDP local, libdatachannel no sabe a qué track mandarlo y lo tira (medido: 0 de 4 contra 4 de 4).
 * Emisor real (shim + playStream, video sintético) → server de stream falso en modo relay, que le manda PLI al emisor.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";

import { createGoLiveShim, loadGoLiveLib } from "../../src/golive/shim";
import { watchStream, type StreamStats } from "../../src/golive/stats";
import { fakeGateway, startFakeStreamServer, type FakeStreamServer } from "../fakes/fake-stream-server";

const GUILD = "111111111111111111";
const CHANNEL = "222222222222222222";
const STREAMER = "333333333333333333";
const RTC = "444444444444444445";
const KEY = `guild:${GUILD}:${CHANNEL}:${STREAMER}`;
const VIDEO_SSRC = 1001; // el fake asigna 1000 al audio y +1 al video
const hasFfmpeg = Bun.which("ffmpeg") !== null;
const tlsBefore = process.env.NODE_TLS_REJECT_UNAUTHORIZED;

let server: FakeStreamServer;
let shim: ReturnType<typeof createGoLiveShim>;
let abort: AbortController;
let playing: Promise<unknown> = Promise.resolve();
let stats: StreamStats | null = null;
const lines: any[] = [];
let sentPli = 0;
let fromStreamer = 0;

function pli(media: number): Buffer {
  const b = Buffer.alloc(12);
  b[0] = 0x81;
  b[1] = 206;
  b.writeUInt16BE(2, 2);
  b.writeUInt32BE(4242, 4);
  b.writeUInt32BE(media, 8);
  return b;
}

beforeAll(async () => {
  if (!hasFfmpeg) return;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"; // certificado propio del server falso; se restaura al final
  server = startFakeStreamServer({ relay: true, dave: 0, streamerId: STREAMER, onStreamerPacket: () => void fromStreamer++ });
  const lib = await loadGoLiveLib();
  const gw = fakeGateway();
  shim = createGoLiveShim({ gateway: gw, meId: STREAMER, lib });
  shim.attachVoice(GUILD, CHANNEL, "sender-session");
  const create = shim.streamer.createStream.bind(shim.streamer);
  shim.streamer.createStream = () =>
    create().then((conn: unknown) => {
      stats = watchStream(conn, { log: { info: (_e, f) => void lines.push(f) }, intervalMs: 0 });
      return conn;
    });
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
  gw.dispatch("STREAM_CREATE", { stream_key: KEY, rtc_server_id: RTC, viewer_ids: [], paused: false });
  gw.dispatch("STREAM_SERVER_UPDATE", { stream_key: KEY, endpoint: server.endpoint, token: "t" });
  // Que el video esté saliendo (el relay ya recibe RTP del emisor) antes de mandarle RTCP.
  for (let i = 0; i < 200 && fromStreamer < 50; i++) await Bun.sleep(50);
  await Bun.sleep(500);
  for (let i = 0; i < 3; i++) {
    if (server.sendToStreamer(pli(VIDEO_SSRC))) sentPli++;
    await Bun.sleep(50);
  }
  await Bun.sleep(500);
  stats?.report();
}, 20_000);

afterAll(async () => {
  if (!hasFfmpeg) return;
  stats?.stop("idle");
  abort.abort();
  await playing;
  shim.destroy();
  server.stop();
  if (tlsBefore === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  else process.env.NODE_TLS_REJECT_UNAUTHORIZED = tlsBefore;
});

test.skipIf(!hasFfmpeg)("our offer declares the video SSRC Discord gave us (op 2), once", () => {
  const select = server.ops.find((o) => o.op === 1)?.d;
  expect(select.sdp.match(new RegExp(`^a=ssrc:${VIDEO_SSRC} `, "gm"))?.length).toBeGreaterThanOrEqual(1);
  expect(select.sdp).not.toMatch(/a=ssrc:1000 /); // el audio no: no hace falta
});

test.skipIf(!hasFfmpeg)("a PLI from the server reaches the video track and golive.stats counts it", () => {
  expect(sentPli).toBe(3);
  const msg = JSON.parse(lines.at(-1).msg);
  expect(msg.rtcp).not.toBeNull();
  expect(msg.rtcp.pli).toBe(3);
});

test.skipIf(!hasFfmpeg)("golive.stats says what the op 4 negotiated and the size of the last keyframe", () => {
  const msg = JSON.parse(lines.at(-1).msg);
  expect(msg.neg).toBe("H264/opus/v0/?");
  expect(msg.codec).toBe("H264");
  expect(msg.kf).toMatch(/^\d+\/\d+$/);
});
