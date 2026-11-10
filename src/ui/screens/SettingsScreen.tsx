import { useKeyboard } from "@opentui/solid";
import { createResource, createSignal, onCleanup, Show, type JSX } from "solid-js";

import type { Actions } from "../../actions";
import type { Store } from "../../store/store";
import { createEcho, type Echo } from "../../voice/echo";
import { createOpusCodec } from "../../voice/opus";
import { createVad } from "../../voice/vad";
import type { AudioDevice } from "../../voice/devices";
import { LevelMeter } from "../components/LevelMeter";
import { useSelector } from "../store-bridge";
import { cycleTheme, themeEntries, themeLabel, useTheme } from "../theme";
import { Button, type Click } from "../components/Button";
import { statusLabel } from "../components/StatusMenu";
import { OWN_STATUSES, STREAM_QUALITIES } from "../../settings/settings";
import { CUES, type Cue } from "../../sounds/synth";

/** Nombre de cada sonido en la fila de Settings. */
export const CUE_LABELS: Record<Cue, string> = {
  join: "entrar a voz",
  leave: "salir de voz",
  userJoin: "alguien entra a tu canal",
  userLeave: "alguien sale de tu canal",
  mute: "mutear",
  unmute: "desmutear",
  deafen: "ensordecer",
  undeafen: "dejar de ensordecer",
  message: "mención o DM",
  streamStart: "empezar a transmitir",
  streamStop: "dejar de transmitir",
  disconnect: "se cortó la voz",
};

export interface SettingsDeps {
  listAudioDevices(): Promise<{ inputs: AudioDevice[]; outputs: AudioDevice[] }>;
  startCapture: (opts?: { target?: string }) => Promise<any>;
  startPlayback: (opts?: { target?: string }) => Promise<any>;
}

type Section =
  | "input"
  | "output"
  | "inputMode"
  | "sensitivity"
  | "testMic"
  | "streamMonitor"
  | "streamQuality"
  | "sounds"
  | "soundVolume"
  | "soundEvent"
  | "status"
  | "theme"
  | "images"
  | "animate"
  | "avatars";
const SECTIONS: Section[] = [
  "input",
  "output",
  "inputMode",
  "sensitivity",
  "testMic",
  "streamMonitor",
  "streamQuality",
  "sounds",
  "soundVolume",
  "soundEvent",
  "status",
  "theme",
  "images",
  "animate",
  "avatars",
];

