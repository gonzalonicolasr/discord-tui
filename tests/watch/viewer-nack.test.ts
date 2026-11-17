/**
 * Recuperar paquetes perdidos al mirar, sin Discord: NUESTRO emisor de Go Live (ffmpeg) → servidor de stream falso
 * en modo relay que TIRA a propósito paquetes de los keyframes → NUESTRA conexión de espectador. El server falso
 * lee los NACK que le manda el que mira y contesta con RTX (RFC 4588, PT 102, SSRC rtx del op 12). Todo pasa por
 * libdatachannel real (SRTP/SRTCP sobre UDP en 127.0.0.1): prueba que el RTCP que mandamos sale por el cable, y que
 * libdatachannel desenvuelve el RTX solo (al onMessage llega como el paquete original: PT 101, SSRC del video).
 */
import { afterAll, beforeAll, expect, test } from "bun:test";

import { createGoLiveShim, loadGoLiveLib } from "../../src/golive/shim";
import { hasIdr } from "../../src/watch/h264";
import { createViewerConnection, loadViewerLib, type ViewerConnection } from "../../src/watch/viewer";
import { fakeGateway, startFakeStreamServer, type FakeStreamServer } from "../fakes/fake-stream-server";

const GUILD = "111111111111111111";
const CHANNEL = "222222222222222222";
const STREAMER = "333333333333333333";
const ME = "555555555555555555";
const RTC = "444444444444444445";
const KEY = `guild:${GUILD}:${CHANNEL}:${STREAMER}`;
const VIDEO_SSRC = 1001; // el server falso le da 1000 al emisor: audio 1000, video 1001, rtx 1002
const RTX_SSRC = 1002;
const hasFfmpeg = Bun.which("ffmpeg") !== null;
const tlsBefore = process.env.NODE_TLS_REJECT_UNAUTHORIZED;

/** Bytes del encabezado RTP (con CSRC y extensión) y del padding final. */
function rtpLayout(m: Buffer): { header: number; pad: number } {
  let header = 12 + (m[0]! & 0x0f) * 4;
  if (m[0]! & 0x10) header += 4 + m.readUInt16BE(header + 2) * 4;
  return { header, pad: m[0]! & 0x20 ? m[m.length - 1]! : 0 };
}

let server: FakeStreamServer;
let viewer: ViewerConnection | null = null;
const aus: Uint8Array[] = [];
let abort: AbortController;
let shim: ReturnType<typeof createGoLiveShim>;
let playing: Promise<unknown> = Promise.resolve();
/** Paquetes de video del emisor por número de secuencia (para reenviarlos). */
const sent = new Map<number, Buffer>();
/** Paquetes por keyframe (timestamp) y los que el relay tiró a propósito. */
const keyframeSize = new Map<number, number>();
const dropped = new Set<number>();
/** Tirados cuando el visor ya venía recibiendo (los anteriores no los puede pedir: no sabe que existieron). */
const askable = new Set<number>();
const nacked = new Set<number>();
let nackPackets = 0;
let rtxSent = 0;
let rtxSeq = 0;
let diagAtEnd: Record<string, unknown> = {};

