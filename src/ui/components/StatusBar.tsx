import { TextAttributes } from "@opentui/core";
import { Show, type JSX } from "solid-js";

import type { Store } from "../../store/store";
import { formatPrivacyCode } from "../../voice/privacy-code";
import { displayName, truncate } from "../format";
import { useSelector } from "../store-bridge";
import type { Actions } from "../../actions";
import { Button, type Click } from "./Button";
import { statusColor, statusLabel } from "./StatusMenu";
import type { Theme } from "../theme";

export function connectionLabel(connection: string): string {
  if (connection === "ready") return "conectado";
  if (connection === "reconnecting") return "reconectando…";
  if (connection === "resuming") return "reanudando…";
  if (connection === "connecting" || connection === "identifying") return "conectando…";
  return "desconectado";
}

export function StatusBar(props: {
  store: Store;
  theme: Theme;
  mode: "NORMAL" | "INSERT";
  hint?: string | null;
  onHelp?(): void;
  onSettings?(): void;
  onSwitcher?(): void;
  onStatus?(): void;
}): JSX.Element {
  const connection = useSelector(props.store, (state) => state.connection);
  const me = useSelector(props.store, (state) => state.me);
  const inputMode = useSelector(props.store, (state) => state.settings.inputMode);
  const ownStatus = useSelector(props.store, (state) => state.settings.status);
  const connColor = (): string =>
    connection() === "ready" ? props.theme.ok : connection() === "disconnected" ? props.theme.error : props.theme.warn;

  return (
    <box height={1} width="100%" flexDirection="row" flexShrink={0}>
      <text
        fg={props.theme.modeFg}
        bg={props.mode === "INSERT" ? props.theme.modeInsert : props.theme.modeNormal}
        attributes={TextAttributes.BOLD}
        flexShrink={0}
      >
        {` ${props.mode} `}
      </text>
      <text fg={connColor()} flexShrink={0}>{` ● ${connectionLabel(connection())}`}</text>
      <text fg={props.theme.dim} flexShrink={0}> ·</text>
      <text
        fg={statusColor(props.theme, ownStatus())}
        bg={props.theme.selection}
        wrapMode="none"
        flexShrink={0}
        onMouseDown={(e: Click) => {
          e.stopPropagation();
          props.onStatus?.();
        }}
      >
        {` ${statusLabel(ownStatus())} ▾ `}
      </text>
      <text fg={props.theme.dim} wrapMode="none">{` · logueado como ${me()?.username ?? "…"}`}</text>
      <text fg={props.theme.faint} wrapMode="none">{` · mic ${inputMode() === "push_to_talk" ? "PTT" : "VAD"}`}</text>
      <box flexGrow={1} />
      <Show
        when={props.onHelp}
        fallback={<text fg={props.theme.dim} wrapMode="none">{`${props.hint ?? "? ayuda · Ctrl-k saltar · q salir"} `}</text>}
      >
        <box flexDirection="row" columnGap={1} flexShrink={0}>
          <Button label="⌕ Ctrl-k saltar" theme={props.theme} onPress={() => props.onSwitcher?.()} />
          <Button label="⚙ settings" theme={props.theme} onPress={() => props.onSettings?.()} />
          <Button label="? ayuda" theme={props.theme} onPress={() => props.onHelp?.()} />
          <text fg={props.theme.dim}>q salir </text>
        </box>
      </Show>
    </box>
  );
}

/** Texto del botón de Go Live según el estado del stream propio. */
export function streamButtonLabel(status: string): string {
  if (status === "live") return "🔴 EN VIVO · detener";
  if (status === "starting") return "⏳ iniciando…";
  return "📺 transmitir";
}

