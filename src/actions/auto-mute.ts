import type { SystemIdleSource } from "../desktop/wayland-idle";
import { log } from "../log/logger";
import type { Store } from "../store/store";
import type { VoiceActions } from "./voice";

const NOTICE = "🔇 micrófono silenciado por inactividad";
const NOTICE_KEY = "voice-auto-mute";

/**
 * Silenciarse solo: con el mic abierto en una llamada, si Gon deja de usar la PC (teclado/mouse de todo el sistema,
 * no solo de zcord) `settings.autoMuteAfterMinutes` minutos o bloquea la pantalla, se cierra el mic con el mismo
 * camino que la tecla m (Discord lo ve), con notificación de escritorio y un aviso (hasta que abras el mic o salgas
 * de la llamada). Nunca lo vuelve a
 * abrir. Solo mira mientras estás en una llamada, con el ajuste prendido y sin push-to-talk.
 */
export function createAutoMute(deps: {
  store: Store;
  voice: Pick<VoiceActions, "toggleMute">;
  source: SystemIdleSource;
  notify: (title: string, body: string) => void;
}): { stop(): void } {
  const { store } = deps;
  let stopWatching: (() => void) | null = null;
  let watchingMinutes: number | null = null;

  function mute(reason: "idle" | "lock", minutes: number): void {
    const { settings, voice } = store.getState();
    if (settings.autoMuteAfterMinutes === null || settings.inputMode === "push_to_talk") return;
    if (voice.channelId === null || voice.selfMute || voice.selfDeaf) return;
    deps.voice.toggleMute();
    const why = reason === "lock" ? "bloqueaste la pantalla" : `llevabas ${minutes} min sin usar la PC`;
    store.dispatch({ type: "notice/push", key: NOTICE_KEY, level: "error", text: `${NOTICE} (${why}) · m lo abre` });
    deps.notify(NOTICE, `${why} · abrilo con m en zcord`);
    log.info("voice.auto-mute", { state: "muted", mode: reason });
  }

  /** El aviso queda mientras sigas silenciado en la llamada; al abrir el mic o salir se va. */
  function clearNotice(): void {
    const { voice, notices } = store.getState();
    if (voice.channelId !== null && voice.selfMute) return;
    const notice = Object.values(notices).find((n) => n.key === NOTICE_KEY);
    if (notice) store.dispatch({ type: "notice/dismiss", id: notice.id });
  }

  function sync(): void {
    clearNotice();
    const { settings, voice } = store.getState();
    const minutes =
      voice.channelId !== null && settings.inputMode !== "push_to_talk" ? settings.autoMuteAfterMinutes : null;
    if (minutes === watchingMinutes) return;
    stopWatching?.();
    stopWatching = null;
    watchingMinutes = minutes;
    if (minutes === null) return;
    stopWatching = deps.source(minutes * 60_000, {
      idle: () => mute("idle", minutes),
      lock: (locked) => {
        if (locked) mute("lock", minutes);
      },
    });
  }

  const unsubscribe = store.subscribe(sync);
  sync();

  return {
    stop(): void {
      unsubscribe();
      stopWatching?.();
      stopWatching = null;
      watchingMinutes = null;
    },
  };
}
