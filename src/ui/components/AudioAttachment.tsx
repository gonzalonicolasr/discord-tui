import { createSignal, onCleanup, Show, type JSX } from "solid-js";

import { audioPlayer, formatDuration, waveformBars } from "../../media/audio-player";
import { truncate } from "../format";
import type { Theme } from "../theme";
import { Button } from "./Button";

const BARS = 24;

/**
 * Audio adjunto (mensaje de voz de Discord o un ogg/mp3/…): la forma de onda, la duración y ▶ para escucharlo.
 * Mientras suena, la parte ya escuchada se pinta con el acento y ■ lo corta.
 */
export function AudioAttachment(props: {
  id: string;
  url: string;
  filename: string;
  /** Mensaje de voz (flag IS_VOICE_MESSAGE): se muestra como 🎤, no como archivo. */
  voice: boolean;
  durationSecs?: number;
  waveform?: string;
  theme: Theme;
}): JSX.Element {
  const player = audioPlayer();
  const mine = (): boolean => player.state().key === props.id;
  const status = (): string => (mine() ? player.state().status : "idle");
  // Mientras suena se redibuja dos veces por segundo para el tiempo y la parte de la onda ya escuchada.
  const [tick, setTick] = createSignal(0);
  const timer = setInterval(() => {
    if (status() === "playing") setTick((n) => n + 1);
  }, 500);
  onCleanup(() => clearInterval(timer));

  const elapsed = (): number => {
    tick();
    return status() === "playing" ? Math.max(0, (Date.now() - player.state().startedAt) / 1000) : 0;
  };
  const bars = (): string => waveformBars(props.waveform, BARS);
  const playedBars = (): number => {
    const total = props.durationSecs ?? 0;
    return total > 0 ? Math.min(BARS, Math.round((elapsed() / total) * BARS)) : 0;
  };
  const label = (): string => (props.voice ? "🎤 mensaje de voz" : `🎵 ${truncate(props.filename, 30)}`);
  const time = (): string => {
    const total = props.durationSecs;
    if (status() === "playing") return total ? `${formatDuration(elapsed())} / ${formatDuration(total)}` : formatDuration(elapsed());
    return total ? formatDuration(total) : "";
  };

  return (
    <box flexDirection="row" columnGap={1}>
      <text fg={props.theme.fg} wrapMode="none">{label()}</text>
      <text wrapMode="none">
        <span style={{ fg: props.theme.accent }}>{bars().slice(0, playedBars())}</span>
        <span style={{ fg: props.theme.dim }}>{bars().slice(playedBars())}</span>
      </text>
      <Show when={time()}>
        <text fg={props.theme.dim} wrapMode="none">{time()}</text>
      </Show>
      <Button
        label={status() === "playing" ? "■ parar" : status() === "loading" ? "⏳ cargando…" : "▶ escuchar"}
        theme={props.theme}
        active={status() === "playing"}
        onPress={() => player.toggle(props.id, props.url)}
      />
      <Show when={status() === "error" && mine()}>
        <text fg={props.theme.error} wrapMode="none">{player.state().error ?? ""}</text>
      </Show>
    </box>
  );
}
