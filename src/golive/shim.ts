/**
 * `Streamer` de @dank074/discord-video-stream SIN su Client selfbot, sobre NUESTRO gateway, y SIN abrir su
 * propia conexión de voz principal (la de @discordjs/voice ya está conectada y Discord permite una sola por
 * cuenta). Probado en el spike del 2026-11-08 (docs/protocol-notes.md, "Transmitir pantalla").
 *
 * Lo que `Streamer` le pide al client (src/client/Streamer.ts 7.0.0):
 *   - client.on("raw", ({t, d}))    → reemite dispatches por nombre (STREAM_CREATE…)
 *   - client.ws.broadcast({op, d}) → manda ops por el gateway: dejamos pasar solo 18/19/22
 *   - client.user.id               → nuestro user id
 *   - client.token / client.guilds → SOLO setStreamPreview (miniatura): no lo usamos, y el token nunca se le da
 *
 * `createStream()` solo lee de `voiceConnection`: guildId, channelId, session_id, type, botId. Se le inyecta un
 * VoiceConnection "dormido" con el session_id de NUESTRA voz (el del VOICE_STATE_UPDATE propio) que nunca recibe
 * setTokens(), así que nunca abre el WS de voz principal. Nunca se llama `joinVoice()` (abriría una segunda
 * conexión de voz y mandaría un op 4 con self_deaf:true). La librería abre solo el WS del stream.
 *
 * Además, a cada StreamConnection que arma `createStream()`:
 *   - su oferta declara el SSRC de video que asignó Discord (op 2) con `a=ssrc:`. Con dos m-lines (audio + video) y
 *     sin `a=ssrc` local, libdatachannel no sabe a qué track va el RTCP que manda Discord (PLI, NACK, reports) y lo
 *     tira: el RtcpNackResponder de la librería nunca veía un NACK (medido en loopback: 0 de 4 contra 4 de 4).
 *   - se anota lo negociado en el op 4 para golive.stats (stats.ts, `recordNegotiated`).
 */
import { recordNegotiated } from "./stats";


/** Lo que usamos de la librería; se carga a pedido (importarla arrastra node-av y sharp). */
export interface GoLiveLib {
  Streamer: new (client: any) => any;
  VoiceConnection: new (streamer: any, guildId: string | null, botId: string, channelId: string, callback: (c: any) => void) => any;
  playStream(input: unknown, streamer: any, options: { type: "go-live"; format: "nut" }, signal?: AbortSignal): Promise<void>;
}

/**
 * Carga la librería. Bajo Bun nunca importa `zeromq` (que tira abajo Bun: oven-sh/bun#18546): la librería solo
 * lo hace si `!isBun()`, para el volumen en vivo del audio, que no usamos.
 */
export async function loadGoLiveLib(): Promise<GoLiveLib> {
  // La librería loguea con `debug-level` a stderr en nivel INFO por defecto ("Found video stream…"): en la
  // TUI eso ensucia la pantalla. Cada logger lee DEBUG_LEVEL al crearse; los subprocesos usan env limpio.
  process.env.DEBUG_LEVEL = "OFF";
  const mod: any = await import("@dank074/discord-video-stream");
  return { Streamer: mod.Streamer, VoiceConnection: mod.VoiceConnection, playStream: mod.playStream };
}

/** Lo mínimo de nuestro `Gateway` (src/gateway/connection.ts). */
export interface ShimGateway {
  send(op: number, d: unknown): void;
  on(ev: "dispatch", fn: (t: string, d: any) => void): () => void;
}

/** Ops del gateway que manejan las transmisiones. El op 4 NO pasa: lo manda nuestra voz. */
export const STREAM_OPS = { STREAM_CREATE: 18, STREAM_DELETE: 19, STREAM_SET_PAUSED: 22 } as const;
const ALLOWED_OPS = new Set<number>(Object.values(STREAM_OPS));

