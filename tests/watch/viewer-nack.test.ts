/**
 * Recuperar paquetes perdidos al mirar, sin Discord: NUESTRO emisor de Go Live (ffmpeg) → servidor de stream falso
 * en modo relay que TIRA a propósito paquetes de los keyframes → NUESTRA conexión de espectador. El server falso
 * lee los NACK que le manda el que mira y (si `answer`) contesta con RTX (RFC 4588, PT 102, SSRC rtx del op 12) a los
 * 20 ms, como un RTT. Todo pasa por libdatachannel real (SRTP/SRTCP sobre UDP en 127.0.0.1): prueba que el RTCP que
 * mandamos sale por el cable, y que libdatachannel desenvuelve el RTX solo (al onMessage llega como el paquete
 * original: PT 101, SSRC del video). Sin respuesta, el visor tiene que apagar la espera y el NACK solo.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createGoLiveShim, loadGoLiveLib } from "../../src/golive/shim";
import { hasIdr } from "../../src/watch/h264";
import { NACK_USELESS_AFTER, RESEND_MIN_MS } from "../../src/watch/nack";
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
const RTT_MS = 20;
const hasFfmpeg = Bun.which("ffmpeg") !== null;

/** Bytes del encabezado RTP (con CSRC y extensión) y del padding final. */
function rtpLayout(m: Buffer): { header: number; pad: number } {
  let header = 12 + (m[0]! & 0x0f) * 4;
  if (m[0]! & 0x10) header += 4 + m.readUInt16BE(header + 2) * 4;
  return { header, pad: m[0]! & 0x20 ? m[m.length - 1]! : 0 };
}

