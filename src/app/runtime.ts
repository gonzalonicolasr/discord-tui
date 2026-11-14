import { createActions, type Actions } from "../actions";
import { createIdlePresence } from "../actions/presence";
import { createStatusSync } from "../actions/status-sync";
import type { Session } from "../auth/session";
import type { ClientProps } from "../client-props/props";
import { createGateway } from "../gateway/connection";
import { createHttp } from "../rest/http";
import { createRestClient } from "../rest/client";
import { log } from "../log/logger";
import { scheduleUpdateCheck, startUpdateChecks } from "./update-check";
import { imageCache } from "../images/cache";
import { frameCache } from "../images/frames";
import { avatarLoader } from "../images/avatar";
import { notify, notificationTitle, shouldNotify } from "../notify/notify";
import { attachSettingsPersistence } from "../settings/persist";
import type { Settings } from "../settings/settings";
import { selectMessages } from "../store/selectors";
import { createStore, type Store } from "../store/store";
import { createVoiceActions, type VoiceMedia } from "../actions/voice";
import { createGoLive, type GoLive } from "../golive/golive";
import { createStreamWatcher, type StreamWatcher } from "../watch/watch";
import { createVoiceAdapterCreator } from "../voice/adapter";
import { startCapture, startPlayback } from "../voice/audio-io";
import { createOpusCodec } from "../voice/opus";
import { createDjsVoiceSession, type VoiceSession } from "../voice/session";
import { createVad } from "../voice/vad";
import { listAudioDevices } from "../voice/devices";
import { attachVoiceSounds, peerCue } from "../sounds/events";
import { createSoundPlayer, type SoundPlayer } from "../sounds/player";

export interface RuntimeDeps {
  /** false: no buscar versión nueva en GitHub (tests). */
  checkUpdates?: boolean;
  /** Hay una versión nueva en GitHub (`sha` = FETCH_HEAD, o null): main decide si recarga solo (una vez por versión). */
  onUpdateAvailable?: (sha: string | null) => void;
  session: Session;
  me: { id: string; username: string };
  props: ClientProps;
  url?: string;
  WebSocketImpl?: typeof WebSocket;
  fetch?: typeof fetch;
  setTimer?: typeof setTimeout;
  random?: () => number;
  initialSettings?: Settings;
  settingsPath?: string;
  voiceSession?: VoiceSession;
  voiceMedia?: VoiceMedia;
  kittyKeyboard?: () => boolean;
  /** Go Live; por defecto el real (src/golive), atado a este gateway. */
  goLive?: (deps: { store: Store; gateway: ReturnType<typeof createGateway> }) => GoLive;
  /** Ver transmisiones de otros; por defecto el real (src/watch), atado a este gateway. */
  streamWatcher?: (deps: { store: Store; gateway: ReturnType<typeof createGateway> }) => StreamWatcher;
  /** Sonidos de eventos; por defecto los reales (pw-cat o el mixer de la llamada). */
  sounds?: SoundPlayer;
  /** Notificación de escritorio; por defecto `notify-send`. */
  notify?: (title: string, body: string) => void;
}

const defaultMedia: VoiceMedia = {
  startCapture,
  startPlayback,
  createCodec: () => createOpusCodec(),
  createVad: (opts) => createVad(opts),
  listAudioDevices: () => listAudioDevices(),
  createReferenceDecoder: () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Ctor = require("opusscript");
    const ref = new (Ctor.default ?? Ctor)(48_000, 2, 2049);
    return { decode: (opus: Uint8Array) => new Uint8Array(ref.decode(Buffer.from(opus))), destroy: () => ref.delete() };
  },
};

function debugLogEnabled(): boolean {
  const value = process.env.DISCORD_TUI_DEBUG;
  return value === "1" || value === "true";
}

export interface Runtime {
  store: Store;
  actions: Actions;
  start(): void;
  stop(): Promise<void>;
  onUnauthorized(fn: () => void): () => void;
  activity(): void;
}

