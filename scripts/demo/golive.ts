import type { VoiceActions } from "../../src/actions/voice";
import type { Monitor } from "../../src/golive/capture";
import type { Store } from "../../src/store/store";

/** Monitores falsos de la demo (como los de `hyprctl monitors -j`). */
export const DEMO_MONITORS: Monitor[] = [
  { name: "DP-1", width: 1920, height: 1080, focused: true },
  { name: "HDMI-A-1", width: 1920, height: 1080, focused: false },
];

/** Go Live simulado: `⏳ iniciando…` un rato, después `🔴 EN VIVO` con un espectador. No captura nada. */
export function demoStreamActions(store: Store, me: string): Pick<VoiceActions, "startStream" | "stopStream" | "toggleStream" | "listMonitors"> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const selfStream = (on: boolean): void => {
    const v = store.getState().voice;
    if (v.guildId === null || v.channelId === null) return;
    store.dispatch({
      type: "gw",
      t: "VOICE_STATE_UPDATE",
      d: { guild_id: v.guildId, user_id: me, channel_id: v.channelId, self_mute: v.selfMute, self_deaf: v.selfDeaf, self_stream: on },
    });
  };
  const actions = {
    async startStream(monitor?: string | null) {
      const v = store.getState().voice;
      if (v.status !== "connected") {
        store.dispatch({ type: "notice/push", key: "golive", level: "info", text: "entrá a un canal de voz para transmitir" });
        return;
      }
      if (v.stream.status === "live" || v.stream.status === "starting") return;
      const chosen = monitor ?? store.getState().settings.streamMonitor ?? DEMO_MONITORS[0]!.name;
      store.dispatch({ type: "voice/stream", patch: { status: "starting", monitor: chosen, error: null, viewers: undefined, viewerIds: undefined } });
      timer = setTimeout(() => {
        timer = null;
        if (store.getState().voice.stream.status !== "starting") return;
        // En la demo te mira Ramiro (como STREAM_UPDATE con viewer_ids).
        store.dispatch({ type: "voice/stream", patch: { status: "live", viewers: 1, viewerIds: ["900000000000000101"] } });
        selfStream(true);
      }, 600);
    },
    async stopStream() {
      if (timer) clearTimeout(timer);
      timer = null;
      if (store.getState().voice.stream.status === "idle") return;
      store.dispatch({ type: "voice/stream", patch: { status: "idle", error: null, viewers: undefined, viewerIds: undefined } });
      selfStream(false);
    },
    async toggleStream() {
      const status = store.getState().voice.stream.status;
      return status === "live" || status === "starting" ? actions.stopStream() : actions.startStream();
    },
    listMonitors: async () => DEMO_MONITORS,
  };
  return actions;
}

/** Alguien de la demo ya está transmitiendo en Sala 1 (para ver el `📺 en vivo` en la lista). */
export function seedGoLive(store: Store, guildId: string, channelId: string, userId: string): void {
  store.dispatch({
    type: "gw",
    t: "VOICE_STATE_UPDATE",
    d: { guild_id: guildId, user_id: userId, channel_id: channelId, self_mute: false, self_deaf: false, self_stream: true },
  });
}
