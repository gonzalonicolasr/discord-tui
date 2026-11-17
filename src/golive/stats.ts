/**
 * Diagnóstico de la transmisión (Go Live): cada ~5 s una línea `golive.stats` en el log con lo que la librería
 * le mandó a Discord, para entender cortes que no se pueden reproducir sin la cuenta (como el 4006 a los 30 s con
 * el audio de la PC, 2026-11-16).
 *
 * Mira la conexión que devuelve `createStream()` (WebRtcConnWrapper de @dank074/discord-video-stream 7.0.0) sin
 * cambiar lo que hace: envuelve `sendVideoFrame` / `sendAudioFrame` (cuenta y sigue llamando al original) y el WS
 * del stream (cuenta los ops que entran y salen). Sin datos sensibles: solo cantidades, tiempos, estados y NÚMEROS
 * de op; nunca un payload.
 *
 * Campos del `msg` (JSON):
 *   s            segundos desde que el stream quedó listo
 *   v / a        cuadros de video / paquetes de audio entregados a WebRTC
 *   vd / ad      los que la librería tiró sin mandar: WebRTC no conectado (`ready` false) o sin packetizer todavía
 *                (si el envío tira, no se cuenta en ninguno)
 *   v_ms / a_ms  reloj de medios: suma de las duraciones de lo enviado (lo mismo que avanza el timestamp RTP;
 *                es el último pts relativo al primero)
 *   v_idle_ms / a_idle_ms  ms desde el último cuadro / paquete (null si todavía no hubo)
 *   waiting      "video" = el audio sigue y el video no (la librería frena el video esperando al audio);
 *                "audio" = al revés; "both" = no sale nada; "no"; "none-yet" = todavía no salió nada
 *   rtc          estado del PeerConnection (connected, connecting, closed…)
 *   dave / dave_v  DAVE listo (1/0) y versión del protocolo negociada
 *   in / out     ops del WS del stream desde la línea anterior ({"6":2} = dos op 6; "b25" = binario op 25;
 *                "?" = un mensaje de texto que no empieza con su op)
 *   ws           cuántos WS del stream se vieron (más de 1 = la librería reconectó)
 *   neg          lo negociado en el op 4: "códec video/códec audio/v<DAVE>/modo" ("-" si no se vio el op 4)
 *   codec        el códec con el que la librería empaqueta el video
 *   kf / kfs     último keyframe (IDR) entregado a WebRTC: "bytes/~paquetes RTP" (antes de DAVE); kfs = cuántos desde
 *                la línea anterior (con un IDR cada 2 s, ~2-3 por línea)
 *   rtcp         lo que entró por el track de video desde la línea anterior (null = no hay track que mirar):
 *                pli / fir (pedidos de keyframe), nack / nack_pkts (pedidos de retransmisión y paquetes pedidos),
 *                rr (reports), loss_pct (mayor pérdida reportada sobre nuestro video, %), lost (pérdida acumulada
 *                reportada), remb_kbps (estimación de ancho de banda del server)
 */
import type { Logger } from "../log/logger";

export const STATS_INTERVAL_MS = 5_000;
/** Sin cuadros por más que esto, se considera que esa pista está parada. */
const IDLE_MS = 1_000;

interface Track {
  sent: number;
  dropped: number;
  mediaMs: number;
  lastAt: number | null;
}

export interface StreamStats {
  /** Escribe una línea ya (el timer lo llama cada `intervalMs`). */
  report(): void;
  /** Escribe la última línea (`state` = por qué terminó) y deja de mirar. Idempotente. */
  stop(why: string): void;
}

/**
 * El número de op de un mensaje de texto, SIN parsearlo: el identify del stream lleva el token y no hace falta
 * materializar nada del payload. La librería y Discord mandan `{"op":N,…}` (a veces con `"seq":M` antes); se mira
 * solo esa clave al principio, con una expresión anclada. Cualquier otra forma cuenta como "?" (nunca se adivina el
 * op desde adentro del payload).
 */
const LEADING_OP = /^\s*\{\s*(?:"seq"\s*:\s*\d{1,10}\s*,\s*)?"op"\s*:\s*(\d{1,4})\s*[,}]/;

function opOf(data: unknown, binaryOpAt: number): string | null {
  try {
    if (typeof data === "string") return LEADING_OP.exec(data)?.[1] ?? "?";
    const bytes =
      data instanceof ArrayBuffer ? new Uint8Array(data) : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : null;
    if (!bytes || bytes.length <= binaryOpAt) return null;
    return `b${bytes[binaryOpAt]}`;
  } catch {
    return null;
  }
}