/** Una sesión: emisor → relay con pérdida → visor, hasta que `until(diag)` se cumpla (tope 15 s). */
function session(answer: boolean, until: (d: Record<string, any>) => boolean) {
  const s = {
    server: null as unknown as FakeStreamServer,
    viewer: null as ViewerConnection | null,
    aus: [] as Uint8Array[],
    /** Paquetes de video del emisor por número de secuencia (para reenviarlos). */
    sent: new Map<number, Buffer>(),
    /** Paquetes por keyframe (timestamp) y los que el relay tiró a propósito. */
    keyframeSize: new Map<number, number>(),
    dropped: new Set<number>(),
    /** Tirados cuando el visor ya venía recibiendo (los anteriores no los puede pedir: no sabe que existieron). */
    askable: new Set<number>(),
    nacked: new Set<number>(),
    nackPackets: 0,
    rtxSent: 0,
    diag: {} as Record<string, any>,
  };
  let abort: AbortController;
  let shim: ReturnType<typeof createGoLiveShim>;
  let playing: Promise<unknown> = Promise.resolve();
  let rtxSeq = 0;
  const tlsBefore = process.env.NODE_TLS_REJECT_UNAUTHORIZED;

  beforeAll(async () => {
    if (!hasFfmpeg) return;
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"; // certificado propio del server falso; se restaura al final
    s.server = startFakeStreamServer({
      relay: true,
      dave: 0,
      streamerId: STREAMER,
      relayFilter: (m) => {
        if (m[1]! >= 192 && m[1]! <= 223) return true; // RTCP
        if ((m[1]! & 0x7f) !== 101 || m.readUInt32BE(8) !== VIDEO_SSRC) return true;
        const seq = m.readUInt16BE(2);
        s.sent.set(seq, Buffer.from(m));
        const { header } = rtpLayout(m);
        const isIdrFu = (m[header]! & 0x1f) === 28 && (m[header + 1]! & 0x1f) === 5;
        if (!isIdrFu) return true;
        const ts = m.readUInt32BE(4);
        const i = s.keyframeSize.get(ts) ?? 0;
        s.keyframeSize.set(ts, i + 1);
        // Pérdida en ráfaga como la de la PC de Gon: varios paquetes del medio de cada keyframe y el del marker.
        const lose = i === 5 || i === 6 || i === 7 || i % 37 === 20 || (m[1]! & 0x80) !== 0;
        if (lose) s.dropped.add(seq);
        if (lose && s.server.relayed() > 0) s.askable.add(seq);
        return !lose;
      },
      onViewerPacket: (m) => {
        // RTCP compuesto: los Generic NACK (205/1) sobre el video
        for (let o = 0; o + 4 <= m.length && m[o]! >> 6 === 2; o += (m.readUInt16BE(o + 2) + 1) * 4) {
          if (m[o + 1] !== 205 || (m[o]! & 31) !== 1 || m.readUInt32BE(o + 8) !== VIDEO_SSRC) continue;
          s.nackPackets++;
          const end = o + (m.readUInt16BE(o + 2) + 1) * 4;
          for (let f = o + 12; f + 4 <= end; f += 4) {
            const pid = m.readUInt16BE(f);
            const blp = m.readUInt16BE(f + 2);
            const seqs = [pid, ...Array.from({ length: 16 }, (_, b) => (blp & (1 << b) ? (pid + b + 1) & 0xffff : -1)).filter((x) => x >= 0)];
            for (const seq of seqs) {
              s.nacked.add(seq);
              const orig = s.sent.get(seq);
              if (!answer || !orig) continue;
              const { header, pad } = rtpLayout(orig);
              const hdr = Buffer.from(orig.subarray(0, header));
              hdr[0] = hdr[0]! & ~0x20; // sin padding
              hdr[1] = (hdr[1]! & 0x80) | 102;
              hdr.writeUInt16BE(rtxSeq++ & 0xffff, 2);
              hdr.writeUInt32BE(RTX_SSRC, 8);
              const osn = Buffer.alloc(2);
              osn.writeUInt16BE(seq);
              const rtx = Buffer.concat([hdr, osn, orig.subarray(header, orig.length - pad)]);
              setTimeout(() => {
                if (s.server.sendToViewers(rtx)) s.rtxSent++;
              }, RTT_MS);
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
    gw.dispatch("STREAM_SERVER_UPDATE", { stream_key: KEY, endpoint: s.server.endpoint, token: "t" });
    for (let i = 0; i < 100 && !s.server.ops.some((o) => o.op === 12 && o.d?.streams?.some((x: any) => x.active)); i++) await Bun.sleep(50);

    const vlib = await loadViewerLib();
    s.viewer = createViewerConnection(
      vlib,
      { guildId: GUILD, channelId: CHANNEL, meId: ME, streamerId: STREAMER, sessionId: "viewer-session", rtcServerId: RTC, streamKey: KEY, endpoint: s.server.endpoint, token: "stream-token" },
      { onFrame: (au) => s.aus.push(au), onClose: () => {}, onUnsupportedCodec: () => {} },
    );
    // Por condición y no un tiempo fijo: con la PC cargada la conexión puede tardar.
    for (let t = 0; t < 15_000 && !until(s.viewer.diag!()); t += 100) await Bun.sleep(100);
    s.diag = s.viewer.diag!();
  }, 40_000);

  afterAll(async () => {
    if (!hasFfmpeg) return;
    s.viewer?.stop();
    abort.abort();
    await playing;
    shim.destroy();
    s.server.stop();
    if (tlsBefore === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = tlsBefore;
  });

  return s;
}

describe("the SFU answers the NACK with RTX", () => {
  const s = session(true, (d) => d.saved >= 2);

  test.skipIf(!hasFfmpeg)("the relay really dropped packets out of big keyframes", () => {
    const sizes = [...s.keyframeSize.values()];
    expect(sizes.length).toBeGreaterThanOrEqual(2);
    expect(Math.max(...sizes)).toBeGreaterThanOrEqual(100);
    expect(s.dropped.size).toBeGreaterThanOrEqual(5 * sizes.length);
  });

  test.skipIf(!hasFfmpeg)("the viewer's Generic NACK goes out over the wire for the video SSRC and asks for exactly the lost packets", () => {
    expect(s.nackPackets).toBeGreaterThan(0);
    // los del último keyframe pueden no haber llegado a pedirse antes de cortar
    const lastTs = Math.max(...s.keyframeSize.keys());
    const expected = [...s.askable].filter((seq) => s.sent.get(seq)!.readUInt32BE(4) !== lastTs);
    expect(expected.length).toBeGreaterThan(0);
    expect(expected.filter((seq) => !s.nacked.has(seq))).toEqual([]);
    // y no pide lo que sí llegó (en loopback no se pierde nada aparte de lo provocado)
    expect([...s.nacked].filter((seq) => !s.dropped.has(seq))).toEqual([]);
    expect(s.diag.nackPkts).toBeGreaterThan(0);
    expect(s.diag.nackSent).toBeGreaterThanOrEqual(expected.length);
    expect(JSON.stringify(s.diag).length).toBeLessThan(1200); // watch.ts corta la línea del log en 1200
  });

  test.skipIf(!hasFfmpeg)("libdatachannel unwraps the RTX itself (only PT 101 reaches onMessage) and the keyframes complete with it", () => {
    expect(s.rtxSent).toBeGreaterThan(0);
    expect(String(s.diag.pt)).toMatch(/^101:\d+$/); // ni un PT 102 crudo
    expect(s.diag.rtpOther).toBe(0); // ni el SSRC rtx
    expect(s.diag.recovered).toBeGreaterThan(0); // en la ventana creíble de reenvío
    expect(s.diag.stray).toBe(0);
    expect(s.diag.late).toBe(0); // en loopback nada llega desordenado
    const [min] = String(s.diag.rspMs).split("/").map(Number);
    expect(min).toBeGreaterThanOrEqual(Math.max(RESEND_MIN_MS, RTT_MS)); // el RTT simulado
    expect(s.diag.saved).toBeGreaterThanOrEqual(2); // keyframes salvados por un reenvío
    expect(s.diag.nackOff).toBe(false);
    expect(s.diag.lost.n).toBe(0); // ningún cuadro tirado por faltarle paquetes
    // a lo sumo el primero: el visor puede engancharse con un cuadro ya empezado (FU-A sin su comienzo)
    expect(s.viewer!.stats().dropped).toBeLessThanOrEqual(1);
    expect(s.aus.length).toBeGreaterThan(15);
    expect(hasIdr(s.aus[0]!)).toBe(true);
  });
});

describe("the SFU ignores the NACK", () => {
  const s = session(false, (d) => d.nackOff === true);

  test.skipIf(!hasFfmpeg)("after NACK_USELESS_AFTER numbers asked with no answer the viewer stops NACKing and waiting, and drops lossy frames as before", async () => {
    expect(s.diag.nackOff).toBe(true);
    expect(s.diag.nackAsked).toBeGreaterThanOrEqual(NACK_USELESS_AFTER);
    expect(s.diag.recovered).toBe(0);
    expect(s.diag.saved).toBe(0);
    const before = s.nackPackets;
    const lostBefore = (s.viewer!.diag!() as Record<string, any>).lost.n;
    await Bun.sleep(2500); // 2 keyframes más, con pérdida
    expect(s.nackPackets).toBe(before); // no salió ningún NACK más
    const d = s.viewer!.diag!() as Record<string, any>;
    expect(d.lost.n).toBeGreaterThan(lostBefore); // los keyframes con pérdida se tiran (sin esperar el reenvío)
    expect(d.kfReq).toBeGreaterThan(0); // y se pide keyframe como siempre
  });
});
