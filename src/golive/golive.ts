/**
 * Go Live (transmitir pantalla) atado a la voz viva: una transmisión a la vez, por nuestro gateway (ops 18/19/22
 * y los STREAM_*), con el session_id de NUESTRA voz. Se corta sola si salís de la voz, cambiás de canal, se cae
 * el gateway o vuelve con una sesión nueva, Discord la borra (STREAM_DELETE) o se corta la captura.
 */
import { log } from "../log/logger";
import type { Store } from "../store/store";
import type { StreamState } from "../store/types";
import {
  QUALITY,
  defaultCaptureEnv,
  listMonitors as listHyprMonitors,
  pickBackend,
  pickEncoder as pickEncoderDefault,
  startCapture as startCaptureDefault,
  type CaptureEnv,
  type CaptureHandle,
  type Monitor,
} from "./capture";
import { probeDesktopAudio } from "./desktop-audio";
import { GRIM_SLOW, STREAM_ERRORS, streamCloseMessage, streamDeleteMessage } from "./errors";
import { createGoLiveShim, loadGoLiveLib, streamKeyFor, type GoLiveLib, type GoLiveShim } from "./shim";
import { watchStream, type StreamStats } from "./stats";

export interface GoLiveGateway {
  send(op: number, d: unknown): void;
  on(ev: "dispatch", fn: (t: string, d: any) => void): () => void;
  on(ev: "status", fn: (status: string) => void): () => void;
  on(ev: "session", fn: (kind: "identified" | "resumed") => void): () => void;
}

export interface GoLive {
  start(monitor?: string | null): Promise<void>;
  stop(): Promise<void>;
  toggle(): Promise<void>;
  listMonitors(): Promise<Monitor[]>;
  dispose(): void;
}

/** Un error con un mensaje ya listo para mostrar. */
class GoLiveError extends Error {}

/** Tiempo máximo entre el op 18 y que el WS del stream quede listo (select_protocol_ack). */
const CREATE_TIMEOUT_MS = 15_000;

interface Active {
  guildId: string;
  channelId: string;
  key: string;
  abort: AbortController;
  // Referencias que se guardan mientras dura el stream: Bun junta con el GC los Track/PeerConnection sin
  // referencia JS y deja de mandar (spike, webrtc-loopback.ts).
  shim: GoLiveShim | null;
  capture: CaptureHandle | null;
  conn: unknown;
  /** Diagnóstico al log cada ~5 s mientras el stream está listo (stats.ts). */
  stats: StreamStats | null;
}