export function VoiceBar(props: {
  store: Store;
  theme: Theme;
  actions?: Actions;
  onStream?(): void;
  /** Click en 🔈: elegir por dónde sale el audio de la llamada. */
  onOutput?(): void;
}): JSX.Element {
  const state = useSelector(props.store, (s) => s);
  const voice = () => state().voice;
  const channelName = (): string => {
    const id = voice().channelId;
    return id ? state().channels[id]?.name ?? "voz" : "";
  };
  const guildName = (): string => {
    const id = voice().guildId;
    return id ? state().guilds[id]?.name ?? "" : "";
  };
  const speakingNames = (): string => {
    const ids = Object.keys(voice().speaking);
    if (ids.length === 0) return "";
    const names = ids.slice(0, 3).map((id) => displayName(state(), id, voice().guildId));
    return `hablando: ${names.join(", ")}${ids.length > 3 ? ` +${ids.length - 3}` : ""}`;
  };
  /** Quién mira tu transmisión: "👁 Ramiro, Celes" (hasta 3 nombres) o la cuenta si Discord no mandó la lista. */
  const viewersText = (): string => {
    const stream = voice().stream;
    if (stream.status !== "live") return "";
    const ids = stream.viewerIds;
    if (!ids) return stream.viewers !== undefined ? ` · 👁 ${stream.viewers}` : "";
    if (ids.length === 0) return " · 👁 nadie todavía";
    const names = ids.slice(0, 3).map((id) => displayName(state(), id, voice().guildId));
    return ` · 👁 ${names.join(", ")}${ids.length > 3 ? ` +${ids.length - 3}` : ""}`;
  };
  const statusText = (): string => {
    const s = voice().status;
    if (s === "joining") return "conectando…";
    if (s === "reconnecting") return "reconectando…";
    return "";
  };
  const visible = (): boolean => voice().channelId !== null || voice().error !== null;

  return (
    <Show when={visible()}>
      <box height={1} width="100%" flexDirection="row" flexShrink={0} backgroundColor={props.theme.panel}>
        <Show
          when={voice().channelId !== null}
          fallback={<text fg={props.theme.error} wrapMode="none">{` ✗ voz: ${voice().error ?? ""}`}</text>}
        >
          <text fg={props.theme.speaking} attributes={TextAttributes.BOLD} wrapMode="none">{` 🔊 ${channelName()}`}</text>
          <text fg={props.theme.dim} wrapMode="none">{guildName() ? ` · ${guildName()}` : ""}</text>
          <Show when={statusText()}>
            <text fg={props.theme.warn}>{` · ${statusText()}`}</text>
          </Show>
          <Show when={voice().status === "connected"}>
            <text fg={props.theme.ok} wrapMode="none">
              {voice().privacyCode ? ` · 🔒 E2EE ${formatPrivacyCode(voice().privacyCode!)}` : " · 🔒 E2EE"}
            </text>
          </Show>
          <text fg={props.theme.accent}>{` · ${state().settings.inputMode === "push_to_talk" ? "PTT" : "VAD"}`}</text>
          <text fg={voice().selfSpeaking ? props.theme.speaking : props.theme.faint}>
            {voice().selfSpeaking ? " · ● vos" : " · ○ vos"}
          </text>
          <text fg={props.theme.warn}>{voice().selfMute && !voice().selfDeaf ? " 🔇" : ""}</text>
          <text fg={props.theme.error}>{voice().selfDeaf ? " 🙉" : ""}</text>
          <text fg={props.theme.speaking} wrapMode="none">{speakingNames() ? ` · ${speakingNames()}` : ""}</text>
          <text fg={props.theme.warn} wrapMode="none">{voice().pttWarning ? ` · ${voice().pttWarning}` : ""}</text>
          <text fg={props.theme.warn} wrapMode="none">{voice().micError ? ` · sin mic: ${voice().micError}` : ""}</text>
          <text fg={props.theme.accent} wrapMode="none">{viewersText()}</text>
          {/* Se achica antes que el resto de la barra (el nombre del canal y E2EE no se cortan). */}
          <text fg={props.theme.error} wrapMode="none" flexShrink={50}>
            {voice().stream.status === "error" && voice().stream.error ? ` · ✗ transmisión: ${voice().stream.error}` : ""}
          </text>
          <box flexGrow={1} />
          <Show
            when={props.actions?.voice}
            fallback={<text fg={props.theme.dim} wrapMode="none">{"m mute · D deaf · M modo · v salir "}</text>}
          >
            {(voiceActions: () => NonNullable<Actions["voice"]>) => (
              <box flexDirection="row" columnGap={1} flexShrink={0}>
                <Button
                  label={voice().selfMute ? "🎙 muteado" : "🎙 mic"}
                  theme={props.theme}
                  active={voice().selfMute}
                  danger={voice().selfMute}
                  onPress={() => voiceActions().toggleMute()}
                />
                <Show when={props.onOutput}>
                  <Button
                    label={`🔈 ${truncate(voice().outputLabel ?? "salida", 18)}`}
                    theme={props.theme}
                    onPress={() => props.onOutput?.()}
                  />
                </Show>
                <Button
                  label={voice().selfDeaf ? "🎧 sordo" : "🎧 audio"}
                  theme={props.theme}
                  active={voice().selfDeaf}
                  danger={voice().selfDeaf}
                  onPress={() => voiceActions().toggleDeaf()}
                />
                <Button
                  label={state().settings.inputMode === "push_to_talk" ? "🎚 PTT" : "🎚 VAD"}
                  theme={props.theme}
                  onPress={() => voiceActions().toggleInputMode()}
                />
                <Show when={voiceActions().startStream}>
                  <Button
                    label={streamButtonLabel(voice().stream.status)}
                    theme={props.theme}
                    active={voice().stream.status === "live"}
                    danger={voice().stream.status === "live"}
                    onPress={() => {
                      if (props.onStream) return props.onStream();
                      const live = voice().stream.status === "live" || voice().stream.status === "starting";
                      void (live ? voiceActions().stopStream?.() : voiceActions().startStream?.());
                    }}
                  />
                </Show>
                <Button label="✕ salir" theme={props.theme} danger onPress={() => void voiceActions().leaveVoice()} />
                <text> </text>
              </box>
            )}
          </Show>
        </Show>
      </box>
    </Show>
  );
}