/** Un valor del op 4 que puede ir al log: corto y sin espacios ni nada libre (si no, "?"). */
const SAFE_VALUE = /^[A-Za-z0-9_.-]{1,40}$/;
const safeValue = (v: unknown): string => (typeof v === "string" && SAFE_VALUE.test(v) ? v : "?");

/**
 * Lo negociado en el select protocol ack (op 4), para el log: "códec de video/códec de audio/v<DAVE>/modo". Solo esos
 * cuatro campos; nunca la SDP, claves ni ids.
 */
export function negotiatedOf(d: unknown): string {
  const o = (d && typeof d === "object" ? d : {}) as Record<string, unknown>;
  const dave = typeof o.dave_protocol_version === "number" && Number.isInteger(o.dave_protocol_version) ? o.dave_protocol_version : "?";
  return `${safeValue(o.video_codec)}/${safeValue(o.audio_codec)}/v${dave}/${safeValue(o.mode)}`;
}

/** Lo negociado en el op 4 de cada conexión del stream (lo anota `recordNegotiated`). */
const negotiatedBy = new WeakMap<object, string>();

/**
 * Envuelve `handleProtocolAck` de la StreamConnection de la librería para anotar lo negociado (`negotiatedOf`) antes de
 * que la librería lo procese. Nunca tira ni cambia lo que hace la librería.
 */
export function recordNegotiated(media: any): void {
  try {
    const original = media?.handleProtocolAck;
    if (typeof original !== "function") return;
    media.handleProtocolAck = function (this: unknown, d: unknown) {
      try {
        negotiatedBy.set(media, negotiatedOf(d));
      } catch {
        // el diagnóstico nunca frena el op 4
      }
      return original.call(this, d);
    };
  } catch {
    // conexión congelada: queda sin anotar
  }
}

/** Contadores de RTCP que llega por el track de video (lo que reportan Discord y los que miran). */
export interface RtcpCounts {
  pli: number;
  fir: number;
  /** Mensajes NACK y paquetes que piden (pid + los bits de blp). */
  nack: number;
  nack_pkts: number;
  /** Receiver/sender reports recibidos; loss_pct = mayor "fraction lost" (%) sobre NUESTRO video; lost = último acumulado. */
  rr: number;
  loss_pct: number;
  lost: number | null;
  /** Último REMB (estimación de ancho de banda del server) en kbps. */
  remb_kbps: number | null;
}

/**
 * Cuenta un paquete RTCP (compuesto o no): PLI y FIR (PSFB 206 FMT 1/4), NACK genérico (RTPFB 205 FMT 1), REMB (PSFB
 * FMT 15) y los report blocks de RR/SR (201/200) sobre `videoSsrc`. Solo números; lo que no entiende lo saltea.
 */
export function countRtcp(buf: Uint8Array, into: RtcpCounts, videoSsrc: number | null): void {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let off = 0;
  while (off + 4 <= buf.length) {
    if (buf[off]! >> 6 !== 2) return;
    const fmt = buf[off]! & 0x1f;
    const pt = buf[off + 1]!;
    const size = (view.getUint16(off + 2) + 1) * 4;
    if (off + size > buf.length) return;
    if (pt === 206 && fmt === 1) into.pli++;
    else if (pt === 206 && fmt === 4) into.fir++;
    else if (pt === 206 && fmt === 15 && size >= 20 && view.getUint32(off + 12) === 0x52454d42) {
      const exp = buf[off + 17]! >> 2;
      const mantissa = ((buf[off + 17]! & 3) << 16) | (buf[off + 18]! << 8) | buf[off + 19]!;
      into.remb_kbps = Math.round((mantissa * 2 ** exp) / 1000);
    } else if (pt === 205 && fmt === 1) {
      into.nack++;
      for (let f = off + 12; f + 4 <= off + size; f += 4) {
        let blp = view.getUint16(f + 2);
        let lost = 1;
        while (blp) {
          lost += blp & 1;
          blp >>= 1;
        }
        into.nack_pkts += lost;
      }
    } else if (pt === 201 || pt === 200) {
      into.rr++;
      const first = off + (pt === 200 ? 28 : 8);
      for (let b = 0; b < fmt; b++) {
        const at = first + b * 24;
        if (at + 24 > off + size) break;
        if (videoSsrc !== null && view.getUint32(at) !== videoSsrc >>> 0) continue;
        into.loss_pct = Math.max(into.loss_pct, Math.round((buf[at + 4]! * 100) / 256));
        into.lost = (buf[at + 5]! << 16) | (buf[at + 6]! << 8) | buf[at + 7]!;
      }
    }
    off += size;
  }
}

