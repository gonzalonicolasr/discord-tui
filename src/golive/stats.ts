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
 *   vd / ad      los que la librería tiró sin mandar porque WebRTC no estaba conectado (`ready` false)
 *   v_ms / a_ms  reloj de medios: suma de las duraciones de lo enviado (lo mismo que avanza el timestamp RTP;
 *                es el último pts relativo al primero)
 *   v_idle_ms / a_idle_ms  ms desde el último cuadro / paquete (null si todavía no hubo)
 *   waiting      "video" = el audio sigue y el video no (la librería frena el video esperando al audio);
 *                "audio" = al revés; "both" = no sale nada; "no"; "none-yet" = todavía no salió nada
 *   rtc          estado del PeerConnection (connected, connecting, closed…)
 *   dave / dave_v  DAVE listo (1/0) y versión del protocolo negociada
 *   in / out     ops del WS del stream desde la línea anterior ({"6":2} = dos op 6; "b25" = binario op 25)
 *   ws           cuántos WS del stream se vieron (más de 1 = la librería reconectó)
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

function opOf(data: unknown, binaryOpAt: number): string | null {
  try {
    if (typeof data === "string") {
      const op = JSON.parse(data)?.op;
      return typeof op === "number" ? String(op) : null;
    }
    const bytes =
      data instanceof ArrayBuffer ? new Uint8Array(data) : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : null;
    if (!bytes || bytes.length <= binaryOpAt) return null;
    return `b${bytes[binaryOpAt]}`;
  } catch {
    return null;
  }
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
    conn[name] = function (frame: unknown, frametime: number) {
      // Contar nunca puede romper el envío de la librería.
      safe(() => {
        // La librería manda solo con el PeerConnection conectado; si no, lo tira sin avisar.
        if (conn.ready === false) track.dropped++;
        else {
          track.sent++;
          track.mediaMs += Number.isFinite(frametime) ? frametime : 0;
          track.lastAt = now();
        }
      });
      return original.call(this, frame, frametime);
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

  const idle = (t: Track, at: number): number | null => (t.lastAt === null ? null : Math.round(at - t.lastAt));

  const line = (state?: string): void => {
    hookWs();
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
    };
    opsIn = {};
    opsOut = {};
    deps.log.info("golive.stats", { ...(state ? { state } : {}), msg: JSON.stringify(msg) });
  };

  // Si engancharse falla (conexión congelada, propiedad de solo lectura), el diagnóstico queda apagado desde el arranque.
  safe(() => {
    wrap("sendVideoFrame", video);
    wrap("sendAudioFrame", audio);
    hookWs();
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
