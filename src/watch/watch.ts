/**
 * Ver la transmisión (Go Live) de otro, atada a la voz viva: una a la vez, por nuestro gateway (op 20 WATCH_STREAM,
 * op 19 para dejar de ver, STREAM_CREATE / STREAM_SERVER_UPDATE / STREAM_DELETE) con el session_id de NUESTRA voz.
 * Se corta sola si salís de la voz o cambiás de canal, el que transmite corta (STREAM_DELETE o su self_stream),
 * se cae el gateway o vuelve con una sesión nueva, o el WS del stream cierra sin poder reanudar.
 *
 * Los cuadros no pasan por el store (sería un render de Solid por cuadro): la vista se suscribe con `subscribe` y
 * recibe RGBA ya achicado a su caja. Sin suscriptores (vista oculta) no se decodifica nada; al volver se pide un
 * keyframe. Se decodifican todas las access units (H264 no deja saltear) y se escalan como mucho `maxFps` por segundo.
 */
import { log } from "../log/logger";
import { streamCloseMessage } from "../golive/errors";
import { streamKeyFor } from "../golive/shim";
import type { Store } from "../store/store";
import type { WatchState } from "../store/types";
import { displayName } from "../ui/format";
import { createH264Decoder, type DecodedFrame, type H264Decoder } from "./decode";
import { hasIdr, KEYFRAME_PATIENCE, KEYFRAME_RETRY } from "./h264";
import { createViewerConnection, loadViewerLib, type ViewerConnection, type ViewerEvents, type ViewerLib, type ViewerParams } from "./viewer";

export interface WatchGateway {
  send(op: number, d: unknown): void;
  on(ev: "dispatch", fn: (t: string, d: any) => void): () => void;
  on(ev: "status", fn: (status: string) => void): () => void;
  on(ev: "session", fn: (kind: "identified" | "resumed") => void): () => void;
}

export interface FrameSubscription {
  resize(width: number, height: number): void;
  unsubscribe(): void;
}

export interface StreamWatcher {
  watch(userId: string): Promise<void>;
  stop(): Promise<void>;
  /** Mirar si no mirás a esa persona; dejar de ver si ya la mirás. */
  toggle(userId: string): Promise<void>;
  /** Cuadros RGBA que entran en `width`×`height` px mientras dure la suscripción. */
  subscribe(width: number, height: number, onFrame: (frame: DecodedFrame) => void): FrameSubscription;
  dispose(): void;
}

export const WATCH_OPS = { WATCH_STREAM: 20, STREAM_DELETE: 19 } as const;

export const WATCH_ERRORS = {
  notInVoice: "entrá al canal de voz de quien transmite para verlo",
  notStreaming: "esa persona no está transmitiendo",
  self: "esa es tu transmisión",
  noSession: "todavía no tengo la sesión de voz: esperá a que conecte y probá de nuevo",
  noResponse: "Discord no respondió al pedido de ver la transmisión (tardó demasiado)",
  libFailed: "no pude cargar lo necesario para ver transmisiones",
  decoderFailed: "no pude abrir el decodificador de video",
  leftVoice: "saliste de la voz: se dejó de ver la transmisión",
  gatewayLost: "se perdió la conexión con Discord: se dejó de ver la transmisión",
  newSession: "Discord abrió una sesión nueva: se dejó de ver la transmisión",
} as const;

/** `reason` de un STREAM_DELETE de lo que mirás (docs.discord.food). null = corte normal pedido por nosotros. */
export function watchDeleteMessage(reason: unknown, name: string): { text: string; level: "info" | "warn" } | null {
  switch (reason) {
    case undefined:
    case null:
    case "user_requested":
    case "stream_ended":
      return { text: `${name} dejó de transmitir`, level: "info" };
    case "unauthorized":
      return { text: "no tenés permiso para ver esta transmisión", level: "warn" };
    case "stream_full":
      return { text: "la transmisión está llena (demasiada gente mirando)", level: "warn" };
    case "safety_guild_rate_limited":
      return { text: "Discord limitó las transmisiones en este servidor; probá más tarde", level: "warn" };
    case "parse_failed":
    case "invalid_channel":
      return { text: `Discord no aceptó el pedido de ver la transmisión (${reason})`, level: "warn" };
    default:
      return { text: `Discord cortó la transmisión (${typeof reason === "string" ? reason.slice(0, 40) : "sin motivo"})`, level: "warn" };
  }
}