export function streamKeyFor(guildId: string | null, channelId: string, userId: string): string {
  return guildId ? `guild:${guildId}:${channelId}:${userId}` : `call:${channelId}:${userId}`;
}

export interface GoLiveShim {
  readonly streamer: any;
  /** Ops que la librería intentó mandar y bloqueamos (para tests y diagnóstico). */
  readonly blocked: number[];
  attachVoice(guildId: string | null, channelId: string, sessionId: string): void;
  /** Corta el stream (op 19 si hubo op 18) y suelta todo. Idempotente. */
  destroy(): void;
}

export function createGoLiveShim(deps: { gateway: ShimGateway; meId: string; lib: GoLiveLib }): GoLiveShim {
  const rawListeners = new Set<(p: { t: string; d: unknown }) => void>();
  const off = deps.gateway.on("dispatch", (t, d) => {
    if (!t.startsWith("STREAM_")) return; // la librería no ve nada más del gateway
    for (const fn of [...rawListeners]) fn({ t, d });
  });
  const blocked: number[] = [];
  let destroyed = false;

  const fakeClient = {
    user: { id: deps.meId },
    token: undefined,
    on(ev: string, fn: (p: { t: string; d: unknown }) => void) {
      if (ev === "raw") rawListeners.add(fn);
      return fakeClient;
    },
    ws: {
      broadcast(payload: { op: number; d: unknown }) {
        if (destroyed && payload.op !== STREAM_OPS.STREAM_DELETE) return;
        if (!ALLOWED_OPS.has(payload.op)) {
          blocked.push(payload.op);
          return;
        }
        deps.gateway.send(payload.op, payload.d);
      },
    },
  };

  const streamer = new deps.lib.Streamer(fakeClient);
  const createStream = streamer.createStream.bind(streamer);
  streamer.createStream = (): Promise<unknown> => {
    const created = createStream();
    // La StreamConnection se arma de forma sincrónica adentro de createStream(); el WS abre recién con los STREAM_*.
    const media = streamer.voiceConnection?.streamConnection;
    if (media) {
      declareVideoSsrc(media);
      recordNegotiated(media);
    }
    return created;
  };

  return {
    streamer,
    blocked,
    attachVoice(guildId, channelId, sessionId) {
      const vc = new deps.lib.VoiceConnection(streamer, guildId, deps.meId, channelId, () => {});
      vc.session_id = sessionId; // a propósito sin setSession()/setTokens(): no conecta
      streamer._voiceConnection = vc;
    },
    destroy() {
      if (destroyed) return;
      try {
        streamer.stopStream();
      } catch {
        // el WS del stream ya estaba cerrado
      }
      destroyed = true;
      streamer._voiceConnection = undefined;
      off();
      rawListeners.clear();
    },
  };
}

/**
 * Antes de que la librería arme la PeerConnection (`initWebRtc`, después del op 2 que trae los SSRC), agrega el SSRC
 * de video a su definición de video: sale como `a=ssrc:` en la oferta. Una sola vez (la definición se reusa si la
 * librería rearma la PeerConnection). Si la forma de la librería no es la esperada, no hace nada.
 */
export function declareVideoSsrc(media: any): void {
  const wrapper = media?._webRtcWrapper;
  const initWebRtc = wrapper?.initWebRtc;
  if (typeof initWebRtc !== "function") return;
  let declared = false;
  wrapper.initWebRtc = function (this: unknown, ...args: unknown[]) {
    try {
      const ssrc = media.webRtcParams?.videoSsrc;
      if (!declared && typeof ssrc === "number" && ssrc > 0 && typeof wrapper._videoDef?.addSSRC === "function") {
        wrapper._videoDef.addSSRC(ssrc, "zcord", "stream", "video");
        declared = true;
      }
    } catch {
      // sin a=ssrc: igual que antes
    }
    return initWebRtc.apply(this, args);
  };
}