export function createGoLive(deps: {
  store: Store;
  gateway: GoLiveGateway;
  loadLib?: () => Promise<GoLiveLib>;
  env?: CaptureEnv;
  startCapture?: typeof startCaptureDefault;
  pickEncoder?: (env: CaptureEnv) => Promise<"nvenc" | "vaapi" | "x264">;
  createTimeoutMs?: number;
  /**
   * Mandar el audio de la PC con la transmisión. Apagado salvo `ZCORD_GOLIVE_AUDIO=1`: con audio, Discord cierra
   * el stream a los 30 s (4006, "la sesión de la transmisión ya no es válida"; visto el 2026-11-16 en todas las
   * transmisiones). Sin esto la transmisión es solo video, como antes de que existiera el audio.
   */
  desktopAudio?: boolean;
  /** Diagnóstico de la transmisión (inyectable para los tests). */
  stats?: (conn: unknown) => StreamStats;
}): GoLive {
  const { store, gateway } = deps;
  const env = deps.env ?? defaultCaptureEnv;
  const startCapture = deps.startCapture ?? startCaptureDefault;
  const pickEncoder = deps.pickEncoder ?? ((e: CaptureEnv) => pickEncoderDefault(e));
  const loadLib = deps.loadLib ?? loadGoLiveLib;
  const desktopAudio = deps.desktopAudio ?? process.env.ZCORD_GOLIVE_AUDIO === "1";
  const makeStats = deps.stats ?? ((conn: unknown) => watchStream(conn, { log }));

  /** El diagnóstico nunca corta ni frena la transmisión: si tira, se sigue sin él. */
  function startStats(conn: unknown): StreamStats | null {
    try {
      return makeStats(conn);
    } catch (error) {
      log.warn("golive.stats", { state: "off", error_name: error instanceof Error ? error.name : "error" });
      return null;
    }
  }

  /** Última línea del diagnóstico (antes de cerrar la conexión, para que todavía vea su estado). Nunca tira. */
  function stopStats(a: Active, why: string): void {
    const stats = a.stats;
    a.stats = null;
    try {
      stats?.stop(why);
    } catch {
      // el diagnóstico falló al terminar: lo esencial sigue igual
    }
  }
  let lib: GoLiveLib | null = null;
  let active: Active | null = null;
  let stopping: Promise<void> = Promise.resolve();
  /** guildId → session_id de nuestra voz (del VOICE_STATE_UPDATE propio). */
  const voiceSessions = new Map<string, string>();

  const meId = (): string | null => store.getState().me?.id ?? null;
  const setStream = (patch: Partial<StreamState>): void => store.dispatch({ type: "voice/stream", patch });

  function notice(text: string, level: "info" | "warn" | "error" = "warn", key = "golive"): void {
    store.dispatch({ type: "notice/push", key, level, text });
  }

  /** La transmisión sigue solo con video: queda en el log y en un aviso (aparte del de grim). */
  function videoOnly(text: string, why: string): void {
    log.warn("golive.no-audio", { state: why });
    notice(text, "info", "golive-audio");
  }

  function finish(a: Active, error: string | null): Promise<void> {
    if (active !== a) return stopping;
    active = null;
    a.abort.abort();
    stopStats(a, error ? "error" : "idle");
    a.shim?.destroy(); // op 19 si llegó a mandar el op 18
    a.shim = null;
    a.conn = null;
    setStream({ status: error ? "error" : "idle", error, viewers: undefined, viewerIds: undefined, desktopAudio: undefined });
    if (error) {
      log.warn("golive.stopped", { state: "error", msg: error.slice(0, 120) });
      notice(error);
    } else log.info("golive.stopped", { state: "idle" });
    const capture = a.capture;
    a.capture = null;
    stopping = (capture ? capture.stop() : Promise.resolve()).catch(() => {});
    return stopping;
  }

  function failCurrent(error: string): void {
    if (active) void finish(active, error);
  }

  function errorText(error: unknown): string {
    if (error instanceof GoLiveError) return error.message;
    if (error instanceof Error && /No video stream/i.test(error.message)) return STREAM_ERRORS.captureEnded;
    return `no se pudo transmitir (${error instanceof Error ? error.name : "error"})`;
  }

  /**
   * createStream() con timeout, corte por abort y aviso de "en vivo" + vigilancia del WS del stream. Una sola vez
   * por transmisión: con audio se pide antes (mientras se prueba la captura) y playStream recibe el mismo.
   */
  function wrapCreateStream(a: Active, streamer: any): void {
    const original = streamer.createStream.bind(streamer);
    let created: Promise<unknown> | null = null;
    streamer.createStream = (): Promise<unknown> =>
      (created ??= new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new GoLiveError(STREAM_ERRORS.noResponse)), deps.createTimeoutMs ?? CREATE_TIMEOUT_MS);
        a.abort.signal.addEventListener("abort", () => (clearTimeout(timer), reject(new GoLiveError("cortado"))), { once: true });
        Promise.resolve()
          .then(() => original())
          .then(
            (conn: any) => {
              clearTimeout(timer);
              if (active !== a) return reject(new GoLiveError("cortado"));
              a.conn = conn;
              a.stats = startStats(conn);
              const ws = conn?.mediaConnection?.ws;
              ws?.addEventListener?.("close", (e: { code: number; reason?: string }) => {
                const message = streamCloseMessage(e.code);
                log.warn("golive.ws-closed", { close_code: e.code, msg: String(e.reason ?? "").slice(0, 80) });
                if (active === a) stopStats(a, `ws-${e.code}`);
                if (message && active === a) void finish(a, message);
              });
              setStream({ status: "live" });
              log.info("golive.live");
              resolve(conn);
            },
            (error: unknown) => {
              clearTimeout(timer);
              reject(error);
            },
          );
      }));
  }

  async function startNow(monitorArg?: string | null): Promise<void> {
    await stopping;
    if (active) return;
    const state = store.getState();
    const v = state.voice;
    const me = meId();
    if (v.channelId === null || v.guildId === null || v.status !== "connected" || !me) {
      notice(STREAM_ERRORS.notInVoice, "info");
      return;
    }
    const quality = QUALITY[state.settings.streamQuality] ?? QUALITY["720p30"];
    const a: Active = {
      guildId: v.guildId,
      channelId: v.channelId,
      key: streamKeyFor(v.guildId, v.channelId, me),
      abort: new AbortController(),
      shim: null,
      capture: null,
      conn: null,
      stats: null,
    };
    active = a;
    setStream({ status: "starting", monitor: monitorArg ?? null, error: null, viewers: undefined, viewerIds: undefined, desktopAudio: undefined });
    const monitor = monitorArg ?? (await defaultMonitor(state.settings.streamMonitor));
    if (active !== a) return;
    if (monitor) setStream({ monitor });

    const backend = pickBackend(env.which);
    if (!backend) return void finish(a, STREAM_ERRORS.noCapture);
    const sessionId = voiceSessions.get(a.guildId);
    if (!sessionId) return void finish(a, STREAM_ERRORS.noSession);

    try {
      lib ??= await loadLib();
    } catch (error) {
      log.error("golive.lib-failed", { error_name: error instanceof Error ? error.name : "unknown" });
      return void finish(a, STREAM_ERRORS.libFailed);
    }
    const encoder = await pickEncoder(env).catch(() => "x264" as const);
    if (active !== a) return;
    // El audio de la PC solo con wf-recorder: grim va a ~10 fps irregulares y ffmpeg frenaría el audio.
    let audio = desktopAudio && backend === "wf-recorder" && (await probeDesktopAudio(env).catch(() => false));
    if (active !== a) return;
    if (desktopAudio) {
      if (backend === "grim") videoOnly(STREAM_ERRORS.noDesktopAudioGrim, "grim");
      else if (!audio) videoOnly(STREAM_ERRORS.noDesktopAudio, "no-pipewire");
    }

    const shim = createGoLiveShim({ gateway, meId: me, lib });
    a.shim = shim;
    shim.attachVoice(a.guildId, a.channelId, sessionId);
    wrapCreateStream(a, shim.streamer);

    let capture: CaptureHandle;
    try {
      capture = startCapture({ backend, encoder, monitor, quality, env, audio });
    } catch (error) {
      if (!audio) return void finish(a, STREAM_ERRORS.captureEnded);
      log.warn("golive.audio-failed", { error_name: error instanceof Error ? error.name : "error" });
      videoOnly(STREAM_ERRORS.noDesktopAudio, "audio-failed");
      audio = false;
      try {
        capture = startCapture({ backend, encoder, monitor, quality, env });
      } catch {
        return void finish(a, STREAM_ERRORS.captureEnded);
      }
    }
    a.capture = capture;
    if (audio) {
      // Mientras Discord arma el stream, se prueba el audio: si pw-record o ffmpeg mueren en los primeros
      // segundos, o no sale video, se vuelve a capturar solo con video (la transmisión no se corta por el audio).
      shim.streamer.createStream().catch(() => {});
      const ok = await capture.audioReady.catch(() => false);
      if (active !== a) return;
      if (!ok) {
        videoOnly(STREAM_ERRORS.noDesktopAudio, "audio-early-exit");
        a.capture = null;
        await capture.stop().catch(() => {});
        if (active !== a) return;
        audio = false;
        try {
          capture = startCapture({ backend, encoder, monitor, quality, env });
        } catch {
          return void finish(a, STREAM_ERRORS.captureEnded);
        }
        a.capture = capture;
      }
    }
    setStream({ desktopAudio: audio });
    log.info("golive.start", { mode: `${backend}/${encoder}${audio ? "+audio" : ""}`, state: state.settings.streamQuality });
    if (backend === "grim") notice(GRIM_SLOW, "info");
    void capture.ended.then(() => {
      if (active === a) void finish(a, STREAM_ERRORS.captureEnded);
    });

    lib
      .playStream(capture.output, shim.streamer, { type: "go-live", format: "nut" }, a.abort.signal)
      .then(
        () => {
          if (active === a) void finish(a, STREAM_ERRORS.captureEnded);
        },
        (error: unknown) => {
          if (active === a && !a.abort.signal.aborted) void finish(a, errorText(error));
        },
      );
  }

  /**
   * Sin monitor elegido: el de settings si sigue conectado, si no el enfocado, si no el primero. Nunca "" con
   * varios monitores: wf-recorder sin `-o` pregunta por la terminal cuál grabar.
   */
  async function defaultMonitor(saved: string | null): Promise<string> {
    const monitors = await listHyprMonitors(env).catch(() => []);
    if (saved && monitors.some((m) => m.name === saved)) return saved;
    return (monitors.find((m) => m.focused) ?? monitors[0])?.name ?? "";
  }

  function viewersOf(d: any): string[] | undefined {
    if (!Array.isArray(d?.viewer_ids)) return undefined;
    const me = meId();
    return d.viewer_ids.filter((id: unknown): id is string => typeof id === "string" && id !== me);
  }

  gateway.on("dispatch", (t, d) => {
    if (t === "VOICE_STATE_UPDATE") {
      if (!d || d.user_id !== meId() || typeof d.guild_id !== "string") return;
      if (typeof d.session_id === "string" && typeof d.channel_id === "string") voiceSessions.set(d.guild_id, d.session_id);
      else if (d.channel_id === null) voiceSessions.delete(d.guild_id);
      return;
    }
    if (!t.startsWith("STREAM_") || !active || d?.stream_key !== active.key) return;
    if (t === "STREAM_CREATE" || t === "STREAM_UPDATE") {
      const viewerIds = viewersOf(d);
      if (viewerIds !== undefined) setStream({ viewers: viewerIds.length, viewerIds });
    } else if (t === "STREAM_DELETE") {
      log.info("golive.deleted", { state: typeof d?.reason === "string" ? d.reason.slice(0, 40) : "none" });
      void finish(active, streamDeleteMessage(d?.reason));
    }
  });

  gateway.on("status", (status) => {
    if (status === "disconnected") failCurrent(STREAM_ERRORS.gatewayLost);
  });

  gateway.on("session", (kind) => {
    if (kind === "identified") {
      voiceSessions.clear();
      failCurrent(STREAM_ERRORS.newSession);
    }
  });

  // Saliste de la voz, te movieron o se cayó: el stream no sobrevive sin su llamada.
  const offStore = store.subscribe(() => {
    const a = active;
    if (!a) return;
    const v = store.getState().voice;
    if (v.channelId !== a.channelId || v.guildId !== a.guildId || v.status === "idle" || v.status === "error") {
      void finish(a, STREAM_ERRORS.leftVoice);
    }
  });

  const stop = (): Promise<void> => (active ? finish(active, null) : stopping);

  return {
    start: (monitor) => startNow(monitor),
    stop,
    toggle(): Promise<void> {
      return active ? stop() : startNow();
    },
    listMonitors: () => listHyprMonitors(env),
    dispose(): void {
      offStore();
      void stop();
    },
  };
}
