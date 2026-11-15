import type { SystemIdleSource, SystemIdleTrouble } from "../desktop/wayland-idle";
import { log } from "../log/logger";
import type { Store } from "../store/store";
import type { VoiceActions } from "./voice";

const NOTICE = "🔇 micrófono silenciado por inactividad";
const NOTICE_KEY = "voice-auto-mute";
/** Si la fuente no conecta o se corta, se reintenta una vez por llamada, pasado este rato. */
const RETRY_MS = 60_000;

const TROUBLE_TEXT: Record<SystemIdleTrouble, string> = {
  unavailable: "⚠ el auto-silencio por inactividad no está funcionando (no hay conexión con el compositor): detalle en el log",
  lost: "⚠ el auto-silencio por inactividad dejó de funcionar (se cortó la conexión con el compositor): reintento en un minuto",
  "no-idle": "⚠ el auto-silencio no detecta la inactividad de la PC, solo el bloqueo de pantalla",
  "no-lock": "⚠ el auto-silencio no detecta el bloqueo de pantalla, solo la inactividad de la PC",
};

/**
 * Silenciarse solo: con el mic abierto en una llamada, si Gon deja de usar la PC (teclado/mouse de todo el sistema,
 * no solo de zcord) `settings.autoMuteAfterMinutes` minutos o bloquea la pantalla, se cierra el mic con el mismo
 * camino que la tecla m (Discord lo ve), con notificación de escritorio y un aviso (hasta que abras el mic o salgas
 * de la llamada). Nunca lo vuelve a abrir. Solo mira mientras estás en una llamada, con el ajuste prendido y sin
 * push-to-talk. Si la fuente no anda, lo dice una vez en pantalla (por tipo de problema) y reintenta una vez.
 */
export function createAutoMute(deps: {
  store: Store;
  voice: Pick<VoiceActions, "toggleMute">;
  source: SystemIdleSource;
  notify: (title: string, body: string) => void;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}): { stop(): void } {
  const { store } = deps;
  const setTimer = deps.setTimer ?? setTimeout;
  const clearTimer = deps.clearTimer ?? clearTimeout;
  let stopWatching: (() => void) | null = null;
  let watchingMinutes: number | null = null;
  /** Sube con cada vigilancia nueva: los eventos de una vieja se ignoran. */
  let generation = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  const warned = new Set<SystemIdleTrouble>();

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

  function onTrouble(kind: SystemIdleTrouble, minutes: number, retried: boolean): void {
    if (!warned.has(kind)) {
      warned.add(kind);
      store.dispatch({ type: "notice/push", key: `voice-auto-mute-off-${kind}`, level: "warn", text: TROUBLE_TEXT[kind] });
    }
    if ((kind !== "unavailable" && kind !== "lost") || retried || retryTimer !== null) return;
    const gen = generation;
    retryTimer = setTimer(() => {
      retryTimer = null;
      if (gen !== generation) return;
      stopWatching?.();
      watch(minutes, true);
    }, RETRY_MS);
    (retryTimer as { unref?: () => void }).unref?.();
  }

  function watch(minutes: number, retried: boolean): void {
    const gen = ++generation;
    const current = (): boolean => gen === generation;
    stopWatching = deps.source(minutes * 60_000, {
      idle: () => {
        if (current()) mute("idle", minutes);
      },
      lock: (locked) => {
        if (locked && current()) mute("lock", minutes);
      },
      trouble: (kind) => {
        if (current()) onTrouble(kind, minutes, retried);
      },
    });
  }

  function unwatch(): void {
    if (retryTimer !== null) clearTimer(retryTimer);
    retryTimer = null;
    generation += 1;
    stopWatching?.();
    stopWatching = null;
  }

  function sync(): void {
    clearNotice();
    const { settings, voice } = store.getState();
    const minutes =
      voice.channelId !== null && settings.inputMode !== "push_to_talk" ? settings.autoMuteAfterMinutes : null;
    if (minutes === watchingMinutes) return;
    unwatch();
    watchingMinutes = minutes;
    if (minutes !== null) watch(minutes, false);
  }

  const unsubscribe = store.subscribe(sync);
  sync();

  return {
    stop(): void {
      unsubscribe();
      unwatch();
      watchingMinutes = null;
    },
  };
}