export function createRuntime(deps: RuntimeDeps): Runtime {
  const store = createStore();
  const unauthorizedHandlers = new Set<() => void>();
  const notifyUnauthorized = (): void => {
    for (const handler of [...unauthorizedHandlers]) handler();
  };

  const http = createHttp({ props: deps.props, token: deps.session.token, fetch: deps.fetch });
  const rest = createRestClient({ http, onUnauthorized: notifyUnauthorized });
  const gateway = createGateway({
    token: deps.session.token,
    props: deps.props,
    url: deps.url,
    WebSocketImpl: deps.WebSocketImpl,
    setTimer: deps.setTimer,
    random: deps.random,
    presence: () => idle.current(),
  });
  const idle = createIdlePresence({
    gateway,
    settings: () => store.getState().settings,
    ready: () => gateway.status === "ready",
  });
  const voiceSession =
    deps.voiceSession ??
    createDjsVoiceSession({
      adapterCreator: createVoiceAdapterCreator({ gateway, meId: () => store.getState().me?.id ?? deps.me.id }),
      meId: () => store.getState().me?.id ?? deps.me.id,
      canSignal: () => gateway.status === "ready",
    });
  const stream = (deps.goLive ?? ((d) => createGoLive(d)))({ store, gateway });
  const watch = (deps.streamWatcher ?? ((d) => createStreamWatcher(d)))({ store, gateway });
  const media = deps.voiceMedia ?? defaultMedia;
  const voice = createVoiceActions({
    store,
    session: voiceSession,
    media,
    kittyKeyboard: deps.kittyKeyboard,
    stream,
    watch,
  });
  const sounds =
    deps.sounds ??
    createSoundPlayer({
      getSettings: () => store.getState().settings,
      isDeaf: () => store.getState().voice.selfDeaf,
      mixerSink: () => voice.soundSink?.() ?? null,
      startPlayback: (opts) => media.startPlayback(opts),
    });
  const detachSounds = attachVoiceSounds(store, (cue) => sounds.play(cue));
  const statusSync = createStatusSync({ store, rest, presence: idle });
  const actions = createActions({ store, rest, gateway, voice, fetch: deps.fetch, presence: idle, statusSync });
  store.dispatch({ type: "connection", status: gateway.status });

  if (deps.initialSettings) store.dispatch({ type: "settings/loaded", settings: deps.initialSettings });
  const detachSettings = attachSettingsPersistence(store, { path: deps.settingsPath });

  gateway.on("status", (status) => {
    store.dispatch({ type: "connection", status });
    if (status === "ready") voiceSession.gatewayReady?.();
  });
  gateway.on("dispatch", (t, d) => {
    if (t === "READY" && d && typeof d === "object" && debugLogEnabled()) {
      const firstGuild =
        (Array.isArray(d.guilds) ? d.guilds[0] : d.guilds && typeof d.guilds === "object" ? (() => { const k = Object.keys(d.guilds as object)[0]; return k !== undefined ? (d.guilds as any)[k] : undefined; })() : undefined);
      const firstChannel = firstGuild?.channels?.[0];
      log.info("ready.shape", {
        msg: JSON.stringify({
          dKeys: Object.keys(d).sort(),
          guildsType: Array.isArray(d.guilds) ? "array" : typeof d.guilds,
          guildKeys: firstGuild ? Object.keys(firstGuild).sort() : null,
          channelKeys: firstChannel ? Object.keys(firstChannel).sort() : null,
          hasGuildName: typeof firstGuild?.name,
          hasChannelName: typeof firstChannel?.name,
        }),
      });
    }
    const before = t === "VOICE_STATE_UPDATE" ? store.getState() : null;
    try {
      store.dispatch({ type: "gw", t, d });
    } catch (error) {
      log.error("store.dispatch-failed", { error_name: error instanceof Error ? error.name : "unknown", t });
      return;
    }
    if (before) {
      const cue = peerCue(before, store.getState());
      if (cue) sounds.play(cue);
    }
    if (t === "READY") statusSync.ready(d);
    if (t === "USER_SETTINGS_PROTO_UPDATE") statusSync.update(d);
    if (t === "MESSAGE_CREATE" && typeof d?.channel_id === "string" && typeof d?.id === "string") {
      const state = store.getState();
      const message = selectMessages(state, d.channel_id).find((candidate) => candidate.id === d.id);
      if (message && shouldNotify(state, message, state.ui.selectedChannelId)) {
        (deps.notify ?? notify)(notificationTitle(state, message), message.content.slice(0, 200));
        sounds.play("message");
      }
    }
  });

  let readySessions = 0;
  gateway.on("session", (kind) => {
    idle.sessionStarted(kind);
    if (kind === "resumed") return;
    readySessions += 1;
    if (readySessions === 1) return;

    store.dispatch({ type: "messages/staleAll" });
    store.dispatch({ type: "members/resetSubscriptions" });
    const open = store.getState().ui.selectedChannelId;
    if (open !== null) void actions.openChannel(open).catch(() => {});
  });

  gateway.on("fatal", (reason) => {
    store.dispatch({
      type: "notice/push",
      key: "identify-rejected",
      level: "error",
      text: "Discord rechazó la conexión (" + reason + "): puede que haya cambiado el protocolo. Revisá el log.",
    });
    notifyUnauthorized();
  });

  // ¿Versión nueva en GitHub? Un rato después de arrancar (sin apurar la conexión) y después cada 30 min. bin/zcord
  // la instala al recargar (sola si es seguro, o con Ctrl+R) o al próximo inicio.
  const stopUpdateChecks =
    deps.checkUpdates === false
      ? () => {}
      : startUpdateChecks(() => {
          void scheduleUpdateCheck((behind, sha) => {
            store.dispatch({
              type: "notice/push",
              key: "update-available",
              level: "warn",
              text: `Hay una versión nueva de zcord (${behind} cambio${behind === 1 ? "" : "s"}): Ctrl+R la instala y recarga (o se instala sola la próxima vez que lo abras).`,
            });
            deps.onUpdateAvailable?.(sha);
          });
        });

  const noticeSweep = setInterval(() => {
    const now = Date.now();
    store.dispatch({ type: "notice/sweep", now });
    store.dispatch({ type: "typing/sweep", now });
  }, 1000);
  noticeSweep.unref?.();

  // Memoria cada 60 s (solo números): para medir la app real y ver qué crece.
  const memLog = setInterval(() => {
    const mem = process.memoryUsage();
    const state = store.getState();
    let messages = 0;
    for (const slice of Object.values(state.messages)) messages += Object.keys(slice.byId).length;
    const mb = (n: number): number => Math.round(n / 104857.6) / 10;
    log.info("app.mem", {
      msg: JSON.stringify({ rss: mb(mem.rss), heap: mb(mem.heapUsed), images: mb(imageCache.bytes ?? 0), frames: mb(frameCache.bytes), avatars: mb(avatarLoader.bytes), messages, users: Object.keys(state.users).length }),
    });
  }, 60_000);
  memLog.unref?.();

  // Ack solo del canal abierto que estás mirando, con debounce (spec 7.8).
  let lastViewed = "";
  const offAck = store.subscribe(() => {
    const state = store.getState();
    const raw = state.ui.selectedChannelId;
    const channelId = raw !== null && state.channels[raw]?.type !== 4 ? raw : null;
    const newest = channelId === null ? null : state.messages[channelId]?.ids.at(-1) ?? null;
    const key = `${channelId}:${newest}`;
    if (key === lastViewed) return;
    lastViewed = key;
    actions.viewing?.(channelId, newest);
  });

  return {
    store,
    actions,
    start(): void {
      gateway.connect();
      idle.activity();
    },
    async stop(): Promise<void> {
      stopUpdateChecks();
      clearInterval(noticeSweep);
      clearInterval(memLog);
      offAck();
      detachSounds();
      idle.stop();
      if (store.getState().voice.channelId !== null) {
        await Promise.race([voice.leaveVoice(), new Promise((resolve) => setTimeout(resolve, 1_500))]);
      }
      // Por si quedó algo de la captura: no deja procesos huérfanos al salir.
      watch.dispose();
      stream.dispose();
      await Promise.race([stream.stop(), new Promise((resolve) => setTimeout(resolve, 2_000))]);
      await detachSettings();
      gateway.close();
    },
    activity(): void {
      idle.activity();
    },
    onUnauthorized(fn: () => void): () => void {
      unauthorizedHandlers.add(fn);
      return () => {
        unauthorizedHandlers.delete(fn);
      };
    },
  };
}