/** Tiempo máximo entre el op 20 y tener STREAM_CREATE + STREAM_SERVER_UPDATE. */
const WATCH_TIMEOUT_MS = 15_000;
/** Access units esperando al decodificador: más que esto y se tira todo hasta el próximo keyframe. */
const MAX_QUEUE = 30;

interface Active {
  userId: string;
  guildId: string;
  channelId: string;
  key: string;
  name: string;
  timer: ReturnType<typeof setTimeout> | null;
  rtcServerId: string | null;
  server: { endpoint: string; token: string } | null;
  // Referencias vivas mientras dure (el GC de Bun junta Tracks/PeerConnection sin referencia JS).
  conn: ViewerConnection | null;
  deleted: boolean;
}

export function createStreamWatcher(deps: {
  store: Store;
  gateway: WatchGateway;
  loadLib?: () => Promise<ViewerLib>;
  connect?: (lib: ViewerLib, params: ViewerParams, events: ViewerEvents) => ViewerConnection;
  createDecoder?: (width: number, height: number) => Promise<H264Decoder>;
  timeoutMs?: number;
  maxFps?: number;
  now?: () => number;
}): StreamWatcher {
  const { store, gateway } = deps;
  const loadLib = deps.loadLib ?? loadViewerLib;
  const connect = deps.connect ?? createViewerConnection;
  const makeDecoder = deps.createDecoder ?? createH264Decoder;
  const now = deps.now ?? (() => performance.now());
  const frameGapMs = 1000 / (deps.maxFps ?? 12);
  let lib: ViewerLib | null = null;
  let active: Active | null = null;
  /** guildId → session_id de nuestra voz (del VOICE_STATE_UPDATE propio). */
  const voiceSessions = new Map<string, string>();

  // Decodificación (una sola, compartida por la vista que esté suscripta).
  const subscribers = new Set<(f: DecodedFrame) => void>();
  let box = { width: 640, height: 360 };
  let decoder: H264Decoder | null = null;
  let decoderOpening: Promise<H264Decoder | null> | null = null;
  let chain: Promise<void> = Promise.resolve();
  let queued = 0;
  let skipUntilKeyframe = true;
  let skippedSinceDrop = 0;
  let lastShown = -Infinity;

  const meId = (): string | null => store.getState().me?.id ?? null;
  const setWatch = (patch: Partial<WatchState>): void => store.dispatch({ type: "voice/watch", patch });
  const notice = (text: string, level: "info" | "warn" | "error" = "warn"): void =>
    store.dispatch({ type: "notice/push", key: "watch", level, text });

  function resetDecodeState(): void {
    skipUntilKeyframe = true;
    skippedSinceDrop = 0;
    lastShown = -Infinity;
  }

  function closeDecoder(): void {
    const d = decoder;
    decoder = null;
    decoderOpening = null;
    // Después de lo que esté decodificando.
    void chain.then(() => d?.close());
    resetDecodeState();
  }

  function finish(a: Active, message: { text: string; level: "info" | "warn" | "error" } | null): void {
    if (active !== a) return;
    active = null;
    if (a.timer) clearTimeout(a.timer);
    a.conn?.stop();
    a.conn = null;
    // Dejar de ver (op 19); si Discord ya la borró no hace falta.
    if (!a.deleted) gateway.send(WATCH_OPS.STREAM_DELETE, { stream_key: a.key });
    closeDecoder();
    const isError = message !== null && message.level !== "info";
    setWatch({ status: isError ? "error" : "idle", userId: isError ? a.userId : null, error: isError ? message!.text : null });
    if (message) notice(message.text, message.level);
    log.info("watch.stopped", { state: isError ? "error" : "idle" });
  }

  let decodedCounter: () => void = () => {};

  function onFrame(a: Active, au: Uint8Array): void {
    if (active !== a) return;
    if (store.getState().voice.watch.status === "connecting") setWatch({ status: "watching", error: null });
    if (subscribers.size === 0) {
      resetDecodeState(); // vista oculta: no se decodifica; al volver se espera un keyframe
      return;
    }
    if (skipUntilKeyframe) {
      // Después de tirar la cola: si el keyframe pedido no llega, se sigue igual (ver KEYFRAME_PATIENCE).
      // Sin decoder (vista recién vuelta) no hay de dónde seguir con P: solo se reintenta el keyframe.
      if (!hasIdr(au) && !(++skippedSinceDrop >= KEYFRAME_PATIENCE && decoder)) {
        if (skippedSinceDrop % KEYFRAME_RETRY === 0) a.conn?.requestKeyframe();
        return;
      }
      skipUntilKeyframe = false;
      skippedSinceDrop = 0;
    }
    if (queued >= MAX_QUEUE) {
      // El decodificador no da abasto: se tira la cola y se pide un keyframe.
      skipUntilKeyframe = true;
      a.conn?.requestKeyframe();
      return;
    }
    queued++;
    chain = chain
      .then(async () => {
        const dec = await ensureDecoder();
        if (!dec || active !== a) return;
        const want = now() - lastShown >= frameGapMs;
        const frame = await dec.decode(au, want);
        if (frame && active === a) {
          decodedCounter();
          lastShown = now();
          for (const fn of [...subscribers]) fn(frame);
        }
      })
      .catch(() => {})
      .finally(() => {
        queued--;
      });
  }

  function ensureDecoder(): Promise<H264Decoder | null> {
    if (decoder) return Promise.resolve(decoder);
    if (decoderOpening) return decoderOpening;
    // Si se cerró (closeDecoder) mientras abría, esta apertura ya no es la vigente: se descarta.
    const opening: Promise<H264Decoder | null> = makeDecoder(box.width, box.height).then(
      (d) => {
        if (decoderOpening !== opening) {
          d.close();
          return null;
        }
        decoder = d;
        return d;
      },
      () => {
        if (decoderOpening === opening && active) finish(active, { text: WATCH_ERRORS.decoderFailed, level: "error" });
        return null;
      },
    );
    decoderOpening = opening;
    return opening;
  }

  async function connectWhenReady(a: Active): Promise<void> {
    if (active !== a || a.conn || !a.rtcServerId || !a.server) return;
    if (a.timer) clearTimeout(a.timer);
    a.timer = null;
    const sessionId = voiceSessions.get(a.guildId);
    const me = meId();
    if (!sessionId || !me) return finish(a, { text: WATCH_ERRORS.noSession, level: "warn" });
    try {
      lib ??= await loadLib();
    } catch (error) {
      log.error("watch.lib-failed", { error_name: error instanceof Error ? error.name : "unknown" });
      return finish(a, { text: WATCH_ERRORS.libFailed, level: "error" });
    }
    if (active !== a || a.conn) return;
    resetDecodeState();
    a.conn = connect(
      lib,
      { guildId: a.guildId, channelId: a.channelId, meId: me, streamerId: a.userId, sessionId, rtcServerId: a.rtcServerId, streamKey: a.key, endpoint: a.server.endpoint, token: a.server.token },
      {
        onFrame: (au) => onFrame(a, au),
        onClose: (code) => {
          const text = streamCloseMessage(code);
          log.warn("watch.ws-closed", { close_code: code });
          if (text) finish(a, { text, level: "warn" });
        },
        onUnsupportedCodec: (codec) => finish(a, { text: `la transmisión usa ${codec.slice(0, 10)}; por ahora solo se puede ver H264`, level: "warn" }),
      },
    );
    log.info("watch.connecting");
    // Diagnóstico mientras se mira: cada 2 s, solo números y estados (para la primera prueba real).
    let decoded = 0;
    const diagTimer = setInterval(() => {
      if (active !== a || !a.conn) return clearInterval(diagTimer);
      const d = a.conn.diag?.() ?? {};
      log.info("watch.diag", { state: store.getState().voice.watch.status, count: decoded, msg: JSON.stringify(d).slice(0, 400) });
    }, 2_000);
    (diagTimer as { unref?: () => void }).unref?.();
    decodedCounter = () => decoded++;
  }

  async function watchNow(userId: string): Promise<void> {
    if (active?.userId === userId) return;
    if (active) finish(active, null);
    const state = store.getState();
    const v = state.voice;
    const me = meId();
    if (v.channelId === null || v.guildId === null || v.status !== "connected" || !me) return notice(WATCH_ERRORS.notInVoice, "info");
    if (userId === me) return notice(WATCH_ERRORS.self, "info");
    const theirs = v.states[v.guildId]?.[userId];
    if (!theirs || theirs.channelId !== v.channelId) return notice(WATCH_ERRORS.notInVoice, "info");
    if (!theirs.selfStream) return notice(WATCH_ERRORS.notStreaming, "info");
    if (!voiceSessions.has(v.guildId)) return notice(WATCH_ERRORS.noSession, "info");

    const a: Active = {
      userId,
      guildId: v.guildId,
      channelId: v.channelId,
      key: streamKeyFor(v.guildId, v.channelId, userId),
      name: displayName(state, userId, v.guildId),
      timer: null,
      rtcServerId: null,
      server: null,
      conn: null,
      deleted: false,
    };
    active = a;
    setWatch({ status: "connecting", userId, error: null });
    a.timer = setTimeout(() => finish(a, { text: WATCH_ERRORS.noResponse, level: "warn" }), deps.timeoutMs ?? WATCH_TIMEOUT_MS);
    gateway.send(WATCH_OPS.WATCH_STREAM, { stream_key: a.key });
    log.info("watch.start");
  }

  gateway.on("dispatch", (t, d) => {
    if (t === "VOICE_STATE_UPDATE") {
      if (!d || typeof d.guild_id !== "string") return;
      if (d.user_id === meId()) {
        if (typeof d.session_id === "string" && typeof d.channel_id === "string") voiceSessions.set(d.guild_id, d.session_id);
        else if (d.channel_id === null) voiceSessions.delete(d.guild_id);
        return;
      }
      const a = active;
      if (a && d.user_id === a.userId && (d.channel_id !== a.channelId || d.self_stream !== true)) {
        finish(a, { text: `${a.name} dejó de transmitir`, level: "info" });
      }
      return;
    }
    const a = active;
    if (!t.startsWith("STREAM_") || !a || d?.stream_key !== a.key) return;
    if (t === "STREAM_CREATE") {
      if (typeof d.rtc_server_id === "string") a.rtcServerId = d.rtc_server_id;
      void connectWhenReady(a);
    } else if (t === "STREAM_SERVER_UPDATE") {
      if (typeof d.endpoint !== "string" || typeof d.token !== "string") {
        // endpoint null: Discord reasigna el server; se espera al próximo.
        a.conn?.stop();
        a.conn = null;
        a.server = null;
        return;
      }
      const changed = a.server?.endpoint !== d.endpoint || a.server?.token !== d.token;
      a.server = { endpoint: d.endpoint, token: d.token };
      if (changed && a.conn) {
        a.conn.stop();
        a.conn = null;
      }
      void connectWhenReady(a);
    } else if (t === "STREAM_DELETE") {
      a.deleted = true;
      log.info("watch.deleted", { state: typeof d?.reason === "string" ? d.reason.slice(0, 40) : "none" });
      finish(a, watchDeleteMessage(d?.reason, a.name));
    }
  });

  gateway.on("status", (status) => {
    if (status === "disconnected" && active) finish(active, { text: WATCH_ERRORS.gatewayLost, level: "warn" });
  });

  gateway.on("session", (kind) => {
    if (kind !== "identified") return;
    voiceSessions.clear();
    if (active) {
      active.deleted = true; // la sesión vieja ya no existe: no hay a quién mandarle el op 19
      finish(active, { text: WATCH_ERRORS.newSession, level: "warn" });
    }
  });

  const offStore = store.subscribe(() => {
    const a = active;
    if (!a) return;
    const v = store.getState().voice;
    if (v.channelId !== a.channelId || v.guildId !== a.guildId || v.status === "idle" || v.status === "error") {
      finish(a, { text: WATCH_ERRORS.leftVoice, level: "info" });
    }
  });

  const stop = async (): Promise<void> => {
    if (active) finish(active, null);
    else if (store.getState().voice.watch.status === "error") setWatch({ status: "idle", userId: null, error: null });
  };

  return {
    watch: (userId) => watchNow(userId),
    stop,
    toggle: (userId) => (active?.userId === userId ? stop() : watchNow(userId)),
    subscribe(width, height, fn) {
      box = { width, height };
      decoder?.resize(width, height);
      subscribers.add(fn);
      resetDecodeState();
      active?.conn?.requestKeyframe();
      return {
        resize(w, h) {
          box = { width: w, height: h };
          decoder?.resize(w, h);
        },
        unsubscribe() {
          subscribers.delete(fn);
          if (subscribers.size === 0) closeDecoder();
        },
      };
    },
    dispose(): void {
      offStore();
      void stop();
    },
  };
}