beforeAll(async () => {
  if (!hasFfmpeg) return;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"; // certificado propio del server falso; se restaura al final
  server = startFakeStreamServer({
    relay: true,
    dave: 0,
    streamerId: STREAMER,
    relayFilter: (m) => {
      if (m[1]! >= 192 && m[1]! <= 223) return true; // RTCP
      if ((m[1]! & 0x7f) !== 101 || m.readUInt32BE(8) !== VIDEO_SSRC) return true;
      const seq = m.readUInt16BE(2);
      sent.set(seq, Buffer.from(m));
      const { header } = rtpLayout(m);
      const isIdrFu = (m[header]! & 0x1f) === 28 && (m[header + 1]! & 0x1f) === 5;
      if (!isIdrFu) return true;
      const ts = m.readUInt32BE(4);
      const i = keyframeSize.get(ts) ?? 0;
      keyframeSize.set(ts, i + 1);
      // Pérdida en ráfaga como la de la PC de Gon: varios paquetes del medio de cada keyframe y el del marker.
      const lose = i === 5 || i === 6 || i === 7 || i % 37 === 20 || (m[1]! & 0x80) !== 0;
      if (lose) dropped.add(seq);
      if (lose && server.relayed() > 0) askable.add(seq);
      return !lose;
    },
    onViewerPacket: (m) => {
      // RTCP compuesto: los Generic NACK (205/1) sobre el video
      for (let o = 0; o + 4 <= m.length && m[o]! >> 6 === 2; o += (m.readUInt16BE(o + 2) + 1) * 4) {
        if (m[o + 1] !== 205 || (m[o]! & 31) !== 1 || m.readUInt32BE(o + 8) !== VIDEO_SSRC) continue;
        nackPackets++;
        const end = o + (m.readUInt16BE(o + 2) + 1) * 4;
        for (let f = o + 12; f + 4 <= end; f += 4) {
          const pid = m.readUInt16BE(f);
          const blp = m.readUInt16BE(f + 2);
          const seqs = [pid, ...Array.from({ length: 16 }, (_, b) => (blp & (1 << b) ? (pid + b + 1) & 0xffff : -1)).filter((s) => s >= 0)];
          for (const seq of seqs) {
            nacked.add(seq);
            const orig = sent.get(seq);
            if (!orig) continue;
            const { header, pad } = rtpLayout(orig);
            const hdr = Buffer.from(orig.subarray(0, header));
            hdr[0] = hdr[0]! & ~0x20; // sin padding
            hdr[1] = (hdr[1]! & 0x80) | 102;
            hdr.writeUInt16BE(rtxSeq++ & 0xffff, 2);
            hdr.writeUInt32BE(RTX_SSRC, 8);
            const osn = Buffer.alloc(2);
            osn.writeUInt16BE(seq);
            if (server.sendToViewers(Buffer.concat([hdr, osn, orig.subarray(header, orig.length - pad)]))) rtxSent++;
          }
        }
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
    // cuadros grandes y pocos: keyframes de ~100-200 paquetes como los de una transmisión real
    "testsrc2=size=1280x720:rate=15",
    {
      customInputOptions: ["-re", "-f", "lavfi"],
      encoder: mod.Encoders.software({ x264: { preset: "ultrafast", tune: "zerolatency" } }),
      bitrateVideo: 8000,
      bitrateVideoMax: 10000,
      includeAudio: false,
      logLevel: "error",
      customFfmpegFlags: ["-g", "15", "-bf", "0"],
    },
    abort.signal,
  );
  promise.catch(() => {});
  playing = lib.playStream(output, shim.streamer, { type: "go-live", format: "nut" }, abort.signal).catch(() => {});
  for (let i = 0; i < 100 && !gw.sent.some((x) => x.op === 18); i++) await Bun.sleep(50);
  gw.dispatch("STREAM_CREATE", { stream_key: KEY, rtc_server_id: RTC, viewer_ids: [], paused: false });
  gw.dispatch("STREAM_SERVER_UPDATE", { stream_key: KEY, endpoint: server.endpoint, token: "t" });
  for (let i = 0; i < 100 && !server.ops.some((o) => o.op === 12 && o.d?.streams?.some((s: any) => s.active)); i++) await Bun.sleep(50);

  const vlib = await loadViewerLib();
  viewer = createViewerConnection(
    vlib,
    { guildId: GUILD, channelId: CHANNEL, meId: ME, streamerId: STREAMER, sessionId: "viewer-session", rtcServerId: RTC, streamKey: KEY, endpoint: server.endpoint, token: "stream-token" },
    { onFrame: (au) => aus.push(au), onClose: () => {}, onUnsupportedCodec: () => {} },
  );
  await Bun.sleep(4000);
  diagAtEnd = viewer.diag!();
}, 25_000);

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

test.skipIf(!hasFfmpeg)("the relay really dropped packets out of big keyframes", () => {
  const sizes = [...keyframeSize.values()];
  expect(sizes.length).toBeGreaterThanOrEqual(2);
  expect(Math.max(...sizes)).toBeGreaterThanOrEqual(100);
  expect(dropped.size).toBeGreaterThanOrEqual(5 * sizes.length);
});

test.skipIf(!hasFfmpeg)("the viewer's Generic NACK goes out over the wire for the video SSRC and asks for exactly the lost packets", () => {
  expect(nackPackets).toBeGreaterThan(0);
  // los del último keyframe pueden no haber llegado a pedirse antes de cortar
  const lastTs = Math.max(...keyframeSize.keys());
  const expected = [...askable].filter((seq) => sent.get(seq)!.readUInt32BE(4) !== lastTs);
  expect(expected.length).toBeGreaterThan(0);
  expect(expected.filter((seq) => !nacked.has(seq))).toEqual([]);
  // y no pide lo que sí llegó (en loopback no se pierde nada aparte de lo provocado)
  expect([...nacked].filter((seq) => !dropped.has(seq))).toEqual([]);
  expect(diagAtEnd.nackPkts).toBeGreaterThan(0);
  expect(diagAtEnd.nackSent).toBeGreaterThanOrEqual(expected.length);
  expect(JSON.stringify(diagAtEnd).length).toBeLessThan(1200); // watch.ts corta la línea del log en 1200
});

test.skipIf(!hasFfmpeg)("libdatachannel unwraps the RTX itself (only PT 101 reaches onMessage) and the keyframes complete with it", () => {
  expect(rtxSent).toBeGreaterThan(0);
  expect(String(diagAtEnd.pt)).toMatch(/^101:\d+$/); // ni un PT 102 crudo
  expect(diagAtEnd.rtpOther).toBe(0); // ni el SSRC rtx
  expect(diagAtEnd.recovered).toBeGreaterThan(0); // llegaron después de pedirlos
  expect(diagAtEnd.late).toBe(0); // en loopback nada llega desordenado
  expect(diagAtEnd.saved).toBeGreaterThanOrEqual(2); // keyframes salvados por un reenvío
  expect((diagAtEnd.lost as { n: number }).n).toBe(0); // ningún cuadro tirado por faltarle paquetes
  // a lo sumo el primero: el visor puede engancharse con un cuadro ya empezado (FU-A sin su comienzo)
  expect(viewer!.stats().dropped).toBeLessThanOrEqual(1);
  expect(aus.length).toBeGreaterThan(15);
  expect(hasIdr(aus[0]!)).toBe(true);
});