/** Tamaño de fragmento del H264RtpPacketizer de libdatachannel (payload RTP máximo medido: 1220 bytes). */
const RTP_FRAGMENT = 1220;
const START3 = Buffer.from([0, 0, 1]);

/**
 * Si el cuadro (Annex-B, como se lo pasa la librería a WebRTC, antes de DAVE) trae un IDR: sus bytes y los paquetes
 * RTP que ocupa (aprox.: uno por NAL chico, FU-A de 1218 bytes de datos para los grandes). Si no, null.
 */
export function keyframeInfo(frame: Uint8Array): { bytes: number; packets: number } | null {
  const b = Buffer.isBuffer(frame) ? frame : Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength);
  const starts: number[] = [];
  for (let i = b.indexOf(START3); i !== -1; i = b.indexOf(START3, i + 3)) starts.push(i + 3);
  let idr = false;
  let packets = 0;
  for (let k = 0; k < starts.length; k++) {
    const start = starts[k]!;
    let end = k + 1 < starts.length ? starts[k + 1]! - 3 : b.length;
    if (k + 1 < starts.length && end > start && b[end - 1] === 0) end--; // start code de 4 bytes
    const len = end - start;
    if (len <= 0) continue;
    if ((b[start]! & 0x1f) === 5) idr = true;
    packets += len <= RTP_FRAGMENT ? 1 : Math.ceil((len - 1) / (RTP_FRAGMENT - 2));
  }
  return idr ? { bytes: b.length, packets } : null;
}