export function SettingsScreen(props: {
  store: Store;
  actions: Actions;
  deps: SettingsDeps;
  inVoice: boolean;
  onClose(): void;
}): JSX.Element {
  const settings = useSelector(props.store, (state) => state.settings);
  const [devices] = createResource(() => props.deps.listAudioDevices());
  const [monitors] = createResource(async () => (await props.actions.voice?.listMonitors?.().catch(() => [])) ?? []);
  const [row, setRow] = createSignal<Section>("input");
  const [testing, setTesting] = createSignal(false);
  const [level, setLevel] = createSignal(-96);
  const [threshold, setThreshold] = createSignal(-45);
  const [open, setOpen] = createSignal(false);
  const [cue, setCue] = createSignal<Cue>(CUES[0]);

  let echo: Echo | null = null;

  function patch(fields: Partial<typeof settings extends () => infer T ? T : never>): void {
    props.store.dispatch({ type: "settings/set", patch: fields });
  }

  async function startTest(): Promise<void> {
    if (props.inVoice || testing()) return;
    const capture = await props.deps.startCapture({ target: settings().inputDevice ?? undefined });
    const playback = await props.deps.startPlayback({ target: settings().outputDevice ?? undefined });
    const vad = createVad({ sensitivity: settings().vadSensitivity });
    echo = createEcho({ capture, playback, codec: createOpusCodec(), vad, gate: "always" });
    capture.onFrame(() => {
      setLevel(vad.levelDb);
      setThreshold(vad.thresholdDb);
      setOpen(vad.isOpen);
    });
    setTesting(true);
  }

  async function stopTest(): Promise<void> {
    if (!testing()) return;
    await echo?.stop();
    echo = null;
    setTesting(false);
  }

  function cycleDevice(kind: "input" | "output", delta: number): void {
    const list = kind === "input" ? devices()?.inputs : devices()?.outputs;
    if (!list || list.length === 0) return;
    const field = kind === "input" ? "inputDevice" : "outputDevice";
    const current = settings()[field];
    const index = list.findIndex((d) => d.name === current);
    const next = list[(index + delta + list.length) % list.length];
    if (next) patch({ [field]: next.name } as never);
  }

  /** Monitor de Go Live: "preguntar" (null) y después cada monitor conectado. */
  function cycleMonitor(delta: number): void {
    const names: (string | null)[] = [null, ...(monitors() ?? []).map((m) => m.name).filter((n) => n !== "")];
    const index = Math.max(0, names.indexOf(settings().streamMonitor));
    patch({ streamMonitor: names[(index + delta + names.length) % names.length] ?? null });
  }

  function nudgeSensitivity(deltaDb: number): void {
    const current = settings().vadSensitivity;
    const base = current === "auto" ? threshold() : current;
    patch({ vadSensitivity: Math.min(-20, Math.max(-60, base + deltaDb)) });
  }

  /** Lo que hace Enter (dir 0) o h/l (dir −1/+1) sobre una fila; el mouse usa lo mismo. */
  function activate(section: Section, dir: -1 | 0 | 1): void {
    if (section === "input" && dir !== 0) return cycleDevice("input", dir);
    if (section === "output" && dir !== 0) return cycleDevice("output", dir);
    if ((section === "input" || section === "output") && dir === 0) return cycleDevice(section, 1);
    if (section === "inputMode" && dir === 0) {
      const mode = settings().inputMode === "voice_activity" ? "push_to_talk" : "voice_activity";
      if (props.actions.voice) props.actions.voice.setInputMode(mode);
      else patch({ inputMode: mode });
      return;
    }
    if (section === "sensitivity") {
      if (dir !== 0) nudgeSensitivity(dir * 3);
      return;
    }
    if (section === "testMic" && dir === 0) {
      if (testing()) void stopTest();
      else void startTest();
      return;
    }
    if (section === "sounds" && dir === 0) return patch({ sounds: { ...settings().sounds, enabled: !settings().sounds.enabled } });
    if (section === "soundVolume" && dir !== 0) {
      const volume = Math.min(100, Math.max(0, settings().sounds.volume + dir * 10));
      return patch({ sounds: { ...settings().sounds, volume } });
    }
    if (section === "soundEvent") {
      if (dir !== 0) return void setCue(CUES[(CUES.indexOf(cue()) + dir + CUES.length) % CUES.length]!);
      const events = { ...settings().sounds.events, [cue()]: !settings().sounds.events[cue()] };
      return patch({ sounds: { ...settings().sounds, events } });
    }
    if (section === "streamMonitor") return cycleMonitor(dir === 0 ? 1 : dir);
    if (section === "streamQuality") {
      const index = STREAM_QUALITIES.indexOf(settings().streamQuality);
      return patch({ streamQuality: STREAM_QUALITIES[(index + (dir === 0 ? 1 : dir) + STREAM_QUALITIES.length) % STREAM_QUALITIES.length]! });
    }
    if (section === "status") {
      const index = OWN_STATUSES.indexOf(settings().status);
      const next = OWN_STATUSES[(index + (dir === 0 ? 1 : dir) + OWN_STATUSES.length) % OWN_STATUSES.length]!;
      if (props.actions.setStatus) props.actions.setStatus(next);
      else patch({ status: next });
      return;
    }
    if (section === "theme") return patch({ theme: cycleTheme(settings().theme, dir === -1 ? -1 : 1) });
    if (section === "images" && dir === 0) patch({ inlineImages: !settings().inlineImages });
    if (section === "animate" && dir === 0) patch({ animateImages: !settings().animateImages });
    if (section === "avatars" && dir === 0) patch({ showAvatars: !settings().showAvatars });
  }

  useKeyboard((key) => {
    if (key.eventType === "release") return;
    if (key.name === "escape") {
      props.onClose();
      return;
    }
    if (key.name === "j") {
      const index = SECTIONS.indexOf(row());
      setRow(SECTIONS[Math.min(SECTIONS.length - 1, index + 1)]!);
      return;
    }
    if (key.name === "k") {
      const index = SECTIONS.indexOf(row());
      setRow(SECTIONS[Math.max(0, index - 1)]!);
      return;
    }
    if (row() === "sensitivity" && key.name === "a") return patch({ vadSensitivity: "auto" });
    if (key.name === "h" || key.name === "l") return activate(row(), key.name === "l" ? 1 : -1);
    if (key.name === "return") activate(row(), 0);
  });

  onCleanup(() => {
    void stopTest();
  });

  const theme = useTheme(props.store);
  const arrows = (section: Section): boolean =>
    section === "input" ||
    section === "output" ||
    section === "sensitivity" ||
    section === "soundVolume" ||
    section === "soundEvent" ||
    section === "streamMonitor";
  const line = (section: Section, text: string): JSX.Element => (
    <box
      flexDirection="row"
      backgroundColor={row() === section ? theme().selection : undefined}
      onMouseDown={() => {
        setRow(section);
        if (!arrows(section)) activate(section, 0);
      }}
    >
      <text flexGrow={1} fg={row() === section ? theme().selectionFg : theme().fg}>{`${row() === section ? "> " : "  "}${text}`}</text>
      <Show when={arrows(section)}>
        <Button label="◀" theme={theme()} onPress={() => (setRow(section), activate(section, -1))} />
        <text> </text>
        <Button label="▶" theme={theme()} onPress={() => (setRow(section), activate(section, 1))} />
      </Show>
    </box>
  );

  return (
    <box
      position="absolute"
      top={0}
      left={0}
      width="100%"
      height="100%"
      paddingTop={2}
      alignItems="center"
      zIndex={70}
      onMouseDown={() => props.onClose()}
    >
      <box
        onMouseDown={(e: Click) => e.stopPropagation()}
        border
        borderStyle="rounded"
        borderColor={theme().accent}
        backgroundColor={theme().panel}
        title=" Settings "
        titleColor={theme().accent}
        bottomTitle=" click o Enter cambia · ◀ ▶ o h/l ajusta · Esc cierra "
        bottomTitleAlignment="right"
        flexDirection="column"
        width={72}
        padding={1}
      >
        <text fg={theme().header}>Audio</text>
        {line("input", `entrada: ${settings().inputDevice ?? "predeterminada"}  (h/l)`)}
        {line("output", `salida: ${settings().outputDevice ?? "predeterminada"}  (h/l)`)}
        {line("inputMode", `modo de entrada: ${settings().inputMode === "voice_activity" ? "Actividad de voz" : "Push-to-Talk"}`)}
        {line(
          "sensitivity",
          `sensibilidad: ${settings().vadSensitivity === "auto" ? "auto" : `${settings().vadSensitivity} dBFS`}  (h/l, a = auto)`,
        )}
        <Show when={testing()}>
          <LevelMeter levelDb={level()} thresholdDb={threshold()} open={open()} width={40} />
        </Show>
        {line(
          "testMic",
          props.inVoice ? "salí de voz para probar el mic" : testing() ? "probando mic · Enter detiene" : "probar mic · Enter",
        )}
        <Show when={row() === "sensitivity"}>
          <box flexDirection="row" paddingLeft={2}>
            <Button label="auto" theme={theme()} onPress={() => patch({ vadSensitivity: "auto" })} />
          </box>
        </Show>
        <text fg={theme().header}>Transmitir pantalla</text>
        {line("streamMonitor", `monitor: ${settings().streamMonitor ?? "preguntar si hay más de uno"}  (h/l)`)}
        {line(
          "streamQuality",
          `calidad: ${settings().streamQuality}${settings().streamQuality === "1080p30" ? " (puede necesitar Nitro)" : ""}`,
        )}
        <text fg={theme().header}>Sonidos</text>
        {line("sounds", `sonidos de eventos: ${settings().sounds.enabled ? "sí" : "no"}`)}
        {line("soundVolume", `volumen de sonidos: ${settings().sounds.volume}%  (h/l)`)}
        {line(
          "soundEvent",
          `${CUE_LABELS[cue()]}: ${settings().sounds.events[cue()] ? "suena" : "no suena"}  (h/l elige, Enter cambia)`,
        )}
        <text fg={theme().header}>Cuenta</text>
        {line("status", `estado: ${statusLabel(settings().status)}  (Enter o h/l)`)}
        <text fg={theme().header}>Apariencia</text>
        {line("theme", `tema: ${themeLabel(settings().theme)}  (Enter o h/l · ${themeEntries().length} temas)`)}
        {line("images", `imágenes inline: ${settings().inlineImages ? "sí" : "no (solo links)"}`)}
        {line("animate", `animar GIFs y emojis: ${settings().animateImages ? "sí" : "no (primer cuadro)"}`)}
        {line("avatars", `avatares: ${settings().showAvatars ? "sí" : "no"}`)}
      </box>
    </box>
  );
}