export function watchStream(
  conn: any,
  deps: { log: Pick<Logger, "info">; now?: () => number; intervalMs?: number },
): StreamStats {
  const now = deps.now ?? (() => performance.now());
  const start = now();
  const video: Track = { sent: 0, dropped: 0, mediaMs: 0, lastAt: null };
  const audio: Track = { sent: 0, dropped: 0, mediaMs: 0, lastAt: null };
  let opsIn: Record<string, number> = {};
  let opsOut: Record<string, number> = {};
  const freshRtcp = (): RtcpCounts => ({ pli: 0, fir: 0, nack: 0, nack_pkts: 0, rr: 0, loss_pct: 0, lost: null, remb_kbps: null });
  let rtcp = freshRtcp();
  let hookedTrack: any = null;
  let lastKeyframe: { bytes: number; packets: number } | null = null;
  let keyframes = 0;
  let stopped = false;
  let wsSeen = 0;
  let hooked: any = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  /**
   * Algo del diagnóstico tiró (una forma inesperada de la librería): se apaga solo, con una línea en el log, y la
   * transmisión sigue. Nunca tira: en Bun una excepción en un interval o un rechazo sin manejar terminan el proceso.
   */
  const off = (error: unknown): void => {
    stopped = true;
    if (timer) clearInterval(timer);
    timer = null;
    try {
      deps.log.info("golive.stats", { state: "off", error_name: error instanceof Error ? error.name : "error" });
    } catch {
      // ni el log anda: no queda nada que hacer
    }
  };
  /** Corre `fn` y, si tira, apaga el diagnóstico. */
  const safe = (fn: () => void): void => {
    if (stopped) return;
    try {
      fn();
    } catch (error) {
      off(error);
    }
  };

  const wrap = (name: "sendVideoFrame" | "sendAudioFrame", track: Track): void => {
    const original = conn?.[name];
    if (typeof original !== "function") return;
    const packetizer = name === "sendVideoFrame" ? "_videoPacketizer" : "_audioPacketizer";
    conn[name] = function (this: unknown, ...args: unknown[]) {
      // Antes de llamar: la librería solo manda con el PeerConnection conectado y el packetizer armado; si no, lo
      // tira sin avisar. Contar nunca puede romper el envío.
      let drops = false;
      safe(() => {
        drops = conn.ready === false || (packetizer in conn && !conn[packetizer]);
      });
      const result = original.apply(this, args);
      // Solo cuenta si el original no tiró.
      safe(() => {
        if (drops) track.dropped++;
        else {
          if (name === "sendVideoFrame" && args[0] instanceof Uint8Array) {
            const kf = keyframeInfo(args[0]);
            if (kf) {
              lastKeyframe = kf;
              keyframes++;
            }
          }
          const frametime = Number(args[1]);
          track.sent++;
          track.mediaMs += Number.isFinite(frametime) ? frametime : 0;
          track.lastAt = now();
        }
      });
      return result;
    };
  };

  const count = (into: Record<string, number>, op: string | null): void => {
    if (op !== null) into[op] = (into[op] ?? 0) + 1;
  };

  /** Engancha el WS actual del stream (y el nuevo si la librería reconectó). */
  const hookWs = (): void => {
    const ws = conn?.mediaConnection?.ws;
    if (!ws || ws === hooked) return;
    hooked = ws;
    wsSeen++;
    // Entrante binario: seq (2 bytes) + op. Saliente binario: op primero.
    ws.addEventListener?.("message", (e: { data: unknown }) => {
      safe(() => {
        if (hooked === ws) count(opsIn, opOf(e?.data, 2));
      });
    });
    const send = ws.send;
    if (typeof send === "function") {
      ws.send = function (data: unknown) {
        safe(() => {
          if (hooked === ws) count(opsOut, opOf(data, 0));
        });
        return send.call(this, data);
      };
    }
  };

  /**
   * Engancha el track de video (y el nuevo si la librería rearmó la PeerConnection): lo que entra por ahí es el RTCP
   * de Discord (el emisor no recibe video). Solo se cuenta.
   */
  const hookTrack = (): void => {
    const t = conn?._videoTrack;
    if (!t || t === hookedTrack || typeof t.onMessage !== "function") return;
    hookedTrack = t;
    t.onMessage((m: Uint8Array) => {
      safe(() => {
        if (hookedTrack !== t) return;
        const ssrc = conn?.mediaConnection?.webRtcParams?.videoSsrc;
        countRtcp(m, rtcp, typeof ssrc === "number" ? ssrc : null);
      });
    });
  };

  const idle = (t: Track, at: number): number | null => (t.lastAt === null ? null : Math.round(at - t.lastAt));

  const line = (state?: string): void => {
    hookWs();
    hookTrack();
    const at = now();
    const vIdle = idle(video, at);
    const aIdle = idle(audio, at);
    const vStill = vIdle === null || vIdle > IDLE_MS;
    const aStill = aIdle === null || aIdle > IDLE_MS;
    const waiting =
      vIdle === null && aIdle === null ? "none-yet" : vStill && aStill ? "both" : vStill && aIdle !== null ? "video" : aStill && audio.sent > 0 ? "audio" : "no";
    let rtc: string | null = null;
    try {
      const s = conn?.webRtcConn?.state?.();
      rtc = typeof s === "string" ? s : null;
    } catch {
      rtc = null;
    }
    const media = conn?.mediaConnection;
    const daveV = media?._daveProtocolVersion;
    const msg = {
      s: Math.round((at - start) / 1000),
      v: video.sent,
      vd: video.dropped,
      v_ms: Math.round(video.mediaMs),
      v_idle_ms: vIdle,
      a: audio.sent,
      ad: audio.dropped,
      a_ms: Math.round(audio.mediaMs),
      a_idle_ms: aIdle,
      waiting,
      rtc,
      dave: media?.daveReady ? 1 : 0,
      dave_v: typeof daveV === "number" ? daveV : null,
      in: opsIn,
      out: opsOut,
      ws: wsSeen,
      neg: (media && typeof media === "object" && negotiatedBy.get(media)) || "-",
      codec: typeof conn?._videoCodec === "string" ? conn._videoCodec : null,
      kf: lastKeyframe ? `${lastKeyframe.bytes}/${lastKeyframe.packets}` : null,
      kfs: keyframes,
      rtcp: hookedTrack ? rtcp : null,
    };
    opsIn = {};
    opsOut = {};
    keyframes = 0;
    rtcp = { ...freshRtcp(), lost: rtcp.lost, remb_kbps: rtcp.remb_kbps };
    deps.log.info("golive.stats", { ...(state ? { state } : {}), msg: JSON.stringify(msg) });
  };

  // Si engancharse falla (conexión congelada, propiedad de solo lectura), el diagnóstico queda apagado desde el arranque.
  safe(() => {
    wrap("sendVideoFrame", video);
    wrap("sendAudioFrame", audio);
    hookWs();
    hookTrack();
  });

  const intervalMs = deps.intervalMs ?? STATS_INTERVAL_MS;
  if (!stopped && intervalMs > 0) {
    timer = setInterval(() => safe(() => line()), intervalMs);
    (timer as { unref?: () => void }).unref?.();
  }

  return {
    report(): void {
      safe(() => line());
    },
    stop(why: string): void {
      if (stopped) return;
      try {
        line(why);
      } catch {
        // la última línea no salió: igual se apaga
      }
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
